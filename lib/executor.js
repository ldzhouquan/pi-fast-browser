/**
 * Executor: page-freshness checks and action execution on the work-panel
 * browser. Port of jev_ultrafast/browser.py (fresh / browser_operation),
 * but all CDP calls go through the plugin host's allowlisted surface.
 *
 * Safety invariant (kept from the original): every executed target is resolved
 * from an observed DOM node id — model output never becomes selectors,
 * coordinates, shell commands, or executable JS.
 */

"use strict";

const cdp = require("./cdp.js");

const SNAPSHOT_SOURCE = require("node:fs").readFileSync(
  require("node:path").join(__dirname, "..", "snapshot.js"),
  "utf8"
);
const MARKER_EXPR = `(() => { const state=${SNAPSHOT_SOURCE}; return state?.marker ?? null; })()`;

class StalePageError extends Error {
  constructor(message) {
    super(message);
    this.name = "StalePageError";
  }
}

/** Fingerprint of a page snapshot (matches browser.py::fingerprint). */
function fingerprint(info) {
  const content = {
    url: info.url,
    text: info.text,
    actions: info.actions,
    scroll: info.scroll,
  };
  const crypto = require("node:crypto");
  return crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/** Re-observe the page: inject snapshot.js and read the info object. */
async function observe() {
  const info = await cdp.evaluate(SNAPSHOT_SOURCE);
  if (!info || typeof info !== "object") {
    throw new StalePageError("Document is navigating");
  }
  info.fingerprint = fingerprint(info);
  return info;
}

/**
 * Freshness check: is the page (or a specific action's node) unchanged since
 * the observation that produced `page`? Port of browser.py::fresh.
 */
async function fresh(page, action = null) {
  try {
    if (action && ["click", "select"].includes(action.kind)) {
      const node = action.node;
      if (typeof node !== "number") return false;
      const current = await cdp.evaluate(
        `(() => { const c=window.__jevFast; return c ? [c.pageKey(), c.guard(c.nodes.get(${node}))] : null; })()`
      );
      if (!current) return false;
      return JSON.stringify(current) === JSON.stringify([page.page_key, page.guards?.[String(node)]]);
    }
    const marker = await cdp.evaluate(MARKER_EXPR);
    return JSON.stringify(marker) === JSON.stringify(page.marker);
  } catch (error) {
    // A destroyed execution context mid-navigation surfaces as a plain
    // Runtime.evaluate error; treat it as "page not fresh" so the loop
    // re-observes instead of killing the run.
    if (error instanceof StalePageError) throw error;
    throw new StalePageError("Page evaluate failed during freshness check");
  }
}

/**
 * Execute one action. `text` is the generated value for fill actions.
 * Returns { executed } on success. Throws StalePageError when the page changed
 * or the target is covered/disabled, and Error for select execution issues.
 */
async function act(action, page, text = null) {
  if (!(await fresh(page, action))) {
    throw new StalePageError("Page changed since this decision. Observe again.");
  }
  const kind = action.kind;

  if (kind === "wait") {
    await cdp.sleep(100);
    return { executed: action.id };
  }

  if (kind === "scroll") {
    await cdp.inputEvent("mouseWheel", {
      x: 550,
      y: 650,
      deltaX: 0,
      deltaY: action.delta,
    });
    return { executed: action.id };
  }

  // click / fill / select all need a live node with valid geometry.
  if (typeof action.node !== "number") {
    throw new Error("Invalid observed node");
  }

  const target = await cdp.evaluate(
    `(action => {
      const e = window.__jevFast?.nodes.get(action.node);
      if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
          !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
      if (action.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return null;
      const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
      if (!e.contains(document.elementFromPoint(x, y))) return null;
      if (action.kind === 'select') {
        if (e.tagName !== 'SELECT' || ![...e.options].some(o => o.value === action.value &&
            !o.disabled && !o.closest('optgroup[disabled]'))) return null;
        e.value = action.value;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { x, y };
    })(${JSON.stringify(action)})`
  );

  if (target == null) {
    if (kind === "select") {
      throw new Error("Dropdown execution was not confirmed; inspect before retrying.");
    }
    throw new StalePageError("Target changed or is covered. Observe again.");
  }

  if (kind !== "select") {
    const { x, y } = target;
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.inputEvent(type, { x, y, button: "left", clickCount: 1 });
    }
    if (kind === "fill") {
      const isMac = require("node:process").platform === "darwin";
      const modifiers = isMac ? 4 : 2; // Meta on macOS, Ctrl elsewhere
      for (const [type, key, code] of [
        ["keyDown", "a", "KeyA"],
        ["keyUp", "a", "KeyA"],
      ]) {
        await cdp.keyEvent(type, { key, code, modifiers, windowsVirtualKeyCode: 65 });
      }
      await cdp.insertText(text ?? "");
    }
  }
  return { executed: action.id };
}

module.exports = { observe, fresh, act, StalePageError, fingerprint, MARKER_EXPR };
