const vscode = require('vscode');
const crypto = require('crypto');
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
        vscode.commands.registerCommand('ontonim-ai', async () => {
            await provider.sendWorkspaceStateToWebview();
            vscode.window.showInformationMessage("Ontonim AI");
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ontonim-ai.setApiKey', async () => {
            const providerSelection = await vscode.window.showQuickPick(
                [
                    { label: "OpenRouter", description: "Use models like Gemini, Claude, Llama, DeepSeek via OpenRouter", id: "openrouter" },
                    { label: "OpenAI (GPT)", description: "Use OpenAI models (GPT-4o, GPT-4o-mini, etc.) directly", id: "openai" },
                    { label: "Betopia AI", description: "Use Betopia AI models (gpt-5.4-mini, etc.) directly", id: "betopia" },
                    { label: "Groq", description: "Use fast Groq-hosted OpenAI-compatible chat models", id: "groq" }
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
            } else if (providerSelection.id === 'groq') {
                keyPrompt = "Enter your Groq API Key";
                keyPlaceholder = "gsk_...";
                secretKey = 'groq_api_key';
                defaultModel = 'llama-3.3-70b-versatile';
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
                await provider.syncCredentialToBackend(providerSelection.id, defaultModel, trimmedKey);

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
                    { label: "Groq API Key", id: "groq" },
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
            if (clearSelection.id === 'groq' || clearSelection.id === 'all') {
                await context.secrets.delete('groq_api_key');
            }

            vscode.window.showInformationMessage(`Ontonim AI API Key(s) cleared.`);
            provider.sendSettingsToWebview();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ontonim-ai.logout', async () => {
            await provider.logout();
            vscode.window.showInformationMessage("Ontonim AI: Logged out.");
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
        this._abortController = null;
        this._cancelRequested = false;
        this._stopNoticeSent = false;
    }

    resolveWebviewView(webviewView, context, token) {
        void context;
        void token;
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
                    await this.sendAuthStateToWebview();
                    this.sendActiveFileToWebview(vscode.window.activeTextEditor);
                    this.sendModifiedFilesToWebview();
                    await this.sendWorkspaceStateToWebview();
                    break;

                case 'saveSettings':
                    let updatedKeys = [];
                    const changedKeys = {};
                    if (data.openRouterKey && !data.openRouterKey.includes('•') && data.openRouterKey.trim() !== '') {
                        const trimmed = data.openRouterKey.trim();
                        await this._context.secrets.store('openrouter_api_key', trimmed);
                        changedKeys.openrouter = trimmed;
                        updatedKeys.push("OpenRouter");
                    }
                    if (data.openAiKey && !data.openAiKey.includes('•') && data.openAiKey.trim() !== '') {
                        const trimmed = data.openAiKey.trim();
                        if (trimmed.startsWith('sk-ant-')) {
                            vscode.window.showWarningMessage("Ontonim AI Warning: The key you entered for OpenAI starts with 'sk-ant-', which is typically an Anthropic Claude key. OpenAI keys usually start with 'sk-proj-'.");
                        }
                        await this._context.secrets.store('openai_api_key', trimmed);
                        changedKeys.openai = trimmed;
                        updatedKeys.push("OpenAI");
                    }
                    if (data.betopiaKey && !data.betopiaKey.includes('•') && data.betopiaKey.trim() !== '') {
                        const trimmed = data.betopiaKey.trim();
                        await this._context.secrets.store('betopia_api_key', trimmed);
                        changedKeys.betopia = trimmed;
                        updatedKeys.push("Betopia AI");
                    }
                    if (data.groqKey && !data.groqKey.includes('•') && data.groqKey.trim() !== '') {
                        const trimmed = data.groqKey.trim();
                        await this._context.secrets.store('groq_api_key', trimmed);
                        changedKeys.groq = trimmed;
                        updatedKeys.push("Groq");
                    }
                    await this._context.globalState.update('api_provider', data.apiProvider);
                    await this._context.globalState.update('selected_model', data.model);
                    await this._context.globalState.update('auto_approve_readonly', data.autoApprove);
                    await this.syncCredentialToBackend(data.apiProvider, data.model, changedKeys[data.apiProvider]);
                    
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
                    await this._context.globalState.update('session_memory', []);
                    break;

                case 'sendMessage':
                    if (!(await this.ensureAuthenticated())) return;
                    await this.handleUserMessage(data.text, data.activeFile, data.mode);
                    break;

                case 'loginWithGoogle':
                    await this.loginWithGoogle();
                    break;

                case 'logout':
                    await this.logout();
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
                        const fullPath = workspace.getAbsolutePath(data.filePath);
                        if (fullPath) {
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

                case 'stopGeneration':
                    this.stopCurrentRun();
                    break;

                case 'refreshWorkspaceState':
                    await this.sendWorkspaceStateToWebview();
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
        } else if (apiProvider === 'groq') {
            providerKey = 'groq_api_key';
            defaultModel = 'llama-3.3-70b-versatile';
            providerName = 'Groq';
        }

        const apiKey = await this._context.secrets.get(providerKey);
        const model = this._context.globalState.get('selected_model') || defaultModel;

        return { apiProvider, apiKey, model, providerName };
    }

    getBackendUrl() {
        const configured = vscode.workspace.getConfiguration('ontonimAi').get('backendUrl') || 'http://localhost:3987';
        return String(configured).replace(/\/+$/, '');
    }

    async getAuthState() {
        const token = await this._context.secrets.get('ontonim_auth_token');
        const user = this._context.globalState.get('ontonim_auth_user') || null;
        return {
            isAuthenticated: !!(token && user),
            user
        };
    }

    async sendAuthStateToWebview(extra = {}) {
        if (!this._view) return;
        const auth = await this.getAuthState();
        this._view.webview.postMessage({
            command: 'setAuthState',
            ...auth,
            ...extra
        });
    }

    async ensureAuthenticated() {
        const auth = await this.getAuthState();
        if (auth.isAuthenticated) return true;

        if (this._view) {
            this._view.webview.postMessage({
                command: 'setAuthState',
                isAuthenticated: false,
                user: null,
                error: 'Please sign in with Google before using Ontonim AI.'
            });
        }
        return false;
    }

    async loginWithGoogle() {
        if (!this._view) return;

        const backendUrl = this.getBackendUrl();
        const state = crypto.randomUUID();

        try {
            this._view.webview.postMessage({
                command: 'authProgress',
                status: 'Opening Google sign-in...'
            });

            const urlResponse = await fetch(`${backendUrl}/auth/google/url?state=${encodeURIComponent(state)}`);
            if (!urlResponse.ok) {
                throw new Error(`Backend returned ${urlResponse.status}. Is the auth backend running at ${backendUrl}?`);
            }

            const { authUrl } = await urlResponse.json();
            if (!authUrl) {
                throw new Error('Backend did not return a Google auth URL.');
            }

            await vscode.env.openExternal(vscode.Uri.parse(authUrl));
            await this.pollAuthSession(backendUrl, state);
        } catch (err) {
            this._view.webview.postMessage({
                command: 'setAuthState',
                isAuthenticated: false,
                user: null,
                error: this.formatAuthError(err, backendUrl)
            });
        }
    }

    formatAuthError(err, backendUrl) {
        const message = err && err.message ? err.message : String(err);
        if (
            message === 'fetch failed' ||
            message.includes('ECONNREFUSED') ||
            message.includes('ENOTFOUND') ||
            message.includes('Failed to fetch')
        ) {
            return `Cannot connect to Ontonim AI backend at ${backendUrl}. Start it with "npm run backend:dev" and make sure ontonimAi.backendUrl matches this URL.`;
        }

        return message;
    }

    async pollAuthSession(backendUrl, state) {
        const startedAt = Date.now();
        const timeoutMs = 120000;

        while (Date.now() - startedAt < timeoutMs) {
            await new Promise(resolve => setTimeout(resolve, 1500));

            const response = await fetch(`${backendUrl}/auth/session/${encodeURIComponent(state)}`);
            if (response.status === 404) {
                continue;
            }
            if (!response.ok) {
                throw new Error(`Auth session check failed with ${response.status}.`);
            }

            const session = await response.json();
            if (session.status === 'complete' && session.token && session.user) {
                await this._context.secrets.store('ontonim_auth_token', session.token);
                await this._context.globalState.update('ontonim_auth_user', session.user);
                await this.sendAuthStateToWebview();
                const { apiProvider, apiKey, model } = await this.getProviderConfig();
                await this.syncCredentialToBackend(apiProvider, model, apiKey || '');
                vscode.window.showInformationMessage(`Ontonim AI: Signed in as ${session.user.email}.`);
                return;
            }

            this._view.webview.postMessage({
                command: 'authProgress',
                status: 'Waiting for Google sign-in...'
            });
        }

        throw new Error('Google sign-in timed out. Please try again.');
    }

    async logout() {
        await this._context.secrets.delete('ontonim_auth_token');
        await this._context.globalState.update('ontonim_auth_user', null);
        await this.sendAuthStateToWebview();
    }

    async postToBackend(pathName, body) {
        const token = await this._context.secrets.get('ontonim_auth_token');
        if (!token) return null;

        const response = await fetch(`${this.getBackendUrl()}${pathName}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Backend sync failed (${response.status}): ${text}`);
        }

        return response.json();
    }

    async syncCredentialToBackend(provider, model, apiKey = '') {
        try {
            const auth = await this.getAuthState();
            if (!auth.isAuthenticated) return;

            await this.postToBackend('/api/credentials', {
                provider,
                selectedModel: model,
                apiKey
            });
        } catch (err) {
            console.warn('Ontonim AI credential sync failed:', err.message);
        }
    }

    async syncPromptHistoryToBackend({ prompt, activeFile, mode, provider, model }) {
        try {
            const auth = await this.getAuthState();
            if (!auth.isAuthenticated) return;

            await this.postToBackend('/api/history', {
                prompt,
                activeFile: activeFile || '',
                mode: mode || 'agent',
                provider,
                model
            });
        } catch (err) {
            console.warn('Ontonim AI prompt history sync failed:', err.message);
        }
    }

    async sendSettingsToWebview() {
        if (!this._view) return;
        const apiProvider = this._context.globalState.get('api_provider') || 'openrouter';
        const openRouterKey = await this._context.secrets.get('openrouter_api_key');
        const openAiKey = await this._context.secrets.get('openai_api_key');
        const betopiaKey = await this._context.secrets.get('betopia_api_key');
        const groqKey = await this._context.secrets.get('groq_api_key');
        
        let defaultModel = 'google/gemini-2.5-flash';
        if (apiProvider === 'openai') defaultModel = 'gpt-4o';
        else if (apiProvider === 'betopia') defaultModel = 'gpt-5.4-mini';
        else if (apiProvider === 'groq') defaultModel = 'llama-3.3-70b-versatile';

        const model = this._context.globalState.get('selected_model') || defaultModel;
        const autoApprove = !!this._context.globalState.get('auto_approve_readonly');

        this._view.webview.postMessage({
            command: 'setSettings',
            apiProvider,
            openRouterKey: openRouterKey ? '••••••••••••••••••••' : '',
            openAiKey: openAiKey ? '••••••••••••••••••••' : '',
            betopiaKey: betopiaKey ? '••••••••••••••••••••' : '',
            groqKey: groqKey ? '••••••••••••••••••••' : '',
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
        this._cancelRequested = false;
        this._stopNoticeSent = false;

        const { apiProvider, apiKey, model, providerName } = await this.getProviderConfig();
        await this.syncPromptHistoryToBackend({
            prompt: text,
            activeFile,
            mode,
            provider: apiProvider,
            model
        });

        if (!apiKey) {
            this._view.webview.postMessage({
                command: 'addMessage',
                sender: 'assistant',
                text: `⚠️ **API Key Required**: Please configure your ${providerName} API Key in the settings panel (gear icon) before sending prompts.`
            });
            return;
        }

        const sessionMemory = this._context.globalState.get('session_memory') || [];
        const workspaceProfile = mode === 'agent' ? await this.getWorkspaceProfileText() : '';

        // Prepare context-enhanced message content
        let fullUserMessage = [
            workspaceProfile,
            sessionMemory.length ? `Session memory:\n${sessionMemory.map(item => `- ${item}`).join('\n')}` : '',
            `User prompt: ${text}`
        ].filter(Boolean).join('\n\n');

        if (activeFile && mode === 'agent') {
            try {
                const fileContent = await workspace.readFile(activeFile);
                fullUserMessage = `${workspaceProfile}\n\nSession memory:\n${sessionMemory.map(item => `- ${item}`).join('\n') || '- No prior memory yet.'}\n\nActive file: \`${activeFile}\`\n\`\`\`\n${fileContent}\n\`\`\`\n\nUser prompt: ${text}`;
            } catch {
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
            if (this._cancelRequested) {
                break;
            }

            turn++;
            try {
                // Call LLM
                this._abortController = new AbortController();
                const response = await agent.callLLM(apiProvider, apiKey, model, this._history, this._currentMode || 'agent', {
                    signal: this._abortController.signal
                });
                this._abortController = null;

                if (this._cancelRequested) {
                    break;
                }
                
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
                    const enhancedToolCalls = await this.enhanceToolCalls(toolCalls);
                    this._pendingToolCalls = enhancedToolCalls;
                    this._pendingAiResponse = response;

                    const autoApproveEnabled = !!this._context.globalState.get('auto_approve_readonly');
                    const allReadOnly = enhancedToolCalls.every(t => ['list_dir', 'read_file', 'search_grep', 'workspace_snapshot', 'git_status', 'git_diff'].includes(t.name));

                    if (autoApproveEnabled && allReadOnly) {
                        // Auto-execute if user permitted and all calls are read-only
                        await this.handleToolApproval();
                        return; // Let handleToolApproval drive the next iteration
                    } else {
                        // Ask user for permission
                        this._view.webview.postMessage({
                            command: 'requireToolApproval',
                            toolCalls: enhancedToolCalls,
                            plan: this.extractPlanSummary(response)
                        });
                        continueLoop = false; // Pause and wait for WebView message
                    }
                }
            } catch (error) {
                this._abortController = null;
                if (this._cancelRequested || error.name === 'AbortError') {
                    this._history.push({ role: 'user', content: "The current generation was stopped by the user." });
                    this.sendStopNotice();
                    continueLoop = false;
                    break;
                }

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
        this._cancelRequested = false;

        const toolCalls = this._pendingToolCalls;
        const aiResponse = this._pendingAiResponse;
        
        // Reset pending fields
        this._pendingToolCalls = null;
        this._pendingAiResponse = null;

        // Add assistant's tool-call response to history so conversation remains coherent
        this._history.push({ role: 'assistant', content: aiResponse });

        const results = [];

        for (let i = 0; i < toolCalls.length; i++) {
            if (this._cancelRequested) {
                results.push(`<tool_response name="stopped">\nTool execution was stopped by the user before remaining actions ran.\n</tool_response>`);
                break;
            }

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
            } else if (!isError && tool.name === 'move_file') {
                this._modifiedFiles.add(tool.args.to);
            } else if (!isError && tool.name === 'delete_file') {
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
        await this.rememberSessionFacts(toolCalls);
        await this.sendWorkspaceStateToWebview();

        // Add tool results as a single user message to feed back to the AI
        const toolResultsMessage = `Tool execution results:\n${results.join('\n')}`;
        this._history.push({ role: 'user', content: toolResultsMessage });

        if (this._cancelRequested) {
            this._view.webview.postMessage({ command: 'generationFinished' });
            return;
        }

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

    stopCurrentRun() {
        this._cancelRequested = true;
        this._pendingToolCalls = null;
        this._pendingAiResponse = null;

        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }

        this._history.push({ role: 'user', content: "The current generation was stopped by the user." });
        if (this._view) {
            this._view.webview.postMessage({ command: 'generationFinished' });
            this.sendStopNotice();
        }
    }

    sendStopNotice() {
        if (!this._view || this._stopNoticeSent) return;
        this._stopNoticeSent = true;
        this._view.webview.postMessage({
            command: 'addMessage',
            sender: 'assistant',
            text: 'Stopped. No further actions will run for that request.'
        });
    }

    async handleEditPrompt(userPromptIndex, text, activeFile) {
        if (!this._view) return;

        // Reset pending fields
        this._pendingToolCalls = null;
        this._pendingAiResponse = null;
        this._cancelRequested = false;
        this._stopNoticeSent = false;

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
            } catch {
                // If it fails to read the active file, fall back to pure user message
            }
        }

        // Replace/Add user prompt in conversation history
        this._history.push({ role: 'user', content: fullUserMessage });
        const { apiProvider, model } = await this.getProviderConfig();
        await this.syncPromptHistoryToBackend({
            prompt: text,
            activeFile,
            mode: 'agent',
            provider: apiProvider,
            model
        });

        // Retrieve config and re-run agent loop
        const { apiKey } = await this.getProviderConfig();

        await this.runAgentIteration(apiProvider, apiKey, model);
    }

    sendModifiedFilesToWebview() {
        if (!this._view) return;
        this._view.webview.postMessage({
            command: 'setModifiedFiles',
            files: Array.from(this._modifiedFiles)
        });
    }

    async getWorkspaceProfileText() {
        try {
            const snapshot = await workspace.getProjectSnapshot();
            const pkg = snapshot.packageInfo;
            return [
                'Workspace intelligence:',
                `- Project: ${snapshot.rootName}`,
                `- Files indexed: ${snapshot.fileCount}`,
                pkg ? `- Package: ${pkg.name || 'unnamed'}; scripts: ${Object.keys(pkg.scripts || {}).join(', ') || 'none'}` : '- Package: none detected',
                pkg ? `- Dependencies: ${(pkg.dependencies || []).slice(0, 12).join(', ') || 'none'}` : '',
                `- Open files: ${snapshot.openFiles.map(f => `${f.path}${f.dirty ? ' (dirty)' : ''}`).join(', ') || 'none'}`,
                `- Diagnostics: ${snapshot.diagnostics.length ? snapshot.diagnostics.map(d => `${d.severity} ${d.file}:${d.line} ${d.message}`).slice(0, 8).join(' | ') : 'none'}`,
                `- Git: ${snapshot.gitStatus.split('\n').slice(0, 8).join(' | ')}`
            ].filter(Boolean).join('\n');
        } catch (err) {
            return `Workspace intelligence unavailable: ${err.message}`;
        }
    }

    async sendWorkspaceStateToWebview() {
        if (!this._view) return;
        try {
            const snapshot = await workspace.getProjectSnapshot();
            this._view.webview.postMessage({
                command: 'setWorkspaceState',
                snapshot,
                memory: this._context.globalState.get('session_memory') || []
            });
        } catch (err) {
            this._view.webview.postMessage({
                command: 'setWorkspaceState',
                error: err.message,
                memory: this._context.globalState.get('session_memory') || []
            });
        }
    }

    async enhanceToolCalls(toolCalls) {
        const enhanced = [];
        for (const tool of toolCalls) {
            try {
                const preview = await workspace.previewTool(tool);
                enhanced.push({ ...tool, preview });
            } catch (err) {
                enhanced.push({
                    ...tool,
                    preview: {
                        risk: ['write_file', 'make_edit', 'delete_file', 'move_file', 'run_command'].includes(tool.name) ? 'write' : 'read',
                        affectedFiles: [],
                        summary: workspace.describeTool(tool),
                        diff: '',
                        warning: err.message
                    }
                });
            }
        }
        return enhanced;
    }

    extractPlanSummary(response) {
        const cleaned = response
            .replace(/<tool_call[\s\S]*?<\/tool_call>/g, '')
            .trim();
        return cleaned || 'Ontonim AI has prepared an execution plan and is requesting approval for the next actions.';
    }

    async rememberSessionFacts(toolCalls) {
        const memory = this._context.globalState.get('session_memory') || [];
        const changed = toolCalls
            .filter(t => ['write_file', 'make_edit', 'delete_file', 'move_file', 'run_command'].includes(t.name))
            .map(t => {
                if (t.name === 'move_file') return `Moved ${t.args.from} to ${t.args.to}`;
                if (t.name === 'run_command') return `Ran command: ${t.args.command}`;
                return `${t.name} on ${t.args.path}`;
            });

        if (changed.length === 0) return;
        const nextMemory = [...changed, ...memory].slice(0, 20);
        await this._context.globalState.update('session_memory', nextMemory);
    }

    _getHtmlForWebview() {
        const htmlPath = path.join(this._context.extensionPath, 'src', 'webview', 'sidebar.html');
        return fs.readFileSync(htmlPath, 'utf8');
    }
}

class OntonimCodeActionProvider {
    provideCodeActions(document, range, context, token) {
        void range;
        void token;
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
