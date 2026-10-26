import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findChrome, launchChrome, waitFor } from './_helpers/cdp.mjs';

/**
 * 浏览器冒烟测试（ui-kit 运行时）
 * ------------------------------------------------------------------
 * 单元测试运行在 Node 里，无法验证 DOM/CSS/玻璃降级等浏览器行为。
 * 本文件用系统 Chrome（headless，经 CDP 驱动，零第三方依赖）加载
 * 内置 ui-kit 的真实资源，验证：
 *   1. kit 版本、令牌、面板创建与 data-nvui-version 标记；
 *   2. kit 运行时自检 selfCheck 正常路径返回 ok 且无 issues；
 *   3. 缺少 kit CSS 时 selfCheck 能报出 css-not-loaded（自检本身有效）。
 * 未安装 Chrome 时自动跳过，不影响 npm test。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT_DIR = path.resolve(HERE, '..', '..', 'src', 'client', 'vendor', 'ui-kit');

function buildHtml({ withCss }) {
  return `<!doctype html>
<html><head><meta charset="utf-8">
${withCss ? '<link rel="stylesheet" href="/kit/tokens.css"><link rel="stylesheet" href="/kit/components.css">' : ''}
</head><body>
<script src="/kit/nvui-api.js"></script>
<script>
window.addEventListener('load', function () {
  try {
    var kit = window.NVUI;
    var checks = {};
    checks.version = kit && kit.version;
    checks.hasSelfCheck = !!(kit && typeof kit.selfCheck === 'function');
    checks.selfCheck = checks.hasSelfCheck ? kit.selfCheck({ expect: '2.8.0' }) : null;
    checks.compat = kit && typeof kit.checkCompatibility === 'function'
      ? kit.checkCompatibility({ min: '2.8.0' })
      : null;
    checks.cssToken = kit && typeof kit.getToken === 'function'
      ? kit.getToken('--nvui-kit-version')
      : null;
    if (kit && typeof kit.createPanel === 'function') {
      var panel = kit.createPanel({
        id: 'smoke',
        title: 'Smoke',
        tabs: [{ key: 'a', label: 'A' }]
      });
      panel.open();
      checks.panelOpen = !!document.querySelector('.nvui-panel');
      checks.dataVersion = document.documentElement.getAttribute('data-nvui-version');
      panel.close();
    }
    window.__SMOKE__ = { ok: true, checks: checks };
  } catch (err) {
    window.__SMOKE__ = { ok: false, error: String((err && err.stack) || err) };
  }
});
</script>
</body></html>`;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/no-css') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(buildHtml({ withCss: url.pathname === '/' }));
      return;
    }
    const match = url.pathname.match(/^\/kit\/([\w.-]+)$/);
    if (match) {
      const file = path.join(KIT_DIR, match[1]);
      if (fs.existsSync(file)) {
        res.writeHead(200, {
          'content-type': match[1].endsWith('.css') ? 'text/css' : 'text/javascript',
        });
        fs.createReadStream(file).pipe(res);
        return;
      }
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const chromeAvailable = Boolean(findChrome());

test('浏览器冒烟：ui-kit 2.8.0 运行时、面板与 selfCheck 通过', { skip: !chromeAvailable }, async (t) => {
  const { server, base } = await startServer();
  const browser = await launchChrome();
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  });

  await browser.cdp.send('Page.enable');
  await browser.cdp.send('Runtime.enable');
  await browser.cdp.send('Page.navigate', { url: `${base}/` });

  const smoke = await waitFor(browser.cdp, 'window.__SMOKE__ || null');
  assert.equal(smoke.ok, true, smoke.error || '页面初始化失败');

  const checks = smoke.checks;
  assert.equal(checks.version, '2.8.0', '内置 kit 版本应为 2.8.0');
  assert.equal(checks.hasSelfCheck, true, '2.8.0 应提供 selfCheck');
  assert.equal(checks.selfCheck.ok, true, `selfCheck 应通过，实际 issues=${JSON.stringify(checks.selfCheck.issues)}`);
  assert.deepEqual(checks.selfCheck.issues, []);
  assert.equal(checks.compat.compatible, true);
  assert.equal(checks.panelOpen, true, 'createPanel + open 应渲染出 .nvui-panel');
  assert.equal(checks.dataVersion, '2.8.0', '载体的 data-nvui-version 应为 2.8.0');
  assert.match(String(checks.cssToken), /2\.8\.0/, '--nvui-kit-version 令牌应为 2.8.0');
});

test('浏览器冒烟：未加载 kit CSS 时 selfCheck 报 css-not-loaded', { skip: !chromeAvailable }, async (t) => {
  const { server, base } = await startServer();
  const browser = await launchChrome();
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  });

  await browser.cdp.send('Page.enable');
  await browser.cdp.send('Runtime.enable');
  await browser.cdp.send('Page.navigate', { url: `${base}/no-css` });

  const smoke = await waitFor(browser.cdp, 'window.__SMOKE__ || null');
  assert.equal(smoke.ok, true, smoke.error || '页面初始化失败');
  assert.equal(smoke.checks.selfCheck.ok, false, '缺 CSS 时自检应失败');
  assert.ok(
    smoke.checks.selfCheck.issues.includes('css-not-loaded'),
    `issues 应包含 css-not-loaded，实际：${JSON.stringify(smoke.checks.selfCheck.issues)}`,
  );
});
