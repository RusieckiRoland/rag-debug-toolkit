import * as vscode from "vscode";

const CMD_OPEN = "renderedPromptViewer.open";
const CMD_SHOW_DELTA = "renderedPromptViewer.showDelta";
const CMD_SHOW_STEP_INFO = "renderedPromptViewer.showStepInfo";

// Trace Explorer (Sidebar / TreeView)
const VIEW_TRACE_EXPLORER = "renderedPromptViewer.traceExplorerView";
const CMD_TRACE_REFRESH = "renderedPromptViewer.traceExplorer.refresh";
const CMD_TRACE_OPEN_STEP_DELTA = "renderedPromptViewer.traceExplorer.openStepDelta";
const CMD_TRACE_OPEN_LAST = "renderedPromptViewer.traceExplorer.openLastTrace";
const CMD_TRACE_OPEN_CALLMODEL_MD = "renderedPromptViewer.traceExplorer.openCallModelMessages";
const CMD_TRACE_COPY_CALLMODEL = "renderedPromptViewer.traceExplorer.copyCallModelPayload";

type OpenArgs = { line: number; key: "rendered_prompt" | "rendered_chat_messages" };
type TraceEvent = Record<string, any>;

export function activate(context: vscode.ExtensionContext) {
  // Open rendered_prompt / rendered_chat_messages
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
        // Decode the JSON string literal from the log line.
        value = JSON.parse(extracted.literal);
      } catch {
        vscode.window.showErrorMessage("Failed to decode the string (JSON.parse did not succeed).");
        return;
      }

      // rendered_prompt: value is the final prompt string
      if (key === "rendered_prompt") {
        const outDoc = await vscode.workspace.openTextDocument({
          content: value,
          language: "markdown"
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
          language: "markdown"
        });

        await vscode.window.showTextDocument(outDoc, { preview: false });
      } catch {
        vscode.window.showErrorMessage("Failed to parse rendered_chat_messages (expected a JSON array string).");
        return;
      }
    })
  );

  // Delta view (whole trace)
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_SHOW_DELTA, async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const doc = editor.document;
      const events = parseTraceEventsFromActiveDocument(doc);
      if (!events.length) {
        vscode.window.showWarningMessage("No trace events found in the active document.");
        return;
      }

      const md = formatDeltaViewAsMarkdown(events);
      const outDoc = await vscode.workspace.openTextDocument({
        content: md,
        language: "markdown"
      });

      await vscode.window.showTextDocument(outDoc, { preview: false });
    })
  );

  // Step info only view (whole trace, no state)
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_SHOW_STEP_INFO, async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const doc = editor.document;
      const events = parseTraceEventsFromActiveDocument(doc);
      if (!events.length) {
        vscode.window.showWarningMessage("No trace events found in the active document.");
        return;
      }

      const md = formatStepInfoOnlyAsMarkdown(events);
      const outDoc = await vscode.workspace.openTextDocument({
        content: md,
        language: "markdown"
      });

      await vscode.window.showTextDocument(outDoc, { preview: false });
    })
  );

  // Trace Explorer: TreeView in sidebar
  const traceExplorerProvider = new TraceExplorerProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider(VIEW_TRACE_EXPLORER, traceExplorerProvider));

  // Command: refresh trace explorer
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_TRACE_REFRESH, async () => {
      traceExplorerProvider.refresh();
    })
  );

  // Command: open delta for selected step
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_TRACE_OPEN_STEP_DELTA, async (args?: { stepIndex?: number }) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor.");
        return;
      }

      const doc = editor.document;
      const events = parseTraceEventsFromActiveDocument(doc);
      if (!events.length) {
        vscode.window.showWarningMessage("No trace events found in the active document.");
        return;
      }

      const idx = typeof args?.stepIndex === "number" ? args.stepIndex : -1;
      if (idx < 0 || idx >= events.length) {
        vscode.window.showWarningMessage("Invalid step index.");
        return;
      }

      const md = formatSingleStepDeltaAsMarkdown(events, idx);

      const outDoc = await vscode.workspace.openTextDocument({
        content: md,
        language: "markdown"
      });

      await vscode.window.showTextDocument(outDoc, { preview: false });
    })
  );

  // Command: open "<workspace_root>/log/pipeline_traces/latest.json"
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_TRACE_OPEN_LAST, async () => {
      const latestTraceUri = resolveLatestTracePath();
      if (!latestTraceUri) {
        vscode.window.showErrorMessage("Workspace root not found.");
        return;
      }

      if (!(await fileExists(latestTraceUri))) {
        vscode.window.showErrorMessage(`File not found: ${latestTraceUri.fsPath}`);
        return;
      }

      const outDoc = await vscode.workspace.openTextDocument(latestTraceUri);
      await vscode.window.showTextDocument(outDoc, { preview: false });
    })
  );

  // Command: for CallModelAction node - open rendered_chat_messages (+ model_response) as markdown
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_TRACE_OPEN_CALLMODEL_MD, async (args?: { stepIndex?: number }) => {
      const stepIndex = typeof args?.stepIndex === "number" ? args.stepIndex : -1;
      if (stepIndex < 0) return;

      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const events = parseTraceEventsFromActiveDocument(editor.document);
      if (!events.length || stepIndex >= events.length) return;

      const payload = extractCallModelPayload(events[stepIndex]);
      if (!payload.renderedChatMessages) {
        vscode.window.showWarningMessage("rendered_chat_messages not found for this CallModelAction step.");
        return;
      }

      const md = formatCallModelPayloadAsMarkdown(payload.renderedChatMessages, payload.modelResponse);
      const outDoc = await vscode.workspace.openTextDocument({
        content: md,
        language: "markdown"
      });
      await vscode.window.showTextDocument(outDoc, { preview: false });
    })
  );

  // Command: for CallModelAction node - copy rendered_chat_messages (+ model_response) to clipboard
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_TRACE_COPY_CALLMODEL, async (args?: { stepIndex?: number }) => {
      const stepIndex = typeof args?.stepIndex === "number" ? args.stepIndex : -1;
      if (stepIndex < 0) return;

      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const events = parseTraceEventsFromActiveDocument(editor.document);
      if (!events.length || stepIndex >= events.length) return;

      const payload = extractCallModelPayload(events[stepIndex]);
      if (!payload.renderedChatMessages) {
        vscode.window.showWarningMessage("rendered_chat_messages not found for this CallModelAction step.");
        return;
      }

      const text = formatCallModelPayloadForClipboard(payload.renderedChatMessages, payload.modelResponse);
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage("Copied rendered_chat_messages + model_response to clipboard.");
    })
  );

  // Auto-refresh trace explorer when active editor changes or document changes
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => traceExplorerProvider.refresh()));

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const active = vscode.window.activeTextEditor?.document;
      if (!active) return;
      if (e.document.uri.toString() !== active.uri.toString()) return;
      traceExplorerProvider.refresh();
    })
  );

  // CodeLens for rendered_prompt / rendered_chat_messages
  // Also enabled for generated markdown reports (untitled markdown tabs).
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: "json", scheme: "file" },
        { language: "jsonc", scheme: "file" },
        { pattern: "**/*.jsonl" },
        { language: "markdown", scheme: "untitled" },
        { language: "markdown", scheme: "file" }
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
            arguments: [{ line: i, key: "rendered_prompt" } satisfies OpenArgs]
          })
        );
      }

      if (t.includes("\"rendered_chat_messages\"")) {
        const r = new vscode.Range(i, 0, i, Math.max(0, t.length));
        lenses.push(
          new vscode.CodeLens(r, {
            title: "Open rendered_chat_messages",
            command: CMD_OPEN,
            arguments: [{ line: i, key: "rendered_chat_messages" } satisfies OpenArgs]
          })
        );
      }
    }

    return lenses;
  }
}

class TraceStepItem extends vscode.TreeItem {
  readonly kind: "openLatest" | "step" | "callModelOpenMd" | "callModelCopy";
  readonly stepIndex?: number;
  readonly isCallModelAction?: boolean;

  constructor(args: {
    kind: "openLatest" | "step" | "callModelOpenMd" | "callModelCopy";
    label: string;
    stepIndex?: number;
    isCallModelAction?: boolean;
    description?: string;
    tooltip?: string;
  }) {
    const collapsible =
      args.kind === "step" && args.isCallModelAction
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None;

    super(args.label, collapsible);
    this.kind = args.kind;
    this.stepIndex = args.stepIndex;
    this.isCallModelAction = args.isCallModelAction;
    this.description = args.description;
    this.tooltip = args.tooltip;

    if (args.kind === "openLatest") {
      this.iconPath = new vscode.ThemeIcon("folder-opened");
      this.command = { command: CMD_TRACE_OPEN_LAST, title: "Open latest trace" };
      return;
    }

    if (args.kind === "step" && typeof args.stepIndex === "number") {
      this.iconPath = new vscode.ThemeIcon("check");
      this.command = {
        command: CMD_TRACE_OPEN_STEP_DELTA,
        title: "Open Step Delta",
        arguments: [{ stepIndex: args.stepIndex }]
      };
      return;
    }

    if (args.kind === "callModelOpenMd" && typeof args.stepIndex === "number") {
      this.iconPath = new vscode.ThemeIcon("book");
      this.command = {
        command: CMD_TRACE_OPEN_CALLMODEL_MD,
        title: "Open messages as markdown",
        arguments: [{ stepIndex: args.stepIndex }]
      };
      return;
    }

    if (args.kind === "callModelCopy" && typeof args.stepIndex === "number") {
      this.iconPath = new vscode.ThemeIcon("copy");
      this.command = {
        command: CMD_TRACE_COPY_CALLMODEL,
        title: "Copy messages and response",
        arguments: [{ stepIndex: args.stepIndex }]
      };
      return;
    }
  }
}

class TraceExplorerProvider implements vscode.TreeDataProvider<TraceStepItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TraceStepItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TraceStepItem | undefined | null | void> = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TraceStepItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TraceStepItem): Thenable<TraceStepItem[]> {
    if (element) {
      if (element.kind === "step" && element.isCallModelAction && typeof element.stepIndex === "number") {
        return Promise.resolve([
          new TraceStepItem({
            kind: "callModelOpenMd",
            label: "Open messages as MD",
            stepIndex: element.stepIndex
          }),
          new TraceStepItem({
            kind: "callModelCopy",
            label: "Copy messages + response",
            stepIndex: element.stepIndex
          })
        ]);
      }
      return Promise.resolve([]);
    }

    const out: TraceStepItem[] = [
      new TraceStepItem({
        kind: "openLatest",
        label: "Open latest trace",
        description: "log/pipeline_traces/latest.json"
      })
    ];

    const editor = vscode.window.activeTextEditor;
    if (!editor) return Promise.resolve(out);

    const doc = editor.document;
    const events = parseTraceEventsFromActiveDocument(doc);
    if (!events.length) return Promise.resolve(out);

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];

      const stepId = asNonEmptyString(ev?.step?.id) ?? asNonEmptyString(ev.step_id) ?? "";
      const cls = asNonEmptyString(ev?.action?.class) ?? asNonEmptyString(ev.action_name) ?? "";

      const title = `${i + 1}. ${stepId || "step"}${cls ? ` (${cls})` : ""}`;
      const isCallModelAction = cls.toLowerCase() === "callmodelaction";

      const err = isErrorEvent(ev);
      const desc = err ? "ERROR" : "ok";

      // small info line if present
      const outObj = ev?.out ?? null;
      let extra = "";
      if (outObj && typeof outObj === "object") {
        if (typeof outObj.node_texts_count === "number") extra = `node_texts=${outObj.node_texts_count}`;
        if (typeof outObj.expanded_count === "number") extra = `expanded=${outObj.expanded_count}`;
        if (typeof outObj.edges_count === "number") {
          extra = extra ? `${extra}, edges=${outObj.edges_count}` : `edges=${outObj.edges_count}`;
        }
      }

      const description = extra ? `${desc} | ${extra}` : desc;
      const tooltip = JSON.stringify(stripStateFields(ev), null, 2);

      const item = new TraceStepItem({
        kind: "step",
        label: title,
        stepIndex: i,
        isCallModelAction,
        description,
        tooltip
      });
      item.iconPath = err ? new vscode.ThemeIcon("error") : new vscode.ThemeIcon("check");

      out.push(item);
    }

    return Promise.resolve(out);
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

/**
 * ===== TRACE VIEWS (Delta / Step info only) =====
 *
 * Supported inputs:
 * - JSON file containing { pipeline_trace_events: [...] } OR { trace_events: [...] } OR { events: [...] }
 * - Raw JSON array of events
 * - JSONL where each line is a JSON object event
 */
function parseTraceEventsFromActiveDocument(doc: vscode.TextDocument): TraceEvent[] {
  const text = doc.getText().trim();
  if (!text) return [];

  // 1) Whole JSON document mode
  try {
    const parsed = JSON.parse(text);

    // A) { pipeline_trace_events: [...] } / { trace_events: [...] } / { events: [...] }
    if (parsed && typeof parsed === "object") {
      const candidates = [(parsed as any).pipeline_trace_events, (parsed as any).trace_events, (parsed as any).events];

      for (const c of candidates) {
        if (Array.isArray(c)) return c as TraceEvent[];
      }
    }

    // B) raw array
    if (Array.isArray(parsed)) return parsed as TraceEvent[];
  } catch {
    // ignore, fallback to JSONL
  }

  // 2) JSONL mode
  const lines = text.split(/\r?\n/);
  const out: TraceEvent[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === "object") out.push(o as TraceEvent);
    } catch {
      // ignore invalid lines
    }
  }

  return out;
}

function formatDeltaViewAsMarkdown(events: TraceEvent[]): string {
  const parts: string[] = [];
  parts.push("# Trace (Delta view)\n");
  parts.push(
    "- Full state is shown only for: **START**, **END**, and **ERROR steps**.\n" +
      "- Between steps, only **changed top-level fields** are displayed.\n"
  );

  const first = events[0];
  const last = events[events.length - 1];

  const firstBefore = getStateBefore(first);
  const firstAfter = getStateAfter(first);

  // START snapshot: prefer state_before if present, otherwise state_after
  parts.push("## START (full state)\n");
  parts.push("```json\n");
  parts.push(JSON.stringify(firstBefore ?? firstAfter ?? null, null, 2));
  parts.push("\n```\n");

  // walk steps
  let prevState = firstBefore ?? firstAfter ?? null;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const stepTitle = formatStepTitle(ev, i);

    const currAfter = getStateAfter(ev);
    const isErr = isErrorEvent(ev);

    parts.push(`## ${stepTitle}\n`);

    // Compact step header (ts, next_step_id, etc.)
    parts.push(formatStepHeaderAsMarkdown(ev));

    if (isErr) {
      parts.push("\n### ERROR: full state\n");
      parts.push("```json\n");
      parts.push(JSON.stringify(currAfter ?? null, null, 2));
      parts.push("\n```\n");
      prevState = currAfter ?? prevState;
      continue;
    }

    if (currAfter == null || prevState == null) {
      parts.push("\n### Changed fields\n");
      parts.push("_No state available for diff._\n");
      prevState = currAfter ?? prevState;
      continue;
    }

    const delta = diffTopLevel(prevState, currAfter);

    parts.push("\n### Changed fields\n");
    if (Object.keys(delta).length === 0) {
      parts.push("_No changes._\n");
    } else {
      parts.push("```json\n");
      parts.push(JSON.stringify(delta, null, 2));
      parts.push("\n```\n");
    }

    prevState = currAfter;
  }

  // END snapshot
  const endAfter = getStateAfter(last);
  parts.push("## END (full state)\n");
  parts.push("```json\n");
  parts.push(JSON.stringify(endAfter ?? null, null, 2));
  parts.push("\n```\n");

  return parts.join("");
}

function formatSingleStepDeltaAsMarkdown(events: TraceEvent[], stepIndex: number): string {
  const ev = events[stepIndex];

  // Determine prevState:
  // - prefer ev.state_before if present
  // - otherwise use previous step's state_after
  const before = getStateBefore(ev) ?? (stepIndex > 0 ? getStateAfter(events[stepIndex - 1]) : null);
  const after = getStateAfter(ev);

  const parts: string[] = [];
  parts.push(`# Trace (Step delta)\n\n`);
  parts.push(`## ${formatStepTitle(ev, stepIndex)}\n`);
  parts.push(formatStepHeaderAsMarkdown(ev));

  parts.push(`\n### Step info (without state)\n`);
  parts.push("```json\n");
  parts.push(JSON.stringify(stripStateFields(ev), null, 2));
  parts.push("\n```\n");

  parts.push(`\n### Changed fields\n`);
  if (!before || !after) {
    parts.push("_No state available for delta._\n");
    return parts.join("");
  }

  const delta = diffTopLevel(before, after);
  if (Object.keys(delta).length === 0) {
    parts.push("_No changes._\n");
    return parts.join("");
  }

  parts.push("```json\n");
  parts.push(JSON.stringify(delta, null, 2));
  parts.push("\n```\n");

  return parts.join("");
}

function formatStepInfoOnlyAsMarkdown(events: TraceEvent[]): string {
  const parts: string[] = [];
  parts.push("# Trace (Step info only)\n");
  parts.push("- This view omits `state_*` fields and shows only step metadata.\n\n");

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const stepTitle = formatStepTitle(ev, i);
    parts.push(`## ${stepTitle}\n`);

    const info = stripStateFields(ev);

    parts.push("```json\n");
    parts.push(JSON.stringify(info, null, 2));
    parts.push("\n```\n");
  }

  return parts.join("");
}

/**
 * Produces: "1. Id: <stepId>, class: <className>"
 */
function formatStepTitle(ev: TraceEvent, index: number): string {
  const structuredId = asNonEmptyString(ev?.step?.id) ?? "";
  const structuredClass = asNonEmptyString(ev?.action?.class) ?? "";

  const explicitId =
    asNonEmptyString(ev.step_id) ?? asNonEmptyString(ev.stepId) ?? asNonEmptyString(ev.action_step_id) ?? "";

  const explicitClass =
    asNonEmptyString(ev.action_name) ?? asNonEmptyString(ev.actionName) ?? asNonEmptyString(ev.action) ?? asNonEmptyString(ev.type) ?? "";

  let inferred = "";
  const st = getStateAfter(ev);
  const trace = Array.isArray(st?.step_trace) ? st.step_trace : null;
  if (trace && trace.length > 0) {
    inferred = asNonEmptyString(trace[trace.length - 1]) ?? "";
  }

  const id = structuredId || explicitId || inferred || "step";
  const cls = structuredClass || explicitClass || inferred || "unknown";

  const prefix = `${index + 1}.`;
  return `${prefix} Id: ${id}, class: ${cls}`;
}

function formatStepHeaderAsMarkdown(ev: TraceEvent): string {
  const items: Record<string, any> = {};

  const ts =
    asNonEmptyString(ev.ts_utc) ??
    asNonEmptyString(ev.ts) ??
    asNonEmptyString(ev.timestamp) ??
    asNonEmptyString(ev.time) ??
    null;

  if (ts) items.ts_utc = ts;

  const durationMs =
    typeof ev.duration_ms === "number" ? ev.duration_ms : typeof ev.durationMs === "number" ? ev.durationMs : null;

  if (durationMs != null) items.duration_ms = durationMs;

  const level = asNonEmptyString(ev.level) ?? null;
  if (level) items.level = level;

  const next =
    asNonEmptyString(ev.out?.next_step_id) ??
    asNonEmptyString(ev.step?.next_resolved) ??
    asNonEmptyString(ev.next_step_id) ??
    asNonEmptyString(ev.nextStepId) ??
    asNonEmptyString(ev.next) ??
    null;

  if (next) items.next_step_id = next;

  const note =
    asNonEmptyString(ev.message) ??
    asNonEmptyString(ev.note) ??
    asNonEmptyString(ev.summary) ??
    null;

  if (note) items.message = truncate(note, 500);

  if (Object.keys(items).length === 0) {
    return "_(no step header info)_\n";
  }

  return "```json\n" + JSON.stringify(items, null, 2) + "\n```\n";
}

function getStateBefore(ev: TraceEvent): any | null {
  return ev.state_before ?? ev.stateBefore ?? ev.pipeline_state_before ?? ev.pipelineStateBefore ?? null;
}

function getStateAfter(ev: TraceEvent): any | null {
  return ev.state_after ?? ev.stateAfter ?? ev.pipeline_state_after ?? ev.pipelineStateAfter ?? ev.state ?? null;
}

function isErrorEvent(ev: TraceEvent): boolean {
  const level = asNonEmptyString(ev.level);
  if (level && level.toUpperCase() === "ERROR") return true;

  if (ev.exception != null) return true;
  if (ev.error != null && ev.error !== null) return true;
  if (ev.has_error === true) return true;
  if (ev.success === false) return true;

  const ex = asNonEmptyString(ev.exception_message) ?? asNonEmptyString(ev.exceptionMessage);
  if (ex) return true;

  return false;
}

function stripStateFields(ev: TraceEvent): TraceEvent {
  const out: TraceEvent = {};
  for (const k of Object.keys(ev)) {
    if (k === "state_before" || k === "state_after") continue;
    if (k === "stateBefore" || k === "stateAfter") continue;
    if (k === "pipeline_state_before" || k === "pipeline_state_after") continue;
    if (k === "pipelineStateBefore" || k === "pipelineStateAfter") continue;
    if (k === "state") continue;
    out[k] = ev[k];
  }
  return out;
}

function diffTopLevel(prevState: any, nextState: any): Record<string, { from: any; to: any }> {
  const out: Record<string, { from: any; to: any }> = {};

  if (!prevState || !nextState || typeof prevState !== "object" || typeof nextState !== "object") {
    return out;
  }

  const keys = new Set<string>([...Object.keys(prevState), ...Object.keys(nextState)]);

  for (const k of keys) {
    const a = (prevState as any)[k];
    const b = (nextState as any)[k];

    if (!deepEqual(a, b)) {
      out[k] = { from: summarizeValue(a), to: summarizeValue(b) };
    }
  }

  return out;
}

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;

  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return false;

  if (ta !== "object") return a === b;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;

  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    const key = ak[i];
    if (!deepEqual(a[key], b[key])) return false;
  }

  return true;
}

function summarizeValue(v: any): any {
  if (v == null) return v;

  if (typeof v === "string") {
    return truncate(v, 5000);
  }

  if (typeof v === "number" || typeof v === "boolean") {
    return v;
  }

  if (Array.isArray(v)) {
    if (v.length <= 20) return v;
    return { _type: "array", count: v.length };
  }

  if (typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length <= 30) return v;
    return { _type: "object", keys: keys.length };
  }

  return v;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.substring(0, maxLen) + `\n... [truncated, len=${s.length}]`;
}

function asNonEmptyString(v: any): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}

function resolveLatestTracePath(): vscode.Uri | null {
  const root = getPreferredWorkspaceRoot();
  if (!root) return null;
  return vscode.Uri.joinPath(root, "log", "pipeline_traces", "latest.json");
}

function getPreferredWorkspaceRoot(): vscode.Uri | null {
  const activeUri = vscode.window.activeTextEditor?.document?.uri;
  if (activeUri) {
    const activeWs = vscode.workspace.getWorkspaceFolder(activeUri);
    if (activeWs) return activeWs.uri;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri ?? null;
}

function extractCallModelPayload(ev: TraceEvent): { renderedChatMessages: any[] | null; modelResponse: string | null } {
  const renderedCandidates = [
    ev?.out?.rendered_chat_messages,
    ev?.rendered_chat_messages,
    ev?.action_output?.rendered_chat_messages,
    getStateAfter(ev)?.rendered_chat_messages
  ];

  let renderedChatMessages: any[] | null = null;
  for (const c of renderedCandidates) {
    if (Array.isArray(c)) {
      renderedChatMessages = c;
      break;
    }
    if (typeof c === "string") {
      try {
        const parsed = JSON.parse(c);
        if (Array.isArray(parsed)) {
          renderedChatMessages = parsed;
          break;
        }
      } catch {
        // ignore invalid candidate
      }
    }
  }

  const modelResponseCandidates = [
    ev?.out?.model_response,
    ev?.model_response,
    ev?.action_output?.model_response,
    getStateAfter(ev)?.model_response
  ];

  let modelResponse: string | null = null;
  for (const c of modelResponseCandidates) {
    if (typeof c === "string" && c.trim()) {
      modelResponse = c;
      break;
    }
  }

  return { renderedChatMessages, modelResponse };
}

function formatCallModelPayloadAsMarkdown(messages: any[], modelResponse: string | null): string {
  const parts: string[] = [];
  parts.push(formatChatMessagesAsMarkdown(messages));

  parts.push("\n# model_response\n");
  if (modelResponse && modelResponse.trim()) {
    parts.push("```text\n");
    parts.push(modelResponse);
    if (!modelResponse.endsWith("\n")) parts.push("\n");
    parts.push("```\n");
  } else {
    parts.push("_model_response is empty or missing._\n");
  }

  return parts.join("");
}

function formatCallModelPayloadForClipboard(messages: any[], modelResponse: string | null): string {
  const parts: string[] = [];
  parts.push(formatChatMessagesAsMarkdown(messages));
  parts.push("\n# model_response\n");
  parts.push(modelResponse ?? "");
  parts.push("\n");
  return parts.join("");
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
