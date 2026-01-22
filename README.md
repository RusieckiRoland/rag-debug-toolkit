# RAG Debug Toolkit

A small Visual Studio Code extension for inspecting and debugging Retrieval‑Augmented Generation (RAG) pipeline logs.  
It helps you quickly open large prompt payloads and generate readable trace views directly inside VS Code.

## Features

### CodeLens helpers (JSON / JSONC / JSONL)

Shows quick actions above log lines that contain:

- `rendered_prompt`
- `rendered_chat_messages`

Actions:

- **Open rendered_prompt** → opens the decoded prompt as **Markdown**
- **Open rendered_chat_messages** → opens the decoded chat messages as **Markdown** (formatted list)

### Trace views (commands)

- **Rendered Prompt Viewer: Show Trace (Delta)**  
  Shows full state only for START / END / ERROR steps, and only top‑level diffs between steps.

- **Rendered Prompt Viewer: Show Trace (Step info only)**  
  Shows only step metadata (no `state_*` payloads).

### Trace Explorer (Sidebar / TreeView)

A persistent sidebar view that lists pipeline steps from the currently open trace file.

- Shows step order, step id, action class, and small key metrics (e.g. `expanded`, `edges`, `node_texts`)
- Click a step → opens **Step delta** view for the selected step
- Works automatically with the active editor (switch log file → the list refreshes)

Commands:

- **Rendered Prompt Viewer: Trace Explorer (Refresh)**
- **Rendered Prompt Viewer: Trace Explorer (Open step delta)** *(used internally when clicking a step)*

## Quick Start

1. Clone the repository  
2. Build and package:

```bash
npm install
npm run compile
npx @vscode/vsce package
```

## Installation

1. Download the `.vsix`
2. In VS Code open Extensions (`Ctrl+Shift+X`)
3. Click the `...` menu → **Install from VSIX...**
4. Select the `.vsix` file

## Usage

### 1) Open rendered_prompt / rendered_chat_messages

Open any JSON / JSONL file that contains either `rendered_prompt` or `rendered_chat_messages`.  
You will see CodeLens actions above matching lines:

- **Open rendered_prompt**
- **Open rendered_chat_messages**

### 2) Trace views (commands)

Open the Command Palette (`Ctrl+Shift+P`) and run:

- **Rendered Prompt Viewer: Show Trace (Delta)**
- **Rendered Prompt Viewer: Show Trace (Step info only)**

Supported input formats:

- JSON file containing:
  - `{ "pipeline_trace_events": [...] }`
  - `{ "trace_events": [...] }`
  - `{ "events": [...] }`
- Raw JSON array: `[ {...}, {...} ]`
- JSONL: one JSON object per line

### 3) Trace Explorer (Sidebar)

Open the Explorer sidebar and look for **Trace Explorer**.  
It will automatically show steps for the **currently active** trace file.

If you don’t see it:

- open Explorer sidebar (Ctrl+Shift+E)
- expand the **Trace Explorer** section
- make sure you have a trace JSON/JSONL file open

## Version

The extension version is defined in `package.json` (e.g. `0.0.7`) and is the source of truth used by `vsce package`.

## License

MIT — see `LICENSE`.
