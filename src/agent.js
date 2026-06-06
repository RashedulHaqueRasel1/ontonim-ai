const workspace = require('./workspace');

// System prompt to guide Ontonim AI in running workspace tasks.
const SYSTEM_PROMPT = `You are Ontonim AI, an elite AI coding assistant and agent.
You are running as a VS Code extension, directly interacting with the user's workspace.
Your goal is to help the user build, debug, refactor, and understand their code.

You have access to the user's workspace directory. You can read, write, edit, search, and list files.
To perform actions, you MUST use the following XML-based tool call formats. You can output multiple tool calls in a single turn if they can be run in parallel.
Always provide a brief, helpful message explaining what you are doing before outputting tool calls.

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

Workflow rules:
- First, list the files or search the workspace if you don't know the structure.
- Always verify your changes. If you create a file, you can verify it.
- After tools execute, you will receive a <tool_response> with the output. Use this output to decide your next steps or formulate your final reply.
- When you are finished with your task, output a clear summary of the changes made and explanation without any more tool calls.
- DO NOT invent tools other than the five listed above.
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
 * Call the selected LLM API (OpenRouter or OpenAI) with message history.
 * @param {string} apiProvider - 'openrouter' or 'openai'
 * @param {string} apiKey 
 * @param {string} model 
 * @param {Array<Object>} messages 
 * @param {string} mode - 'agent' or 'chat'
 * @returns {Promise<string>} AI content response
 */
async function callLLM(apiProvider, apiKey, model, messages, mode = 'agent') {
    if (!apiKey) {
        let providerName = 'OpenRouter';
        if (apiProvider === 'openai') providerName = 'OpenAI';
        else if (apiProvider === 'betopia') providerName = 'Betopia AI';
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
        endpoint = "https://platform-backend.betopia.ai/v1/chat/completions";
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
        const response = await fetch(endpoint, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errBody = await response.text();
            let providerName = 'OpenRouter';
            if (apiProvider === 'openai') providerName = 'OpenAI';
            else if (apiProvider === 'betopia') providerName = 'Betopia AI';
            throw new Error(`${providerName} API error: ${response.status} - ${errBody}`);
        }

        const data = await response.json();
        if (apiProvider === 'betopia') {
            if (data.content) {
                return data.content;
            } else {
                throw new Error(`Unexpected Betopia AI response format: ${JSON.stringify(data)}`);
            }
        } else {
            if (data.choices && data.choices[0] && data.choices[0].message) {
                return data.choices[0].message.content;
            } else {
                const providerName = apiProvider === 'openai' ? 'OpenAI' : 'OpenRouter';
                throw new Error(`Unexpected ${providerName} response format: ${JSON.stringify(data)}`);
            }
        }
    } catch (error) {
        let providerName = 'OpenRouter';
        if (apiProvider === 'openai') providerName = 'OpenAI';
        else if (apiProvider === 'betopia') providerName = 'Betopia AI';
        console.error(`${providerName} API call failed:`, error);
        throw error;
    }
}

/**
 * Call OpenRouter API with message history (for backwards compatibility).
 */
async function callOpenRouter(apiKey, model, messages, mode = 'agent') {
    return callLLM('openrouter', apiKey, model, messages, mode);
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
