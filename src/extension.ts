import * as vscode from "vscode";

const CMD_OPEN = "renderedPromptViewer.open";

type OpenArgs = { line: number; key: "rendered_prompt" | "rendered_chat_messages" };

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_OPEN, async (args?: Partial<OpenArgs>) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const doc = editor.document;
      const lineNo = typeof args?.line === "number" ? args.line : editor.selection.active.line;
      const key = (args?.key ?? "rendered_prompt") as OpenArgs["key"];

      const lineText = doc.lineAt(lineNo).text;
      const extracted = tryExtractJsonStringLiteralByKey(lineText, key);

      if (!extracted) {
        vscode.window.showWarningMessage(`No "${key}" found on this line.`);
        return;
      }

      let value: string;
      try {
        // 1) Decode the JSON string literal from the log line.
        value = JSON.parse(extracted.literal);
      } catch {
        vscode.window.showErrorMessage('Failed to decode the string (JSON.parse did not succeed).');
        return;
      }

      // rendered_prompt: value is the final prompt string
      if (key === "rendered_prompt") {
        const outDoc = await vscode.workspace.openTextDocument({
          content: value,
          language: "markdown",
        });
        await vscode.window.showTextDocument(outDoc, { preview: false });
        return;
      }

      // rendered_chat_messages: value is JSON string of messages array -> parse again
      try {
        const messages = JSON.parse(value);
        const md = formatChatMessagesAsMarkdown(messages);

        const outDoc = await vscode.workspace.openTextDocument({
          content: md,
          language: "markdown",
        });

        await vscode.window.showTextDocument(outDoc, { preview: false });
      } catch {
        vscode.window.showErrorMessage('Failed to parse rendered_chat_messages (expected a JSON array string).');
        return;
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: "json", scheme: "file" },
        { language: "jsonc", scheme: "file" },
        { pattern: "**/*.jsonl" },
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
            arguments: [{ line: i, key: "rendered_prompt" } satisfies OpenArgs],
          })
        );
      }

      if (t.includes("\"rendered_chat_messages\"")) {
        const r = new vscode.Range(i, 0, i, Math.max(0, t.length));
        lenses.push(
          new vscode.CodeLens(r, {
            title: "Open rendered_chat_messages",
            command: CMD_OPEN,
            arguments: [{ line: i, key: "rendered_chat_messages" } satisfies OpenArgs],
          })
        );
      }
    }

    return lenses;
  }
}

function tryExtractJsonStringLiteralByKey(
  lineText: string,
  key: "rendered_prompt" | "rendered_chat_messages"
): { literal: string } | null {
  const keyNeedle = `"${key}"`;
  const keyIdx = lineText.indexOf(keyNeedle);
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

function formatChatMessagesAsMarkdown(messages: any): string {
  if (!Array.isArray(messages)) {
    throw new Error("rendered_chat_messages is not an array");
  }

  const parts: string[] = [];
  parts.push("# rendered_chat_messages\n");

  for (let idx = 0; idx < messages.length; idx++) {
    const m = messages[idx];
    const role = typeof m?.role === "string" ? m.role : "unknown";
    const content = typeof m?.content === "string" ? m.content : "";

    parts.push(`## ${idx + 1}. ${role}\n`);
    parts.push("```text\n");
    parts.push(content);
    if (!content.endsWith("\n")) parts.push("\n");
    parts.push("```\n");
  }

  return parts.join("");
}
