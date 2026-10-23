# 测试目录（tests/）

测试基于 Node.js 原生 `node:test` + `node:assert/strict`，无第三方测试框架。

测试文件命名必须能**反查到被测源文件或被测主题**（snake_case + `.test.js`）：

```
src/server/PathGuard.js / UrlGuard.js  →  tests/security.test.js
src/server/SharedService.js             →  tests/share.test.js
src/server/Version.js                   →  tests/version.test.js
备份 + 还原全链路                       →  tests/e2e_backup_restore.test.js
核心流程与服务端集成                   →  tests/st_webdav.test.js
```

**规则要点：**

- 禁止 `test1.js`、`a.test.js` 这类无意义命名。
- 测试必须可独立运行：不依赖执行顺序，不依赖真实网络（不得连真实 WebDAV 网盘，
  需要服务端时用本地临时 HTTP 服务器模拟）。
- 断言**行为**而非实现细节。
- 禁止为了让测试通过而修改断言或跳过测试。
- 改 bug 必须有能复现的回归测试（先红后绿）。
- 新增 `src/server/Xxx.js` 时，同步新增对应测试。

**运行方式**：

```bash
npm test
```

跑单个文件：

```bash
node --test tests/security.test.js
```
