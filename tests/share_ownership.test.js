import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

import { isBackupOwnedBy } from '../src/server/PathGuard.js';

/**
 * 共享目录模式（isolateUserDirectory=false）的归属校验回归
 * ------------------------------------------------------------------
 * 2026-10-26 实测缺陷：非隔离模式下同一远端目录混有各账号备份，
 * `/delete` 有「只能操作本人前缀文件」的校验，但 `/share` 缺失，
 * 导致 bob 可分享 alice 的备份并把归属记成 bob，进而反向阻塞 alice（409）。
 * 本文件锁定修复：/share 与 /delete 使用同一归属校验，管理员例外。
 */

const ALICE_FILE = 'ST_Backup_alice_core_20260101_000000__alice-note.zip';
const BOB_FILE = 'ST_Backup_bob_core_20260101_000000__bob-note.zip';

function writeUserConfig(userDir, overrides = {}) {
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'st_webdav_config.json'), JSON.stringify({
    webdavUrl: 'http://127.0.0.1:59999/dav',
    webdavUsername: 'test',
    webdavPassword: 'test',
    remoteDirectory: 'Shared_Backups',
    isolateUserDirectory: false,
    timeoutMs: 300,
    backupScope: 'core',
    ...overrides,
  }));
}

test('PathGuard: isBackupOwnedBy 按 handle 前缀判定归属且不误匹配', () => {
  assert.equal(isBackupOwnedBy(ALICE_FILE, 'alice'), true);
  assert.equal(isBackupOwnedBy(ALICE_FILE, 'bob'), false);
  // 前缀边界：handle "a" 不得匹配 "ST_Backup_alice_..."
  assert.equal(isBackupOwnedBy(ALICE_FILE, 'a'), false);
  // handle "alice" 不得匹配 "ST_Backup_alice2_..."
  assert.equal(isBackupOwnedBy('ST_Backup_alice2_core_20260101_000000.zip', 'alice'), false);
  // 非法入参
  assert.equal(isBackupOwnedBy(null, 'alice'), false);
  assert.equal(isBackupOwnedBy(ALICE_FILE, ''), false);
  assert.equal(isBackupOwnedBy(ALICE_FILE, null), false);
});

test('API 契约: 共享目录模式下 /share 与 /delete 只允许操作本人备份，管理员例外', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st_webdav_share_owner_'));
  const usersRoot = path.join(root, 'data', '_users');
  const aliceDir = path.join(usersRoot, 'alice');
  const bobDir = path.join(usersRoot, 'bob');
  writeUserConfig(aliceDir);
  writeUserConfig(bobDir);

  const originalCwd = process.cwd();
  process.chdir(root);

  const { init, exit } = await import('../index.js');
  const app = express();
  app.use(express.json());
  // 测试用身份注入：按请求头切换用户（模拟 ST 的 req.user）
  app.use((req, _res, next) => {
    const handle = String(req.get('x-test-handle') || 'bob');
    req.user = {
      handle,
      admin: req.get('x-test-admin') === '1',
      directories: { root: path.join(usersRoot, handle) },
    };
    next();
  });
  const router = express.Router();
  await init(router);
  app.use('/api/plugins/st-webdav', router);

  let server;
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}/api/plugins/st-webdav`;
  const post = (url, body, headers = {}) => fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  try {
    // 1) bob 分享 alice 的备份 → 403（修复前会 200 并冒认归属）
    let resp = await post('/share', { fileName: ALICE_FILE });
    assert.equal(resp.status, 403, '非管理员分享他人备份必须 403');
    assert.match((await resp.json()).error, /只能分享属于本人的备份/);

    // 2) bob 删除 alice 的备份 → 403（既有行为，重构后保持）
    resp = await post('/delete', { fileName: ALICE_FILE });
    assert.equal(resp.status, 403, '非管理员删除他人备份必须 403');
    assert.match((await resp.json()).error, /只能删除属于本人的备份/);

    // 3) bob 分享自己的备份 → 通过归属校验（后续因测试 WebDAV 不可达而为 500，
    //    关键断言是不能被误拦为 403）
    resp = await post('/share', { fileName: BOB_FILE });
    assert.notEqual(resp.status, 403, '本人备份不得被归属校验误拦');
    assert.equal(resp.status, 500, '测试 WebDAV 不可达时返回 500');

    // 4) 管理员分享 alice 的备份 → 归属校验豁免（同样只断言不是 403）
    resp = await post('/share', { fileName: ALICE_FILE }, { 'x-test-admin': '1' });
    assert.notEqual(resp.status, 403, '管理员应豁免归属校验');
  } finally {
    await exit();
    await new Promise(resolve => server.close(resolve));
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
