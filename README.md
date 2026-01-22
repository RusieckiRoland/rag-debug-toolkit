# RAG Debug Toolkit

A small Visual Studio Code extension for inspecting and debugging Retrieval-Augmented Generation (RAG) pipeline logs.  
It helps you quickly open large prompt payloads and generate readable trace reports directly inside VS Code.

## Features

- **CodeLens helpers** for JSON / JSONC / JSONL logs:
  - `rendered_prompt`
  - `rendered_chat_messages`
- Opens extracted content in a new editor tab:
  - `rendered_prompt` → Markdown
  - `rendered_chat_messages` → Markdown (formatted list of messages)
- Trace report commands:
  - **Rendered Prompt Viewer: Show Trace (Delta)**  
    Shows full state only for START/END/ERROR steps, and only top-level diffs between steps.
  - **Rendered Prompt Viewer: Show Trace (Step info only)**  
    Shows only step metadata (no `state_*` payloads).

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

## Version

The extension version is defined in `package.json` (e.g. `0.0.5`) and is the source of truth used by `vsce package`.

## License

MIT — see `LICENSE`.
