import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPluginVersion } from '../src/server/Version.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 版本号一致性守卫
 * ------------------------------------------------------------------
 * 背景：v1.1.0 升级时漏改了前端面板的版本徽章与备份清单中的版本字段，
 *      用户在 UI 上看到的仍是 v1.0.0。本文件用测试把「版本号只有一个
 *      事实来源」这一约束固化下来，避免同类漂移再次发生。
 */

// ------------------------------------------------------------------
// 1. 服务端版本号读取
// ------------------------------------------------------------------

test('Version: 服务端读取到的版本号与 package.json 一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  assert.equal(getPluginVersion(), pkg.version, '服务端版本号必须与 package.json 完全一致');
});

test('Version: 服务端版本号读取结果稳定（多次调用一致）', () => {
  const first = getPluginVersion();
  const second = getPluginVersion();
  assert.equal(first, second);
  assert.ok(first && first !== 'unknown', '版本号不应为 unknown');
});

// ------------------------------------------------------------------
// 2. 三个版本号来源必须互相一致
// ------------------------------------------------------------------

test('Version: package.json / manifest.json / 服务端 info.version 三者一致', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf-8'));

  assert.equal(
    manifest.version,
    pkg.version,
    'manifest.json 的 version 必须与 package.json 一致（酒馆 UI 读的是 manifest）'
  );

  const indexSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf-8');
  // 服务端 info.version 已改为从 Version.js 读取，不应再有硬编码版本字面量
  assert.ok(
    indexSrc.includes('getPluginVersion()'),
    'index.js 的 info.version 必须通过 getPluginVersion() 读取，不得硬编码'
  );
  assert.equal(
    /version:\s*['"]\d+\.\d+\.\d+['"]/.test(indexSrc),
    false,
    'index.js 中不应残留硬编码的版本号字面量'
  );
});

// ------------------------------------------------------------------
// 3. 前端不得残留硬编码版本号
// ------------------------------------------------------------------

test('Version: 前端面板不得硬编码版本号', () => {
  const clientSrc = fs.readFileSync(path.join(ROOT, 'src', 'client', 'index.js'), 'utf-8');

  // createPanel 的 version 参数必须是动态值
  assert.ok(
    /version:\s*`v\$\{PLUGIN_VERSION\}`/.test(clientSrc),
    'createPanel 的 version 参数必须使用动态的 PLUGIN_VERSION'
  );

  // 不得出现 version: 'v1.x.x' 这类硬编码
  assert.equal(
    /version:\s*['"]v?\d+\.\d+\.\d+['"]/.test(clientSrc),
    false,
    '前端不得残留硬编码的版本号（历史上此处为 v1.0.0，升级时漏改）'
  );
});

test('Version: 前端具备三级版本来源（服务端 / manifest / 字面量兜底）', () => {
  const clientSrc = fs.readFileSync(path.join(ROOT, 'src', 'client', 'index.js'), 'utf-8');

  assert.ok(
    clientSrc.includes('pluginVersion'),
    '前端应从 /config 响应中读取服务端下发的 pluginVersion'
  );
  assert.ok(
    clientSrc.includes('loadVersionFromManifest'),
    '前端应具备从 manifest.json 读取版本号的次级来源'
  );
  assert.ok(
    clientSrc.includes('PLUGIN_VERSION_FALLBACK'),
    '前端应保留字面量兜底，避免版本号读取失败时显示为空'
  );
});

test('Version: 服务端 /config 响应包含 pluginVersion 字段', () => {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf-8');
  assert.ok(
    /pluginVersion:\s*getPluginVersion\(\)/.test(indexSrc),
    '/config 响应必须包含 pluginVersion 字段，供前端面板显示'
  );
});

// ------------------------------------------------------------------
// 4. 备份清单中的版本号
// ------------------------------------------------------------------

test('Version: 备份清单使用动态版本号而非硬编码', () => {
  const backupSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'BackupService.js'), 'utf-8');

  assert.ok(
    backupSrc.includes('getPluginVersion()'),
    '备份清单的 version 字段必须通过 getPluginVersion() 获取'
  );
  assert.equal(
    /version:\s*['"]\d+\.\d+\.\d+['"]/.test(backupSrc),
    false,
    'BackupService 中不得残留硬编码的版本号（历史上为 1.0.0，升级时漏改）'
  );
});

// ------------------------------------------------------------------
// 5. UI Kit 版本一致性
// ------------------------------------------------------------------

test('Version: ui-kit 三个文件的版本号互相一致', () => {
  const apiSrc = fs.readFileSync(path.join(ROOT, 'src', 'client', 'vendor', 'ui-kit', 'nvui-api.js'), 'utf-8');
  const tokensSrc = fs.readFileSync(path.join(ROOT, 'src', 'client', 'vendor', 'ui-kit', 'tokens.css'), 'utf-8');
  const compSrc = fs.readFileSync(path.join(ROOT, 'src', 'client', 'vendor', 'ui-kit', 'components.css'), 'utf-8');

  const apiVer = apiSrc.match(/var VERSION = '([^']+)'/)?.[1];
  assert.ok(apiVer, 'nvui-api.js 必须定义 VERSION');

  const tokensVer = tokensSrc.match(/版本：ui-kit v([\d.]+)/)?.[1];
  const compVer = compSrc.match(/版本：ui-kit v([\d.]+)/)?.[1];

  assert.equal(tokensVer, apiVer, 'tokens.css 的版本号必须与 nvui-api.js 一致');
  assert.equal(compVer, apiVer, 'components.css 的版本号必须与 nvui-api.js 一致');
});

test('Version: 前端要求的 UI Kit 最低版本不超过内置副本版本', () => {
  const clientSrc = fs.readFileSync(path.join(ROOT, 'src', 'client', 'index.js'), 'utf-8');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'src', 'client', 'vendor', 'ui-kit', 'nvui-api.js'), 'utf-8');

  const minVer = clientSrc.match(/NVUI_MIN_VERSION = '([^']+)'/)?.[1];
  const bundledVer = apiSrc.match(/var VERSION = '([^']+)'/)?.[1];

  assert.ok(minVer, '前端必须定义 NVUI_MIN_VERSION');
  assert.ok(bundledVer, '内置 ui-kit 必须定义 VERSION');

  // 简单 semver 比较：内置版本 >= 最低要求，否则前端会拒绝使用本地副本
  const toNum = v => v.split('.').map(Number);
  const [a1, a2, a3] = toNum(bundledVer);
  const [b1, b2, b3] = toNum(minVer);
  const bundledIsNewer = a1 > b1 || (a1 === b1 && (a2 > b2 || (a2 === b2 && a3 >= b3)));
  assert.ok(
    bundledIsNewer,
    `内置 UI Kit 版本 (${bundledVer}) 不得低于前端要求的最低版本 (${minVer})`
  );
});

test('Version: 文档与准则中的 UI Kit 版本与内置副本一致', () => {
  const apiSrc = fs.readFileSync(path.join(ROOT, 'src', 'client', 'vendor', 'ui-kit', 'nvui-api.js'), 'utf-8');
  const bundledVer = apiSrc.match(/var VERSION = '([^']+)'/)?.[1];
  assert.ok(bundledVer);

  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8');
  const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf-8');

  assert.ok(
    readme.includes(`内置 v${bundledVer} 离线副本`),
    `README.md 应当引用内置 UI Kit 当前版本 v${bundledVer}`
  );
  assert.ok(
    agents.includes(`当前 v${bundledVer}`),
    `AGENTS.md 应当引用内置 UI Kit 当前版本 v${bundledVer}`
  );
});

