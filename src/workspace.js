const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const DEFAULT_IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build', '.vscode', 'out', 'coverage', '.next'];
const TEXT_EXTENSIONS = new Set([
    '.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.css', '.scss', '.html', '.yml', '.yaml',
    '.mjs', '.cjs', '.py', '.java', '.go', '.rs', '.php', '.rb', '.sh', '.txt', '.xml', '.toml'
]);

function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        return folders[0].uri.fsPath;
    }
    return null;
}

function getAbsolutePath(relativePath = '.') {
    const root = getWorkspaceRoot();
    if (!root) return null;

    const absolutePath = path.resolve(root, relativePath);
    const relative = path.relative(root, absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return null;
    }

    return absolutePath;
}

function toRelativePath(absPath) {
    const root = getWorkspaceRoot();
    if (!root) return absPath;
    return path.relative(root, absPath);
}

function isTextFile(filePath) {
    return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function listFiles(dir = '.', ignoreDirs = DEFAULT_IGNORE_DIRS) {
    const root = getWorkspaceRoot();
    if (!root) throw new Error("No active workspace found.");

    const absoluteDir = getAbsolutePath(dir);
    if (!absoluteDir) throw new Error("Path is outside the workspace.");

    const filesList = [];

    async function scan(currentDir) {
        let entries;
        try {
            entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const entryPath = path.join(currentDir, entry.name);
            const relativePath = path.relative(root, entryPath);
            const parts = relativePath.split(path.sep);

            if (ignoreDirs.some(ignore => parts.includes(ignore))) {
                continue;
            }

            if (entry.isDirectory()) {
                await scan(entryPath);
            } else if (entry.isFile()) {
                filesList.push(relativePath);
            }
        }
    }

    await scan(absoluteDir);
    return filesList.sort();
}

async function readFile(relativePath) {
    const absPath = getAbsolutePath(relativePath);
    if (!absPath) throw new Error(`Permission denied: Cannot read file outside workspace path "${relativePath}".`);
    if (!fs.existsSync(absPath)) throw new Error(`File not found: "${relativePath}"`);
    return fs.promises.readFile(absPath, 'utf8');
}

async function writeFile(relativePath, content) {
    const absPath = getAbsolutePath(relativePath);
    if (!absPath) throw new Error(`Permission denied: Cannot write file outside workspace path "${relativePath}".`);

    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, content, 'utf8');
    await openInEditor(absPath);
    return `Successfully wrote file: ${relativePath}`;
}

async function makeEdit(relativePath, search, replace) {
    const absPath = getAbsolutePath(relativePath);
    if (!absPath) throw new Error(`Permission denied: Cannot edit file outside workspace path "${relativePath}".`);
    if (!fs.existsSync(absPath)) throw new Error(`File not found: "${relativePath}"`);

    const content = await fs.promises.readFile(absPath, 'utf8');
    if (!content.includes(search)) {
        const compactContent = content.replace(/\s+/g, '');
        const compactSearch = search.trim().replace(/\s+/g, '');
        if (compactContent.includes(compactSearch)) {
            throw new Error(`Target search block found in "${relativePath}" but whitespace or formatting differs. Use write_file or provide an exact match.`);
        }
        throw new Error(`Could not find the target search block in "${relativePath}".`);
    }

    const updatedContent = content.replace(search, replace);
    await fs.promises.writeFile(absPath, updatedContent, 'utf8');
    await openInEditor(absPath);
    return `Successfully updated file: ${relativePath}`;
}

async function deleteFile(relativePath) {
    const absPath = getAbsolutePath(relativePath);
    if (!absPath) throw new Error(`Permission denied: Cannot delete outside workspace path "${relativePath}".`);
    if (!fs.existsSync(absPath)) throw new Error(`File not found: "${relativePath}"`);
    await fs.promises.rm(absPath, { recursive: false, force: false });
    return `Successfully deleted file: ${relativePath}`;
}

async function moveFile(from, to) {
    const fromAbs = getAbsolutePath(from);
    const toAbs = getAbsolutePath(to);
    if (!fromAbs || !toAbs) throw new Error("Permission denied: Move paths must stay inside the workspace.");
    if (!fs.existsSync(fromAbs)) throw new Error(`File not found: "${from}"`);
    await fs.promises.mkdir(path.dirname(toAbs), { recursive: true });
    await fs.promises.rename(fromAbs, toAbs);
    await openInEditor(toAbs);
    return `Successfully moved file: ${from} -> ${to}`;
}

async function openInEditor(absPath) {
    try {
        const doc = await vscode.workspace.openTextDocument(absPath);
        await vscode.window.showTextDocument(doc, { preview: false });
    } catch {
        // Non-text files or hidden editors are safe to ignore.
    }
}

async function searchWorkspace(query) {
    const allFiles = await listFiles();
    const results = [];

    for (const relPath of allFiles) {
        const absPath = getAbsolutePath(relPath);
        if (!absPath || !isTextFile(relPath)) continue;

        try {
            const content = await fs.promises.readFile(absPath, 'utf8');
            const lines = content.split('\n');
            lines.forEach((line, index) => {
                if (line.toLowerCase().includes(query.toLowerCase())) {
                    results.push({ path: relPath, line: index + 1, text: line.trim() });
                }
            });
        } catch {
            // Ignore unreadable files.
        }

        if (results.length >= 100) break;
    }

    return results;
}

function execCommand(command, options = {}) {
    const root = getWorkspaceRoot();
    if (!root) throw new Error("No active workspace found.");

    return new Promise((resolve) => {
        cp.exec(command, {
            cwd: root,
            timeout: options.timeout || 120000,
            maxBuffer: options.maxBuffer || 1024 * 1024
        }, (error, stdout, stderr) => {
            resolve({
                command,
                exitCode: error && typeof error.code === 'number' ? error.code : 0,
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                timedOut: !!(error && error.killed)
            });
        });
    });
}

async function getGitStatus() {
    const result = await execCommand('git status --short --branch', { timeout: 15000 });
    return result.stdout || result.stderr || 'Git status unavailable.';
}

async function getGitDiff(filePath = null) {
    const quoted = filePath ? ` -- "${filePath.replace(/"/g, '\\"')}"` : '';
    const result = await execCommand(`git diff --no-ext-diff --minimal${quoted}`, { timeout: 20000 });
    return result.stdout || 'No unstaged diff.';
}

function getDiagnosticsSummary(limit = 30) {
    return vscode.languages.getDiagnostics()
        .flatMap(([uri, diagnostics]) => diagnostics.map(diag => ({
            file: toRelativePath(uri.fsPath),
            line: diag.range.start.line + 1,
            severity: ['Error', 'Warning', 'Information', 'Hint'][diag.severity] || 'Unknown',
            message: diag.message
        })))
        .slice(0, limit);
}

async function getOpenFiles() {
    return vscode.window.visibleTextEditors.map(editor => ({
        path: toRelativePath(editor.document.uri.fsPath),
        language: editor.document.languageId,
        dirty: editor.document.isDirty
    }));
}

async function getProjectSnapshot() {
    const root = getWorkspaceRoot();
    if (!root) throw new Error("No active workspace found.");

    const files = await listFiles();
    const packagePath = getAbsolutePath('package.json');
    let packageInfo = null;

    if (packagePath && fs.existsSync(packagePath)) {
        try {
            const packageJson = JSON.parse(await fs.promises.readFile(packagePath, 'utf8'));
            packageInfo = {
                name: packageJson.name,
                scripts: packageJson.scripts || {},
                dependencies: Object.keys(packageJson.dependencies || {}),
                devDependencies: Object.keys(packageJson.devDependencies || {})
            };
        } catch (e) {
            packageInfo = { error: e.message };
        }
    }

    return {
        rootName: path.basename(root),
        files: files.slice(0, 160),
        fileCount: files.length,
        packageInfo,
        openFiles: await getOpenFiles(),
        gitStatus: await getGitStatus(),
        diagnostics: getDiagnosticsSummary()
    };
}

async function formatFile(relativePath) {
    const absPath = getAbsolutePath(relativePath);
    if (!absPath) throw new Error(`Permission denied: Cannot format outside workspace path "${relativePath}".`);
    const doc = await vscode.workspace.openTextDocument(absPath);
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand('editor.action.formatDocument');
    await doc.save();
    return `Formatted file: ${relativePath}`;
}

async function validateWorkspace() {
    const root = getWorkspaceRoot();
    if (!root) throw new Error("No active workspace found.");

    const packagePath = getAbsolutePath('package.json');
    if (!packagePath || !fs.existsSync(packagePath)) {
        return 'No package.json found. Skipped npm validation.';
    }

    const pkg = JSON.parse(await fs.promises.readFile(packagePath, 'utf8'));
    const reports = [];

    if (pkg.scripts && pkg.scripts.lint) {
        const lint = await execCommand('npm run lint', { timeout: 120000 });
        reports.push(`lint exit ${lint.exitCode}\n${lint.stdout || lint.stderr}`);
    }

    if (pkg.scripts && pkg.scripts.test) {
        const test = await execCommand('npm test -- --runInBand', { timeout: 120000 });
        reports.push(`test exit ${test.exitCode}\n${test.stdout || test.stderr}`);
    }

    if (reports.length === 0) {
        return 'No lint or test scripts found in package.json.';
    }

    return reports.join('\n\n');
}

async function previewTool(tool) {
    const { name, args } = tool;
    const risk = ['write_file', 'make_edit', 'delete_file', 'move_file', 'run_command'].includes(name) ? 'write' : 'read';
    const preview = { risk, affectedFiles: [], summary: '', diff: '' };

    if (name === 'write_file') {
        preview.affectedFiles = [args.path];
        const before = fs.existsSync(getAbsolutePath(args.path) || '') ? await readFile(args.path) : '';
        preview.diff = createUnifiedDiff(args.path, before, args.content || '');
        preview.summary = before ? `Overwrite ${args.path}` : `Create ${args.path}`;
    } else if (name === 'make_edit') {
        preview.affectedFiles = [args.path];
        const before = await readFile(args.path);
        const after = before.includes(args.search) ? before.replace(args.search, args.replace || '') : before;
        preview.diff = createUnifiedDiff(args.path, before, after);
        preview.summary = `Edit ${args.path}`;
    } else if (name === 'delete_file') {
        preview.affectedFiles = [args.path];
        preview.summary = `Delete ${args.path}`;
    } else if (name === 'move_file') {
        preview.affectedFiles = [args.from, args.to];
        preview.summary = `Move ${args.from} to ${args.to}`;
    } else if (name === 'run_command') {
        preview.summary = `Run command: ${args.command}`;
    } else if (name === 'format_file') {
        preview.affectedFiles = [args.path];
        preview.summary = `Format ${args.path}`;
    } else {
        preview.summary = describeTool(tool);
    }

    return preview;
}

function createUnifiedDiff(filePath, before, after) {
    if (before === after) return 'No diff available.';
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    const maxLines = Math.max(beforeLines.length, afterLines.length);
    const lines = [`--- ${filePath}`, `+++ ${filePath}`];
    let shown = 0;

    for (let i = 0; i < maxLines && shown < 220; i++) {
        if (beforeLines[i] === afterLines[i]) continue;
        if (beforeLines[i] !== undefined) lines.push(`- ${beforeLines[i]}`);
        if (afterLines[i] !== undefined) lines.push(`+ ${afterLines[i]}`);
        shown++;
    }

    if (shown >= 220) lines.push('... diff truncated ...');
    return lines.join('\n');
}

function describeTool(tool) {
    const { name, args } = tool;
    if (name === 'list_dir') return `List files in ${args.path || '.'}`;
    if (name === 'read_file') return `Read ${args.path}`;
    if (name === 'search_grep') return `Search for ${args.query}`;
    if (name === 'git_status') return 'Inspect Git status';
    if (name === 'git_diff') return args.path ? `Inspect diff for ${args.path}` : 'Inspect workspace diff';
    if (name === 'workspace_snapshot') return 'Analyze project structure, Git, diagnostics, and open files';
    if (name === 'validate_workspace') return 'Run available validation scripts';
    return name;
}

module.exports = {
    getWorkspaceRoot,
    getAbsolutePath,
    listFiles,
    readFile,
    writeFile,
    makeEdit,
    deleteFile,
    moveFile,
    searchWorkspace,
    execCommand,
    getGitStatus,
    getGitDiff,
    getDiagnosticsSummary,
    getOpenFiles,
    getProjectSnapshot,
    formatFile,
    validateWorkspace,
    previewTool,
    createUnifiedDiff,
    describeTool
};
