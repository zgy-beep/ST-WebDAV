# 项目目录结构规范

> 与 `../../AGENTS.md` §4 配合使用；本文件更具体，冲突时以本文件为准。
> 目标：**按职责分层，让任何人 30 秒内知道东西该放哪。**

---

## 1. 核心原则

1. **根目录只放入口级文件**。源码、测试、文档、脚本一律进子目录。
2. **按职责分层，不按文件类型平铺**。禁止 `utils.js` / `helpers.js` / `common.js` 这类无归属杂物袋。
3. **一个文件一个职责**。文件超过 ~500 行且有多个独立职责时必须拆分。
4. **模块单向依赖**，禁止循环依赖。新增依赖前先确认不形成环。
5. **同类东西放一起**。测试与源码职责对应，文档按主题分目录。
6. **可复制即自包含**。需要被整体复制到其它仓库的目录（如 `src/client/vendor/ui-kit/`），内部链接用同目录相对路径。

---

## 2. 标准目录树（本项目实际结构）

```
ST-WebDAV/
│
├── AGENTS.md                   # AI 编码助手行为准则
├── README.md                   # 产品视角说明（面向使用者，不写实现细节）
├── CHANGELOG.md                # 版本变更记录
├── CODE_REVIEW.md              # 安全/性能代码审查报告
├── LICENSE                     # 许可证（MIT）
├── manifest.json               # 宿主扩展清单（前端入口 + 版本 + CSS）
├── package.json                # 包配置与脚本入口（唯一版本事实来源）
├── pnpm-lock.yaml              # 锁文件，必须提交
│
├── index.js                    # ── 服务端插件入口（export init/exit/info）
├── style.css                   # ── 前端业务样式（manifest.json 引用）
│
├── src/                        # ── 源码
│   ├── client/                 #   前端扩展（IIFE，由 manifest.json 加载）
│   │   ├── index.js            #     前端唯一入口
│   │   ├── README.md
│   │   └── vendor/
│   │       └── ui-kit/         #     上游组件库内置副本（只读，见 §8）
│   └── server/                 #   服务端业务模块（PascalCase 文件名）
│       ├── BackupService.js    #     备份打包与上传
│       ├── RestoreService.js   #     还原与两阶段校验
│       ├── SharedService.js    #     跨账号共享区
│       ├── ConfigManager.js    #     多用户配置与凭据存储
│       ├── WebDavClient.js     #     WebDAV 协议客户端
│       ├── SchedulerService.js #     定时备份
│       ├── CryptoHelper.js     #     AES-256-GCM 加密
│       ├── PathGuard.js        #     文件名白名单
│       ├── UrlGuard.js         #     SSRF 防御
│       ├── JobLock.js          #     任务互斥锁
│       ├── UserHelper.js       #     用户目录解析
│       ├── Version.js          #     版本号读取
│       ├── BackupCategories.js #     备份分类定义
│       ├── Constants.js        #     跨模块共享常量（打断循环依赖）
│       └── README.md
│
├── tests/                      # ── 测试（node:test，snake_case + .test.js）
│   ├── st_webdav.test.js
│   ├── security.test.js
│   ├── share.test.js
│   ├── version.test.js
│   ├── e2e_backup_restore.test.js
│   └── README.md
│
├── docs/                       # ── 文档，按主题分目录
│   ├── engineering/            #   工程规范（提交、版本、目录、AI 协同）
│   ├── decisions/              #   架构决策记录 ADR
│   └── ui-kit/                 #   上游组件库接入说明与已知问题
│
└── scripts/                    # ── 可执行脚本
    └── validate-commit-msg.mjs
```

---

## 3. 各目录职责与边界

| 目录 | 职责 | 允许放 | 禁止放 |
|---|---|---|---|
| `src/server/` | 服务端业务逻辑 | 备份/还原/加密/校验/调度模块 | 前端代码、测试 |
| `src/client/` | 前端扩展 | 面板渲染、事件绑定、NVUI 调用 | 服务端逻辑、直连文件系统 |
| `src/client/vendor/ui-kit/` | 上游副本 | 上游原始文件，**只读** | 我们的业务代码、本地补丁 |
| `tests/` | 测试 | 测试用例、夹具 | 产品代码、真实密钥 |
| `docs/` | 文档 | Markdown 文档 | 源码、可执行脚本 |
| `docs/decisions/` | 决策记录 | ADR 文档 | 日常笔记 |
| `docs/ui-kit/` | 上游相关 | 接入说明、已知问题、迁移对照 | 上游源码修改 |
| `scripts/` | 自动化脚本 | 构建/检查/发布脚本 | 业务逻辑 |

---

## 4. 命名规范

### 4.1 目录

| 规则 | 示例 |
|---|---|
| 小写 + `-` 分隔 | `src/client/vendor/ui-kit/` |
| 单数或惯用复数 | `src/server/`（单数） / `src/tests/`（惯用复数） |
| 不用中文、不用下划线 | ✅ `worldbook-editor/` ❌ `worldbook_editor/` `设置面板/` |
| 不用 `new`、`temp`、`misc`、`stuff` | 这些名字说明还没想清楚职责 |

### 4.2 文件

> **注意**：本项目采用 **PascalCase 服务端模块 + snake_case 测试文件** 的混合风格。
> 这是**跟随现状**的结果，不是笔误 —— 新文件请沿用对应目录的既有风格。

| 类型 | 规则 | 示例 |
|---|---|---|
| 服务端模块 | **PascalCase** | `PathGuard.js`、`WebDavClient.js` |
| 前端入口 | camelCase | `index.js` |
| 测试 | **snake_case** + `.test.js` | `security.test.js`、`e2e_backup_restore.test.js` |
| 文档 | kebab-case.md | `git-workflow.md` |
| 脚本 | kebab-case（可执行） | `validate-commit-msg.mjs` |
| 样式 | kebab-case.css | `style.css` |

### 4.3 前缀隔离

**前端样式与 CSS 变量必须带项目前缀**，避免与宿主主题或其它插件冲突：

```
CSS 类：    .st-webdav-container  .st-webdav-card   ← 项目前缀
CSS 变量：  --st-webdav-radius-md  --st-webdav-gap  ← 项目前缀
```

前缀用 `st-webdav-`（小写），全项目统一，**不得中途更换**。
ui-kit 自身的 `nvui-` 前缀保持不变，不要占用来做自己的前缀。

---

## 5. `src/` 内部的分层规则

### 5.1 依赖方向（必须单向）

```
index.js（服务端入口）
    │
    ├──▶ BackupService ──┐
    ├──▶ RestoreService ─┤  经 Constants.js 共享常量（禁止互相直接 import）
    ├──▶ SharedService ──┘
    ├──▶ ConfigManager
    ├──▶ WebDavClient
    └──▶ SchedulerService
```

**禁止**：
- `BackupService` ⇄ `RestoreService` 互相 import（这正是 `Constants.js` 存在的原因）
- 任何模块反向 import `index.js`

跨模块协作的正确方式：把双方都要用的逻辑提到 `Constants.js`（纯常量）或独立工具模块。

### 5.2 各层职责

| 层 | 职责 | 不该做 |
|---|---|---|
| `index.js` | 模块装配、生命周期、路由注册 | 写具体业务逻辑 |
| `src/server/*.js` | 服务端业务逻辑 | 直接访问前端 DOM |
| `src/client/index.js` | 面板渲染与交互 | 触碰文件系统、绕过服务端 API |

### 5.3 宿主与配置的访问方式

- **服务端配置**一律经 `ConfigManager`（`ConfigManager.forUser(req.user)`），**禁止**直接读 `st_webdav_config.json`。
- **前端**只能通过 `/api/plugins/st-webdav/*` 路由与服务端通信，**禁止**在前端直接发起 WebDAV 请求。

---

## 6. `tests/` 组织

### 6.1 命名与位置

```
src/server/PathGuard.js   →  tests/security.test.js（主题型）
src/server/Version.js     →  tests/version.test.js
备份+还原全链路           →  tests/e2e_backup_restore.test.js
```

### 6.2 测试分层

| 层 | 覆盖 | 要求 |
|---|---|---|
| 单元测试 | 纯函数、解析、格式化 | 零依赖、秒级完成 |
| 集成测试 | 多模块协作 | 可用 mock 隔离宿主与网络 |
| 端到端 | 备份→还原全链路 | 用本地临时 WebDAV 服务器，不依赖真实网盘 |
| 实机验证 | 真实酒馆环境 | 需人工触发，作为回归依据留存 |

### 6.3 禁止

- ❌ 测试依赖执行顺序
- ❌ 测试依赖真实网络（不得连真实 WebDAV 网盘）
- ❌ 测试直接改生产代码路径（如绕过入口调私有函数）
- ❌ 为了让测试通过而改断言

### 6.4 运行方式

```bash
npm test
```

---

## 7. `docs/` 组织

| 目录 | 放什么 | 命名 |
|---|---|---|
| `engineering/` | 工程规范（提交、版本、目录、AI 协同） | kebab-case.md |
| `decisions/` | 架构决策记录（ADR） | `NNN-<简短标题>.md` |
| `ui-kit/` | 上游接入说明、已知问题、迁移对照 | kebab-case.md |
| 其它主题 | 按主题自建目录 | kebab-case.md |

### 7.1 架构决策记录（ADR）

记录**为什么这么做**，防止半年后重复讨论同一件事。

```markdown
# ADR-003：运行时设置改由单一 runtime 层管理

- 状态：已接受
- 日期：2026-10-21
- 相关：#45

## 背景
多个模块各自访问 SillyTavern.getContext()，导致宿主版本适配要改 N 处。

## 决策
只允许 src/runtime.js 接触宿主，其余模块经 runtime 取能力。

## 后果
- 正面：适配成本降到 1 处；业务逻辑可单测
- 负面：多一层间接；新人不熟悉时要先读 runtime
```

---

## 8. `src/client/vendor/ui-kit/` 目录的特殊约定

由于该目录是**上游组件库的内置副本**：

| 规则 | 说明 |
|---|---|
| **只读** | 不修改其中任何文件。发现问题走上游 issue 流程 |
| **自包含** | 内部文档链接用同目录相对路径，不引用父目录 |
| **独立版本** | 版本号写在 CSS 文件头（当前 v2.5.0），与本项目版本不联动 |
| **加载优先级** | 本地副本优先，CDN 仅作降级兜底（见 `../../AGENTS.md` §6.4） |
| **同步方式** | 从上游仓库整目录同步，**不逐文件挑选**（避免半新半旧） |

**同步流程：**

```
① 读上游 CHANGELOG，识别破坏性变更
    ↓
② 备份当前版本号，确认改动清单
    ↓
③ 整目录覆盖同步
    ↓
④ 更新内置副本的版本号
    ↓
⑤ 跑本项目全量测试（npm test）
    ↓
⑥ 处理本项目的适配代码（破坏性变更的迁移）
    ↓
⑦ 删除已不需要的临时隔离层
    ↓
⑧ 本项目 CHANGELOG 记录「升级 ui-kit vX → vY」
```

> 上游仓库：<https://github.com/zgy-beep/ui-kit>

---

## 9. 根目录文件清单

**允许存在于根目录的文件**（且仅这些）：

```
AGENTS.md        README.md         CHANGELOG.md      CODE_REVIEW.md
LICENSE          manifest.json     package.json      pnpm-lock.yaml
index.js         style.css
```

> `index.js` 与 `style.css` 位于根目录是**宿主的加载约定**（`manifest.json` 指向它们），不是破例。

**其它一切**（配置、脚本、文档、源码、测试）必须进子目录。

例外：`.gitignore`、`.gitattributes`、`.npmrc` 等**点文件**属于仓库级配置，留在根目录是惯例。

---

## 10. 常见错误与纠正

| 错误 | 纠正 |
|---|---|
| 根目录堆了 20 个 `.js` | 全部移入 `src/server/` 或 `src/client/` |
| 出现 `src/utils.js` 杂物袋 | 按职责拆进对应模块；确需共用则移入 `Constants.js` 且保持纯常量 |
| 服务端模块用 kebab-case | 跟随现状用 PascalCase |
| `tests/` 里混进生产代码 | 移回 `src/` |
| 测试命名 `test1.js` | 改为 `<主题>.test.js` |
| 文档散落根目录 | 归入 `docs/<主题>/` |
| 在 `src/client/vendor/ui-kit/` 里改源码 | 还原，走上游 issue 流程 |
| 直接读 `st_webdav_config.json` | 改用 `ConfigManager` |
| 新增顶层目录随手就加 | 先在 PR 里说明理由，经评审 |
