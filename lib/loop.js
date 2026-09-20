/**
 * The Fast Browser run loop: observe -> Jev decision -> execute -> repeat.
 *
 * Port of jev_ultrafast/agent.py's tick/predict/act state machine, adapted to
 * run inside the plugin process against the work-panel browser. Runs are
 * tracked in a module-level Map and executed as fire-and-forget promises, so
 * the agent tools (jev_run/jev_wait/jev_cancel) never block the host's tool
 * timeouts — they poll or cancel by runId.
 */

"use strict";

const policy = require("./policy.js");
const executor = require("./executor.js");
const cdp = require("./cdp.js");

/** Bounded history kept per run so model context stays small. */
const HISTORY_CAP = 100;
/** Finished runs are dropped after this many ms (keeps the Map bounded). */
const RUN_RETENTION_MS = 10 * 60 * 1000;

class RunManager {
  constructor() {
    /** @type {Map<string, object>} */
    this.runs = new Map();
    /** Pending runs, processed one at a time by the resident service worker. */
    this._queue = [];
    this._workerBusy = false;
    this._workerStarted = false;
    this._seq = 0;
    this._onEvent = null; // (eventName, payload) => void; wired to bus in main.js
  }

  _nextId() {
    this._seq += 1;
    return `run-${Date.now()}-${this._seq}`;
  }

  /** Create a run record (not started). */
  createRun({ url, goal, settings, maxSteps }) {
    const runId = this._nextId();
    const run = {
      runId,
      url,
      goal,
      settings,
      maxSteps: Number(maxSteps) || settings.maxSteps || 60,
      status: "starting", // starting | running | done | blocked | error | canceled
      history: [],
      stepCount: 0, // independent of history.length so capping never corrupts the budget
      decisions: [],
      text_calls: [],
      error: null,
      startedAt: null,
      finishedAt: null,
      elapsedMs: 0,
      latest: null, // latest snapshot (page info + element table view)
      _cancelled: false,
    };
    this.runs.set(runId, run);
    return run;
  }

  /**
   * Enqueue a run for the resident worker. The worker runs OUTSIDE any tool
   * invocation (started from the declared background service), so its pi.*
   * calls are NOT tagged to an invocation and survive the jev_run tool
   * returning immediately.
   */
  /**
   * Enqueue a run. Execution is owned by the service poller (startWorker),
   * which runs OUTSIDE any tool invocation — so the loop's pi.* calls are not
   * tagged to a tool invocation and are never rejected when jev_run returns.
   * enqueue itself never starts the loop: doing so from the tool's async
   * context would tag the worker with the finishing invocation.
   */
  enqueue(run) {
    this._queue.push(run);
    return run;
  }

  /**
   * Start the resident poller. Call exactly once from the background service's
   * start() — that context has no invocation tag, and the poller (and every
   * run it drains) inherits that untagged context.
   */
  startWorker() {
    if (this._workerStarted) return;
    this._workerStarted = true;
    this._poller = setInterval(() => this._drain(), 200);
    this._poller.unref?.();
    this._drain();
  }

  _drain() {
    if (this._workerBusy) return;
    if (this._queue.length === 0) return;
    this._workerBusy = true;
    const run = this._queue.shift();
    run.startedAt = Date.now();
    run.status = "running";
    this._emit("progress", { runId: run.runId, status: "running", step: 0 });
    (async () => {
      try {
        await this._runLoop(run);
      } catch (error) {
        run.status = "error";
        run.error = error?.message ?? String(error);
        run.finishedAt = Date.now();
        run.elapsedMs = Date.now() - run.startedAt;
        this._emit("error", { runId: run.runId, error: run.error, history: this._historyView(run) });
      } finally {
        this._workerBusy = false;
        this._drain(); // process the next queued run
      }
    })();
  }

  cancel(runId) {
    const run = this.runs.get(runId);
    if (!run) return false;
    run._cancelled = true;
    return true;
  }

  /** Stop the resident poller (call from the service's stop). */
  stopWorker() {
    if (this._poller) {
      clearInterval(this._poller);
      this._poller = null;
    }
    this._workerStarted = false;
  }

  /** Drop terminal runs older than the retention window (call from jev_run). */
  prune() {
    const now = Date.now();
    for (const [id, run] of this.runs) {
      if (["done", "blocked", "error", "canceled"].includes(run.status) && run.finishedAt && now - run.finishedAt > RUN_RETENTION_MS) {
        this.runs.delete(id);
      }
    }
  }

  /** True if any run is active (shares the work-panel browser). */
  hasActiveRun() {
    for (const run of this.runs.values()) {
      if (run.status === "running" || run.status === "starting") return true;
    }
    return false;
  }

  /** Current status summary for jev_wait / jev_observe-style consumers. */
  status(runId) {
    const run = this.runs.get(runId);
    if (!run) return null;
    return {
      runId: run.runId,
      status: run.status,
      error: run.error,
      elapsedMs: run.elapsedMs,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      stepCount: run.stepCount,
      history: this._historyView(run),
      textCalls: (run.text_calls || []).slice(-8),
      latestElementTable: run.latest?.elementTable ?? null,
      latestUrl: run.latest?.url ?? null,
      latestTitle: run.latest?.title ?? null,
    };
  }

  _historyView(run) {
    return run.history.slice(-20).map((h) => ({
      step: h.step,
      action: h.action,
      kind: h.kind,
      choice: h.choice,
      operation: h.operation,
      target: h.target,
      text: h.text,
      page_changed: h.page_changed,
      elapsed_ms: h.elapsed_ms,
    }));
  }

  _emit(event, payload) {
    if (this._onEvent) {
      try {
        this._onEvent(event, payload);
      } catch {
        // never let a bus failure kill the loop
      }
    }
  }

  async _navigate(url) {
    await pi.browser.navigate({ url });
    // Wait for load (mirrors browser.py's readyState loop, 15s cap).
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const ready = await executor
        .observe()
        .then(() => true)
        .catch(() => false);
      if (ready) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Best effort: if the page never reports complete, proceed — observe will
    // throw StalePage on next use if the document really is navigating.
  }

  async _runLoop(run) {
    await this._navigate(run.url);
    let page = await executor.observe();
    run.latest = this._pageView(run, page);
    let pendingText = null; // { context, value } — reuse after a stale re-observe

    // The loop itself. Each iteration = predict + act (tick).
    while (run.status === "running" && !run._cancelled) {
      if (run.stepCount >= run.maxSteps) {
        run.status = "blocked";
        run.error = `Stopped at the ${run.maxSteps}-action step budget`;
        break;
      }

      // --- predict ---
      let decision;
      try {
        decision = await policy.choose(page, run.goal, run.history, run.settings);
      } catch (error) {
        // A failed decision must not kill the run if it's a transient model error;
        // but repeated failures should stop. Treat as error for now (no action
        // was executed, nothing lost).
        run.status = "error";
        run.error = error?.message ?? String(error);
        break;
      }
      run.decisions.push({ ...decision, fingerprint: page.fingerprint });
      const selected = decision.choice;

      // DONE / BLOCKED
      if (selected === "DONE" || selected === "BLOCKED") {
        const stillFresh = await executor.fresh(page);
        if (!stillFresh) {
          // Page changed; re-observe and continue (do not terminate on stale DONE).
          page = await executor.observe();
          run.latest = this._pageView(run, page);
          continue;
        }
        run.status = selected === "DONE" ? "done" : "blocked";
        if (selected === "BLOCKED") run.error = "No supported operation can make progress.";
        break;
      }

      // Find the action by choice id.
      const action = (page.actions || []).find((a) => a.id === selected);
      if (!action) {
        run.status = "error";
        run.error = `Decision referenced unknown action "${selected}"; nothing executed.`;
        break;
      }

      // --- text generation for TYPE_TEXT ---
      let text = null;
      let helper = null;
      let skipFill = false;
      if (action.kind === "fill") {
        const stillFresh = await executor.fresh(page);
        if (!stillFresh) {
          page = await executor.observe();
          run.latest = this._pageView(run, page);
          continue; // re-decide on the fresh page
        }
        const ctx = policy.fieldContext(run.goal, action, page, run.history);
        if (pendingText && JSON.stringify(pendingText.context) === JSON.stringify(ctx)) {
          text = pendingText.value;
          helper = pendingText.helper;
        } else {
          try {
            const gen = await policy.fieldText(ctx);
            text = gen.value;
            helper = gen.helper;
            pendingText = { context: ctx, value: text, helper };
            run.text_calls.push({ ...helper, field: action.label, value: text });
          } catch (error) {
            // Missing value or model failure: do NOT act — typing an empty
            // string would wipe the field. Record and move on (counts a step).
            run.text_calls.push({ error: error?.message ?? String(error), field: action.label });
            skipFill = true;
          }
        }
      }

      // --- act (executor re-checks freshness immediately before input) ---
      if (skipFill) {
        // Nothing was typed and nothing should be; the loop would otherwise
        // spin here forever, so count it as a step and re-decide.
        run.stepCount += 1;
        run.latest = this._pageView(run, page);
        this._emit("progress", { runId: run.runId, status: "running", step: run.stepCount, lastAction: action.label, skipped: true });
        continue;
      }
      try {
        await executor.act(action, page, text);
      } catch (error) {
        if (error instanceof executor.StalePageError) {
          page = await executor.observe();
          run.latest = this._pageView(run, page);
          continue; // loop back to predict on fresh state (pendingText survives
          // only if context is unchanged — handled at the fill branch)
        }
        // select/interrupt errors: stop, nothing more to do safely.
        run.status = "error";
        run.error = error?.message ?? String(error);
        break;
      }

      // Record execution BEFORE observing (a stale post-action observation must
      // not erase the executed action).
      run.stepCount += 1;
      run.history.push({
        step: run.stepCount,
        action: action.label,
        kind: action.kind,
        choice: selected,
        probability: decision.probabilities?.[selected] ?? null,
        confidence: decision.confidence,
        latency_ms: decision.latency_ms,
        text,
        text_helper: helper?.model ?? null,
        text_latency_ms: helper?.latency_ms ?? 0,
        operation: decision.operation,
        target: decision.target,
        page_changed: null,
        url: page.url,
        usage: decision.usage ?? {},
        executed_ms: Date.now() - run.startedAt,
        elapsed_ms: Date.now() - run.startedAt,
      });
      if (run.history.length > HISTORY_CAP) run.history.splice(0, run.history.length - HISTORY_CAP);
      pendingText = null; // consumed on success

      // Post-action settle wait (autocomplete suggestions, animation frames).
      await cdp.waitAfterInput(action);

      // Observe next state. A post-action navigation (e.g. clicking a search
      // suggestion) is expected: wait for it to settle (bounded) instead of
      // treating it as a fatal error.
      let next = null;
      for (let attempt = 0; attempt < 40 && !next; attempt += 1) {
        try {
          next = await executor.observe();
        } catch (error) {
          if (!(error instanceof executor.StalePageError)) throw error;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (!next) {
        run.status = "error";
        run.error = "Page did not settle after the action.";
        break;
      }
      {
        const changed = next.fingerprint !== page.fingerprint;
        const last = run.history[run.history.length - 1];
        last.page_changed = changed;
        last.url = next.url;
        last.elapsed_ms = Date.now() - run.startedAt;
        page = next;
        run.latest = this._pageView(run, page);
        run.elapsedMs = Date.now() - run.startedAt;
        this._emit("progress", {
          runId: run.runId,
          status: "running",
          step: run.stepCount,
          lastAction: last.action,
        });

        // Repetition detection: 3 consecutive no-change, non-wait steps -> blocked.
        // Treat a null page_changed (stale post-action observe) as no-change so a
        // genuinely stuck run still gets detected.
        const recent = run.history.slice(-3);
        if (
          recent.length === 3 &&
          recent.every((h) => h.page_changed !== true && h.kind !== "wait")
        ) {
          run.status = "blocked";
          run.error = "No page change after repeated actions; blocked.";
          break;
        }
      }
    }

    if (run._cancelled) {
      run.status = "canceled";
    }
    run.finishedAt = Date.now();
    run.elapsedMs = Date.now() - run.startedAt;
    this._emit("done", {
      runId: run.runId,
      status: run.status,
      error: run.error,
      stepCount: run.stepCount,
      elapsedMs: run.elapsedMs,
      history: this._historyView(run),
    });
  }

  /** Compact view of a page snapshot for status polling. */
  _pageView(run, page) {
    const { elements, controls } = policy.actionSpace(page.actions || []);
    return {
      url: page.url,
      title: page.title,
      viewport: { w: page.w, h: page.h },
      scroll: page.scroll ?? null,
      elementCount: elements.length,
      elementTable: elements
        .slice(0, 60)
        .map((el) => {
          const value = el.value != null && el.value !== "" ? ` · ${String(el.value).slice(0, 60)}` : "";
          return `[${el.index}] ${el.role || "?"}  ${el.label}${value}  ops=${el.operations.join("|")}`;
        })
        .concat(
          Object.entries(controls).map(([id, action]) => `[${id}] ${action.kind}  ${action.label}`)
        )
        .join("\n"),
    };
  }
}

module.exports = { RunManager };
