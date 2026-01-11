import * as vscode from "vscode";

const CMD_OPEN = "renderedPromptViewer.open";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_OPEN, async (args?: { line: number }) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const doc = editor.document;
      const lineNo = typeof args?.line === "number" ? args.line : editor.selection.active.line;

      const lineText = doc.lineAt(lineNo).text;
      const extracted = tryExtractRenderedPrompt(lineText);
      if (!extracted) {
        vscode.window.showWarningMessage('No "rendered_prompt" found on this line.');
        return;
      }

      let value: string;
      try {
        value = JSON.parse(extracted.literal);
      } catch {
        vscode.window.showErrorMessage('Failed to decode the string (JSON.parse did not succeed).');
        return;
      }

      const outDoc = await vscode.workspace.openTextDocument({
        content: value,
        language: "markdown"
      });

      await vscode.window.showTextDocument(outDoc, { preview: false });
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: "json", scheme: "file" },
        { language: "jsonc", scheme: "file" },
        { pattern: "**/*.jsonl" }
      ],
      new RenderedPromptCodeLensProvider()
    )
  );
}

export function deactivate() {}

class RenderedPromptCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];

    for (let i = 0; i < document.lineCount; i++) {
      const t = document.lineAt(i).text;
      if (t.includes("\"rendered_prompt\"")) {
        const r = new vscode.Range(i, 0, i, Math.max(0, t.length));
        lenses.push(
          new vscode.CodeLens(r, {
            title: "Open rendered_prompt",
            command: CMD_OPEN,
            arguments: [{ line: i }]
          })
        );
      }
    }

    return lenses;
  }
}

function tryExtractRenderedPrompt(lineText: string): { literal: string } | null {
  const keyIdx = lineText.indexOf("\"rendered_prompt\"");
  if (keyIdx < 0) return null;

  const colonIdx = lineText.indexOf(":", keyIdx);
  if (colonIdx < 0) return null;

  let i = colonIdx + 1;
  while (i < lineText.length && /\s/.test(lineText[i])) i++;

  if (i >= lineText.length || lineText[i] !== "\"") return null;

  let j = i + 1;
  let escaped = false;

  while (j < lineText.length) {
    const ch = lineText[j];
    if (escaped) {
      escaped = false;
      j++;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      j++;
      continue;
    }
    if (ch === "\"") {
      const literal = lineText.substring(i, j + 1);
      return { literal };
    }
    j++;
  }

  return null;
}
