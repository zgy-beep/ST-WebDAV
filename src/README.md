# 源码目录（src/）

本目录存放产品源码。按 `../docs/engineering/directory-structure.md` 的分层规则组织：

```
src/
├── client/          # 前端扩展（IIFE，由 manifest.json 加载）
│   ├── index.js     #   前端唯一入口
│   └── vendor/
│       └── ui-kit/  #   上游组件库内置副本（只读，见 §「ui-kit 副本」）
└── server/          # 服务端业务模块（PascalCase 文件名）
    ├── BackupService.js    RestoreService.js   SharedService.js
    ├── ConfigManager.js    WebDavClient.js     SchedulerService.js
    ├── CryptoHelper.js     PathGuard.js        UrlGuard.js
    ├── JobLock.js          UserHelper.js       Version.js
    ├── BackupCategories.js Constants.js
    └── README.md
```

**规则要点：**

- 服务端入口在**根目录 `index.js`**（导出 `init` / `exit` / `info`，注册 Express 路由），
  前端入口在 `src/client/index.js`。**只有这两个入口**，不要新增第三个。
- 依赖单向：`index.js` → 服务端模块 → `Constants.js`，禁止反向与循环。
- 服务端模块之间**禁止互相 import**：`BackupService` 与 `RestoreService` 共享的常量
  一律放 `Constants.js`（该文件的存在目的就是打断这个环）。
- 前端**不得**触碰文件系统或直连 WebDAV，只能经 `/api/plugins/st-webdav/*` 路由；
  接口行为约定（状态码、scope 解析、并发语义）见 [`server/README.md`](server/README.md)。
- 禁止出现 `utils.js` / `helpers.js` 这类无归属杂物袋。
- 前端样式类名与 CSS 变量必须带项目前缀（`.st-webdav-` / `--st-webdav-`）；
  ui-kit 自身的 `nvui-` 前缀不得占用。

## ui-kit 副本

`src/client/vendor/ui-kit/` 是上游 [`zgy-beep/ui-kit`](https://github.com/zgy-beep/ui-kit)
的内置副本（当前 v2.8.0），**只读**。

- 禁止修改其中任何文件；发现缺陷走上游 issue 流程（`docs/ui-kit/issue-reporting.md`）。
- 禁止用 `!important` / 内联样式 / 覆写类名的方式在业务侧给 kit 打补丁。
- 加载顺序为「宿主达标 → 本地副本 → 宿主旧版 → CDN 兜底」，详见 `../../AGENTS.md` §6.4。

**新建服务端模块时**，同步更新本目录下的 `README.md` 说明其职责边界。
