const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

/**
 * Gets the current active workspace root path.
 * If multiple workspace folders are open, returns the first one.
 * @returns {string|null}
 */
function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        return folders[0].uri.fsPath;
    }
    return null;
}

/**
 * Normalizes a path relative to the workspace root.
 * Prevents directory traversal attacks (escaping the workspace).
 * @param {string} relativePath 
 * @returns {string|null} Absolute path, or null if outside workspace.
 */
function getAbsolutePath(relativePath) {
    const root = getWorkspaceRoot();
    if (!root) return null;

    // Resolve relative path against workspace root
    const absolutePath = path.resolve(root, relativePath);

    // Ensure the path is within the workspace root
    if (!absolutePath.startsWith(root)) {
        return null; // Out of bounds
    }

    return absolutePath;
}

/**
 * Recursively list all files in the workspace (excluding common ignored directories).
 * @param {string} dir - Directory path relative to workspace root (defaults to '.')
 * @param {string[]} ignoreDirs - Directories to ignore
 * @returns {Promise<string[]>} List of relative file paths
 */
async function listFiles(dir = '.', ignoreDirs = ['node_modules', '.git', 'dist', 'build', '.vscode', 'out', 'package-lock.json', 'yarn.lock']) {
    const root = getWorkspaceRoot();
    if (!root) throw new Error("No active workspace found.");

    const absoluteDir = getAbsolutePath(dir);
    if (!absoluteDir) throw new Error("Path is outside the workspace.");

    const filesList = [];

    async function scan(currentDir) {
        let entries;
        try {
            entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        } catch (e) {
            return; // Ignore unreadable directories
        }

        for (const entry of entries) {
            const entryPath = path.join(currentDir, entry.name);
            const relativePath = path.relative(root, entryPath);

            // Check if ignored
            if (ignoreDirs.some(ignore => {
                const parts = relativePath.split(path.sep);
                return parts.includes(ignore);
            })) {
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
    return filesList;
}

/**
 * Read the contents of a file.
 * @param {string} relativePath - Path relative to workspace root
 * @returns {Promise<string>} File content
 */
async function readFile(relativePath) {
    const absPath = getAbsolutePath(relativePath);
    if (!absPath) throw new Error(`Permission denied: Cannot read file outside workspace path "${relativePath}".`);

    if (!fs.existsSync(absPath)) {
        throw new Error(`File not found: "${relativePath}"`);
    }

    const content = await fs.promises.readFile(absPath, 'utf8');
    return content;
}

/**
 * Write/Create a file with the given content.
 * @param {string} relativePath - Path relative to workspace root
 * @param {string} content - Content to write
 * @returns {Promise<string>} Status message
 */
async function writeFile(relativePath, content) {
    const absPath = getAbsolutePath(relativePath);
    if (!absPath) throw new Error(`Permission denied: Cannot write file outside workspace path "${relativePath}".`);

    const dirName = path.dirname(absPath);
    if (!fs.existsSync(dirName)) {
        await fs.promises.mkdir(dirName, { recursive: true });
    }

    await fs.promises.writeFile(absPath, content, 'utf8');
    
    // Automatically open the file in the editor for the user to see the change
    try {
        const doc = await vscode.workspace.openTextDocument(absPath);
        await vscode.window.showTextDocument(doc, { preview: false });
    } catch (e) {
        // Ignore if editor can't open it (e.g. binary file, though they should be text)
    }

    return `Successfully wrote file: ${relativePath}`;
}

/**
 * Edit a file by searching for a specific block and replacing it.
 * @param {string} relativePath - Path relative to workspace root
 * @param {string} search - Content to search for
 * @param {string} replace - Content to replace it with
 * @returns {Promise<string>} Status message
 */
async function makeEdit(relativePath, search, replace) {
    const absPath = getAbsolutePath(relativePath);
    if (!absPath) throw new Error(`Permission denied: Cannot edit file outside workspace path "${relativePath}".`);

    if (!fs.existsSync(absPath)) {
        throw new Error(`File not found: "${relativePath}"`);
    }

    const content = await fs.promises.readFile(absPath, 'utf8');

    // Perform exact block replacement
    if (!content.includes(search)) {
        // Try trimming whitespace to be more forgiving
        const trimmedSearch = search.trim();
        const searchIndex = content.replace(/\s+/g, '').indexOf(trimmedSearch.replace(/\s+/g, ''));
        
        if (searchIndex === -1) {
            throw new Error(`Could not find the target search block in "${relativePath}". Please make sure your search block matches exactly.`);
        }
        
        // If we found a loose match, we still want to be careful. Let's report that we couldn't match exactly.
        throw new Error(`Target search block found in "${relativePath}" but whitespace or formatting differs. Please write the complete file or provide an exact match.`);
    }

    const updatedContent = content.replace(search, replace);
    await fs.promises.writeFile(absPath, updatedContent, 'utf8');

    // Automatically open the file in the editor
    try {
        const doc = await vscode.workspace.openTextDocument(absPath);
        await vscode.window.showTextDocument(doc, { preview: false });
    } catch (e) {
        // Ignore
    }

    return `Successfully updated file: ${relativePath}`;
}

/**
 * Grep search in workspace files.
 * @param {string} query - Search term
 * @returns {Promise<{path: string, line: number, text: string}[]>} Search results
 */
async function searchWorkspace(query) {
    const root = getWorkspaceRoot();
    if (!root) throw new Error("No active workspace found.");

    const allFiles = await listFiles();
    const results = [];

    for (const relPath of allFiles) {
        const absPath = getAbsolutePath(relPath);
        if (!absPath) continue;

        try {
            const content = await fs.promises.readFile(absPath, 'utf8');
            const lines = content.split('\n');
            lines.forEach((line, index) => {
                if (line.toLowerCase().includes(query.toLowerCase())) {
                    results.push({
                        path: relPath,
                        line: index + 1,
                        text: line.trim()
                    });
                }
            });
        } catch (e) {
            // Ignore unreadable files
        }

        // Limit search results to prevent flooding
        if (results.length >= 100) {
            break;
        }
    }

    return results;
}

module.exports = {
    getWorkspaceRoot,
    getAbsolutePath,
    listFiles,
    readFile,
    writeFile,
    makeEdit,
    searchWorkspace
};
