# Fast Browser

> **A fast, visible browser agent for PI Desktop — Jev decides; you stay in the loop.**

[中文](#中文) · [English](#fast-browser)

Fast Browser turns a live PI Desktop work-panel browser into a compact, controllable action space. It observes the page as a numbered list of real controls, asks Jev for one constrained decision at a time, performs that action through the host-approved CDP surface, and repeats until the goal is complete, blocked, canceled, or reaches its step budget.

No Python. No Browser Harness. No separate Chrome window. No browser automation API key stored in the plugin.

## Why Fast Browser?

Most browser agents have a trust problem: a model sees a page, writes arbitrary automation code, and hopes the page did not change before that code runs. Fast Browser takes a narrower, more inspectable path.

```text
Your goal
   ↓
Visible work-panel browser → numbered, observed controls → Jev chooses one action
                                                            ↓
                                              freshness check → host CDP execution
                                                            ↓
                                                   observe the new page
```

- **Fast by design.** One TypeSafe/Jev request selects both the next operation and its target from the current action space.
- **Visible by default.** The shared work-panel browser remains on screen, so an agent's progress is easy to follow.
- **Grounded actions.** The model can only choose controls collected from the current DOM—not CSS selectors, screen coordinates, shell commands, or arbitrary JavaScript.
- **Safe against stale pages.** Every decision is tied to an observed page fingerprint and rechecked immediately before execution.
- **Zero extra key handling for text.** When a field needs a value, Fast Browser uses PI Desktop's already configured session model via `agent.complete`; the plugin never receives that model provider's API key.

## Install

### Requirements

- PI Desktop `>= 0.2.0`
- A TypeSafe API key for Jev routing
- At least one model configured in PI Desktop when the task needs text entered into a field

### From the bundled package

1. In PI Desktop's plugin manager, install [`dist/pi.fast-browser-0.2.0.piplug`](dist/pi.fast-browser-0.2.0.piplug).
2. Enable **Fast Browser**.
3. Open the plugin settings and set **TypeSafe API Key** (`typesafeKey`).
4. Optionally change `typesafeModel` (default: `jev-latest`) or the per-run step budget (`maxSteps`, default: `60`).

The routing key is used only for Jev decisions at `api.typesafe.ai`. Field-text generation uses PI Desktop's configured model surface instead of asking you to copy another provider key into the plugin.

## Your first run

Give the agent a URL and a concrete, observable goal:

```text
jev_run(
  url: "https://example.com/search",
  goal: "Search for a round-trip flight from Shanghai to Tokyo next Friday and show the results.",
  maxSteps: 30
)
```

`jev_run` returns immediately with a `runId`. Check on its progress without blocking the agent session:

```text
jev_wait(runId: "run-…", timeoutMs: 20000)
```

You can stop a run at any time:

```text
jev_cancel(runId: "run-…")
```

For a hands-on, inspectable workflow, navigate the work-panel browser yourself, then use `jev_observe` and `jev_act` one action at a time.

## Tools

| Tool | What it does | Best for |
| --- | --- | --- |
| `jev_observe` | Returns a numbered table of the current page's actionable controls plus a text preview. | Inspecting a page before acting. |
| `jev_act` | Executes one observed click, text entry, select, scroll, or wait action. | Manual stepping, debugging, and high-control tasks. |
| `jev_run` | Navigates, then runs the observe → decide → act loop in the background. | End-to-end, multi-step browser tasks. |
| `jev_wait` | Waits for a run to finish or returns its latest state after a timeout. | Tracking progress using a `runId`. |
| `jev_cancel` | Marks a running loop for cancellation. | Taking back control of the shared browser. |

### Manual example

```text
# 1. Inspect the current page
jev_observe()

# 2. Use an index from the returned table
jev_act(target: "3")

# 3. Type into an observed editable field
jev_act(target: "5", text: "Tokyo")

# 4. Select option 2 of observed select control 6
jev_act(target: "6:2")
```

For a text field, omitting `text` asks the host-configured model to infer a value from the task and page context. If the value is missing or uncertain, it types nothing rather than inventing personal information.

## What happens during a run

1. **Navigate and observe.** The plugin snapshots DOM-backed actions and renders them as a small numbered action space.
2. **Decide.** Jev receives the current page, the goal, recent actions, and the offered operations. It chooses an operation and, where needed, a target in one request.
3. **Validate.** The response must contain valid probabilities for every available choice; an invalid response executes nothing.
4. **Act.** Fast Browser rechecks the page and target before it clicks, fills, selects, scrolls, or waits.
5. **Repeat.** It observes the resulting page and continues until `done`, `blocked`, `error`, `canceled`, or the step limit.

Finished runs are eligible for in-memory cleanup after 10 minutes when a new run starts. Only one run can use the work-panel browser at a time.

## Guardrails and boundaries

Fast Browser is deliberately designed for **visible, DOM-backed browser work**. It is useful for research, forms, searches, and repeatable navigation where you want the actions to remain grounded in what is actually on the page.

- Page text is treated as untrusted content, not as instructions for the agent.
- A page change invalidates the earlier decision; Fast Browser observes again instead of applying a stale action.
- Click and select targets must still be visible and unobscured when execution begins.
- The agent does not generate selectors, coordinate clicks, shell commands, or executable page scripts.
- The plugin does not invent missing personal data for form fields.
- CAPTCHA challenges, controls that are not exposed as supported DOM actions, and workflows requiring a human judgment or authorization may leave a run `blocked`.

As with any browser automation, review consequential actions—especially submissions, purchases, account changes, and messages—before initiating them.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `typesafeKey` | `""` | TypeSafe API key used for Jev routing. Required by `jev_run`. |
| `typesafeModel` | `jev-latest` | TypeSafe model ID used to choose browser operations. |
| `maxSteps` | `60` | Hard maximum number of executed or skipped actions in one run. Per-run `maxSteps` can override it. |

## Architecture

```text
main.js             PI Desktop tool, settings, service, and event wiring
snapshot.js          Page snapshot that discovers usable DOM actions
lib/cdp.js           Approved CDP evaluation and input primitives
lib/executor.js      Observation, freshness checks, visibility checks, execution
lib/policy.js        Jev decision request/validation and host-model text helper
lib/loop.js          Background run queue, state machine, history, cancellation
```

Run events are published on the PI Desktop bus:

- `fast-browser.run.progress`
- `fast-browser.run.done`
- `fast-browser.run.error`

## Development

The repository has no runtime npm dependency. Run the logic suite with Node:

```bash
node test/fast-browser.test.js
```

The tests cover the indexed action space, strict decision validation, retry behavior, text-model selection, and an end-to-end `RunManager` loop with a stubbed browser. They do not require CDP, a network connection, or a PI Desktop host.

## License

[MIT](manifest.json)

---

# 中文

> **面向 PI Desktop 的快速、可见浏览器智能体：Jev 负责决策，你始终掌握进度。**

Fast Browser 将 PI Desktop 的工作面板浏览器转化为一个紧凑、可控的动作空间：它先把页面上真实可用的控件整理成带编号的列表，再让 Jev 每次只从当前可选动作中做一个受约束的决策，随后通过宿主许可的 CDP 接口执行，并循环直到任务完成、受阻、取消或达到步数上限。

无需 Python，无需 Browser Harness，无需单独打开 Chrome，也不需要在插件中保存浏览器自动化模型的 API Key。

## 为什么选 Fast Browser？

许多浏览器智能体的问题在于：模型看完页面后生成任意自动化代码，而页面可能已经变化。Fast Browser 选择了更窄、更可检查的路径。

```text
你的目标
   ↓
可见的工作面板浏览器 → 已观察到的编号控件 → Jev 选择一个动作
                                               ↓
                                  页面新鲜度校验 → 宿主 CDP 执行
                                               ↓
                                         再次观察新页面
```

- **为速度而生。** 每一步仅用一次 TypeSafe/Jev 请求，同时选择下一种操作和目标控件。
- **全程可见。** 工作面板浏览器始终在屏幕上，执行过程一目了然。
- **动作有据可查。** 模型只能选择当前 DOM 中已收集的控件，不能生成 CSS 选择器、屏幕坐标、Shell 命令或任意 JavaScript。
- **避免过期操作。** 每个决策均绑定到对应页面指纹，并在执行前立即复检。
- **不用额外管理文本模型 Key。** 填写字段时，插件通过 `agent.complete` 调用 PI Desktop 中已配置的会话模型；插件不会接触该模型提供商的 API Key。

## 安装

### 前置条件

- PI Desktop `>= 0.2.0`
- 用于 Jev 路由决策的 TypeSafe API Key
- 如任务需要填写文本字段，PI Desktop 中至少配置一个可用模型

### 安装内置包

1. 在 PI Desktop 的插件管理器中安装 [`dist/pi.fast-browser-0.2.0.piplug`](dist/pi.fast-browser-0.2.0.piplug)。
2. 启用 **Fast Browser**。
3. 打开插件设置，填写 **TypeSafe API Key**（`typesafeKey`）。
4. 如有需要，调整 `typesafeModel`（默认 `jev-latest`）或步数上限 `maxSteps`（默认 `60`）。

路由 Key 仅用于向 `api.typesafe.ai` 请求 Jev 决策。字段文本则使用 PI Desktop 已配置的模型能力，无需把另一家模型服务的 Key 复制进插件。

## 第一次运行

向智能体提供 URL 和一个清晰、可观察的目标：

```text
jev_run(
  url: "https://example.com/search",
  goal: "搜索下周五从上海到东京的往返航班，并展示搜索结果。",
  maxSteps: 30
)
```

`jev_run` 会立即返回 `runId`。用它查看进度，而不会阻塞当前智能体会话：

```text
jev_wait(runId: "run-…", timeoutMs: 20000)
```

随时停止任务：

```text
jev_cancel(runId: "run-…")
```

如果你需要逐步确认，可先自行导航工作面板浏览器，再使用 `jev_observe` 和 `jev_act` 一步步操作。

## 工具一览

| 工具 | 功能 | 适用场景 |
| --- | --- | --- |
| `jev_observe` | 返回当前页面可操作控件的编号表和页面文本预览。 | 操作前检查页面。 |
| `jev_act` | 执行一次已观察到的点击、输入、选择、滚动或等待。 | 手动逐步操作、调试、需要更高控制度的任务。 |
| `jev_run` | 负责导航，并在后台运行「观察 → 决策 → 执行」循环。 | 多步骤端到端浏览器任务。 |
| `jev_wait` | 等待任务结束，或在超时后返回最新状态。 | 基于 `runId` 跟踪进度。 |
| `jev_cancel` | 标记并取消正在运行的循环。 | 收回对共享浏览器的控制权。 |

### 手动操作示例

```text
# 1. 检查当前页面
jev_observe()

# 2. 使用返回表中的元素编号
jev_act(target: "3")

# 3. 向可编辑字段输入文本
jev_act(target: "5", text: "东京")

# 4. 选择编号为 6 的下拉控件中的第 2 个选项
jev_act(target: "6:2")
```

对于文本输入框，如果省略 `text`，插件会让宿主已配置的模型根据目标和页面上下文推断填写内容。若信息缺失或无法确定，插件不会擅自编造个人信息，也不会输入内容。

## 一次运行如何进行

1. **导航并观察。** 插件快照 DOM 中的可用动作，并把它们构造成小型编号动作空间。
2. **决策。** Jev 接收当前页面、任务目标、最近动作和可选操作，在一次请求中选出操作及其目标。
3. **校验。** 返回结果必须为每个可选项提供有效概率；不合法的结果不会执行任何动作。
4. **执行。** 点击、填写、选择、滚动或等待之前，Fast Browser 会再次确认页面和目标仍然有效。
5. **循环。** 它观察执行后的页面，直至状态变为 `done`、`blocked`、`error`、`canceled`，或达到步数上限。

新的任务启动时，已结束且超过 10 分钟的任务详情会从内存中清理。由于工作面板浏览器是共享资源，同一时间只能运行一个任务。

## 安全边界与适用范围

Fast Browser 专为**可见且由 DOM 支持的浏览器工作**设计。它适合需要基于页面真实状态完成的搜索、表单、研究和重复导航任务。

- 页面文本被视为不可信内容，而不是给智能体的指令。
- 页面变化会让旧决策失效；插件会重新观察，而不是执行过期操作。
- 点击和选择目标在执行时必须依然可见且未被遮挡。
- 智能体不会生成选择器、坐标点击、Shell 命令或可执行页面脚本。
- 插件不会为表单字段杜撰缺失的个人数据。
- 验证码、未以受支持 DOM 动作暴露的控件，以及需要人工判断或授权的流程，可能使任务处于 `blocked` 状态。

与任何浏览器自动化工具一样，在启动提交、购买、账户变更或发送消息等重要操作前，请先审阅即将执行的结果。

## 设置项

| Key | 默认值 | 说明 |
| --- | --- | --- |
| `typesafeKey` | `""` | 用于 Jev 路由决策的 TypeSafe API Key；`jev_run` 必填。 |
| `typesafeModel` | `jev-latest` | 用来选择浏览器操作的 TypeSafe 模型 ID。 |
| `maxSteps` | `60` | 单次任务中可执行或跳过动作的硬性上限；可由 `jev_run` 的 `maxSteps` 单独覆盖。 |

## 架构

```text
main.js             PI Desktop 工具、设置、后台服务和事件注册
snapshot.js          页面快照，发现可用的 DOM 动作
lib/cdp.js           经许可的 CDP 求值与输入原语
lib/executor.js      观察、新鲜度与可见性检查、动作执行
lib/policy.js        Jev 决策请求/校验，以及宿主模型文本助手
lib/loop.js          后台任务队列、状态机、历史记录与取消机制
```

任务事件会发布到 PI Desktop bus：

- `fast-browser.run.progress`
- `fast-browser.run.done`
- `fast-browser.run.error`

## 开发与测试

项目没有运行时 npm 依赖，可直接使用 Node 运行逻辑测试：

```bash
node test/fast-browser.test.js
```

测试覆盖编号动作空间、严格决策校验、重试行为、文本模型选择，以及使用 stub 浏览器的端到端 `RunManager` 循环；不需要 CDP、网络连接或 PI Desktop 宿主环境。

## 许可证

[MIT](manifest.json)

## 附加内容（Additions）

- **[`skills/fast-browser/SKILL.md`](skills/fast-browser/SKILL.md)** — The fast-browser (JEV) skill doc: drive the work-panel browser via the observe → act workflow, and the boundary between JEV and CDP `evaluate`。fast-browser（JEV）技能说明：内置浏览器 UI 自动化的使用规范，以及 JEV 与 CDP evaluate 的分工边界。
- **[`scripts/pi-cookie-import/`](scripts/pi-cookie-import/README.md)** — Chrome Cookie → PI-Desktop import tool: decrypt Chrome's login cookies into the work-panel browser so Jev tasks can access logged-in sites (macOS)。Chrome Cookie 导入工具：把 Chrome 的登录 Cookie 解密导入内置浏览器，使 Jev 任务能以已登录状态访问需要登录的站点。用法与安全说明见其 [README](scripts/pi-cookie-import/README.md)。
