/**
 * Fast Browser (pi.fast-browser) — v0.2.0
 *
 * Jev-powered browser agent for PI-Desktop. One TypeSafe request per decision,
 * work-panel browser via the host's allowlisted CDP surface, session-model text
 * generation via agent.complete (no API keys leave the host).
 *
 * Tools:
 *   jev_observe  — snapshot + Jev element table
 *   jev_act      — execute one action (manual stepping / debugging)
 *   jev_run      — full autonomous loop (returns runId immediately)
 *   jev_wait     — poll a run to completion / timeout
 *   jev_cancel   — stop a run and release the browser
 *
 * Runs live in-process (RunManager) as fire-and-forget promises, so tool calls
 * never block on the host's tool/complete timeouts. Progress is broadcast on
 * the plugin bus for external observers.
 */

"use strict";

const policy = require("./lib/policy.js");
const executor = require("./lib/executor.js");
const { RunManager } = require("./lib/loop.js");

const manager = new RunManager();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function loadSettings() {
  try {
    const settings = await pi.plugin.getSettings();
    return {
      typesafeKey: String(settings?.typesafeKey ?? ""),
      typesafeModel: String(settings?.typesafeModel ?? "jev-latest"),
      maxSteps: Number(settings?.maxSteps) || 60,
    };
  } catch {
    return { typesafeKey: "", typesafeModel: "jev-latest", maxSteps: 60 };
  }
}

// ---------------------------------------------------------------------------
// Element table rendering (shared by jev_observe and jev_act)
// ---------------------------------------------------------------------------

function renderTable(elements, controls, maxElements = 60) {
  const lines = [];
  for (const el of elements.slice(0, maxElements)) {
    const value = el.value != null && el.value !== "" ? ` · ${String(el.value).slice(0, 60)}` : "";
    lines.push(`[${el.index}] ${el.role || "?"}  ${el.label}${value}  ops=${el.operations.join("|")}`);
    if (el.options?.length) {
      for (const opt of el.options.slice(0, 5)) lines.push(`      → [${opt.index}] ${opt.label}`);
    }
  }
  for (const [id, action] of Object.entries(controls)) {
    lines.push(`[${id}] ${action.kind}  ${action.label}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function doObserve(includeText = true, maxElements = 60) {
  const info = await executor.observe();
  const { elements, targets, controls } = policy.actionSpace(info.actions || []);
  const result = {
    ok: true,
    url: info.url,
    title: info.title,
    viewport: { w: info.w, h: info.h },
    scroll: info.scroll ?? null,
    elementCount: elements.length,
    controls: Object.keys(controls),
    operations: Object.keys(targets),
    elementTable: renderTable(elements, controls, maxElements),
    pageChangedMarkers: { actions: (info.actions || []).length, omitted: info.omitted_actions ?? 0 },
  };
  if (includeText) {
    const text = String(info.text || "");
    result.pageTextPreview =
      text.length > 1500 ? `${text.slice(0, 1500)}… (${text.length} chars total)` : text;
  }
  return result;
}

/**
 * Resolve a user-facing target ("3", "6:2", "scroll_down", "wait") to a
 * snapshot action. Indexes come from the current observation.
 */
async function resolveTarget(target) {
  const info = await executor.observe();
  const { elements, targets, controls } = policy.actionSpace(info.actions || []);
  if (target === "wait") return { action: controls.WAIT, page: info };
  if (target === "scroll_down") return { action: controls.SCROLL_DOWN, page: info };
  if (target === "scroll_up") return { action: controls.SCROLL_UP, page: info };

  // element index, or select "index:option"
  const selectMatch = /^(\d+):(\d+)$/.exec(target);
  if (selectMatch) {
    const [, idx, optIdx] = selectMatch;
    const option = elements[Number(idx) - 1]?.options?.[Number(optIdx) - 1];
    if (!option) throw new Error(`Unknown select option target "${target}"`);
    const action = targets.SELECT?.[option.index];
    if (!action) throw new Error(`Select option "${target}" not actionable`);
    return { action, page: info };
  }
  const idxNum = Number(target);
  if (!Number.isInteger(idxNum) || idxNum < 1 || idxNum > elements.length) {
    throw new Error(`Unknown target "${target}"; use an element index, "N:M" for select, or scroll_down/scroll_up/wait`);
  }
  const element = elements[idxNum - 1];
  // Prefer the first offered operation; for editable elements, click is the
  // "Open" variant and fill is the typed variant. For a bare index we act on
  // the element's primary kind.
  const kind = element.operations.includes("TYPE_TEXT") ? "fill" : element.operations.includes("CLICK") ? "click" : "select";
  const candidates = targets[kind === "fill" ? "TYPE_TEXT" : kind === "click" ? "CLICK" : "SELECT"];
  // Target keys are element indexes ("3") or "index:option" for selects; the
  // actionSpace element itself does NOT carry the DOM node id, so resolve by
  // the index key directly (fall back to a node match for safety).
  let action = candidates?.[element.index] ?? Object.values(candidates || {}).find((a) => a.node === element.node);
  if (!action) throw new Error(`Element ${target} has no ${kind} action`);
  return { action, page: info };
}

async function onLoad() {
  // Settings are read fresh on every tool call (loadSettings) so a key filled
  // in after the plugin loaded takes effect immediately — no reload needed.

  // Broadcast run events to the bus for external observers (self-delivery is
  // skipped by the host, so this is purely for other plugins/panels).
  manager._onEvent = (event, payload) => {
    const topic =
      event === "done" ? "fast-browser.run.done" : event === "error" ? "fast-browser.run.error" : "fast-browser.run.progress";
    pi.bus.publish(topic, payload).catch(() => {});
  };

  // The runner service executes runs outside any tool invocation, so its pi.*
  // calls survive the jev_run tool returning immediately (lib/loop.js worker).
  await pi.services.register({
    id: "runner",
    start: () => {
      manager.startWorker();
      return Promise.resolve();
    },
    stop: () => {
      manager.stopWorker();
      return Promise.resolve();
    },
  });

  await pi.agent.registerTool({
    name: "jev_observe",
    description:
      "Inject the Jev DOM snapshot into the work-panel browser and return the numbered " +
      "element table (index, role, label, value, operations) plus page text preview. " +
      "Each call re-observes the current page; element indices are stable while the page " +
      "does not change. Call after pi.browser.navigate.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        includeText: { type: "boolean", description: "Include page text preview (default true)." },
        maxElements: { type: "number", description: "Cap element rows returned (default 60, max 250)." },
      },
    },
    execute: async (args) => {
      if (manager.hasActiveRun()) throw new Error("A jev_run is active; cancel it or wait before observing.");
      const includeText = args?.includeText !== false;
      const maxElements = Math.min(Math.max(Number(args?.maxElements) || 60, 1), 250);
      return doObserve(includeText, maxElements);
    },
  });

  await pi.agent.registerTool({
    name: "jev_act",
    description:
      "Execute one observed action on the work-panel browser. target is an element index " +
      "from jev_observe (\"3\"), a select option (\"6:2\"), or a control (\"scroll_down\", " +
      "\"scroll_up\", \"wait\"). For TYPE_TEXT fields pass text; the executor re-checks page " +
      "freshness and target visibility/occlusion before input. Returns the executed action " +
      "and the fresh element table.",
    risk: "high",
    schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Element index, select 'N:M', or control id." },
        text: { type: "string", description: "Value to type for editable fields (TYPE_TEXT)." },
      },
      required: ["target"],
    },
    execute: async (args) => {
      if (manager.hasActiveRun()) throw new Error("A jev_run is active; cancel it or wait before acting.");
      const { action, page } = await resolveTarget(String(args?.target ?? ""));
      if (action.kind === "fill" && args?.text == null) {
        // No explicit text: use the session model to generate it from context.
        const ctx = policy.fieldContext("", action, page, []);
        const gen = await policy.fieldText(ctx);
        action._generatedText = gen.value;
      }
      await executor.act(action, page, action._generatedText ?? (args?.text != null ? String(args.text) : null));
      const view = await doObserve(true, 60);
      return { ok: true, executed: action.id, kind: action.kind, text: args?.text ?? action._generatedText ?? null, ...view };
    },
  });

  await pi.agent.registerTool({
    name: "jev_run",
    description:
      "Run the full Jev browser-agent loop on the work-panel browser: navigate to url, then " +
      "observe -> Jev decision (TypeSafe) -> execute -> repeat until DONE, BLOCKED, the step " +
      "budget, or cancel. Returns immediately with a runId; poll with jev_wait. Requires the " +
      "typesafeKey plugin setting. The work-panel browser must be idle.",
    risk: "high",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Page URL to open." },
        goal: { type: "string", description: "Natural-language goal (e.g. a flight search)." },
        maxSteps: { type: "number", description: "Step budget override (default from settings, 60)." },
      },
      required: ["url", "goal"],
    },
    execute: async (args) => {
      manager.prune();
      const settings = await loadSettings();
      const url = String(args?.url ?? "").trim();
      const goal = String(args?.goal ?? "").trim();
      if (!url || !goal) throw new Error("url and goal are required");
      if (!settings.typesafeKey) {
        throw new Error("TYPESAFE_API_KEY is not configured; set the plugin setting typesafeKey first.");
      }
      // One run at a time: the work-panel browser is a shared, visible resource.
      if (manager.hasActiveRun()) {
        throw new Error("A run is already active; cancel it first or wait for it to finish.");
      }
      const run = manager.createRun({ url, goal, settings, maxSteps: args?.maxSteps });
      manager.enqueue(run);
      // Returns immediately — the runner service executes the loop in the
      // background; poll progress with jev_wait.
      return { ok: true, runId: run.runId, status: "running" };
    },
  });

  await pi.agent.registerTool({
    name: "jev_wait",
    description:
      "Wait for a jev_run run to reach a terminal state (done/blocked/error/canceled) or for " +
      "the timeout to elapse. Returns status, step history, and the latest element table. " +
      "Call repeatedly while status is 'running'.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run id from jev_run." },
        timeoutMs: { type: "number", description: "Max wait in ms (default 20000, max 90000)." },
      },
      required: ["runId"],
    },
    execute: async (args) => {
      const runId = String(args?.runId ?? "");
      const timeoutMs = Math.min(Math.max(Number(args?.timeoutMs) || 20000, 0), 90000);
      const deadline = Date.now() + timeoutMs;
      let status = manager.status(runId);
      if (!status) throw new Error(`Unknown runId ${runId}`);
      while (["starting", "running"].includes(status.status) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        status = manager.status(runId);
        if (!status) throw new Error(`Unknown runId ${runId}`);
      }
      return { ok: true, ...status };
    },
  });

  await pi.agent.registerTool({
    name: "jev_cancel",
    description: "Cancel a running jev_run loop. The run is marked canceled and stops at its next checkpoint.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run id from jev_run." },
      },
      required: ["runId"],
    },
    execute: async (args) => {
      const runId = String(args?.runId ?? "");
      const canceled = manager.cancel(runId);
      return { ok: true, runId, canceled };
    },
  });
}

async function onUnload() {
  for (const tool of ["jev_observe", "jev_act", "jev_run", "jev_wait", "jev_cancel"]) {
    try {
      await pi.agent.unregisterTool(tool);
    } catch {
      // best effort
    }
  }
}

module.exports = { onLoad, onUnload };
