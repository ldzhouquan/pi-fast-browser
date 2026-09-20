# Fast Browser（pi.fast-browser）

基于 Jev 的 PI-Desktop 浏览器智能体。这是 [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) 循环逻辑的 TypeScript/JS 移植版，通过宿主允许的 CDP 接口驱动**工作面板浏览器（work-panel browser）**——不需要 Python、不需要 Browser Harness、不需要单独的 Chrome。

## 为什么这样设计

- **Jev 仍然是路由器（router）**。每一步决策只发一次 TypeSafe 请求，同时决定操作类型和目标元素（动态索引动作空间）。这保留了 jev-ultrafast 高效快速的优势（性能与成本特性）。
- **文本生成使用宿主配置的模型**。当操作是 TYPE_TEXT 时，由 `pi.agent.complete` 生成字段值。模型从宿主已配置的 provider 中自动挑选（优先选择便宜/快速的非推理模型；每次运行的 `text_calls` 中会报告选中的模型 id）。因此插件永远接触不到 API Key，无需用户填写端点，也不会出现容易输错的自由文本 Key 字段。
- **单一浏览器，全程可见**。工作面板浏览器是共享的可见资源——用户可以观看到每一步执行；同一时间只运行一个任务。

## 工具（Tools）

| 工具 | 用途 |
| --- | --- |
| `jev_observe` | 注入 snapshot.js，返回编号元素表 + 页面文本预览 |
| `jev_act` | 按元素索引 / 下拉选项 / 控制命令执行一个操作 |
| `jev_run` | 运行完整循环：导航 → 观察 → Jev 决策 → 执行 → 重复 |
| `jev_wait` | 轮询任务直到 done / blocked / error / canceled 或超时 |
| `jev_cancel` | 停止正在运行的循环 |

## 设置（Settings）

| Key | 默认值 | 用途 |
| --- | --- | --- |
| `typesafeKey` | `""` | TypeSafe API Key（`jev_run` 必需） |
| `typesafeModel` | `jev-latest` | 路由决策使用的模型 id |
| `maxSteps` | 60 | 每次运行的硬性步数预算 |

## 架构（Architecture）

```
main.js            工具注册、设置、bus 接线
lib/cdp.js         pi.browser.cdp 封装（evaluate / input / insertText / waits）
lib/executor.js    observe、fresh（page_key + guard / marker）、act（click / fill / select / scroll / wait）
lib/policy.js      actionSpace、choose（TypeSafe 请求 + 严格校验）、fieldText（agent.complete）
lib/loop.js        RunManager：tick / predict / act 状态机、历史记录、重复检测
snapshot.js        原样取自 jev-ultrafast（107 行，未做任何修改）
```

任务在进程内以 fire-and-forget promise 的方式跟踪：`jev_run` 立即返回 `runId`，`jev_wait` 轮询进度，因此长循环永远不会触发宿主的工具超时限制。进度通过 `fast-browser.run.progress | done | error`（已声明的 bus 主题）广播。

## 安全不变量（继承自原版）

- 模型输出永远不会变成选择器、坐标、shell 命令或可执行 JS——每个目标都从已观察到的 DOM 节点 id 解析。
- 每个决策都绑定到产生它的那次观察（fingerprint / page_key + guard）；页面过期时重新观察、重新决策。
- TypeSafe 响应在真正执行任何操作之前必须通过严格的概率校验。
- 决策在执行前被消费，因此重试永远不会造成重复点击。

## 测试（Test）

```bash
node test/fast-browser.test.js
```

覆盖 actionSpace、validateChoice、postJson 重试、choose（有效/无效响应）、fieldText，以及 RunManager 循环通过 stub 浏览器达到 DONE——无需 CDP、网络或宿主调用。
