# ADR-004：ui-kit v2.8.0 能力采纳边界：暂不接入玻璃 force 与运行时自检

- 状态：已接受（2026-10-27 部分修订：运行时自检已接入，见 ADR-005；玻璃 force 仍暂缓）
- 日期：2026-10-26
- 相关：无上游 issue；依据上游 ui-kit v2.8.0 的 CHANGELOG/UPGRADING 与前端现状

## 背景

内置 ui-kit 已升级到 v2.8.0（`src/client/index.js:17` 的
`NVUI_MIN_VERSION = '2.8.0'`；`src/client/vendor/ui-kit/nvui-api.js` 头部与
`:55` 的 `VERSION` 均为 v2.8.0）。v2.8.0 是 MINOR、additive：新增 `selfCheck` /
`checkCompatibility` / `defaults`、`--nvui-kit-version`、`.nvui-actions` 与
`createPanel` 的 `glass` 模式，无删除/改名（上游 `CHANGELOG.md:9-30`）。

其中两项能力需要本项目主动接入才会生效：

- **玻璃 force 模式**：`createPanel({ glass: 'force' })` 或
  `panel.setGlassMode('force')`；默认 `auto`，`force` 要求插件显式开启，并在插件设置
  里给用户关闭项；在 `prefers-reduced-transparency` / `forced-colors` / 浏览器不支持时
  自动回退（上游 `UPGRADING.md:51-63`）。
- **运行时自检**：`NVUI.selfCheck({ expect })` 可检查版本、CSS 是否加载、玻璃回退状态
  等（上游 `UPGRADING.md:20-29`）。

本项目现状：

- `createPanel` 调用未传 `glass`，走默认 `auto`（`src/client/index.js:496-513`）；
- `src/` 内没有 `selfCheck` / `checkCompatibility` / `NVUI.defaults` 调用（在 `src/`
  内搜索仅见 `createPanel`）；
- 没有浏览器端自动化测试基建：`package.json` 只有 `node --test tests/*.test.js`，
  无 devDependencies；`tests/` 下 5 个 `.test.js` 全部为 node:test；
- manual-qa 清单尚在建立中：`docs/engineering/manual-qa.md` 为 2026-10-26 同期新增，
  目前是待执行模板，尚无任何执行记录（覆盖范围与执行计划待确认）；
- 设置页没有玻璃相关开关，也没有需求记录（仓库内无 issue 台账）。

## 决策

1. 面板继续使用 `createPanel` 的默认 `glass: 'auto'`，不启用 `force` 模式，不新增玻璃
   相关设置项。
2. 暂不在运行时调用 `NVUI.selfCheck()` / `checkCompatibility()` / `NVUI.defaults`。
3. 先补 manual-qa 清单与最基本的浏览器端测试基建，再评估上述两项能力的接入。
4. v2.8.0 只采纳与现有用法兼容的部分（默认间距、组件默认值、既有 API），不改变现有
   面板契约与无障碍行为。

## 备选方案

- **立即接入 selfCheck，仅 console.warn**：能早发现版本/CSS 不匹配，但当前加载链路已有
  `NVUI_MIN_VERSION` 双闸（`src/client/index.js:171`、`:193`），而 `selfCheck` 的返回值
  没有浏览器测试可断言，`console.warn` 也无法在 CI 中被拦截；留待测试基建，暂缓。
- **立即接入 glass force 并加设置项**：需要覆盖 reduced-transparency / forced-colors /
  旧 Safari 等回退场景（`UPGRADING.md:60-63`），当前没有浏览器验证手段，且没有需求
  证据；已否决。
- **把宿主最低版本提到 2.8.0 并去掉本地/CDN 兜底**：会破坏离线可用与旧宿主兼容，违反
  AGENTS.md §6.4 的本地优先顺序；已否决。
- **退回 v2.7.x**：v2.8.0 是 additive、无删除/改名（上游 `CHANGELOG.md:11`），退回没有
  收益；已否决。

## 后果

- 正面：不引入需长期维护的玻璃设置项与浏览器兼容分支；升级风险最小；继续沿用上游
  默认值，面板行为不变。
- 负面：宿主开启 Fast UI 时无法强制玻璃，可能错过观感改进；运行时没有版本/CSS 自检，
  异常只能靠测试与用户反馈发现。
- 负面：manual-qa 尚无执行记录、浏览器测试基建缺失是整体缺口，本 ADR 不解决它，只是
  把接入决策推迟到补齐之后。
- 需要配套做的事：
  - 下次升级 ui-kit 或发现相关缺陷时重新巡检（见 `docs/ui-kit/known-issues.md` 巡检记录）；
  - manual-qa 清单完成并建立基础浏览器测试基建后，另写 ADR 评估 force / selfCheck 接入；
  - 若出现明确的用户需求或上游缺陷证据，可提前修订本决策。

## 修订记录

- **2026-10-27 · 运行时自检部分已修订**：浏览器测试基建（`tests/browser/`，CI 内执行）与
  manual-qa 就位后，v1.3.0 已接入 `NVUI.selfCheck({ expect })`，并把结果展示到「服务设置 →
  运行时诊断」；决策见 [ADR-005](ADR-005-kit-selfcheck-diagnostics-ui.md)。
  **本 ADR 仍有效的部分**：不接入 `createPanel({ glass: 'force' })`——它需要新增用户可见的
  设置项与关闭开关，目前仍无需求证据；后续若接入，应另写 ADR 修订。

