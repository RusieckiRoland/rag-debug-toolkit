# RAG Debug Toolkit

This is a simple Visual Studio Code extension designed to help debug Retrieval-Augmented Generation (RAG) pipelines. It provides a minimal tool to quickly view and format RAG prompts directly in your editor.

## Features

- Adds a CodeLens action above lines containing `rendered_prompt` keys in JSON/JSONL files.
- Allows you to open the prompt in a new tab with proper formatting.

## Quick Start

   1. Clone the repository
   2. Run in terminal

```bash
   npm install
   npm run compile
   npx @vscode/vsce package
```

## Installation

1. Download the `.vsix`.
2. In VS Code, go to the Extensions view (Ctrl+Shift+X), click on the `...` menu, and choose "Install from VSIX...".
3. Select the downloaded file to install.

## Usage

Once installed, open any JSON or JSONL file that includes a `rendered_prompt` key. You will see an "Open rendered_prompt" link above the line. Click it to view the formatted prompt in a new tab.

## License

This project is licensed under the MIT License. See the LICENSE file for details.