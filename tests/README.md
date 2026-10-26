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
npm test            # 服务端/契约单元与集成测试（Node，无浏览器）
npm run test:browser # 浏览器冒烟（需要本机 Chrome/Edge；未安装时自动 skip）
```

跑单个文件：

```bash
node --test tests/security.test.js
```

## 浏览器冒烟（tests/browser/）

`tests/browser/` 存放需要真实 DOM/CSS 的用例，通过 Node 内置 WebSocket 直连系统
Chrome 的 DevTools 协议（零第三方依赖，不下载浏览器），验证 ui-kit 运行时行为：

- `kit_smoke.test.mjs` —— 内置 ui-kit 的版本/令牌/面板创建/`data-nvui-version`，
  以及 `NVUI.selfCheck()` 的正常路径（ok、issues 为空）与缺少 CSS 时的报错路径
  （issues 含 `css-not-loaded`）。
- `_helpers/cdp.mjs` —— 极简 CDP 客户端；可用 `CHROME_PATH` 指定浏览器路径。
- CI 中由 runner 自带 Chrome 执行；本地未装 Chrome 时用例自动 skip，`npm test` 不受影响。

**边界**：浏览器冒烟只覆盖 ui-kit 运行时契约，不启动 SillyTavern 宿主；
宿主交互与实机验收见 `docs/engineering/manual-qa.md`。
