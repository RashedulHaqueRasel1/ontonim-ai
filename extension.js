const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const agent = require('./src/agent');
const workspace = require('./src/workspace');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('Ontonim AI Extension is now active!');

    const provider = new OntonimAIChatProvider(context);

    // Register Webview View
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(OntonimAIChatProvider.viewType, provider)
    );

    // Register Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('ontonim-ai.focusSidebar', () => {
            vscode.commands.executeCommand('workbench.view.extension.ontonim-ai-sidebar');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ontonim-ai.setApiKey', async () => {
            const providerSelection = await vscode.window.showQuickPick(
                [
                    { label: "OpenRouter", description: "Use models like Gemini, Claude, Llama, DeepSeek via OpenRouter", id: "openrouter" },
                    { label: "OpenAI (GPT)", description: "Use OpenAI models (GPT-4o, GPT-4o-mini, etc.) directly", id: "openai" },
                    { label: "Betopia AI", description: "Use Betopia AI models (gpt-5.4-mini, etc.) directly", id: "betopia" }
                ],
                { placeHolder: "Select API Provider" }
            );

            if (!providerSelection) return;

            let keyPrompt = "Enter your OpenRouter API Key";
            let keyPlaceholder = "sk-or-v1-...";
            let secretKey = 'openrouter_api_key';
            let defaultModel = 'google/gemini-2.5-flash';

            if (providerSelection.id === 'openai') {
                keyPrompt = "Enter your OpenAI API Key";
                keyPlaceholder = "sk-proj-...";
                secretKey = 'openai_api_key';
                defaultModel = 'gpt-4o';
            } else if (providerSelection.id === 'betopia') {
                keyPrompt = "Enter your Betopia API Key";
                keyPlaceholder = "Enter Betopia API Key";
                secretKey = 'betopia_api_key';
                defaultModel = 'gpt-5.4-mini';
            }

            const key = await vscode.window.showInputBox({
                prompt: keyPrompt,
                placeHolder: keyPlaceholder,
                password: true
            });

            if (key) {
                const trimmedKey = key.trim();
                if (providerSelection.id === 'openai' && trimmedKey.startsWith('sk-ant-')) {
                    vscode.window.showWarningMessage("Ontonim AI Warning: The key you entered starts with 'sk-ant-', which is typically an Anthropic Claude key. OpenAI keys usually start with 'sk-proj-'.");
                }
                await context.secrets.store(secretKey, trimmedKey);
                await context.globalState.update('api_provider', providerSelection.id);
                await context.globalState.update('selected_model', defaultModel);

                vscode.window.showInformationMessage(`Ontonim AI ${providerSelection.label} API Key saved successfully.`);
                provider.sendSettingsToWebview();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ontonim-ai.clearApiKey', async () => {
            const clearSelection = await vscode.window.showQuickPick(
                [
                    { label: "OpenRouter API Key", id: "openrouter" },
                    { label: "OpenAI API Key", id: "openai" },
                    { label: "Betopia API Key", id: "betopia" },
                    { label: "All API Keys", id: "all" }
                ],
                { placeHolder: "Select API Key to Clear" }
            );

            if (!clearSelection) return;

            if (clearSelection.id === 'openrouter' || clearSelection.id === 'all') {
                await context.secrets.delete('openrouter_api_key');
            }
            if (clearSelection.id === 'openai' || clearSelection.id === 'all') {
                await context.secrets.delete('openai_api_key');
            }
            if (clearSelection.id === 'betopia' || clearSelection.id === 'all') {
                await context.secrets.delete('betopia_api_key');
            }

            vscode.window.showInformationMessage(`Ontonim AI API Key(s) cleared.`);
            provider.sendSettingsToWebview();
        })
    );

    // Register Explain and Fix Command
    context.subscriptions.push(
        vscode.commands.registerCommand('ontonim-ai.explainAndFix', async (document, diagnostic) => {
            let doc = document;
            let diag = diagnostic;

            const editor = vscode.window.activeTextEditor;
            
            if (!doc || !diag) {
                if (!editor) {
                    vscode.window.showWarningMessage("Ontonim AI: No active editor open to fix errors.");
                    return;
                }
                doc = editor.document;
                const position = editor.selection.active;
                const line = position.line;
                
                const diagnostics = vscode.languages.getDiagnostics(doc.uri);
                diag = diagnostics.find(d => d.range.contains(position)) || 
                       diagnostics.find(d => d.range.start.line === line || d.range.end.line === line);
            }

            if (!diag) {
                vscode.window.showInformationMessage("Ontonim AI: No diagnostic errors found at current cursor position.");
                return;
            }

            // Bring the chatbot to focus
            await vscode.commands.executeCommand('ontonim-ai.chatView.focus');

            // Wait up to 1 second for webview to be initialized if it wasn't already
            let attempts = 0;
            while (!provider._view && attempts < 10) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }

            const filePath = vscode.workspace.asRelativePath(doc.uri);
            const lineText = doc.lineAt(diag.range.start.line).text.trim();

            const promptText = `I encountered the following error in my code:
File: \`${filePath}\` (Line ${diag.range.start.line + 1})
Error Message: \`${diag.message}\`
Code line with error:
\`\`\`
${lineText}
\`\`\`

Please explain this error and write a fix for it.`;

            if (provider._view) {
                provider._view.webview.postMessage({
                    command: 'addMessage',
                    sender: 'user',
                    text: `Explain and Fix Error: "${diag.message}" at line ${diag.range.start.line + 1} of ${filePath}`
                });
            }

            // Run user message handler in agent mode
            await provider.handleUserMessage(promptText, filePath, 'agent');
        })
    );

    // Register Code Actions Provider for Quick Fixes
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { scheme: 'file' },
            new OntonimCodeActionProvider(),
            {
                providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
            }
        )
    );

    // Monitor active editor to update the active file context
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            provider.sendActiveFileToWebview(editor);
        })
    );

    // Initial check for active file on startup
    provider.sendActiveFileToWebview(vscode.window.activeTextEditor);
}

class OntonimAIChatProvider {
    static viewType = 'ontonim-ai.chatView';
    _view;
    _context;
    _history = [];
    _pendingToolCalls = null;
    _pendingAiResponse = null;

    constructor(context) {
        this._context = context;
        this._modifiedFiles = new Set();
    }

    resolveWebviewView(webviewView, context, token) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from WebView
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.command) {
                case 'loadSettings':
                    await this.sendSettingsToWebview();
                    this.sendActiveFileToWebview(vscode.window.activeTextEditor);
                    this.sendModifiedFilesToWebview();
                    break;

                case 'saveSettings':
                    let updatedKeys = [];
                    if (data.openRouterKey && !data.openRouterKey.includes('•') && data.openRouterKey.trim() !== '') {
                        const trimmed = data.openRouterKey.trim();
                        await this._context.secrets.store('openrouter_api_key', trimmed);
                        updatedKeys.push("OpenRouter");
                    }
                    if (data.openAiKey && !data.openAiKey.includes('•') && data.openAiKey.trim() !== '') {
                        const trimmed = data.openAiKey.trim();
                        if (trimmed.startsWith('sk-ant-')) {
                            vscode.window.showWarningMessage("Ontonim AI Warning: The key you entered for OpenAI starts with 'sk-ant-', which is typically an Anthropic Claude key. OpenAI keys usually start with 'sk-proj-'.");
                        }
                        await this._context.secrets.store('openai_api_key', trimmed);
                        updatedKeys.push("OpenAI");
                    }
                    if (data.betopiaKey && !data.betopiaKey.includes('•') && data.betopiaKey.trim() !== '') {
                        const trimmed = data.betopiaKey.trim();
                        await this._context.secrets.store('betopia_api_key', trimmed);
                        updatedKeys.push("Betopia AI");
                    }
                    await this._context.globalState.update('api_provider', data.apiProvider);
                    await this._context.globalState.update('selected_model', data.model);
                    await this._context.globalState.update('auto_approve_readonly', data.autoApprove);
                    
                    if (updatedKeys.length > 0) {
                        vscode.window.showInformationMessage(`Ontonim AI: Saved settings and updated API Key for: ${updatedKeys.join(', ')}.`);
                    } else {
                        vscode.window.showInformationMessage("Ontonim AI: Configuration saved.");
                    }
                    await this.sendSettingsToWebview();
                    break;

                case 'clearHistory':
                    this._history = [];
                    this._pendingToolCalls = null;
                    this._pendingAiResponse = null;
                    this._modifiedFiles.clear();
                    this.sendModifiedFilesToWebview();
                    break;

                case 'sendMessage':
                    await this.handleUserMessage(data.text, data.activeFile, data.mode);
                    break;

                case 'insertCode':
                    try {
                        const editor = vscode.window.activeTextEditor;
                        if (editor) {
                            editor.edit(editBuilder => {
                                editBuilder.insert(editor.selection.active, data.text);
                            });
                        } else {
                            vscode.window.showWarningMessage("No active editor found to insert code.");
                        }
                    } catch (err) {
                        vscode.window.showErrorMessage("Failed to insert code: " + err.message);
                    }
                    break;

                case 'newUntitledFile':
                    try {
                        const doc = await vscode.workspace.openTextDocument({
                            content: data.text
                        });
                        await vscode.window.showTextDocument(doc);
                    } catch (err) {
                        vscode.window.showErrorMessage("Failed to create new file: " + err.message);
                    }
                    break;

                case 'openFile':
                    try {
                        const root = workspace.getWorkspaceRoot();
                        if (root) {
                            const fullPath = path.join(root, data.filePath);
                            const doc = await vscode.workspace.openTextDocument(fullPath);
                            await vscode.window.showTextDocument(doc, { preview: false });
                        }
                    } catch (err) {
                        vscode.window.showErrorMessage("Failed to open file: " + err.message);
                    }
                    break;

                case 'editPrompt':
                    await this.handleEditPrompt(data.index, data.text, data.activeFile);
                    break;

                case 'approveTools':
                    await this.handleToolApproval();
                    break;

                case 'rejectTools':
                    this.handleToolRejection();
                    break;
            }
        });
    }

    async getProviderConfig() {
        const apiProvider = this._context.globalState.get('api_provider') || 'openrouter';
        let providerKey = 'openrouter_api_key';
        let defaultModel = 'google/gemini-2.5-flash';
        let providerName = 'OpenRouter';

        if (apiProvider === 'openai') {
            providerKey = 'openai_api_key';
            defaultModel = 'gpt-4o';
            providerName = 'OpenAI';
        } else if (apiProvider === 'betopia') {
            providerKey = 'betopia_api_key';
            defaultModel = 'gpt-5.4-mini';
            providerName = 'Betopia AI';
        }

        const apiKey = await this._context.secrets.get(providerKey);
        const model = this._context.globalState.get('selected_model') || defaultModel;

        return { apiProvider, apiKey, model, providerName };
    }

    async sendSettingsToWebview() {
        if (!this._view) return;
        const apiProvider = this._context.globalState.get('api_provider') || 'openrouter';
        const openRouterKey = await this._context.secrets.get('openrouter_api_key');
        const openAiKey = await this._context.secrets.get('openai_api_key');
        const betopiaKey = await this._context.secrets.get('betopia_api_key');
        
        let defaultModel = 'google/gemini-2.5-flash';
        if (apiProvider === 'openai') defaultModel = 'gpt-4o';
        else if (apiProvider === 'betopia') defaultModel = 'gpt-5.4-mini';

        const model = this._context.globalState.get('selected_model') || defaultModel;
        const autoApprove = !!this._context.globalState.get('auto_approve_readonly');

        this._view.webview.postMessage({
            command: 'setSettings',
            apiProvider,
            openRouterKey: openRouterKey ? '••••••••••••••••••••' : '',
            openAiKey: openAiKey ? '••••••••••••••••••••' : '',
            betopiaKey: betopiaKey ? '••••••••••••••••••••' : '',
            model,
            autoApprove
        });
    }

    sendActiveFileToWebview(editor) {
        if (!this._view) return;

        if (editor) {
            const root = workspace.getWorkspaceRoot();
            if (root) {
                const filePath = editor.document.fileName;
                if (filePath.startsWith(root)) {
                    const relativePath = path.relative(root, filePath);
                    const fileName = path.basename(filePath);
                    this._view.webview.postMessage({
                        command: 'setActiveFile',
                        filePath: relativePath,
                        fileName: fileName
                    });
                    return;
                }
            }
        }

        this._view.webview.postMessage({
            command: 'setActiveFile',
            filePath: null,
            fileName: null
        });
    }

    async handleUserMessage(text, activeFile, mode = 'agent') {
        if (!this._view) return;

        this._currentMode = mode;

        const { apiProvider, apiKey, model, providerName } = await this.getProviderConfig();

        if (!apiKey) {
            this._view.webview.postMessage({
                command: 'addMessage',
                sender: 'assistant',
                text: `⚠️ **API Key Required**: Please configure your ${providerName} API Key in the settings panel (gear icon) before sending prompts.`
            });
            return;
        }

        // Prepare context-enhanced message content
        let fullUserMessage = text;
        if (activeFile && mode === 'agent') {
            try {
                const fileContent = await workspace.readFile(activeFile);
                fullUserMessage = `Context: User is currently working on \`${activeFile}\` with the following content:\n\`\`\`\n${fileContent}\n\`\`\`\n\nUser prompt: ${text}`;
            } catch (err) {
                // If it fails to read the active file, fall back to pure user message
            }
        }

        // Add user prompt to conversation history
        this._history.push({ role: 'user', content: fullUserMessage });

        // Run the agent loop
        await this.runAgentIteration(apiProvider, apiKey, model);
    }

    async runAgentIteration(apiProvider, apiKey, model, maxTurns = 8) {
        if (!this._view) return;

        let turn = 0;
        let continueLoop = true;

        this._view.webview.postMessage({ command: 'generationStarted' });

        while (continueLoop && turn < maxTurns) {
            turn++;
            try {
                // Call LLM
                const response = await agent.callLLM(apiProvider, apiKey, model, this._history, this._currentMode || 'agent');
                
                // Parse proposed tool calls
                const toolCalls = this._currentMode === 'chat' ? [] : agent.parseToolCalls(response);

                if (toolCalls.length === 0) {
                    // No tool calls: AI finished its response
                    this._history.push({ role: 'assistant', content: response });
                    
                    this._view.webview.postMessage({
                        command: 'addMessage',
                        sender: 'assistant',
                        text: response
                    });
                    
                    continueLoop = false;
                } else {
                    // AI proposed tool calls. Store them and request approval
                    this._pendingToolCalls = toolCalls;
                    this._pendingAiResponse = response;

                    const autoApproveEnabled = !!this._context.globalState.get('auto_approve_readonly');
                    const allReadOnly = toolCalls.every(t => ['list_dir', 'read_file', 'search_grep'].includes(t.name));

                    if (autoApproveEnabled && allReadOnly) {
                        // Auto-execute if user permitted and all calls are read-only
                        await this.handleToolApproval();
                        return; // Let handleToolApproval drive the next iteration
                    } else {
                        // Ask user for permission
                        this._view.webview.postMessage({
                            command: 'requireToolApproval',
                            toolCalls: toolCalls
                        });
                        continueLoop = false; // Pause and wait for WebView message
                    }
                }
            } catch (error) {
                this._view.webview.postMessage({
                    command: 'addMessage',
                    sender: 'assistant',
                    text: `❌ **Error during execution:** ${error.message}`
                });
                continueLoop = false;
            }
        }

        this._view.webview.postMessage({ command: 'generationFinished' });
    }

    async handleToolApproval() {
        if (!this._view || !this._pendingToolCalls) return;

        this._view.webview.postMessage({ command: 'generationStarted' });

        const toolCalls = this._pendingToolCalls;
        const aiResponse = this._pendingAiResponse;
        
        // Reset pending fields
        this._pendingToolCalls = null;
        this._pendingAiResponse = null;

        // Add assistant's tool-call response to history so conversation remains coherent
        this._history.push({ role: 'assistant', content: aiResponse });

        const results = [];

        for (let i = 0; i < toolCalls.length; i++) {
            const tool = toolCalls[i];
            
            // Notify WebView that tool is running
            this._view.webview.postMessage({
                command: 'toolProgress',
                index: i,
                status: 'running'
            });

            // Execute the tool call
            const resultText = await agent.executeTool(tool.name, tool.args);
            const isError = resultText.startsWith('Error executing tool');
            
            if (!isError && (tool.name === 'write_file' || tool.name === 'make_edit')) {
                this._modifiedFiles.add(tool.args.path);
            }

            // Notify WebView of result
            this._view.webview.postMessage({
                command: 'toolProgress',
                index: i,
                status: isError ? 'error' : 'success'
            });

            results.push(`<tool_response name="${tool.name}">\n${resultText}\n</tool_response>`);
        }

        this.sendModifiedFilesToWebview();

        // Add tool results as a single user message to feed back to the AI
        const toolResultsMessage = `Tool execution results:\n${results.join('\n')}`;
        this._history.push({ role: 'user', content: toolResultsMessage });

        // Query AI again with the results
        const { apiProvider, apiKey, model } = await this.getProviderConfig();
        
        await this.runAgentIteration(apiProvider, apiKey, model);
    }

    handleToolRejection() {
        this._pendingToolCalls = null;
        this._pendingAiResponse = null;
        
        this._history.push({ role: 'user', content: "Tool execution was cancelled by the user." });
        
        this._view.webview.postMessage({ command: 'generationFinished' });
    }

    async handleEditPrompt(userPromptIndex, text, activeFile) {
        if (!this._view) return;

        // Reset pending fields
        this._pendingToolCalls = null;
        this._pendingAiResponse = null;

        // Find the index in history corresponding to the N-th user prompt
        let userPromptCount = 0;
        let targetHistoryIndex = -1;

        for (let i = 0; i < this._history.length; i++) {
            const msg = this._history[i];
            if (msg.role === 'user' && !msg.content.startsWith('Tool execution results:')) {
                if (userPromptCount === userPromptIndex) {
                    targetHistoryIndex = i;
                    break;
                }
                userPromptCount++;
            }
        }

        if (targetHistoryIndex === -1) {
            await this.handleUserMessage(text, activeFile);
            return;
        }

        // Keep history only up to that prompt (discard everything after it)
        this._history = this._history.slice(0, targetHistoryIndex);

        // Re-construct context-enhanced message content
        let fullUserMessage = text;
        if (activeFile) {
            try {
                const fileContent = await workspace.readFile(activeFile);
                fullUserMessage = `Context: User is currently working on \`${activeFile}\` with the following content:\n\`\`\`\n${fileContent}\n\`\`\`\n\nUser prompt: ${text}`;
            } catch (err) {
                // If it fails to read the active file, fall back to pure user message
            }
        }

        // Replace/Add user prompt in conversation history
        this._history.push({ role: 'user', content: fullUserMessage });

        // Retrieve config and re-run agent loop
        const { apiProvider, apiKey, model } = await this.getProviderConfig();

        await this.runAgentIteration(apiProvider, apiKey, model);
    }

    sendModifiedFilesToWebview() {
        if (!this._view) return;
        this._view.webview.postMessage({
            command: 'setModifiedFiles',
            files: Array.from(this._modifiedFiles)
        });
    }

    _getHtmlForWebview(webview) {
        const htmlPath = path.join(this._context.extensionPath, 'src', 'webview', 'sidebar.html');
        return fs.readFileSync(htmlPath, 'utf8');
    }
}

class OntonimCodeActionProvider {
    provideCodeActions(document, range, context, token) {
        const diagnostics = context.diagnostics;
        if (!diagnostics || diagnostics.length === 0) {
            return [];
        }

        const actions = [];
        for (const diagnostic of diagnostics) {
            const action = new vscode.CodeAction(
                "Explain and Fix (Ontonim AI)",
                vscode.CodeActionKind.QuickFix
            );
            action.command = {
                command: 'ontonim-ai.explainAndFix',
                title: 'Explain and Fix with Ontonim AI',
                arguments: [document, diagnostic]
            };
            action.diagnostics = [diagnostic];
            action.isPreferred = true;
            actions.push(action);
        }
        return actions;
    }
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
