---
name: fast-browser
description: Drive PI-Desktop's built-in work-panel browser with the fast-browser (JEV) tools: observe the page as a numbered element table, then click/type/select by index. Use for all UI navigation and interaction. CDP evaluate is only for page-script checks (cookies, URL, network).
---

# Fast Browser (JEV) — PI-Desktop 内置浏览器 UI 自动化

## 何时用本技能

内置浏览器（work-panel browser）的所有 **UI 操作**都走 fast-browser（JEV）工具：
点击菜单/按钮/标签、填输入框、选下拉选项、滚动页面、多步导航、读取页面可见内容。

**不要**用 CDP `evaluate` 做这些事（CDP evaluate 只用于跑页面脚本，见下方边界）。

## 工具清单

| 工具 | 作用 |
|---|---|
| `plugin_pi_fast_browser_jev_observe` | 注入 Jev DOM 快照，返回**编号元素表**（index、role、label、value、ops）+ 页面文本预览。每次调用重新观察当前页。页面不变时元素索引稳定。 |
| `plugin_pi_fast_browser_jev_act` | 执行一个操作：`target` 为元素索引（`"3"`）、下拉选项（`"6:2"`）或控制命令（`scroll_down`/`scroll_up`/`wait`）。文本输入传 `text`。返回执行结果 + 刷新后的元素表。 |
| `plugin_pi_fast_browser_jev_run` | 全自动循环：导航到 url → observe → Jev 决策 → 执行，直到完成/阻塞/出错。适合明确目标的一次性任务。 |
| `plugin_pi_fast_browser_jev_wait` | 等 `jev_run` 到达终态（done/blocked/error/canceled）或超时。 |
| `plugin_pi_fast_browser_jev_cancel` | 取消运行中的 `jev_run` 循环。 |

## 标准工作流（UI 操作）

```
1. jev_observe(maxElements=60~100, includeText=true)
   → 拿到编号元素表，从中找到目标元素
2. jev_act(target="<索引>", text="<如需输入>")
   → 点击/输入/选择
3. 页面变化后需要新的元素快照 → 再调 jev_observe（索引会刷新）
```

要点：
- **点击**：用 observe 返回的索引，如 `jev_act(target="5")`
- **下拉选择**：`target="6:2"`（第 6 个元素的第 2 个选项）
- **输入**：`jev_act(target="<textbox 索引>", text="内容")`
- **滚动**：`jev_act(target="scroll_down")` / `"scroll_up"`
- **等页面渲染**：先 `jev_act(target="wait")` 或直接重新 `jev_observe`，若内容没变说明还在加载，再观察一次
- 点击后内容区没切换：URL 变了但元素没变时，重新 observe 等渲染

## 与 CDP evaluate 的分工边界

| 场景 | 用哪个 |
|---|---|
| 点击、输入、导航、读页面 UI | **JEV（本技能）** |
| 读 `document.cookie`、`location.href` | CDP `evaluate` |
| 跑任意页面 JS、查 console/network | CDP `evaluate` / `console` |
| 验证登录态（cookie + 页面 UI） | JEV 看 UI + CDP evaluate 看 cookie |

规则：**UI 交互优先 JEV；只有需要跑页面脚本时才用 CDP evaluate。**
CDP 大多数方法（`Network.setCookies`、`Storage.getCookies`、`Browser.getVersion`）被 allowlist 禁用，不要依赖它们。

## 注意事项

- 每次 `jev_observe` 重新观察页面，元素索引在**页面未变化时**才稳定；操作后必须重新 observe。
- `jev_run` 是自动循环，适合独立任务；交互式逐步操作用手动 observe→act。
- fast-browser 操作的是 PI-Desktop 的 work-panel 浏览器，与 `Browser` 技能（Playwright 无头 `Browse.ts`）是**两套不同浏览器**，不要混用。
