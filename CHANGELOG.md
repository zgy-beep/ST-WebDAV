# 变更日志

本文件记录项目的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [1.2.1] - 2026-10-26

### 修复
- **自定义分类备份的 scope 归一化**：只传分类、未传 scope 时按「自定义」处理，
  修复归档实际内容（如核心全集）与 manifest / 远端元数据记录的 categories 不一致，
  备份列表的分类标签从此与实际内容一致
- **并发任务冲突返回 409**：同一用户的备份/还原互斥冲突由 500 改为 409，
  前端可区分「稍后重试」与服务端故障；其余内部错误仍返回 500

### 内部
- 新增 `src/server/JobBusyError.js`：冲突错误类型与 `HTTP_CONFLICT` 常量，
  由路由统一映射状态码，避免把任务占用误报为服务端故障
- 新增 7 条回归测试：scope 归一化、归档内容、JobLock 冲突、HTTP 状态码映射（测试规模 58 → 65）

## [1.2.0] - 2026-10-26

### 依赖
- **UI Kit 升级至 v2.8.0**：
  - 更新内置 `src/client/vendor/ui-kit/` 副本至 `v2.8.0`（上游 additive 小版本：无删除、无改名，三个运行资产逐字节对齐 tag `012653a`）；
  - 引入运行时自检 `NVUI.selfCheck()` / `NVUI.checkCompatibility()`、`NVUI.defaults` 与 `data-nvui-version` 标记，
    便于在真实酒馆宿主里排查 kit 版本、玻璃降级状态与 token 缺失；
  - 新增 `createPanel({ glass })` 三档玻璃模式（`auto` / `force` / `solid`，默认 `auto`）。本项目保持默认 `auto`，
    不改动既有观感；同时继承 v2.7.1 / v2.7.2 的玻璃修复（面板透明感、宿主禁模糊时近不透明 `.nvui-glass-fallback` 回退、探测三态自愈）与 #15 浏览器回归稳定性修复；
  - 组件侧新增 `.nvui-actions` 按钮组容器、正文相邻按钮 8px 默认间距与 `--nvui-kit-version` 令牌（组件类 80 → 81，token 110 → 111，仅新增）；
  - 同步 `NVUI_MIN_VERSION` 最低版本要求为 `2.8.0`，`README.md` / `AGENTS.md` / `style.css` 与前端头注释中的 kit 版本引用一并收敛。
- **UI Kit 升级至 v2.7.0**：
  - 更新内置 `src/client/vendor/ui-kit/` 副本至 `v2.7.0`；
  - 继承上游宿主表单隔离与 opt-in 表单作用域（`.nvui-form-scope`）、`select optgroup` 主题适配（#12）、焦点陷阱优化（#13）以及宿主模态弹层下的 Esc 让位机制（#14）；
  - 自定义分类复选框切换为规范的 `.nvui-checkbox` 独立复选框组件，消除潜在的宿主 checkbox 样式干扰；
  - 同步 `NVUI_MIN_VERSION` 最低版本要求为 `2.7.0`，并在 `tests/version.test.js` 中补齐文档与准则版本守卫。

### 内部
- 新增 `.github/` 协作设施：PR 描述模板、ui-kit bug / feature issue 模板，以及 push / PR 到 `main`
  自动运行 `npm test` 的 CI 工作流（Node 22 + pnpm 锁文件，红灯不得合并）
- 新增发版实机验收清单 `docs/engineering/manual-qa.md`：覆盖 6 家 WebDAV 服务端、宿主面板、
  UI Kit 视觉、加密还原、共享区、回滚与轮转；README 的兼容性声明改为引用该清单
- 补齐 ADR-001～004（v02 加密格式、共享区权限模型、ui-kit 3 资产内置策略、v2.8.0 能力采纳边界），
  并在 `docs/ui-kit/known-issues.md` 增加巡检记录
- 修正文档漂移：AGENTS §7.1 版本号同步口径、ui-kit 版本引用（v2.5.0 → v2.8.0）、
  CODE_REVIEW 的历史快照与测试基线说明
- 提交信息校验脚本补充 `release` scope，与 `versioning.md` §8 的 `chore(release)` 发版提交对齐
- 版本号收敛为单一事实来源（`package.json`），由 `tests/version.test.js` 守卫，
  修复升级后前端徽章仍显示旧版本号的漂移问题
- `AGENTS.md` 与 `docs/engineering/` 全套规范完成项目实例化：占位符全部替换为真实值，
  目录结构、命名约定、ui-kit 路径与测试命令同步至当前代码

## [1.1.0] - 2026-10-21

### 新增
- **跨账号共享备份**：可将任意备份「分享」到远端共享区 `<备份根目录>/_shared/`，所有能访问该路径的账号
  都能看到并一键还原，无需互加好友或交换凭据；支持撤回分享，同名冲突返回 409
- **UI Kit 升级至 v2.5.0**：补齐 `.nvui-hint.is-ok` / `.is-danger`、`.nvui-btn.is-xs`、
  `.nvui-badge.is-subtle`、`.nvui-progress.is-primary` 四组此前前端在用但缺失的类名，
  成功/失败提示着色、分类全选按钮、加密徽章等样式不再静默失效
- 备份进度、状态、历史列表接口按用户精确隔离

### 修复
- **远端路径穿越（B1，阻塞级）**：新增 `PathGuard.sanitizeBackupFileName()` 强制文件名白名单，
  修复 `fileName` 未经净化拼接远端路径导致跨用户越权读取/删除备份的漏洞（路由层与服务层双层校验）
- **加密强度不足**：密文格式升级 v02，KDF 由 PBKDF2-HMAC-SHA256 100,000 次提升至 210,000 次，
  迭代次数写入文件头；同时支持读取 v01 历史备份
- **ZIP 炸弹绕过**：配额检查改为在实际解压**之前**依据 zip 头声明尺寸执行，STORED 条目按实际占用计费
- **还原残留**：改为两阶段流程——先遍历全部条目完成路径与配额校验，通过后才统一写盘
- **SSRF 跨源泄露**：HTTP 重定向逐跳重新校验，跳转目标重新通过 SSRF 检查，跨源跳转自动剥离 `Authorization` 头
- **版本号漂移**：版本号收敛为单一事实来源（`package.json`），由 `tests/version.test.js` 守卫，
  修复升级到 v1.1.0 后前端徽章仍显示 v1.0.0 的问题
- 备份与还原改用统一的 `JobLock` 互斥，避免同一用户并发产生不一致的备份包

### 安全
- 凭据配置文件 `st_webdav_config.json` 在打包与还原两侧均被拦截，永不进入备份包
- `/test` 接口增加按用户维度的频率限制（默认 10 次 / 60 秒），降低被当作内网端口扫描器的风险
- 共享区元数据索引写入使用 per-directory 互斥锁串行化，避免多人同时分享时丢失更新

### 内部
- 测试规模从 13 项扩展至 57 项，全部通过
- 新增 `src/server/` 5 个安全模块：`PathGuard` / `UrlGuard` / `JobLock` / `Version` / `SharedService`
- 删除根目录 `ui-kit/` 双副本，`src/client/vendor/ui-kit/` 成为唯一事实来源
- 提交信息校验脚本 `scripts/validate-commit-msg.mjs`

## [1.0.0] - 2026-10-21

首个正式版本。

### 新增
- 建立可复用的工程规范体系：`AGENTS.md` 作为 AI 编码助手行为准则
- Git 提交与推送规范：分支命名、Conventional Commits、PR 描述模板与评审流程
- 语义化版本号规范：主/次/修订号递增时机与 CHANGELOG 维护规则
- 目录结构规范：按职责分层，杜绝根目录堆文件
- AI 协同开发指南：人机分工边界、任务拆解、代码审查与验收标准
- 向上游 ui-kit 提交 issue 的规范与 Issue 模板
- 提交信息校验脚本 `scripts/validate-commit-msg.mjs`

[未发布]: https://github.com/zgy-beep/ST-WebDAV/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/zgy-beep/ST-WebDAV/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/zgy-beep/ST-WebDAV/releases/tag/v1.0.0
