# Fast Browser (pi.fast-browser)

Jev-powered browser agent for PI-Desktop. A TypeScript/JS port of
[jev-ultrafast](https://github.com/browser-use/jev-ultrafast)'s loop that drives
the **work-panel browser** through the host's allowlisted CDP surface — no
Python, no Browser Harness, no separate Chrome.

## Why this design

- **Jev stays the router.** One TypeSafe request per decision decides both the
  operation and the target element (dynamic indexed action space). This keeps
  the performance/cost profile that makes jev-ultrafast fast.
- **Text generation uses a host-configured model.** When the operation is
  TYPE_TEXT, `pi.agent.complete` generates the field value. The model is
  auto-picked from the host's configured providers (preferring cheap/fast
  non-reasoning models; the picked id is reported in each run's text_calls), so
  the plugin never sees API keys, never asks for an endpoint, and there is no
  free-text key field that can be mistyped.
- **One browser, visible.** The work-panel browser is a shared visible resource
  — the user can watch every step; a single run is enforced at a time.

## Tools

| Tool | Purpose |
| --- | --- |
| `jev_observe` | Inject snapshot.js, return the numbered element table + page text |
| `jev_act` | Execute one action by index / select option / control id |
| `jev_run` | Run the full loop: navigate → observe → Jev decision → execute → repeat |
| `jev_wait` | Poll a run to done/blocked/error/canceled or timeout |
| `jev_cancel` | Stop a running loop |

## Settings

| Key | Default | Purpose |
| --- | --- | --- |
| `typesafeKey` | "" | TypeSafe API key (required for `jev_run`) |
| `typesafeModel` | `jev-latest` | Routing model id |
| `maxSteps` | 60 | Hard step budget per run |

## Architecture

```
main.js            tool registration, settings, bus wiring
lib/cdp.js         pi.browser.cdp wrappers (evaluate / input / insertText / waits)
lib/executor.js    observe, fresh (page_key+guard / marker), act (click/fill/select/scroll/wait)
lib/policy.js      actionSpace, choose (TypeSafe request + strict validation), fieldText (agent.complete)
lib/loop.js        RunManager: tick/predict/act state machine, history, repetition detection
snapshot.js        verbatim from jev-ultrafast (107 lines, no changes)
```

Runs are tracked in-process as fire-and-forget promises: `jev_run` returns a
`runId` immediately, `jev_wait` polls, so the host's tool-timeout limits are
never hit by long loops. Progress is broadcast on
`fast-browser.run.progress|done|error` (declared bus topics).

## Safety invariants (kept from the original)

- Model output never becomes selectors, coordinates, shell commands, or
  executable JS — every target is resolved from an observed DOM node id.
- Every decision is bound to the observation that produced it (fingerprint /
  page_key + guard); stale pages re-observe and re-decide.
- TypeSafe responses must pass strict probability validation before anything
  executes.
- Decisions are consumed before execution, so retries can never double-click.

## Test

```bash
node test/fast-browser.test.js
```

Covers actionSpace, validateChoice, postJson retry, choose (valid/invalid
responses), fieldText, and the RunManager loop reaching DONE through a stubbed
browser — no CDP, no network, no host calls.
