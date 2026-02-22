import * as vscode from "vscode";
declare const require: any;
const deflateRawSync: (data: Uint8Array) => Uint8Array = require("zlib").deflateRawSync;

const CMD_OPEN = "renderedPromptViewer.open";
const CMD_SHOW_DELTA = "renderedPromptViewer.showDelta";
const CMD_SHOW_STEP_INFO = "renderedPromptViewer.showStepInfo";

// Trace Explorer (Sidebar / TreeView)
const VIEW_TRACE_EXPLORER = "renderedPromptViewer.traceExplorerView";
const CMD_TRACE_REFRESH = "renderedPromptViewer.traceExplorer.refresh";
const CMD_TRACE_OPEN_STEP_DELTA = "renderedPromptViewer.traceExplorer.openStepDelta";
const CMD_TRACE_OPEN_LAST = "renderedPromptViewer.traceExplorer.openLastTrace";
const CMD_TRACE_OPEN_PUML = "renderedPromptViewer.traceExplorer.openPumlDiagram";
const CMD_TRACE_OPEN_CALLMODEL_MD = "renderedPromptViewer.traceExplorer.openCallModelMessages";
const CMD_TRACE_COPY_CALLMODEL = "renderedPromptViewer.traceExplorer.copyCallModelPayload";

type OpenArgs = { line: number; key: "rendered_prompt" | "rendered_chat_messages" };
type TraceEvent = Record<string, any>;
const CFG_PUML_BASE_URL = "pumlBaseUrl";
const CFG_SECTION = "renderedPromptViewer";
const BUILD_STAMP_UNKNOWN = "build ?";

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
  const traceExplorerProvider = new TraceExplorerProvider(BUILD_STAMP_UNKNOWN);
  context.subscriptions.push(vscode.window.registerTreeDataProvider(VIEW_TRACE_EXPLORER, traceExplorerProvider));
  resolveBuildStamp(context).then((stamp) => {
    traceExplorerProvider.setBuildStamp(stamp);
    traceExplorerProvider.refresh();
  });

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

  // Command: generate activity diagram in PUML and open PlantText with Base64 payload.
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_TRACE_OPEN_PUML, async () => {
      const events = await loadEventsForPuml();
      if (!events.length) {
        vscode.window.showWarningMessage("No trace events found for PUML generation.");
        return;
      }

      const puml = buildActivityPuml(events);
      const target = buildPumlRenderTarget(ensureClosedPuml(puml));
      if (target.copyPumlToClipboard) {
        await vscode.env.clipboard.writeText(puml);
      }
      await vscode.env.openExternal(target.url);
      if (target.copyPumlToClipboard) {
        vscode.window.showWarningMessage(
          "PUML link is too long for reliable query rendering. PlantUML source was copied to clipboard - paste into PlantText and click Save & Refresh."
        );
      }
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
  readonly kind: "openPuml" | "openLatest" | "step" | "callModelOpenMd" | "callModelCopy";
  readonly stepIndex?: number;
  readonly isCallModelAction?: boolean;

  constructor(args: {
    kind: "openPuml" | "openLatest" | "step" | "callModelOpenMd" | "callModelCopy";
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

    if (args.kind === "openPuml") {
      this.iconPath = new vscode.ThemeIcon("symbol-class");
      this.command = { command: CMD_TRACE_OPEN_PUML, title: "Open PUML diagram" };
      return;
    }

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
  private buildStamp: string;

  constructor(initialBuildStamp: string) {
    this.buildStamp = initialBuildStamp;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setBuildStamp(stamp: string): void {
    this.buildStamp = stamp || BUILD_STAMP_UNKNOWN;
  }

  getTreeItem(element: TraceStepItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TraceStepItem): Promise<TraceStepItem[]> {
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
        kind: "openPuml",
        label: "PUML",
        description: "diagram activity"
      }),
      new TraceStepItem({
        kind: "openLatest",
        label: "Open latest trace",
        description: "log/pipeline_traces/latest.json"
      })
    ];

    const editor = vscode.window.activeTextEditor;
    if (!editor) return Promise.resolve(out);

    const doc = editor.document;
    const sourceEvents = parseTraceEventsFromActiveDocument(doc);
    const events = normalizeEventsForPuml(sourceEvents);
    if (!events.length) return Promise.resolve(out);
    const sourceIndexByEvent = new Map<TraceEvent, number>();
    for (let sourceIndex = 0; sourceIndex < sourceEvents.length; sourceIndex++) {
      sourceIndexByEvent.set(sourceEvents[sourceIndex], sourceIndex);
    }

    const timing = buildTraceTiming(events);
    const durationStats = await buildDurationStatsFromFolder(doc.uri);

    let visibleIndex = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];

      const stepId = asNonEmptyString(ev?.step?.id) ?? asNonEmptyString(ev.step_id) ?? "";
      const cls = getActionClass(ev);
      if (isUnknownStep(stepId, cls)) continue;
      visibleIndex++;

      const title = `${visibleIndex}. ${stepId || "step"}${cls ? ` (${cls})` : ""}`;
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

      const timed = formatTimingForStep(timing, i, cls, durationStats);
      const parts = [desc];
      if (timed) parts.push(timed);
      if (extra) parts.push(extra);
      const description = parts.join(" | ");
      const tooltip = JSON.stringify(stripStateFields(ev), null, 2);

      const item = new TraceStepItem({
        kind: "step",
        label: title,
        stepIndex: sourceIndexByEvent.get(ev) ?? i,
        isCallModelAction,
        description,
        tooltip
      });
      const stepTiming = timing.steps[i];
      const isSlow = !err && isStepSlow(stepTiming?.durationMs ?? null, cls, durationStats);
      if (err) {
        item.iconPath = new vscode.ThemeIcon("error");
      } else if (isSlow) {
        item.iconPath = new vscode.ThemeIcon("clock", new vscode.ThemeColor("errorForeground"));
      } else {
        item.iconPath = new vscode.ThemeIcon("check");
      }

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
  return parseTraceEventsFromText(text);
}

function parseTraceEventsFromText(text: string): TraceEvent[] {
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

type StepTiming = { startMs: number | null; endMs: number | null; durationMs: number | null; elapsedMs: number | null };
type DurationStats = { perClass: Map<string, number[]>; global: number[] };

function getActionClass(ev: TraceEvent): string {
  const raw = asNonEmptyString(ev?.action?.class) ?? asNonEmptyString(ev.action_name) ?? "";
  return raw.toLowerCase() === "unknown" ? "" : raw;
}

function parseTsMs(v: any): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    // if epoch seconds, convert to ms
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function getEventDurationMs(ev: TraceEvent): number | null {
  const d =
    (typeof ev.duration_ms === "number" ? ev.duration_ms : null) ??
    (typeof ev.durationMs === "number" ? ev.durationMs : null) ??
    (typeof ev?.timing?.duration_ms === "number" ? ev.timing.duration_ms : null) ??
    (typeof ev?.timing?.durationMs === "number" ? ev.timing.durationMs : null);
  return d != null && Number.isFinite(d) && d >= 0 ? d : null;
}

function getEventEndMs(ev: TraceEvent): number | null {
  return (
    parseTsMs(ev.t_ms) ??
    parseTsMs(ev.ts_ms) ??
    parseTsMs(ev.ts_utc) ??
    parseTsMs(ev.ts) ??
    parseTsMs(ev.timestamp) ??
    parseTsMs(ev.time) ??
    parseTsMs(ev.finished_at) ??
    parseTsMs(ev.end_ts_utc) ??
    parseTsMs(ev.end_ts)
  );
}

function getEventStartMs(ev: TraceEvent): number | null {
  const explicit =
    parseTsMs(ev.started_at) ??
    parseTsMs(ev.start_ts_utc) ??
    parseTsMs(ev.start_ts) ??
    parseTsMs(ev.start_time) ??
    parseTsMs(ev?.timing?.started_at);
  if (explicit != null) return explicit;

  const end = getEventEndMs(ev);
  const dur = getEventDurationMs(ev);
  if (end != null && dur != null) return end - dur;
  return null;
}

function buildTraceTiming(events: TraceEvent[]): { traceStartMs: number | null; steps: StepTiming[] } {
  const starts = events.map((e) => getEventStartMs(e)).filter((x): x is number => x != null);
  const ends = events.map((e) => getEventEndMs(e)).filter((x): x is number => x != null);
  const traceStartMs = starts.length ? Math.min(...starts) : ends.length ? Math.min(...ends) : null;

  // For traces with CONSUME events: duration(step) = step_end - consume_for_same_step
  // This yields realistic step duration even when explicit duration_ms is absent.
  const consumeQueue = new Map<string, number[]>();
  for (const ev of events) {
    const kind = asNonEmptyString(ev.event_type)?.toUpperCase() ?? "";
    if (kind !== "CONSUME") continue;
    const sid = asNonEmptyString(ev.consumer_step_id) ?? "";
    const end = getEventEndMs(ev);
    if (!sid || end == null) continue;
    if (!consumeQueue.has(sid)) consumeQueue.set(sid, []);
    consumeQueue.get(sid)!.push(end);
  }

  let prevEndMs: number | null = null;
  const steps: StepTiming[] = events.map((ev) => {
    const explicitDuration = getEventDurationMs(ev);
    const endMs = getEventEndMs(ev);
    let startMs = getEventStartMs(ev);

    const stepId = asNonEmptyString(ev?.step?.id) ?? asNonEmptyString(ev.step_id) ?? "";
    if (stepId) {
      const q = consumeQueue.get(stepId);
      if (q && q.length && endMs != null) {
        const idx = q.findIndex((v) => v <= endMs);
        if (idx >= 0) {
          startMs = q[idx];
          q.splice(idx, 1);
        }
      }
    }

    if (startMs == null && prevEndMs != null) startMs = prevEndMs;
    const durationMs =
      explicitDuration != null
        ? explicitDuration
        : startMs != null && endMs != null && endMs >= startMs
          ? endMs - startMs
          : null;
    const elapsedMs = traceStartMs != null && endMs != null ? endMs - traceStartMs : null;
    prevEndMs = endMs ?? prevEndMs;
    return { startMs, endMs, durationMs, elapsedMs };
  });

  return { traceStartMs, steps };
}

async function buildDurationStatsFromFolder(docUri: vscode.Uri): Promise<DurationStats> {
  const perClass = new Map<string, number[]>();
  const global: number[] = [];

  if (docUri.scheme !== "file") return { perClass, global };

  const folderUri = parentDir(docUri);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(folderUri);
  } catch {
    return { perClass, global };
  }

  const files = entries
    .filter(([name, t]) => t === vscode.FileType.File && /\.(json|jsonl)$/i.test(name))
    .slice(0, 120);

  for (const [name] of files) {
    const uri = vscode.Uri.joinPath(folderUri, name);
    let text = "";
    try {
      text = await readUtf8(uri);
    } catch {
      continue;
    }
    if (!text || text.length > 20 * 1024 * 1024) continue;

    const events = parseTraceEventsFromText(text.trim());
    for (const ev of events) {
      const cls = getActionClass(ev).toLowerCase();
      const d = getEventDurationMs(ev);
      if (d == null || !Number.isFinite(d) || d < 0) continue;
      if (!perClass.has(cls)) perClass.set(cls, []);
      perClass.get(cls)!.push(d);
      global.push(d);
    }
  }

  return { perClass, global };
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(v.length - 1, Math.floor((v.length - 1) * p)));
  return v[idx];
}

function allowedDurationMs(cls: string, stats: DurationStats): number | null {
  const classVals = stats.perClass.get(cls.toLowerCase()) ?? [];
  const source = classVals.length >= 6 ? classVals : stats.global;
  if (source.length < 6) return null;

  const med = percentile(source, 0.5);
  const p90 = percentile(source, 0.9);
  return Math.max(150, med * 2.2, p90 * 1.25);
}

function isStepSlow(durationMs: number | null, cls: string, stats: DurationStats): boolean {
  if (durationMs == null) return false;
  const allowed = allowedDurationMs(cls, stats);
  if (allowed == null) return false;
  return durationMs > allowed;
}

function formatSeconds(ms: number): string {
  const s = ms / 1000;
  if (s < 1) return `${s.toFixed(2).replace(".", ",")}s`;
  if (s < 10) return `${s.toFixed(1).replace(".", ",")}s`;
  return `${Math.round(s)}s`;
}

function formatTimingForStep(
  timing: { traceStartMs: number | null; steps: StepTiming[] },
  index: number,
  cls: string,
  stats: DurationStats
): string | null {
  const t = timing.steps[index];
  if (!t) return null;

  const parts: string[] = [];
  if (t.elapsedMs != null && t.elapsedMs >= 0) {
    parts.push(`t=${formatSeconds(t.elapsedMs)}`);
  }

  if (t.durationMs != null && t.durationMs >= 0) {
    const dur = `+${formatSeconds(t.durationMs)}`;
    parts.push(isStepSlow(t.durationMs, cls, stats) ? `[SLOW] ${dur}` : dur);
  }

  return parts.length ? parts.join(", ") : null;
}

function parentDir(uri: vscode.Uri): vscode.Uri {
  const p = uri.path;
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return uri.with({ path: "/" });
  return uri.with({ path: p.substring(0, idx) });
}

async function readUtf8(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const DecoderCtor = (globalThis as any).TextDecoder;
  if (typeof DecoderCtor === "function") {
    return new DecoderCtor("utf-8").decode(bytes);
  }
  return Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join("");
}

function buildPumlRenderTarget(puml: string): { url: vscode.Uri; copyPumlToClipboard: boolean } {
  const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
  const rawBase = asNonEmptyString(cfg.get<string>(CFG_PUML_BASE_URL)) ?? "https://www.planttext.com";
  const base = rawBase.trim() || "https://www.planttext.com";
  const sep = base.includes("?") ? "&" : "?";
  const encoded = encodePlantUmlForUrl(puml);
  const full = `${base}${sep}text=${encoded}`;

  // Some browsers/sites truncate very long query strings, resulting in empty PlantText editor.
  // In that case open base URL and copy source to clipboard.
  if (full.length > 7000) {
    const noQuery = base.split("?")[0] || "https://www.planttext.com";
    return { url: vscode.Uri.parse(noQuery), copyPumlToClipboard: true };
  }

  return { url: vscode.Uri.parse(full), copyPumlToClipboard: false };
}

function ensureClosedPuml(puml: string): string {
  const rows = puml.split(/\r?\n/).map((x) => x.trimEnd());
  const hasEndNote = rows.some((r) => r.trim().toLowerCase() === "end note");
  const hasNoteRight = rows.some((r) => r.trim().toLowerCase() === "note right");
  const hasStop = rows.some((r) => r.trim().toLowerCase() === "stop");
  const hasEndUml = rows.some((r) => r.trim().toLowerCase() === "@enduml");

  // If there is a note block marker but no explicit close, close it defensively.
  if (hasNoteRight && !hasEndNote) rows.push("end note");
  if (!hasStop) rows.push("stop");
  if (!hasEndUml) rows.push("@enduml");
  return rows.join("\n");
}

function encodePlantUmlForUrl(text: string): string {
  const compressed = deflateRawSync(utf8Bytes(text));
  return plantUmlEncodeBytes(compressed);
}

function utf8Bytes(text: string): Uint8Array {
  const encoded = encodeURIComponent(text);
  const out: number[] = [];
  for (let i = 0; i < encoded.length; i += 1) {
    const ch = encoded[i];
    if (ch === "%") {
      const hex = encoded.slice(i + 1, i + 3);
      out.push(parseInt(hex, 16));
      i += 2;
      continue;
    }
    out.push(ch.charCodeAt(0));
  }
  return new Uint8Array(out);
}

function plantUmlEncodeBytes(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    const b1 = data[i] ?? 0;
    const b2 = data[i + 1] ?? 0;
    const b3 = data[i + 2] ?? 0;
    out += append3bytes(b1, b2, b3);
  }
  return out;
}

function append3bytes(b1: number, b2: number, b3: number): string {
  const c1 = b1 >> 2;
  const c2 = ((b1 & 0x3) << 4) | (b2 >> 4);
  const c3 = ((b2 & 0xf) << 2) | (b3 >> 6);
  const c4 = b3 & 0x3f;
  return `${encode6bit(c1 & 0x3f)}${encode6bit(c2 & 0x3f)}${encode6bit(c3 & 0x3f)}${encode6bit(c4 & 0x3f)}`;
}

function encode6bit(b: number): string {
  if (b < 10) return String.fromCharCode(48 + b);
  if (b < 36) return String.fromCharCode(65 + (b - 10));
  if (b < 62) return String.fromCharCode(97 + (b - 36));
  if (b === 62) return "-";
  if (b === 63) return "_";
  return "?";
}

async function loadEventsForPuml(): Promise<TraceEvent[]> {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const events = parseTraceEventsFromActiveDocument(editor.document);
    const filtered = normalizeEventsForPuml(events);
    if (filtered.length) return filtered;
  }

  const latestUri = resolveLatestTracePath();
  if (!latestUri || !(await fileExists(latestUri))) return [];

  try {
    const text = await readUtf8(latestUri);
    const events = parseTraceEventsFromText(text.trim());
    return normalizeEventsForPuml(events);
  } catch {
    return [];
  }
}

function normalizeEventsForPuml(events: TraceEvent[]): TraceEvent[] {
  // Prefer strict execution-step events (step id + concrete action class),
  // because mixed traces may include synthetic/helper records that break loop detection.
  const strict = events.filter(isStructuralStepEvent);
  if (strict.length >= 3) return strict;

  // Fallback for sparse traces where action class is not always present.
  return events.filter((ev) => {
    const stepId = asNonEmptyString(ev?.step?.id) ?? asNonEmptyString(ev.step_id) ?? "";
    const cls = getActionClass(ev);
    if (cls.trim().toLowerCase() === "action") return false;
    return !isUnknownStep(stepId, cls);
  });
}

function isStructuralStepEvent(ev: TraceEvent): boolean {
  const stepId = asNonEmptyString(ev?.step?.id) ?? asNonEmptyString(ev.step_id) ?? "";
  const cls = asNonEmptyString(ev?.action?.class) ?? "";
  const normalized = cls.trim().toLowerCase();
  if (!stepId || !cls) return false;
  if (normalized === "unknown" || normalized === "action") return false;
  return true;
}

function buildActivityPuml(events: TraceEvent[]): string {
  type Node = {
    idx: number;
    key: string;
    stepId: string;
    actionClass: string;
    status: string;
    nextStepId: string | null;
    elapsedMs: number | null;
    durationMs: number | null;
  };

  const timing = buildTraceTiming(events);
  const nodes: Node[] = events.map((ev, i) => {
    const stepId = asNonEmptyString(ev?.step?.id) ?? asNonEmptyString(ev.step_id) ?? `step_${i + 1}`;
    const actionClass = getActionClass(ev);
    const status = isErrorEvent(ev) ? "ERROR" : "ok";
    const nextStepId = getNextStepId(ev);
    const t = timing.steps[i];
    return {
      idx: i,
      key: `${stepId}::${actionClass || "action"}`,
      stepId,
      actionClass: actionClass || "action",
      status,
      nextStepId,
      elapsedMs: t?.elapsedMs ?? null,
      durationMs: t?.durationMs ?? null
    };
  });

  const byStepId = new Map<string, number[]>();
  for (const n of nodes) {
    if (!byStepId.has(n.stepId)) byStepId.set(n.stepId, []);
    byStepId.get(n.stepId)!.push(n.idx);
  }
  const repeatedSteps = Array.from(byStepId.entries())
    .filter(([, indexes]) => indexes.length > 1)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  const edges = new Map<number, Set<number>>();
  for (const n of nodes) {
    let target: number | null = null;
    if (n.nextStepId && byStepId.has(n.nextStepId)) {
      const candidates = byStepId.get(n.nextStepId)!;
      target = candidates.find((idx) => idx > n.idx) ?? candidates[0] ?? null;
    } else if (n.idx + 1 < nodes.length) {
      target = n.idx + 1;
    }
    if (target != null) {
      if (!edges.has(n.idx)) edges.set(n.idx, new Set<number>());
      edges.get(n.idx)!.add(target);
    }
  }

  const lines: string[] = [];
  lines.push("@startuml");
  lines.push("title Trace Activity Flow (observed run)");

  if (!nodes.length) {
    lines.push("start");
    lines.push(":No events;");
    lines.push("stop");
    lines.push("@enduml");
    return lines.join("\n");
  }

  lines.push("start");
  const stepLine = (n: Node): string => {
    const elapsed = n.elapsedMs != null && n.elapsedMs >= 0 ? formatSeconds(n.elapsedMs) : "?";
    const duration = n.durationMs != null && n.durationMs >= 0 ? formatSeconds(n.durationMs) : "?";
    const body = `${n.idx + 1}. ${n.stepId} (${n.actionClass})\\nstatus=${n.status} | t=${elapsed} | +${duration}`;
    return `:${escapePumlLabel(body)};`;
  };

  type ObservedIteration = { start: number; endExclusive: number; iterationNo: number };
  const detectObservedIterations = (): ObservedIteration[] => {
    let chosenIndexes: number[] | null = null;
    let bestCoverage = -1;
    let bestFirst = Number.MAX_SAFE_INTEGER;

    for (const [, indexes] of byStepId.entries()) {
      if (indexes.length < 3) continue; // at least 2 full observed iterations
      let coverage = 0;
      let valid = true;
      for (let i = 0; i < indexes.length - 1; i += 1) {
        const gap = indexes[i + 1] - indexes[i];
        if (gap <= 0) {
          valid = false;
          break;
        }
        coverage += gap;
      }
      if (!valid) continue;
      const first = indexes[0];
      if (coverage > bestCoverage || (coverage === bestCoverage && first < bestFirst)) {
        bestCoverage = coverage;
        bestFirst = first;
        chosenIndexes = indexes;
      }
    }

    if (!chosenIndexes) return [];
    const out: ObservedIteration[] = [];
    for (let i = 0; i < chosenIndexes.length - 1; i += 1) {
      out.push({
        start: chosenIndexes[i],
        endExclusive: chosenIndexes[i + 1],
        iterationNo: i + 1
      });
    }
    return out;
  };

  const iterations = detectObservedIterations();
  const iterByStart = new Map<number, ObservedIteration>();
  for (const it of iterations) iterByStart.set(it.start, it);

  let i = 0;
  while (i < nodes.length) {
    const it = iterByStart.get(i);
    if (!it) {
      lines.push(stepLine(nodes[i]));
      i += 1;
      continue;
    }
    lines.push(`partition "Loop iteration #${it.iterationNo} (observed)" {`);
    for (let k = it.start; k < it.endExclusive; k += 1) {
      lines.push(stepLine(nodes[k]));
    }
    lines.push("}");
    i = it.endExclusive;
  }

  const jumps = Array.from(edges.entries()).flatMap(([from, tos]) =>
    Array.from(tos).map((to) => `${nodes[from].stepId} -> ${nodes[to].stepId}`)
  );
  if (jumps.length) {
    lines.push("note right");
    lines.push("Flow edges (inferred):");
    for (const j of jumps.slice(0, 80)) {
      lines.push(`- ${escapePumlLabel(j)}`);
    }
    if (jumps.length > 80) lines.push(`- ... and ${jumps.length - 80} more`);
    if (repeatedSteps.length) {
      lines.push("");
      lines.push("Repeated steps (loop signal):");
      for (const [stepId, indexes] of repeatedSteps.slice(0, 20)) {
        const positions = indexes.slice(0, 8).map((idx) => idx + 1).join(", ");
        const suffix = indexes.length > 8 ? ", ..." : "";
        lines.push(`- ${escapePumlLabel(`${stepId} x${indexes.length} @ [${positions}${suffix}]`)}`);
      }
      if (repeatedSteps.length > 20) lines.push(`- ... and ${repeatedSteps.length - 20} more`);
    }
    lines.push("end note");
  } else if (repeatedSteps.length) {
    lines.push("note right");
    lines.push("Repeated steps (loop signal):");
    for (const [stepId, indexes] of repeatedSteps.slice(0, 20)) {
      const positions = indexes.slice(0, 8).map((idx) => idx + 1).join(", ");
      const suffix = indexes.length > 8 ? ", ..." : "";
      lines.push(`- ${escapePumlLabel(`${stepId} x${indexes.length} @ [${positions}${suffix}]`)}`);
    }
    if (repeatedSteps.length > 20) lines.push(`- ... and ${repeatedSteps.length - 20} more`);
    lines.push("end note");
  }
  lines.push("stop");
  lines.push("@enduml");
  return lines.join("\n");
}

function escapePumlLabel(s: string): string {
  return s.replace(/"/g, "'");
}

function getNextStepId(ev: TraceEvent): string | null {
  return (
    asNonEmptyString(ev.out?.next_step_id) ??
    asNonEmptyString(ev.step?.next_resolved) ??
    asNonEmptyString(ev.next_step_id) ??
    asNonEmptyString(ev.nextStepId) ??
    asNonEmptyString(ev.next) ??
    null
  );
}

function isUnknownStep(stepId: string, cls: string): boolean {
  const s = stepId.trim().toLowerCase();
  const c = cls.trim().toLowerCase();
  return (!s || s === "step" || s === "unknown") && (!c || c === "unknown");
}

async function resolveBuildStamp(context: vscode.ExtensionContext): Promise<string> {
  try {
    const compiledUri = vscode.Uri.joinPath(context.extensionUri, "out", "extension.js");
    const stat = await vscode.workspace.fs.stat(compiledUri);
    return `build ${formatBuildDate(stat.mtime)}`;
  } catch {
    return BUILD_STAMP_UNKNOWN;
  }
}

function formatBuildDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mm = `${d.getMinutes()}`.padStart(2, "0");
  const ss = `${d.getSeconds()}`.padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}
