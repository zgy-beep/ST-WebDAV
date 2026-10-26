import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

import { JobLock } from '../src/server/JobLock.js';

/**
 * HTTP 状态码契约回归
 * ------------------------------------------------------------------
 * 2026-10-26 实机验收发现：并发备份被互斥拒绝时返回 500，而「任务占用」
 * 属于客户端可重试的冲突，应为 409。本用例真正启动 Express 路由，
 * 验证 409 映射生效、且非冲突错误仍保持 500（避免一刀切改状态码）。
 */

test('API 契约: 并发备份/还原冲突返回 409，非冲突错误仍为 500', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st_webdav_api_conflict_'));
  const userDir = path.join(root, 'data', 'default-user');
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'settings.json'), '{"theme":"api-test"}');
  // 插件初始化时 ConfigManager 会读取该用户目录下的配置文件
  fs.writeFileSync(path.join(userDir, 'st_webdav_config.json'), JSON.stringify({
    webdavUrl: 'http://127.0.0.1:59999/dav',
    webdavUsername: 'test',
    webdavPassword: 'test',
    remoteDirectory: 'QA_Backups',
    isolateUserDirectory: false,
    timeoutMs: 1000,
    backupScope: 'core',
  }));

  const originalCwd = process.cwd();
  process.chdir(root);

  const { init, exit } = await import('../index.js');
  const app = express();
  app.use(express.json());
  // 单用户模式：宿主以 req.user 注入当前用户目录
  app.use((req, _res, next) => {
    req.user = { handle: 'default-user', admin: true, directories: { root: userDir } };
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
  const post = (url, body) => fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  try {
    // 1) 备份锁被占用 → 409
    const releaseBackup = JobLock.acquire('default-user', 'backup');
    try {
      const resp = await post('/backup', { scope: 'core' });
      assert.equal(resp.status, 409, '并发备份应返回 409');
      const body = await resp.json();
      assert.match(body.error, /另一个备份任务正在进行中/);
    } finally {
      releaseBackup();
    }

    // 2) 还原锁被占用 → 409
    const releaseRestore = JobLock.acquire('default-user', 'restore');
    try {
      const resp = await post('/restore', { fileName: 'ST_Backup_core_20260101_000000.zip' });
      assert.equal(resp.status, 409, '并发还原应返回 409');
      const body = await resp.json();
      assert.match(body.error, /另一个恢复任务正在进行中/);
    } finally {
      releaseRestore();
    }

    // 3) 非冲突错误（加密未提供口令）不应被误映射为 409
    const resp = await post('/backup', { scope: 'core', encrypt: true, password: '' });
    assert.equal(resp.status, 500, '真正的内部错误仍应为 500');
    const body = await resp.json();
    assert.match(body.error, /未提供加密密码/);
  } finally {
    JobLock.release('default-user');
    await exit();
    await new Promise(resolve => server.close(resolve));
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
