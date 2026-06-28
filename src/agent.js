const workspace = require('./workspace');

// System prompt to guide Ontonim AI in running workspace tasks.
const SYSTEM_PROMPT = `You are Ontonim AI, an elite AI coding assistant and agent.
You are running as a VS Code extension, directly interacting with the user's workspace.
Your goal is to help the user build, debug, refactor, and understand their code.

You have access to the user's workspace directory. You can inspect project structure, Git status, diagnostics, open files, dependencies, read/write/edit/move/delete files, format files, validate the workspace, and run approved terminal commands.
To perform actions, you MUST use the following XML-based tool call formats. You can output multiple tool calls in a single turn if they can be run in parallel.
Always provide a brief, helpful message explaining what you are doing before outputting tool calls.

Plan-first workflow:
- For every user task that requires workspace actions, first analyze the workspace and then present a concrete proposed action list before any tool call.
- For every implementation, refactor, fix, command, file creation, file edit, move, rename, or deletion, the plan must include: goal, affected files, exact execution steps, validation, risks, and rollback notes.
- Treat the plan as a confirmation request: the VS Code host will show the proposed actions with Confirm & Run and Cancel buttons before they execute.
- Do not imply that files have been changed until the user confirms and the tool results show success.
- After changes, validate when possible and finish with a final report: changed files, validation, risks, and recommended next steps.
- Never skip user approval for mutating tools.

Here are the tool call specifications:

1. List Files and Directories:
Use this to see what files exist in a directory (defaults to current directory ".").
<tool_call name="list_dir">
  <path>.</path>
</tool_call>

2. Read File:
Use this to read the full contents of a file.
<tool_call name="read_file">
  <path>path/to/file.js</path>
</tool_call>

3. Write File (Create or Overwrite):
Use this to create a new file or completely overwrite an existing one with new content.
Wrap the content in CDATA to prevent XML syntax issues.
<tool_call name="write_file">
  <path>path/to/file.js</path>
  <content><![CDATA[
// file content here
]]></content>
</tool_call>

4. Make Edit (Search & Replace):
Use this to edit a specific block of code in an existing file.
The search block must match the existing file content EXACTLY, including indentation.
Wrap search and replace content in CDATA.
<tool_call name="make_edit">
  <path>path/to/file.js</path>
  <search><![CDATA[
old code to be replaced
]]></search>
  <replace><![CDATA[
new code to replace the old code
]]></replace>
</tool_call>

5. Search Grep:
Use this to search for text patterns or terms across all workspace files.
<tool_call name="search_grep">
  <query>functionName</query>
</tool_call>

6. Workspace Snapshot:
Use this to understand architecture, package scripts, dependencies, Git state, open files, and diagnostics.
<tool_call name="workspace_snapshot"></tool_call>

7. Git Status:
<tool_call name="git_status"></tool_call>

8. Git Diff:
<tool_call name="git_diff">
  <path>optional/file.js</path>
</tool_call>

9. Run Terminal Command:
Use only after explaining why the command is needed. Commands run in the workspace and require approval.
<tool_call name="run_command">
  <command>npm run lint</command>
  <reason>Validate the extension after edits</reason>
</tool_call>

10. Delete File:
<tool_call name="delete_file">
  <path>path/to/file.js</path>
</tool_call>

11. Move or Rename File:
<tool_call name="move_file">
  <from>old/path.js</from>
  <to>new/path.js</to>
</tool_call>

12. Format File:
<tool_call name="format_file">
  <path>path/to/file.js</path>
</tool_call>

13. Validate Workspace:
Runs available lint/test scripts from package.json when present.
<tool_call name="validate_workspace"></tool_call>

Workflow rules:
- First, list the files or search the workspace if you don't know the structure.
- Always verify your changes. If you create a file, you can verify it.
- After tools execute, you will receive a <tool_response> with the output. Use this output to decide your next steps or formulate your final reply.
- When you are finished with your task, output a clear summary of the changes made and explanation without any more tool calls.
- DO NOT invent tools other than the tools listed above.
- NEVER try to access files outside the workspace.
`;

const SYSTEM_PROMPT_CHAT = `You are Ontonim AI, an elite AI coding assistant.
You are running as a VS Code extension, directly interacting with the user via a chat panel.
Your goal is to answer coding questions, explain concepts, brainstorm architectures, and write helpful code snippets.
In this mode, you do NOT have access to workspace file modification tools. Your responses should be purely informative and conversational. Do not use tool calls (<tool_call>).`;

/**
 * Parses XML-like tool calls from the AI response string.
 * @param {string} text 
 * @returns {Array<{name: string, args: Object}>}
 */
function parseToolCalls(text) {
    const toolCalls = [];
    const toolCallRegex = /<tool_call\s+name="([^"]+)"\s*>([\s\S]*?)<\/tool_call>/g;
    let match;

    while ((match = toolCallRegex.exec(text)) !== null) {
        const name = match[1];
        const innerContent = match[2];
        const args = {};

        // Parse path
        const pathMatch = /<path>([\s\S]*?)<\/path>/.exec(innerContent);
        if (pathMatch) args.path = pathMatch[1].trim();

        const fromMatch = /<from>([\s\S]*?)<\/from>/.exec(innerContent);
        if (fromMatch) args.from = fromMatch[1].trim();

        const toMatch = /<to>([\s\S]*?)<\/to>/.exec(innerContent);
        if (toMatch) args.to = toMatch[1].trim();

        const commandMatch = /<command>([\s\S]*?)<\/command>/.exec(innerContent);
        if (commandMatch) args.command = commandMatch[1].trim();

        const reasonMatch = /<reason>([\s\S]*?)<\/reason>/.exec(innerContent);
        if (reasonMatch) args.reason = reasonMatch[1].trim();

        // Parse query
        const queryMatch = /<query>([\s\S]*?)<\/query>/.exec(innerContent);
        if (queryMatch) args.query = queryMatch[1].trim();

        // Parse content (check CDATA first, fallback to plain text)
        const contentCdataMatch = /<content>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/content>/.exec(innerContent);
        if (contentCdataMatch) {
            args.content = contentCdataMatch[1];
        } else {
            const contentMatch = /<content>([\s\S]*?)<\/content>/.exec(innerContent);
            if (contentMatch) args.content = contentMatch[1];
        }

        // Parse search (check CDATA first, fallback to plain text)
        const searchCdataMatch = /<search>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/search>/.exec(innerContent);
        if (searchCdataMatch) {
            args.search = searchCdataMatch[1];
        } else {
            const searchMatch = /<search>([\s\S]*?)<\/search>/.exec(innerContent);
            if (searchMatch) args.search = searchMatch[1];
        }

        // Parse replace (check CDATA first, fallback to plain text)
        const replaceCdataMatch = /<replace>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/replace>/.exec(innerContent);
        if (replaceCdataMatch) {
            args.replace = replaceCdataMatch[1];
        } else {
            const replaceMatch = /<replace>([\s\S]*?)<\/replace>/.exec(innerContent);
            if (replaceMatch) args.replace = replaceMatch[1];
        }

        toolCalls.push({ name, args });
    }

    return toolCalls;
}

/**
 * Call the selected LLM API with message history.
 * @param {string} apiProvider - 'openrouter', 'openai', 'betopia', or 'groq'
 * @param {string} apiKey 
 * @param {string} model 
 * @param {Array<Object>} messages 
 * @param {string} mode - 'agent' or 'chat'
 * @param {{signal?: AbortSignal}} options
 * @returns {Promise<string>} AI content response
 */
async function callLLM(apiProvider, apiKey, model, messages, mode = 'agent', options = {}) {
    if (!apiKey) {
        const providerName = getProviderName(apiProvider);
        throw new Error(`${providerName} API key is missing. Please set it in Ontonim AI settings.`);
    }

    const systemPrompt = mode === 'chat' ? SYSTEM_PROMPT_CHAT : SYSTEM_PROMPT;

    // Determine default model and endpoint details
    let defaultModel = "google/gemini-2.5-flash";
    let endpoint = "https://openrouter.ai/api/v1/chat/completions";
    let headers = {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
    };

    if (apiProvider === 'openai') {
        defaultModel = "gpt-4o";
        endpoint = "https://api.openai.com/v1/chat/completions";
    } else if (apiProvider === 'betopia') {
        defaultModel = "gpt-5.4-mini";
        endpoint = "https://api.betopia.ai/v1/chat/completions";
    } else if (apiProvider === 'groq') {
        defaultModel = "llama-3.3-70b-versatile";
        endpoint = "https://api.groq.com/openai/v1/chat/completions";
    } else {
        // OpenRouter specific headers
        headers["HTTP-Referer"] = "https://github.com/ontonim-ai/vscode-extension";
        headers["X-Title"] = "Ontonim AI Extension";
    }

    const payload = {
        model: model || defaultModel,
        messages: [
            { role: "system", content: systemPrompt },
            ...messages
        ],
        temperature: 0.2 // Lower temperature for more reliable coding tasks
    };

    if (apiProvider === 'betopia') {
        payload.max_completion_tokens = 4096;
    } else {
        payload.max_tokens = 4096;
    }

    try {
        let response = await fetch(endpoint, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(payload),
            signal: options.signal
        });

        if (response.status === 429) {
            const retryAfterMs = getRetryAfterMs(response);
            if (retryAfterMs > 0 && retryAfterMs <= 8000) {
                await sleep(retryAfterMs, options.signal);
                response = await fetch(endpoint, {
                    method: "POST",
                    headers: headers,
                    body: JSON.stringify(payload),
                    signal: options.signal
                });
            }
        }

        if (!response.ok) {
            const errBody = await response.text();
            const providerName = getProviderName(apiProvider);
            throw new Error(formatProviderError(providerName, response.status, errBody, response.headers));
        }

        const data = await response.json();
        const content = extractResponseContent(data);
        if (typeof content === 'string') {
            return content;
        }

        const providerName = getProviderName(apiProvider);
        throw new Error(`Unexpected ${providerName} response format: ${JSON.stringify(data)}`);
    } catch (error) {
        const providerName = getProviderName(apiProvider);
        console.error(`${providerName} API call failed:`, error);
        throw error;
    }
}

function getRetryAfterMs(response) {
    const retryAfter = response.headers.get('retry-after');
    if (!retryAfter) return 0;

    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000);
    }

    const retryDate = Date.parse(retryAfter);
    if (Number.isNaN(retryDate)) return 0;
    return Math.max(0, retryDate - Date.now());
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            reject(createAbortError());
            return;
        }

        const timer = setTimeout(resolve, ms);
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(createAbortError());
            }, { once: true });
        }
    });
}

function createAbortError() {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
}

function formatProviderError(providerName, status, errBody, headers) {
    const parsedMessage = extractErrorMessage(errBody);
    const retryAfter = headers.get('retry-after');

    if (status === 429) {
        const retryText = retryAfter ? ` Retry after: ${retryAfter}.` : '';
        return [
            `${providerName} returned 429 rate/quota limit.`,
            parsedMessage ? `Provider message: ${parsedMessage}` : '',
            `${retryText}This usually means the selected model has hit request/token limits, the API project has no remaining credit, billing is not enabled for API usage, or the provider account tier does not include that model. A ChatGPT/Groq subscription does not always equal API billing access.`,
            `Try a lower-cost model, wait for the limit window to reset, or check the provider dashboard for API credits and model access.`
        ].filter(Boolean).join('\n')
    }

    return `${providerName} API error: ${status}${parsedMessage ? ` - ${parsedMessage}` : ` - ${errBody}`}`;
}

function extractErrorMessage(errBody) {
    if (!errBody) return '';
    try {
        const parsed = JSON.parse(errBody);
        if (typeof parsed.error === 'string') return parsed.error;
        if (parsed.error && typeof parsed.error.message === 'string') return parsed.error.message;
        if (typeof parsed.message === 'string') return parsed.message;
        if (typeof parsed.detail === 'string') return parsed.detail;
    } catch {
        // Fall through to text body.
    }

    return errBody.length > 700 ? `${errBody.slice(0, 700)}...` : errBody;
}

function extractResponseContent(data) {
    if (!data || typeof data !== 'object') return null;
    if (typeof data.content === 'string') return data.content;
    if (typeof data.text === 'string') return data.text;
    if (typeof data.output_text === 'string') return data.output_text;

    const firstChoice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (firstChoice) {
        if (firstChoice.message && typeof firstChoice.message.content === 'string') {
            return firstChoice.message.content;
        }
        if (typeof firstChoice.text === 'string') {
            return firstChoice.text;
        }
        if (typeof firstChoice.content === 'string') {
            return firstChoice.content;
        }
    }

    return null;
}

function getProviderName(apiProvider) {
    if (apiProvider === 'openai') return 'OpenAI';
    if (apiProvider === 'betopia') return 'Betopia AI';
    if (apiProvider === 'groq') return 'Groq';
    return 'OpenRouter';
}

/**
 * Call OpenRouter API with message history (for backwards compatibility).
 */
async function callOpenRouter(apiKey, model, messages, mode = 'agent', options = {}) {
    return callLLM('openrouter', apiKey, model, messages, mode, options);
}

/**
 * Execute a single tool and return the string result.
 * @param {string} name 
 * @param {Object} args 
 * @returns {Promise<string>} Result output
 */
async function executeTool(name, args) {
    try {
        switch (name) {
            case 'list_dir': {
                const pathVal = args.path || '.';
                const files = await workspace.listFiles(pathVal);
                return `Files in workspace:\n${files.join('\n')}`;
            }
            case 'read_file': {
                if (!args.path) throw new Error("Missing 'path' parameter for read_file.");
                const content = await workspace.readFile(args.path);
                return `Content of ${args.path}:\n\`\`\`\n${content}\n\`\`\``;
            }
            case 'write_file': {
                if (!args.path) throw new Error("Missing 'path' parameter for write_file.");
                if (args.content === undefined) throw new Error("Missing 'content' parameter for write_file.");
                const status = await workspace.writeFile(args.path, args.content);
                return status;
            }
            case 'make_edit': {
                if (!args.path) throw new Error("Missing 'path' parameter for make_edit.");
                if (args.search === undefined) throw new Error("Missing 'search' parameter for make_edit.");
                if (args.replace === undefined) throw new Error("Missing 'replace' parameter for make_edit.");
                const status = await workspace.makeEdit(args.path, args.search, args.replace);
                return status;
            }
            case 'search_grep': {
                if (!args.query) throw new Error("Missing 'query' parameter for search_grep.");
                const results = await workspace.searchWorkspace(args.query);
                if (results.length === 0) {
                    return `No results found for search query: "${args.query}"`;
                }
                const formatted = results.map(r => `File: ${r.path}:${r.line} - "${r.text}"`).join('\n');
                return `Search results for "${args.query}":\n${formatted}`;
            }
            case 'workspace_snapshot': {
                const snapshot = await workspace.getProjectSnapshot();
                return `Workspace snapshot:\n${JSON.stringify(snapshot, null, 2)}`;
            }
            case 'git_status': {
                return `Git status:\n${await workspace.getGitStatus()}`;
            }
            case 'git_diff': {
                return `Git diff:\n${await workspace.getGitDiff(args.path || null)}`;
            }
            case 'run_command': {
                if (!args.command) throw new Error("Missing 'command' parameter for run_command.");
                const result = await workspace.execCommand(args.command);
                return [
                    `Command: ${result.command}`,
                    `Exit code: ${result.exitCode}`,
                    result.timedOut ? 'Timed out: true' : '',
                    result.stdout ? `STDOUT:\n${result.stdout}` : '',
                    result.stderr ? `STDERR:\n${result.stderr}` : ''
                ].filter(Boolean).join('\n');
            }
            case 'delete_file': {
                if (!args.path) throw new Error("Missing 'path' parameter for delete_file.");
                return workspace.deleteFile(args.path);
            }
            case 'move_file': {
                if (!args.from || !args.to) throw new Error("Missing 'from' or 'to' parameter for move_file.");
                return workspace.moveFile(args.from, args.to);
            }
            case 'format_file': {
                if (!args.path) throw new Error("Missing 'path' parameter for format_file.");
                return workspace.formatFile(args.path);
            }
            case 'validate_workspace': {
                return workspace.validateWorkspace();
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    } catch (err) {
        return `Error executing tool '${name}': ${err.message}`;
    }
}

module.exports = {
    callLLM,
    callOpenRouter,
    parseToolCalls,
    executeTool
};
