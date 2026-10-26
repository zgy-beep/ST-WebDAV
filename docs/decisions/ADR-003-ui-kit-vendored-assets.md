# ADR-003：ui-kit 内置副本策略：只 vendor 3 个运行时资产

- 状态：已接受
- 日期：2026-10-26
- 相关：无上游 issue；依据 AGENTS.md §6、tests/version.test.js 与上游 ui-kit v2.8.0 文档

## 背景

本项目依赖上游 `zgy-beep/ui-kit`，并在 `src/client/vendor/ui-kit/` 放一份内置副本，
用于离线加载与「本地优先」的加载顺序（AGENTS.md §6.4；`src/client/index.js:179-196`）。

上游 v2.8.0 的升级指南要求下游覆盖 **4 个运行资产**：`tokens.css`、
`components.css`、`nvui-api.js`、`tokens.json`，并强调 4 个必须同版本
（上游 `UPGRADING.md:9-18`）。

但本项目运行时只加载 3 个文件：`tokens.css`、`components.css`、`nvui-api.js`
（`src/client/index.js:180-217`）；全仓 `src/`、`tests/`、`scripts/` 未发现
`tokens.json` 的运行时引用（`src/client/vendor/ui-kit/tokens.css:16` 仅注释提及）。
当前内置副本恰好只有这 3 个文件。

AGENTS.md §6 的硬规则是：不在本地改写 ui-kit、发现缺陷先提上游 issue、升级时同步
内置副本（AGENTS.md §6.1）。

## 决策

1. 内置副本只保留 3 个运行时资产：`nvui-api.js`、`tokens.css`、`components.css`
   （`src/client/vendor/ui-kit/`）。
2. 不内置 `tokens.json`：本项目运行时与测试都不读取它；上游将其用于发布校验与下游
   自检（上游 `scripts/verify-release.js`、`test/downstream-check.js:22,32,44`），
   不属于本插件的运行必需品。
3. 内置副本文件保持与上游对应 tag 原文件**字节一致**，不修改、不 fork、不本地打补丁
   （AGENTS.md §6.1）。
4. 升级方式：用上游对应 tag 的 `nvui-api.js` / `tokens.css` / `components.css` 原文件
   整体覆盖，然后跑本项目测试；内置版本以 `nvui-api.js` 的 `VERSION` 为准
   （`src/client/vendor/ui-kit/nvui-api.js:55`）。
5. 由本项目自建 3 资产守卫，替代上游 `downstream-check.js`：`tests/version.test.js`
   校验 3 个文件版本一致（`:130-143`）、内置版本不低于 `NVUI_MIN_VERSION`
   （`:145-164`），并校验 README/AGENTS 引用的版本号（`:166-182`）。

## 备选方案

- **Fork 或本地打补丁**：直接违反 AGENTS.md §6.1，会造成分叉，上游修复后补丁冲突；
  已否决。
- **4 资产全量内置（含 `tokens.json`）**：可以让上游 `downstream-check.js` 原样运行，
  但该脚本还要求下游 `package.json` 的 version 等于 kit 版本
  （上游 `test/downstream-check.js:27-28,47`），本项目 `package.json` 是插件版本
  （决策时 1.1.0，与 kit 版本语义不同），永远无法满足；多同步一个文件并不能省掉自建守卫，已否决。
- **只靠 CDN 或宿主自带版本**：离线可用性、版本确定性与防注入都变差
  （`src/client/index.js:179` 注释；AGENTS.md §6.4）；已否决。
- **升级时只换 CSS 或只换 JS**：上游明确「只换 CSS 会缺 API，只换 JS 会缺样式」
  （`UPGRADING.md:18`）；已否决。

## 后果

- 正面：离线可用、无外部脚本注入、版本确定；3 个资产与上游字节一致（2026-10-26 用
  SHA256 比对确认），可直接 diff 审计；内置体积小。
- 负面：上游 `downstream-check.js` 不能直接用于本仓库（缺 `tokens.json`，且
  `package.json` 版本语义不同），升级自检依赖自建守卫与人工核对。
- 负面：`tokens.css` / `components.css` 文件头的版本注释需与 `nvui-api.js` 的
  `VERSION` 同步更新，只能靠 `tests/version.test.js:138-142` 拦截漂移。
- 负面：若上游未来让 `tokens.json` 进入运行时链路，本决策需重新评估（触发条件待确认）。
- 需要配套做的事：
  - 升级 ui-kit 时按「覆盖 3 文件 → 跑 `npm test` → 更新版本引用文档」执行；
  - 不得为图省事把 `tokens.json` 塞进内置副本后再本地改写加载逻辑；
  - 发现组件缺陷按 `docs/ui-kit/issue-reporting.md` 提上游，不在 vendor 内修。
