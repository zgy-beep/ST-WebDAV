# 迭代路线图（Roadmap）

> 本文件回答「下一版做什么、什么时候算完成」。版本递增规则见
> [`docs/engineering/versioning.md`](engineering/versioning.md)，验收项见
> [`docs/engineering/manual-qa.md`](engineering/manual-qa.md)。
> 每次发版后更新「当前状态」「已完成」「验收覆盖现状」三节。

## 当前状态

| 项 | 值 |
|---|---|
| 最新版本 | **v1.3.0**（2026-10-27） |
| 自动化测试 | 67 项单元/契约测试 + 2 项浏览器冒烟（CI 均执行） |
| CI | `npm test` + `npm run test:browser`（push / PR 到 `main`） |
| 内置 ui-kit | v2.8.0（已接入运行时 `selfCheck`） |
| 最近一次实机验收 | 2026-10-26/27：真实 ST 1.19.0、真实 WebDAV（自建 WsgiDAV）、隔离 harness、4 套本地真实实现协议矩阵 |

## 已完成

| 版本 | 主题 | 内容 |
|---|---|---|
| v1.2.0 | ui-kit v2.8.0 + 工程化 | 内置副本升级、`.github` PR/Issue 模板与 CI、manual-qa 清单、ADR-001~004、文档漂移修正 |
| v1.2.1 | 实机验收修复 | 自定义分类备份 scope 归一化、并发任务冲突 409、7 条回归测试 |
| v1.2.2 | 实机验收修复 | 共享目录模式 `/share` 归属校验（与 `/delete` 对齐）、2 条回归测试 |
| v1.3.0 | 验收收口 + 自检/浏览器基建 | kit 运行时 `selfCheck`、零依赖浏览器冒烟（CI）、定时备份/轮转/快照上限/加密共享/空口令/本地优先验收、4 套真实 WebDAV 实现协议矩阵 |

## 验收覆盖现状（截至 v1.3.0）

- **已 PASS**：宿主面板（打开/标签/关闭/Esc/遮罩/焦点陷阱与归还/移动端抽屉/重复开关/刷新）、
  UI（深浅主题/玻璃正常态与回退/进度条/吐司/内联确认/本地优先与 CDN 阻断）、
  备份/加密备份/列表/删除/分享/撤回/同名 409、定时备份（触发/去重/可还原）、
  历史轮转（超额清理/隔离目录不误删）、回滚快照（生成/内容/保留 5 份上限）、
  加密还原/错误口令/v01 历史兼容/加密共享还原、跨账号共享区全链路、
  空口令拦截、真实 ST + 真实 WebDAV 全链路、4 套本地真实实现协议矩阵（28/28）、
  浏览器冒烟（本地与 CI，2/2）、kit 运行时自检在真实宿主零告警（selfCheck 返回
  `ok=true / issues=[]`，实测捕获到插件调用 1 次）。
- **风险接受（书面，2026-10-27）**：
  - **HOST-10 移动端安全区**：headless 无法产生非零 `env(safe-area-inset-bottom)`。依据：
    kit 规则为 `calc(var(--nvui-space-1) + env(safe-area-inset-bottom))`（`components.css:2429-2435` 等），
    非刘海环境解析为 0px 与实测一致；风险为无 `env()` 支持的旧浏览器上 calc 声明整体失效。
    现代浏览器均支持 `env()`，**接受风险**；有真机时补测。
  - **UI-05 不支持 `backdrop-filter` 的浏览器**：无法真实禁用该能力（6 组 Chrome flag 均无效）。
    等价分支已用 `prefers-reduced-transparency` 验证：探针 computed=none → 面板加
    `nvui-glass-fallback`、97% 近不透明、对比度 13.72/12.47。**接受风险**并保留依据。
- **BLOCKED（外部条件）**：坚果云 / Alist / 群晖 NAS / Nextcloud / InfiniCLOUD 五家商用服务端
  —— 无测试账号；已用 4 套本地真实实现（WsgiDAV / rclone / dufs / webdav-server）替代协议覆盖。
- **未覆盖**：COPY 降级路径（下载+上传；4 套实现均原生支持 COPY，仅单元测试覆盖）；
  本地 vendored ui-kit 加载分支（宿主已复用 2.8.0，未触发该分支）。

## v1.4.0 候选清单

| # | 事项 | 依据 / 缺口 | 验收标准 | 规模 |
|---|---|---|---|---|
| 1 | 商用 WebDAV 服务端矩阵 | 现为 BLOCKED（无账号） | 5 家各跑 DAV-01~06，PASS 或书面 BLOCKED | L |
| 2 | COPY 降级路径真实覆盖 | 尚未真实触发 | 用禁 COPY 的代理/实现，分享走下载+上传成功 | S |
| 3 | 真机/受限浏览器项 | HOST-10、UI-05 现为风险接受 | 真机安全区与真实不支持 `backdrop-filter` 的浏览器实测 | S |
| 4 | vendored 加载分支隔离验证 | 宿主复用导致未触发 | 独立环境（无宿主 kit）下命中本地副本并自检通过 | S |
| 5 | selfCheck 结果的产品化 | 当前仅 console.warn | 是否在面板设置页展示诊断信息（需产品决策，可写 ADR） | M |

**发版判定**：`npm test` + `npm run test:browser` 全绿 + manual-qa 全量执行（或 BLOCKED/风险接受
项有书面记录）+ CHANGELOG/版本/tag/Release 按 `versioning.md` §8 完成。

## 维护约定

- 每次发版后：更新「当前状态」「已完成」「验收覆盖现状」，从未完成项中移除或新增。
- 验收项本身以 `manual-qa.md` 为准；本文件只做**取舍与排序**，不复述检查步骤。
- 新增迭代目标需写清「依据（验收记录/issue/ADR）→ 验收标准 → 规模」，
  不接受无法验收的模糊目标。
