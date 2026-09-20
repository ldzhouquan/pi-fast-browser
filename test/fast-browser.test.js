/**
 * Test suite for io.github.ldzhouquan.fast-browser (Fast Browser) ported logic.
 *
 * Covers policy (actionSpace, validateChoice, postJson retry, choose with a
 * stubbed fetch, fieldText with a stubbed host) and the RunManager loop's
 * terminal behavior with a stubbed browser. Pure logic only — no CDP, no
 * network, no host calls.
 */

"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const pluginRoot = __dirname + "/..";

// ---------------------------------------------------------------------------
// Helpers: stub globalThis.pi (host API surface used by policy/loop/executor).
// ---------------------------------------------------------------------------

function makePiStub() {
  return {
    browser: {
      navigate: async () => ({}),
      cdp: async ({ method, params }) => {
        throw new Error(`unexpected cdp call ${method} in pure-logic test`);
      },
    },
    agent: { complete: async (input) => ({ text: "{\"text\":\"Zurich\"}", modelKey: input?.modelKey, usage: {} }) },
    models: { list: async () => [{ key: "test/model", modelId: "model" }] },
    plugin: { getSettings: async () => ({}) },
    net: { fetch: async () => { throw new Error("no net.fetch in pure-logic test"); } },
    bus: { publish: async () => ({}) },
  };
}

function loadModule(name, pi) {
  globalThis.pi = pi;
  const filename = path.join(pluginRoot, name);
  const code = fs.readFileSync(filename, "utf8");
  const module = { exports: {} };
  // Evaluate in this realm so assertions compare equal arrays.
  const wrapped = new Function("module", "exports", "require", "__dirname", "__filename", "pi", code + "\n;return module.exports;");
  return wrapped(module, module.exports, (id) => {
    if (id === "./cdp.js") return require(path.join(pluginRoot, "lib/cdp.js"));
    if (id === "./policy.js") return loadModule("lib/policy.js", pi);
    if (id === "./executor.js") return loadModule("lib/executor.js", pi);
    if (id === "./loop.js") return loadModule("lib/loop.js", pi);
    if (id === "node:fs") return require("node:fs");
    if (id === "node:path") return require("node:path");
    if (id === "node:crypto") return require("node:crypto");
    if (id === "node:process") return require("node:process");
    return require(id);
  }, path.dirname(filename), filename, pi);
}

// ---------------------------------------------------------------------------
// 1. actionSpace
// ---------------------------------------------------------------------------

function testActionSpace() {
  const policy = loadModule("lib/policy.js", makePiStub());
  const actions = [
    { id: "e1", node: 1, kind: "click", role: "button", label: "Search", value: "" },
    { id: "e2", node: 2, kind: "fill", role: "combobox", label: "Where to?", value: "" },
    { id: "e3", node: 3, kind: "select", role: "combobox", label: "Travelers → 1 adult", value: "1", current_value: "1 adult" },
    { id: "e4", node: 3, kind: "select", role: "combobox", label: "Travelers → 2 adults", value: "2", current_value: "1 adult" },
    { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
    { id: "wait", kind: "wait", label: "Wait for the page to update" },
  ];
  const { elements, targets, controls } = policy.actionSpace(actions);
  assert.strictEqual(elements.length, 3);
  assert.deepStrictEqual(elements[0].operations, ["CLICK"]);
  assert.deepStrictEqual(elements[1].operations, ["TYPE_TEXT"]);
  assert.deepStrictEqual(elements[2].operations, ["SELECT"]);
  assert.deepStrictEqual(Object.keys(targets), ["CLICK", "TYPE_TEXT", "SELECT"]);
  assert.strictEqual(Object.keys(targets.SELECT).length, 2);
  assert.ok("3:1" in targets.SELECT && "3:2" in targets.SELECT);
  assert.deepStrictEqual(Object.keys(controls), ["SCROLL_DOWN", "WAIT"]);
  console.log("  ✓ actionSpace");
}

// ---------------------------------------------------------------------------
// 2. validateChoice
// ---------------------------------------------------------------------------

function testValidateChoice() {
  const policy = loadModule("lib/policy.js", makePiStub());
  const ids = ["e1", "e2", "e3"];
  // valid
  policy.validateChoice(
    { choice: "e2", probabilities: { e1: 0.1, e2: 0.8, e3: 0.1 }, confidence: 0.8 },
    ids
  );
  // invalid: choice not in ids
  assert.throws(() => policy.validateChoice({ choice: "e9", probabilities: { e1: 0.1, e2: 0.8, e3: 0.1 }, confidence: 0.8 }, ids));
  // invalid: probabilities don't sum to 1
  assert.throws(() => policy.validateChoice({ choice: "e2", probabilities: { e1: 0.5, e2: 0.5, e3: 0.5 }, confidence: 0.5 }, ids));
  // invalid: chosen not the max
  assert.throws(() => policy.validateChoice({ choice: "e1", probabilities: { e1: 0.1, e2: 0.8, e3: 0.1 }, confidence: 0.8 }, ids));
  // invalid: probability out of range
  assert.throws(() => policy.validateChoice({ choice: "e2", probabilities: { e1: 0.1, e2: 1.5, e3: -0.6 }, confidence: 0.8 }, ids));
  console.log("  ✓ validateChoice");
}

// ---------------------------------------------------------------------------
// 3. postJson retry
// ---------------------------------------------------------------------------

async function testPostJsonRetry() {
  const policy = loadModule("lib/policy.js", makePiStub());
  let calls = 0;
  const fetchStub = async () => {
    calls += 1;
    if (calls < 3) return { status: 503, ok: false, text: async () => "slow" };
    return { status: 200, ok: true, json: async () => ({ hello: "world" }) };
  };
  const result = await awaitOrThrow(policy.postJson("https://x.test", "key", {}, { fetch: fetchStub }));
  assert.strictEqual(calls, 3, "retried twice then succeeded");
  assert.strictEqual(result.hello, "world");
  let c2 = 0;
  const fetch400 = async () => {
    c2 += 1;
    return { status: 400, ok: false, text: async () => "bad" };
  };
  await assert.rejects(() => policy.postJson("https://x.test", "key", {}, { fetch: fetch400 }));
  assert.strictEqual(c2, 1, "no retry on 400");
  console.log("  ✓ postJson retry");
}

// ---------------------------------------------------------------------------
// 4. choose with stubbed fetch
// ---------------------------------------------------------------------------

async function testChoose() {
  const policy = loadModule("lib/policy.js", makePiStub());
  const page = {
    url: "https://example.com",
    title: "Flights",
    text: "Search flights",
    actions: [
      { id: "e1", node: 1, kind: "click", role: "button", label: "Search", value: "" },
      { id: "e2", node: 2, kind: "fill", role: "combobox", label: "Where to?", value: "" },
    ],
  };
  const settings = { typesafeKey: "k", typesafeModel: "jev-latest", maxSteps: 60 };
  // valid response: CLICK on e1
  const fetchStub = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      model: "jev-latest",
      usage: {},
      answers: {
        operation: { choice: "CLICK", probabilities: { CLICK: 0.6, TYPE_TEXT: 0.4, DONE: 0.0, BLOCKED: 0.0 }, confidence: 0.6 },
        click_target: { choice: "1", probabilities: { "1": 1.0 }, confidence: 1.0 },
      },
    }),
  });
  const decision = await policy.choose(page, "Search flights", [], settings, fetchStub);
  assert.strictEqual(decision.operation, "CLICK");
  assert.strictEqual(decision.target, "1");
  assert.strictEqual(decision.choice, "e1");
  assert.ok(decision.latency_ms >= 0);

  // invalid response: probabilities don't cover all ids → throws
  const badFetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      model: "jev-latest",
      usage: {},
      answers: {
        operation: { choice: "CLICK", probabilities: { CLICK: 0.6, TYPE_TEXT: 0.4, DONE: 0.0, BLOCKED: 0.0 }, confidence: 0.6 },
        click_target: { choice: "1", probabilities: { "1": 0.9 }, confidence: 0.9 },
      },
    }),
  });
  await assert.rejects(() => policy.choose(page, "Search flights", [], settings, badFetch));

  // missing key → clear error before any fetch
  await assert.rejects(
    () => policy.choose(page, "goal", [], { typesafeKey: "", typesafeModel: "jev-latest", maxSteps: 60 }, fetchStub),
    /typesafeKey/
  );
  console.log("  ✓ choose");
}

// ---------------------------------------------------------------------------
// 5. fieldText
// ---------------------------------------------------------------------------

async function testFieldText() {
  const pi = makePiStub();
  // models.list exposes a fast cheap model and a slow expensive one.
  pi.models.list = async () => [
    { key: "anthropic/claude-sonnet-4-6", modelId: "claude-sonnet-4-6", providerName: "Anthropic" },
    { key: "deepseek/deepseek-chat", modelId: "deepseek-chat", providerName: "DeepSeek" },
  ];
  const policy = loadModule("lib/policy.js", pi);
  // pickTextModel prefers the cheap/fast one.
  // Cheap/fast beats expensive when no default is marked.
  const pick = policy.pickTextModel([
    { key: "anthropic/claude-sonnet-4-6" },
    { key: "deepseek/deepseek-chat" },
  ]);
  assert.strictEqual(pick.key, "deepseek/deepseek-chat", "prefers cheap/fast model");
  // But the host's default model wins when present (account-restricted APIs).
  const pickDefault = policy.pickTextModel([
    { key: "anthropic/claude-sonnet-4-6", isDefault: true },
    { key: "deepseek/deepseek-chat" },
  ]);
  assert.strictEqual(pickDefault.key, "anthropic/claude-sonnet-4-6", "prefers isDefault model");
  const ctx = { goal: "fly to Zurich", field: { label: "Where to?", role: "combobox", value: "" }, page: { title: "Flights", text: "" }, recent_actions: [] };
  const gen = await policy.fieldText(ctx);
  assert.strictEqual(gen.value, "Zurich");
  assert.strictEqual(gen.helper.model, "deepseek/deepseek-chat", "reports the picked model");
  console.log("  ✓ fieldText (auto-pick model)");
}

// ---------------------------------------------------------------------------
// 6. RunManager loop — terminal behavior with a stubbed browser
// ---------------------------------------------------------------------------

function testRunManager() {
  const pi = makePiStub();
  // Stub the browser surface the loop touches: navigate + evaluate.
  pi.browser.navigate = async () => ({});
  pi.browser.cdp = async ({ method, params }) => {
    if (method === "Runtime.evaluate") {
      const expr = params?.expression ?? "";
      const isRawSnapshot = expr.trimStart().startsWith("(() => {") && !expr.includes("const state=");
      // snapshot.js: return a minimal page info on first evaluate
      if (isRawSnapshot) {
        return {
          result: {
            value: {
              url: "https://example.com",
              title: "Flights",
              text: "",
              w: 1200,
              h: 800,
              scroll: { y: 0, height: 800 },
              actions: [{ id: "e1", node: 1, kind: "click", role: "button", label: "Search", value: "" }],
              marker: ["m"],
              page_key: [["k"]],
              guards: { "1": ["g"] },
              omitted_actions: 0,
            },
          },
        };
      }
      // MARKER / fresh checks: stable marker
      if (expr.includes("marker")) {
        return { result: { value: ["m"] } };
      }
      if (expr.includes("pageKey")) {
        return { result: { value: [["k"], ["g"]] } };
      }
      return { result: { value: undefined } };
    }
    return { result: { value: undefined } };
  };

  const { RunManager } = loadModule("lib/loop.js", pi);
  const manager = new RunManager();
  manager._onEvent = (event) => {
    if (event === "done") manager._lastEvent = "done";
  };

  // Stub policy.choose to return DONE immediately.
  const policy = loadModule("lib/policy.js", pi);
  const originalChoose = policy.choose;
  // Monkey-patch the module's exported choose by replacing the require cache? Easier:
  // RunManager imports policy via require('./policy.js') in its module; we can't
  // easily patch that here, so instead we test the state machine with a real
  // choose that returns DONE through a stubbed fetch.
  // choose() uses pi.net.fetch (host contract { status, bodyText }) when no
  // fetchImpl is injected — return a DONE decision.
  pi.net.fetch = async () => ({
    status: 200,
    bodyText: JSON.stringify({
      model: "jev-latest",
      usage: {},
      answers: {
        operation: { choice: "DONE", probabilities: { CLICK: 0.0, DONE: 1.0, BLOCKED: 0.0 }, confidence: 1.0 },
      },
    }),
  });
  // Need choose to see ids including DONE etc. — the operation head criteria keys
  // come from targets + controls + DONE/BLOCKED, matching our stub. Good.

  const run = manager.createRun({
    url: "https://example.com",
    goal: "Search",
    settings: { typesafeKey: "k", typesafeModel: "jev-latest", maxSteps: 60 },
    maxSteps: 60,
  });
  manager.startWorker();
  manager.enqueue(run);
  // Wait for the worker (service context in production) to finish.
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      const s = manager.status(run.runId);
      if (s && !["running", "starting"].includes(s.status)) {
        clearInterval(t);
        try {
          assert.strictEqual(s.status, "done", `expected done, got ${s.status} (${s.error})`);
          console.log("  ✓ RunManager loop DONE");
          resolve();
        } catch (e) {
          reject(e);
        }
      }
    }, 20);
    setTimeout(() => { clearInterval(t); reject(new Error("run did not finish in time")); }, 3000);
  });
}

function testSkipFill() {
  const pi = makePiStub();
  pi.browser.navigate = async () => ({});
  // Page has one fillable field; observe returns it.
  const pageInfo = {
    url: "https://example.com",
    title: "Form",
    text: "",
    w: 1200,
    h: 800,
    scroll: { y: 0, height: 800 },
    actions: [{ id: "e1", node: 1, kind: "fill", role: "combobox", label: "Where to?", value: "" }],
    marker: ["m"],
    page_key: [["k"]],
    guards: { "1": ["g"] },
    omitted_actions: 0,
  };
  let rawSnapshotCount = 0;
  let actCalls = [];
  pi.browser.cdp = async ({ method, params }) => {
    if (method !== "Runtime.evaluate") return { result: { value: undefined } };
    const expr = params?.expression ?? "";
    const isRawSnapshot = expr.trimStart().startsWith("(() => {") && !expr.includes("const state=");
    if (isRawSnapshot) {
      rawSnapshotCount += 1;
      return { result: { value: pageInfo } };
    }
    if (expr.includes("marker")) return { result: { value: ["m"] } };
    if (expr.includes("pageKey")) return { result: { value: [["k"], ["g"]] } };
    return { result: { value: undefined } };
  };
  // net.fetch returns TYPE_TEXT decision on first call, then DONE.
  let netCalls = 0;
  pi.net.fetch = async () => {
    netCalls += 1;
    const body = netCalls === 1
      ? { answers: { operation: { choice: "TYPE_TEXT", probabilities: { TYPE_TEXT: 1.0, DONE: 0.0, BLOCKED: 0.0 }, confidence: 1.0 }, type_text_target: { choice: "1", probabilities: { "1": 1.0 }, confidence: 1.0 } } }
      : { answers: { operation: { choice: "DONE", probabilities: { TYPE_TEXT: 0.0, DONE: 1.0, BLOCKED: 0.0 }, confidence: 1.0 } } };
    return { status: 200, bodyText: JSON.stringify({ model: "jev-latest", usage: {}, ...body }) };
  };
  // agent.complete always FAILS (returns null text per the prompt contract).
  pi.agent.complete = async (input) => ({ text: "{\"text\": null}", modelKey: input?.modelKey, usage: {} });
  pi.models.list = async () => [{ key: "test/model", modelId: "model" }];

  const { RunManager } = loadModule("lib/loop.js", pi);
  const manager = new RunManager();
  // Spy on executor.act by wrapping after load: the loop calls executor.act,
  // which would dispatch CDP Input events — our stub returns undefined, so
  // act would throw "Invalid observed node" only if reached. We instead assert
  // via netCalls: fill->skip must NOT call act, and the loop must continue to
  // DONE on the second decision.
  const run = manager.createRun({
    url: "https://example.com",
    goal: "Fill it",
    settings: { typesafeKey: "k", typesafeModel: "jev-latest", maxSteps: 10 },
    maxSteps: 10,
  });
  manager.startWorker();
  manager.enqueue(run);
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      const s = manager.status(run.runId);
      if (s && !["running", "starting"].includes(s.status)) {
        clearInterval(t);
        try {
          assert.strictEqual(s.status, "done", `expected done, got ${s.status} (${s.error})`);
          assert.strictEqual(s.stepCount, 1, "one skipped fill step counted");
          assert.strictEqual(netCalls, 2, "TYPE_TEXT then DONE");
          console.log("  ✓ RunManager skipFill (failed text never wipes field)");
          resolve();
        } catch (e) {
          reject(e);
        }
      }
    }, 20);
    setTimeout(() => { clearInterval(t); reject(new Error("skipFill run did not finish")); }, 3000);
  });
}

function awaitOrThrow(promise) {
  return Promise.resolve(promise).catch((e) => {
    throw e;
  });
}

// ---------------------------------------------------------------------------

async function main() {
  console.log("policy:");
  testActionSpace();
  testValidateChoice();
  await testPostJsonRetry();
  await testChoose();
  await testFieldText();
  console.log("loop:");
  await testRunManager();
  await testSkipFill();
  console.log("\nALL TESTS PASSED ✅");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
