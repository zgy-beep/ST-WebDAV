# AGENTS.md — AI 编码助手行为准则

> 本文件是 AI 编码助手（Claude Code / Cursor / Codex / Copilot 等）在本仓库工作时的**行为准则**。
> 本文件**已针对 ST-WebDAV 实例化**，不含任何占位符；文中引用的细则文档位于 `docs/`。
> 阅读顺序：先读本文件 → 再读本文件引用的细则文档 → 最后读代码。
> 若本文件与细则文档冲突，以**更具体的那一份**为准；细则文档与本文件冲突时，以本文件为准。

---

## 0. 项目速查表

| 项 | 值 |
|---|---|
| 项目名 | ST-WebDAV（SillyTavern WebDAV 全量备份与还原插件） |
| 仓库名 | ST-WebDAV |
| 仓库地址 | `https://github.com/zgy-beep/ST-WebDAV.git` |
| 技术栈 | Node.js 22 / ESM / Express 5 / `archiver` + `fflate` / 原生 `node:test` |
| 宿主环境 | SillyTavern（服务端插件 + 前端扩展双形态） |
| 主分支 | `main` |
| 发布分支 | 无（仅 `main`，标签直接打在已合并的主干上） |
| 包管理器 | pnpm（锁文件 `pnpm-lock.yaml`） |
| 上游组件库 | `zgy-beep/ui-kit`（内置副本：`src/client/vendor/ui-kit/`，当前 v2.8.0） |
| 测试命令 | `npm test`（等价 `pnpm test`） |
| 检查命令 | `node scripts/validate-commit-msg.mjs`（提交信息校验） |

> **本项目未配置 ESLint / Prettier**，不存在 `npm run lint`。静态检查靠 `npm test` 中的版本一致性守卫 +
> 提交信息校验脚本兜底。**不要臆造不存在的脚本**。

---

## 1. 项目是什么

用**一段话**说明项目定位（面向使用者视角，不是实现视角）。细节见 `README.md`。

```
项目：ST-WebDAV —— SillyTavern 的 WebDAV 全量备份与还原插件
仓库：ST-WebDAV
技术栈：Node.js 22 / ESM / Express 5 / archiver + fflate / node:test
宿主：SillyTavern（服务端插件 init/exit + 前端扩展 IIFE）
主分支：main
```

插件把酒馆的配置（`settings.json`、API Key、预设、世界书、主题）与全量资产（角色卡、聊天记录、用户文件）
流式打包上传到用户自己的 WebDAV 网盘，支持定时备份、远端历史轮转、跨账号共享区，以及可选的
AES-256-GCM 端到端加密。

---

## 2. 动手前的强制流程

**任何改动前，按顺序执行，不得跳步：**

1. **读** —— 先读相关文件，再改。禁止凭文件名/猜测/记忆写代码。
   - 至少读：目标文件、它的直接调用方、相关的类型定义或数据结构。
   - 改公共接口前，先搜全部调用点（`grep` 全仓），确认不会破坏其他模块。
2. **定位** —— 找到根因，而不是改表象。
   - 症状 ≠ 原因。修之前先说明「现象 → 根因 → 修复点」的因果链。
3. **计划** —— 改动超过 3 个文件、或涉及公共接口/数据结构时，先输出计划再执行。
4. **执行** —— 最小必要改动。不顺手重构、不顺手改格式、不顺手加功能。
5. **验证** —— 跑 `npm test`（+ 提交前跑 `node scripts/validate-commit-msg.mjs`），贴真实输出。
6. **汇报** —— 改了什么、为什么、验证结果、下一步。见 §9。

> **只读探查优先**：能用读取/搜索解决的问题，不要动手写文件。

### 2.1 本项目的特殊前置检查（安全敏感模块）

改动下列任一模块前，**必须**先读 `CODE_REVIEW.md` 对应章节，并写明安全影响：

| 模块 | 改动前必须确认 |
|---|---|
| `src/server/PathGuard.js` | 文件名白名单规则未被放宽（`ST_Backup_` 前缀、禁 `..`、禁路径分隔符） |
| `src/server/UrlGuard.js` | SSRF 白名单与元数据地址拦截未被削弱；重定向仍逐跳校验 |
| `src/server/CryptoHelper.js` | 密文格式版本、KDF 迭代次数、IV/Auth Tag 长度未被削弱；v1 向后兼容未被破坏 |
| `src/server/RestoreService.js` | Zip-Slip 两阶段校验、Zip-Bomb 配额前置检查仍在 |
| `src/server/BackupService.js` | 凭据文件 `st_webdav_config.json` 仍在打包与还原两侧被排除 |
| `src/server/UserHelper.js` | 用户目录未出现「不存在就回退 default-user」的分支 |
| `index.js` | 共享区删除/撤回的权限判定（仅分享者本人或管理员）未被绕过 |

> **安全降级一律视为破坏性变更**：宁可回退功能，也不要削弱既有校验。

---

## 3. 代码风格

### 3.1 通用原则

- **跟随现有代码**：新代码的命名、缩进、注释语言、文件组织必须与同目录已有代码一致。
  - 不要把 `camelCase` 改成 `snake_case`，或反过来。
  - 不要引入新的格式化风格；项目已有 Prettier/ESLint 配置就遵守它。
- **小函数**：一个函数只做一件事，建议 ≤ 40 行；超过就考虑拆分。
- **早返回**：用卫语句提前 return，避免深层嵌套（建议嵌套 ≤ 3 层）。
- **无魔法值**：常量抽到命名常量或配置项，注明单位。
- **注释解释「为什么」，不解释「是什么」**。
  - 反例：`// 循环 i`（代码已经说了）
  - 正例：`// 宿主在 800ms 后才注入 extensions，手动重试一次避免首屏空白`
- **注释写中文**，与项目现有注释语言保持一致。
- **删除死代码**：被重构淘汰的分支、变量、未使用的导出要一并删掉，不要留着。

### 3.2 语言细节

| 项 | 约定 |
|---|---|
| 缩进 | 2 空格 |
| 行宽 | ≤ 100 字符，超出则换行，不硬压 |
| 引号 | 单引号 |
| 分号 | 有 |
| 文件末尾 | 必须有且仅有一个换行符 |

### 3.3 禁止事项

- ❌ 禁止提交 `console.log` 调试残留（服务端日志统一用 `[ST-WebDAV]` 前缀；前端仅用 `console.warn`/`console.error` 报告降级）
- ❌ 禁止注释掉的死代码块
- ❌ 禁止 `TODO` 不带负责人与 issue 链接
- ❌ 禁止在业务代码里硬编码密钥、token、URL（走配置或环境变量）
- ❌ 禁止引入新依赖而不说明理由（见 §7）
- ❌ 禁止提交构建产物、依赖目录、缓存（见 §5.4）

---

## 4. 目录约定与命名规范

### 4.1 目录约定（本项目实际结构）

```
ST-WebDAV/
├── AGENTS.md               # 本文件：AI 行为准则
├── README.md               # 产品视角说明（面向使用者）
├── CHANGELOG.md            # 版本变更记录
├── CODE_REVIEW.md          # 安全/性能代码审查报告，改动安全模块前必读
├── LICENSE
├── manifest.json           # 宿主扩展清单（前端入口指向 src/client/index.js）
├── package.json            # 依赖与脚本（唯一版本事实来源）
├── pnpm-lock.yaml          # 锁文件，必须提交
├── index.js                # 服务端插件入口（export init/exit/info，注册 Express 路由）
├── style.css               # 前端业务样式（由 manifest.json 引用）
├── src/
│   ├── client/             # 前端扩展（IIFE，由 manifest.json 加载）
│   │   ├── index.js        #   前端唯一入口
│   │   └── vendor/
│   │       └── ui-kit/     #   上游组件库内置副本（只读，见 §6）
│   └── server/             # 服务端业务模块（PascalCase 文件名）
│       ├── BackupService.js  RestoreService.js  SharedService.js
│       ├── ConfigManager.js  WebDavClient.js    SchedulerService.js
│       ├── CryptoHelper.js   PathGuard.js        UrlGuard.js
│       ├── JobLock.js        UserHelper.js       Version.js
│       ├── BackupCategories.js  Constants.js
│       └── README.md
├── tests/                  # 测试：node:test，snake_case + .test.js
│   └── README.md
├── docs/
│   ├── engineering/        # 工程规范（本文档的细则）
│   ├── decisions/          # 架构决策记录（ADR）
│   └── ui-kit/             # 上游组件库的接入与已知问题
└── scripts/
    └── validate-commit-msg.mjs
```

**铁律：**

1. **根目录只放「入口级」文件**（README、CHANGELOG、CODE_REVIEW、manifest/package.json、LICENSE、AGENTS.md、
   `index.js`、`style.css`）。源码、测试、文档、脚本一律进子目录。
   > `index.js` 与 `style.css` 留在根目录是宿主的加载约定（`manifest.json` 指向它们），不是破例。
2. **按职责分层**。服务端在 `src/server/`，前端在 `src/client/`，禁止出现 `utils.js` / `helpers.js` / `common.js` 这类无归属杂物袋。
3. **入口固定**：`index.js`（服务端 `init`/`exit`）与 `src/client/index.js`（前端 IIFE）是仅有的两个入口，
   其余模块可独立测试。**不要新增第三个入口**。
4. **模块单向依赖，禁止反向引用与循环依赖**。`src/server/Constants.js` 单独存在正是为了打断
   `BackupService` ↔ `RestoreService` 的环 —— 新增共享常量放这里，不要让两个服务互相 import。
5. **测试与源码职责对应**：新增 `src/server/Xxx.js` 时，同步新增 `tests/xxx.test.js`。
6. 详见 `docs/engineering/directory-structure.md`。

### 4.2 命名规范

**通用：**

| 对象 | 规则 | 本项目示例 |
|---|---|---|
| 目录 | 小写 + `-` 分隔 | `src/server/`、`src/client/vendor/ui-kit/` |
| 服务端模块文件 | **PascalCase**（跟随现状） | `BackupService.js`、`PathGuard.js` |
| 测试文件 | **snake_case + `.test.js`**（跟随现状） | `security.test.js`、`e2e_backup_restore.test.js` |
| 变量/函数 | `camelCase` | `sanitizeBackupFileName` |
| 常量 | `UPPER_SNAKE_CASE` | `MAX_RETRY_COUNT`、`TEST_RATE_LIMIT` |
| CSS 类 | kebab-case，**带项目前缀** | `.st-webdav-container` |
| CSS 变量 | kebab-case，**带项目前缀** | `--st-webdav-radius-md` |
| 环境变量 | `UPPER_SNAKE_CASE` | `WEBDAV_URL` |
| 特性开关 | `camelCase` | `isolateUserDirectory` |

**规则：**

- **前缀隔离**：业务样式类名与 CSS 变量必须用 `st-webdav-` / `--st-webdav-` 前缀。
  ui-kit 自身的 `nvui-` / `--nvui-` 前缀属于上游，**不得占用**。
- **布尔命名**用 `is` / `has` / `enable` / `should` 开头，不用 `not`（双重否定难读）。
- **函数名是动词或动宾短语**：`createPanel()`、`parseEntries()`、`shouldRetry()`。
- **getter 无副作用**：`get*()` 只读取，`set*()` 才写入，`is*()` 返回布尔。
- **缩写全大写**：`URL`、`HTML`、`ID`、`API`；其余单词首字母大写：`parseHtml()`。

### 4.3 测试文件命名

| 类型 | 命名 | 位置 |
|---|---|---|
| 单元/集成测试 | `<被测模块>.test.js`（snake_case） | `tests/` |
| 端到端测试 | `e2e_<场景>.test.js` | `tests/` |
| 主题型测试 | `<主题>.test.js`（如 `security.test.js`、`share.test.js`、`version.test.js`） | `tests/` |
| 公共测试辅助 | `_helpers/` | `tests/` |

> 测试文件**必须能反查到被测源文件或被测主题**，禁止 `test1.js`、`a.test.js` 这类无意义命名。

---

## 5. 测试与提交要求

### 5.1 测试要求

- **改 bug 必须有回归测试**：先让测试复现问题（红），再修（绿）。提交时两个状态都要能复现。
- **新功能必须有测试**：至少覆盖正常路径 + 一个异常输入。
- **测试命名描述行为**，不要描述实现：`returns empty list when no entries` > `test parse`。
- **断言行为不实现**：不要断言私有变量名、内部调用次数等易碎细节。
- **测试必须可独立运行**，不依赖执行顺序，不依赖真实网络（用固定夹具/fixture）。
- **禁止为了让测试通过而修改断言或跳过测试**。测试红了就是代码有问题，或测试写错了——两者都要明说。
- 覆盖率不作硬指标，但**核心逻辑必须有测试**。

### 5.2 提交要求

- **提交前必跑**：`npm test` 全绿才提交。提交信息须通过 `node scripts/validate-commit-msg.mjs`。
- **一次提交只做一件事**：不把修 bug 和加功能混在一起。
- **提交信息格式**：见 `docs/engineering/git-workflow.md`（Conventional Commits）。
  - 首行 `<类型>(<范围>): <主题>`，主题用中文，不加句号。
  - **允许的 scope**（与 `scripts/validate-commit-msg.mjs` 的 `SCOPES` 集合保持同步）：
    `client` `server` `editor` `runtime` `api` `ui` `settings` `test` `docs`
    `engineering` `ui-kit` `build` `deps` `release`
  - **新增 scope 必须同时改脚本**，否则提交会被 hook 拦下。
- **不提交**：`.env`、密钥、本地配置、`node_modules/`、构建产物、临时文件。
- **推送是外部动作**：除非用户明确指示，否则**只提交不推送**。

### 5.3 验证真实性

**禁止**在没跑过的情况下声称「已修复」「测试通过」。

- 必须贴**真实输出**，不接受「应该没问题」「理论上可以通过」。
- 没跑成 → 明确说「未运行 / 运行失败 + 原因 + 复现命令」。
- 自动化测试覆盖不到的（UI 视觉、宿主交互），必须说明**人工验证步骤**，或明确标注「待实机验证」。

### 5.4 禁止提交的文件

```
node_modules/  dist/  build/  .env  *.log  *.tmp
.DS_Store  Thumbs.db  coverage/  .idea/  .vscode/（团队共享的除外）
st_webdav_config.json  backups/
```

> `st_webdav_config.json`（含 WebDAV 凭据）与 `backups/`（本地备份产物）已在 `.gitignore` 中，
> **提交前必须确认 `git status` 里没有它们**。备份包内**永不包含**凭据文件。

---

## 6. 与上游组件库（ui-kit）协作的硬规则

> 本项目依赖 `zgy-beep/ui-kit`（UI 组件库）。**该规则不可绕过。**

### 6.1 铁律

1. **不在本地改写 ui-kit**。
   - 不修改 `src/client/vendor/ui-kit/` 下的任何文件。
   - 不在业务仓库里 fork 一份 ui-kit 源码改。
   - 不通过覆写 CSS 类名、加 `!important`、内联样式等方式「本地打补丁」绕过组件缺陷。
2. **发现缺陷 → 向上游提 issue**，按 `docs/ui-kit/issue-reporting.md` 的格式提交。
3. **上游修复后同步版本**：升级内置的 `src/client/vendor/ui-kit/` 副本，跑通全部测试再合并。
4. **业务代码里不写 ui-kit 的补丁逻辑**。若某组件确实无法满足需求，走「业务侧自建组件」而非「篡改 kit」。

### 6.2 为什么要这么定

- 本地改写 = 制造分叉。上游修复后，本地补丁会冲突，且缺陷会扩散到其他插件。
- 本地改写 = 风险外溢。ui-kit 被多个插件共用，一处被改可能破坏其他插件。
- 提 issue = 问题被记录、被复现、被上游修一次，所有下游同时受益。

### 6.3 允许的例外

| 情况 | 允许做法 |
|---|---|
| 需求是新的（kit 没有这个组件） | 上游提 **feature request issue**；同时业务侧可临时自建组件，标注 TODO + issue 链接 |
| 上游修复前必须先解阻塞 | 业务侧写**隔离层**（单独文件 + 明确注释 + 关联 issue 链接 + 移除条件），不得修改 kit 文件本身 |
| 紧急线上问题 | 先隔离层兜底，同步提 issue，**48 小时内**补上上游 issue 链接 |

> 隔离层文件的抬头必须写：
> ```
> // 临时绕过：ui-kit#<编号> —— <一句话描述>
> // 移除条件：ui-kit 修复并升级到 >= <版本> 后删除本文件
> ```

### 6.4 本项目的加载顺序（改动前端时必须遵守）

`src/client/index.js` 的 `ensureNVUI()` 实际顺序是：

1. 宿主已加载且版本 ≥ `NVUI_MIN_VERSION`（2.8.0）→ 直接复用；
2. **本地 Vendored 优先**（`src/client/vendor/ui-kit/`，零网络、可离线、防注入）；
3. 本地失败 → 降级到宿主旧版；
4. 仍不可用 → 仅允许 `cdn.jsdelivr.net` / `fastly.jsdelivr.net` 的 CDN 兜底。

> 注意：README 早期版本描述为「在线动态加载」，**以代码为准** —— 本地副本才是首选。
> 前端业务样式必须 100% 取自 `var(--nvui-*)` 令牌，**零颜色字面量、无裸元素选择器、无 `!important`**。

---

## 7. 依赖管理

- 新增依赖前先确认：**标准库/现有依赖能否解决？** 能就不新增。
- 新增依赖必须在 PR 描述里说明：**为什么需要 / 替代方案 / 体积影响 / 许可证**。
- 锁文件必须提交；**不要手改锁文件**。
- 定期清理无用依赖（`pnpm prune`）。
- 当前运行时依赖仅 3 个：`archiver`（流式打包）、`fflate`（解压）、`express`（路由）。
- **Windows 环境注意**（若在 Windows 开发）：
  - 清理目录用 Node 的 `fs.rmSync` / `fs.unlinkSync`，**不要**用 PowerShell 的 `Move-Item` / `Remove-Item -Recurse`（会穿透 junction 打到真实目标，误删受版本控制的文件）。
  - 改完用户级环境变量后，Directory Opus 与 VS Code 拉起的终端仍是旧环境快照，需**完全重启**它们才生效。

### 7.1 版本号的唯一事实来源

`package.json` 的 `version` 是**唯一事实来源**。`src/server/Version.js` 的 `getPluginVersion()` 负责读取它。

- `manifest.json` 的 `version` **必须**与之一致（酒馆 UI 读的是 manifest）—— 由 `tests/version.test.js` 守卫。
- 前端另有两级兜底（`manifest.json` → 内联字面量），但**不得**成为新的硬编码来源。
- **版本号只需手工改 `package.json` 与 `manifest.json` 两处**（守卫测试校验二者相等，但**不会自动同步**，漏改即测试失败）；除这两处外，任何地方都不得新增硬编码版本来源。

---

## 8. 常见任务的标准动作

| 任务 | 标准动作 |
|---|---|
| 修 bug | 复现 → 定位根因 → 加回归测试（红）→ 修（绿）→ 跑全量 → 汇报 |
| 加功能 | 读现有同类实现 → 计划 → 实现 → 加测试 → 更新 README/CHANGELOG → 汇报 |
| 改公共接口 | 搜全部调用点 → 列出受影响面 → 计划 → 实现 → 更新所有调用方 + 测试 → 汇报 |
| 改安全模块 | 先读 `CODE_REVIEW.md` 对应章节 → 补安全回归测试 → 确认无降级 → 汇报 |
| 性能问题 | 先测量拿到数据（内存占用/耗时分布），**不凭推理下结论**；改动后复测对比 |
| 升级 ui-kit | 对照上游 CHANGELOG 识别破坏性变更 → 迁移 → 跑全量测试 → 更新内置副本版本号 |
| 提 issue | 按 `docs/ui-kit/issue-reporting.md` 模板写 → 自查清单 → 提交 |
| 发版 | 按 `docs/engineering/versioning.md` §8 流程走（改 `package.json` → CHANGELOG → 打标签） |

---

## 9. 汇报格式

每次完成改动后，**必须**包含以下三段，缺一不可：

```markdown
## 改了什么

- `src/server/PathGuard.js:42-58` —— 新增 XXX 校验，修复 YYY
- `tests/security.test.js` —— 新增 3 条断言覆盖 ZZZ

## 为什么这么改

- 根因：<一句话>（证据：<文件:行号 / 实测数据>）
- 方案选择：<为什么选 A 不选 B>

## 验证结果

- `npm test` —— 57 passed / 0 failed（真实输出片段）
- ⚠️ 未覆盖：<哪部分没验证到，为什么>

## 接下来做什么

1. <明确的下一步，带动作主体>
2. ...
```

**禁止**只说「改好了」「已完成」。

---

## 10. 禁止事项清单（红线）

- ❌ 修改 `src/client/vendor/ui-kit/` 下的任何文件
- ❌ 未获指示就 `git push` / 建 PR / 发 issue / 发布
- ❌ 声称未实际执行的测试「通过」
- ❌ 提交密钥、token、`.env`、`st_webdav_config.json`
- ❌ 顺手重构无关代码、顺手改格式
- ❌ 删除或覆盖用户数据、删除未确认的目录
- ❌ 静默扩大改动范围（改了范围外的东西而不说）
- ❌ 伪造数据、编造实测结果、编造 issue 链接
- ❌ 让模块形成循环依赖
- ❌ 把业务逻辑写进宿主/上游组件库目录
- ❌ **削弱任何既有安全校验**（路径穿越、SSRF、加密强度、配额、权限判定）
- ❌ **把凭据文件打进备份包**或让它进入还原目标目录

---

## 11. 参考文档

| 文档 | 内容 |
|---|---|
| `docs/engineering/git-workflow.md` | 分支命名、提交信息、PR 描述与评审流程 |
| `docs/engineering/versioning.md` | 语义化版本号（SemVer）规范与发版流程 |
| `docs/engineering/directory-structure.md` | 目录分层与文件归属细则 |
| `docs/engineering/ai-collaboration.md` | 人机分工、任务拆解、代码审查与验收标准 |
| `docs/ui-kit/issue-reporting.md` | 向上游提 issue 的格式与要素 |
| `docs/ui-kit/known-issues.md` | 上游问题台账与临时隔离层清单 |
| `docs/decisions/README.md` | 架构决策记录（ADR）写法 |
| `docs/ROADMAP.md` | 迭代路线：当前状态、已完成版本与 v1.3.0 收口清单 |
| `CODE_REVIEW.md` | 安全/性能审查报告，改动安全模块前必读 |
| `README.md` | 产品视角说明 |
| `CHANGELOG.md` | 版本变更记录 |
