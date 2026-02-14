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
- A dedicated top row action is always visible: **Open latest trace** → opens `log/pipeline_traces/latest.json` from workspace root
- A dedicated top row action is always visible: **PUML** → builds Activity UML from the trace flow and opens PlantText with encoded diagram
- For steps with class `CallModelAction`, dedicated child actions are always visible:
  - **Open messages as MD** → opens `rendered_chat_messages` formatted as Markdown and appends `model_response`
  - **Copy messages + response** → copies `rendered_chat_messages` + `model_response` to clipboard

Commands:

- **Rendered Prompt Viewer: Trace Explorer (Refresh)**
- **Rendered Prompt Viewer: Trace Explorer (Open step delta)** *(used internally when clicking a step)*
- **Rendered Prompt Viewer: Trace Explorer (Open last trace)**
- **Rendered Prompt Viewer: Trace Explorer (Open PUML diagram)**

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

Use the title-bar button to open the latest trace from:

- workspace root → `log/pipeline_traces/latest.json`

Use the **PUML** top action to generate and open an Activity UML diagram:

- flow is inferred from `next_step_id` / `nextStepId` / similar fields (with sequence fallback)
- step labels include step name/id, action class, status, elapsed time, and step duration
- diagram source is sent as PlantUML URL encoding (`deflate` + PlantUML base64 alphabet) in `text=...`

### 5) Custom PUML server URL

You can change the destination server used by the **PUML** action:

- Setting: `renderedPromptViewer.pumlBaseUrl`
- Default: `https://www.planttext.com`
- The extension appends `?text=<encoded>` (or `&text=<encoded>` if query already exists)

How to set your own server in VS Code:

1. Open **Settings** (`Ctrl+,`)
2. Search for: `renderedPromptViewer.pumlBaseUrl`
3. Set it to your server URL, for example:
   - `https://puml.mycompany.local`
   - `https://puml.mycompany.local/render`

You can also set it directly in `.vscode/settings.json`:

```json
{
  "renderedPromptViewer.pumlBaseUrl": "https://puml.mycompany.local"
}
```

For each `CallModelAction` row you can use child actions:

- **Open messages as MD** (chat messages in Markdown + model response)
- **Copy messages + response** (chat messages + model response to clipboard)

### 4) Timing and slow actions

In **Trace Explorer**, each step can show:

- elapsed time since trace start
- step duration (`+...`)

The extension scans other `.json` / `.jsonl` trace files in the same folder as the active trace and builds duration statistics per action class (for example `CallModelAction` is evaluated separately from other actions).

If a step duration is statistically above the expected range for its class, it is marked as **SLOW** and shown with a red clock icon.

Notes:

- if there is not enough historical data in the folder, slow detection is conservative
- VS Code TreeView does not support coloring only part of a text label, so slow state is indicated by icon + `SLOW` marker

If you don’t see it:

- open Explorer sidebar (Ctrl+Shift+E)
- expand the **Trace Explorer** section
- make sure you have a trace JSON/JSONL file open

## Version

The extension version is defined in `package.json` (current: `0.0.14`) and is the source of truth used by `vsce package`.

## License

MIT — see `LICENSE`.
