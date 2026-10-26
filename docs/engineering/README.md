# 工程规范总览

本目录是项目工程规范的**单一入口**。所有细则文档互相引用、职责不重叠。

---

## 文档清单

| 文档 | 解决的问题 | 主要读者 |
|---|---|---|
| [`../../AGENTS.md`](../../AGENTS.md) | AI 编码助手的行为准则与红线 | AI 助手（每次会话必读） |
| [`git-workflow.md`](git-workflow.md) | 分支命名、提交信息、PR 与评审流程 | 所有人 |
| [`versioning.md`](versioning.md) | 版本号递增时机与 CHANGELOG 维护 | 所有人 |
| [`directory-structure.md`](directory-structure.md) | 文件该放哪、依赖怎么分层 | 所有人 |
| [`ai-collaboration.md`](ai-collaboration.md) | 人机分工、任务拆解、验收标准 | 人 + AI |
| [`manual-qa.md`](manual-qa.md) | 发版实机验收项、操作步骤与执行记录（自动化覆盖不到的部分） | 发版负责人 / 验证人 |
| [`../ui-kit/issue-reporting.md`](../ui-kit/issue-reporting.md) | 向上游提 issue 的格式与跟踪 | 发现 ui-kit 缺陷时 |
| [`../decisions/README.md`](../decisions/README.md) | 架构决策记录（ADR）的写法与时机 | 遇到架构选择时 |

---

## 阅读路径

**新加入项目的人 / AI 首次接触：**

```
AGENTS.md  →  README.md  →  directory-structure.md  →  按需查其余
```

**准备提 PR：**

```
git-workflow.md（分支 + 提交 + PR 模板）
    →  ai-collaboration.md（自审清单 + 验收标准）
```

**准备发版：**

```
versioning.md（递增哪一位）
    →  manual-qa.md（实机验收项与记录）
    →  CHANGELOG.md（写条目）
    →  git-workflow.md §5（打标签与发布）
```

**发现 ui-kit 有 bug：**

```
AGENTS.md §6（铁律：不在本地改写）
    →  ../ui-kit/issue-reporting.md（怎么写 issue）
    →  ../ui-kit/known-issues.md（登记与跟踪）
```

---

## 规范之间的关系

```
                    ┌─────────────────────┐
                    │      AGENTS.md      │  ← 总纲：行为准则与红线
                    │   （每次会话必读）   │
                    └──────────┬──────────┘
                               │ 细化
        ┌──────────────┬───────┴───────┬──────────────┐
        ▼              ▼               ▼              ▼
  git-workflow   versioning   directory-      ai-collaboration
      .md            .md       structure.md       .md
                                  │
                                  ▼
                          ┌───────────────┐
                          │  ui-kit/      │  ← 外部组件库的协作边界
                          │issue-reporting│
                          └───────────────┘
```

**冲突时的优先级**（从上到下）：

1. `AGENTS.md` 中的**红线清单**（§10）—— 任何情况不可绕过。
2. 具体细则文档（更具体 > 更笼统）。
3. `AGENTS.md` 的通用条款。

---

## 规范的落地方式

**规范不是纸面文章，以下机制让它真正生效：**

| 机制 | 文件 | 作用 |
|---|---|---|
| 提交信息校验 | `scripts/validate-commit-msg.mjs` | 提交时自动拦截不合规信息（**已落地**） |
| 版本号守卫 | `tests/version.test.js` | 强制 `package.json` / `manifest.json` / 服务端版本一致（**已落地**） |
| 持续集成（CI） | `.github/workflows/ci.yml` | push / PR 到 `main` 时自动跑 `npm test`，红灯不得合并（**已落地**） |
| 上游问题台账 | `docs/ui-kit/known-issues.md` | 跟踪 ui-kit 缺陷直到同步修复（**已落地**） |
| PR 描述模板 | `.github/PULL_REQUEST_TEMPLATE.md` | 发起 PR 时自动带出描述结构与自查清单（**已落地**） |
| Issue 模板 | `.github/ISSUE_TEMPLATE/ui-kit-*.md` | 上报 ui-kit 问题时带出必填要素与自查清单（**已落地**） |

**接入 git hook（可选）：**

```bash
# Linux / macOS
cp scripts/validate-commit-msg.mjs scripts/
cat > .git/hooks/commit-msg << 'EOF'
#!/bin/sh
node scripts/validate-commit-msg.mjs "$1"
EOF
chmod +x .git/hooks/commit-msg

# Windows PowerShell
@'
#!/bin/sh
node scripts/validate-commit-msg.mjs "$1"
'@ | Set-Content .git/hooks/commit-msg -Encoding ascii
```

---

## 维护约定

- **规范本身也是代码**：改动规范需走 PR，同样受本规范约束。
- **规范要跟着实践走**：实践中形成的更好做法，及时回写到对应文档，而不是只留在某个人的记忆里。
- **每季度回顾一次**：检查清单里的条目是否还有效，是否有踩坑后新增的红线。
