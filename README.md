<div align="center">
  <h1>🌌 Ontonim AI</h1>
  <p><strong>An Elite, Workspace-Aware Agentic Coding Assistant for Visual Studio Code</strong></p>
</div>

---

Ontonim AI is a next-generation AI coding assistant designed to empower developers by seamlessly integrating context-aware artificial intelligence directly into the Visual Studio Code editor. Powered by **OpenRouter**, it connects you to top-tier LLMs (Gemini, Claude, DeepSeek, Llama) to help you build, refactor, search, and troubleshoot your projects efficiently.

Unlike simple chat bots, Ontonim AI is **Agentic**. It doesn't just give you code snippets; it can independently explore your workspace, read files, search across directories, and apply precise multi-file edits directly into your project.

---

## ✨ Premium Features

### 🎨 Stunning User Interface & Themes
*   **Glassmorphism Design:** A highly polished, modern sidebar UI utilizing frosted glass effects (`backdrop-filter`) and VS Code's native syntax highlighting.
*   **Dynamic Custom Themes:** Personalize your chat environment via the Settings panel with 6 vibrant, dynamic themes:
    *   🟣 **Midnight Purple** (Default)
    *   🔵 **Ocean Blue**
    *   🟢 **Emerald Green**
    *   🔴 **Rose Red**
    *   🟡 **Amber Gold**
    *   ⚪ **Slate Gray**

### 🧠 Workspace-Aware Agent
*   **Active File Context:** Ontonim AI automatically detects the file you are actively editing and silently feeds it as context, making your queries precise and seamless.
*   **Autonomous Tools:** Proposes and executes operations (Read, Write, Edit, Grep, List) in your workspace using an XML-based Tool System.
*   **Safety Controls:** Review all file operations before they execute, or enable **Auto-approve read tools** for a frictionless workflow.

### ⚡ Smart Interactions & Productivity
*   **Quick Fix Integrations:** Built-in VS Code `CodeActionProvider`. Simply press `Ctrl + Shift + .` on any diagnostic error to trigger the **"Explain and Fix"** command.
*   **Intelligent History Panel:** A beautiful floating modal that tracks your prompt history. Includes automatic relative timestamps (e.g., `just now`, `2m ago`) and allows you to resubmit past prompts with a single click. Click outside to easily dismiss.
*   **Auto-Collapsing AI Responses:** Large, extensive outputs automatically collapse into a compact view to keep your chat interface incredibly clean and readable. 
*   **Prompt Editing & Copying:** One-click copy for any AI response and a quick edit button for tweaking and resubmitting your own user prompts.
*   **Quick Prompts & Follow-Ups:** One-click suggested follow-up chips generated dynamically based on the context of the AI's response.

---

## 🛠️ Installation & Setup

### Running the Extension Locally

1.  **Clone the Repository** and open it in VS Code.
2.  **Install dependencies**:
    ```bash
    npm install
    ```
3.  **Launch Extension**:
    *   Press `F5` (or go to `Run and Debug` -> select `Launch Extension`).
    *   This will open a new **Extension Development Host** window with Ontonim AI active.
4.  **Open the Sidebar**:
    *   Click on the **Ontonim AI** icon in the Activity Bar (left-hand sidebar) or use the command `Ontonim AI: Focus Chat Panel` via the Command Palette.

---

## ⚙️ Configuration

1.  Click the **Gear Icon (⚙️)** at the top right of the Ontonim AI sidebar.
2.  Paste your **OpenRouter API Key** *(keys are stored securely in VS Code's Secret Storage)*.
3.  Select your preferred **Chat Theme** to customize your experience.
4.  Toggle **Auto-approve read-only tools** if you prefer the agent to explore files without interrupting you for permissions.
5.  Click **Save Settings**.
6.  Use the **Header Dropdown** to seamlessly switch between top-tier AI models (e.g., Gemini 2.5 Pro, Claude 3.5 Sonnet).

---

## 🤖 Tool Ecosystem (Agentic Capabilities)

Ontonim AI understands the structure of your project by executing proposed tool calls. 

| Tool | Capability | Example Use Case |
| :--- | :--- | :--- |
| `list_dir` | Recursively list workspace files | *"What components are in my src directory?"* |
| `read_file` | Read exact contents of any file | *"Review the logic in auth.service.ts"* |
| `write_file` | Create a new file or rewrite an existing one | *"Create a new React component called UserCard"* |
| `make_edit` | Execute targeted search-and-replace | *"Rename the 'count' state variable to 'totalCount'"* |
| `search_grep` | Search text patterns globally | *"Find everywhere the DatabaseService is used"* |

---

<div align="center">
  <i>Enjoy a premium, hands-free coding experience with Ontonim AI!</i>
</div>
