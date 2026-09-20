/**
 * CDP transport for the Fast Browser plugin.
 *
 * All browser control goes through the host's `pi.browser.cdp({ method,
 * params })`, which is gated by the `browser.cdp` permission and restricted to
 * the host allowlist (Runtime.evaluate, Input.*, DOM.getBoxModel, ...).
 * This module is the only place that touches the browser, so the executor and
 * loop stay portable and testable with a stubbed transport.
 */

"use strict";

/** Evaluate an expression in the page; returns the value or throws. */
async function evaluate(expression, { awaitPromise = true } = {}) {
  const response = await pi.browser.cdp({
    method: "Runtime.evaluate",
    params: { expression, returnByValue: true, awaitPromise },
  });
  if (response?.exceptionDetails) {
    const detail =
      response.exceptionDetails.exception?.description ||
      response.exceptionDetails.text ||
      "Runtime.evaluate threw";
    throw new Error(`Page evaluate failed: ${detail}`);
  }
  return response?.result?.value;
}

/** Dispatch an input event (mouseWheel / mousePressed / mouseReleased / ...). */
async function inputEvent(type, params) {
  return pi.browser.cdp({
    method: "Input.dispatchMouseEvent",
    params: { type, ...params },
  });
}

/** Send a key event (keyDown / keyUp / rawKeyDown / ...). */
async function keyEvent(type, params) {
  return pi.browser.cdp({
    method: "Input.dispatchKeyEvent",
    params: { type, ...params },
  });
}

/** Insert text at the current focus (replaces selection). */
async function insertText(text) {
  return pi.browser.cdp({
    method: "Input.insertText",
    params: { text },
  });
}

/** Small sleep helper (ms). */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait after an executed fill for the page to settle:
 *  - combobox: up to 200ms for a visible suggestion panel
 *  - others: at most two animation frames or 50ms
 * Mirrors browser.py observe()'s after_input logic; runs read-only.
 */
async function waitAfterInput(action) {
  const fieldNode = action?.node;
  const isCombobox = action?.kind === "fill" && fieldNode != null;
  const expression = `(async () => {
    const action = ${JSON.stringify(action)};
    const field = window.__jevFast?.nodes.get(action?.node);
    const autocomplete = action?.kind === 'fill' && field?.getAttribute('role') === 'combobox';
    let frames = 0, stopped = false;
    const finish = () => { stopped = true; };
    const deadline = Date.now() + (autocomplete ? 200 : 50);
    const ready = () => {
      if (stopped) return;
      const ids = (field?.getAttribute('aria-controls') || field?.getAttribute('aria-owns') || '')
        .split(/\\s+/).filter(Boolean);
      const roots = ids.length ? ids.map(id => document.getElementById(id)).filter(Boolean) : [document];
      const options = roots.flatMap(root => [...root.querySelectorAll('[role="option"]')]);
      if (++frames >= 2 && (!autocomplete || options.some(e => {
        const r = e.getBoundingClientRect();
        return r.width && r.height && r.bottom > 0 && r.top < innerHeight &&
          e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }))) { finish(); return; }
      if (Date.now() >= deadline) { finish(); return; }
      requestAnimationFrame(ready);
    };
    requestAnimationFrame(ready);
    await new Promise(resolve => {
      const t = setInterval(() => { if (stopped) { clearInterval(t); resolve(); } }, 10);
      setTimeout(() => { if (!stopped) { stopped = true; clearInterval(t); resolve(); } }, 350);
    });
  })()`;
  try {
    await evaluate(expression);
  } catch {
    // Read-only; navigation during the wait is fine.
  }
}

module.exports = { evaluate, inputEvent, keyEvent, insertText, sleep, waitAfterInput };
