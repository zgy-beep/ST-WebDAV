import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as fflate from 'fflate';

import { BackupService } from '../src/server/BackupService.js';
import { RestoreService } from '../src/server/RestoreService.js';
import { ConfigManager } from '../src/server/ConfigManager.js';
import { JobLock } from '../src/server/JobLock.js';
import { JobBusyError, HTTP_CONFLICT } from '../src/server/JobBusyError.js';

/**
 * 备份/还原 API 契约回归
 * ------------------------------------------------------------------
 * 两个缺陷由 2026-10-26 实机验收发现：
 *   1. 只传 categories 未传 scope 时，scope 回落配置值（如 core）导致归档内容
 *      与 manifest/远端 meta 记录的 categories 不一致；
 *   2. 并发任务冲突抛普通 Error，路由层统一映射 500，语义应为 409。
 */


function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st_webdav_contract_'));
  const userDir = path.join(root, 'data', 'default-user');
  fs.mkdirSync(path.join(userDir, 'worlds'), { recursive: true });
  fs.mkdirSync(path.join(userDir, 'characters'), { recursive: true });
  fs.writeFileSync(path.join(userDir, 'settings.json'), '{"theme":"contract-test"}');
  fs.writeFileSync(path.join(userDir, 'secrets.json'), '{"k":"v"}');
  fs.writeFileSync(path.join(userDir, 'worlds', 'lore.json'), '{"entries":[]}');
  fs.writeFileSync(path.join(userDir, 'characters', 'card.json'), '{"name":"demo"}');
  return { root, userDir, cfgPath: path.join(root, 'config.json') };
}

function createMockWebDavClient() {
  const storage = new Map();
  return {
    storage,
    updateConfig: () => {},
    ensureDirectory: async () => {},
    put: async (remotePath, body) => {
      if (Buffer.isBuffer(body)) {
        storage.set(remotePath, body);
      } else {
        const chunks = [];
        for await (const chunk of body) chunks.push(chunk);
        storage.set(remotePath, Buffer.concat(chunks));
      }
      return { success: true, status: 201 };
    },
    getBuffer: async (remotePath) => {
      const buf = storage.get(remotePath);
      if (!buf) throw new Error('File not found: ' + remotePath);
      return buf;
    },
    listFiles: async () => [],
    delete: async () => ({ success: true }),
  };
}

function createServices(fixture, overrides = {}) {
  const client = createMockWebDavClient();
  const configManager = new ConfigManager(fixture.cfgPath);
  configManager.update({
    webdavUrl: 'https://dav.example.com/remote.php/webdav',
    remoteDirectory: 'Contract_Backups',
    isolateUserDirectory: false,
    backupScope: 'core',
    retentionCount: 5,
    ...overrides,
  });
  return {
    client,
    configManager,
    backupService: new BackupService({ webDavClient: client, configManager }),
    restoreService: new RestoreService({ webDavClient: client, configManager }),
  };
}

function requestUserFor(userDir) {
  return { handle: 'default-user', directories: { root: userDir } };
}

function unzipEntries(buffer) {
  return fflate.unzipSync(new Uint8Array(buffer));
}

test('Backup 契约: 只传 categories 未传 scope 时按自定义分类打包且元数据一致', async () => {
  const fixture = createFixture();
  try {
    const { backupService, client } = createServices(fixture);
    const result = await backupService.runBackup({
      categories: ['settings'],
      requestUser: requestUserFor(fixture.userDir),
    });

    assert.equal(result.success, true);
    assert.equal(result.scope, 'custom', '未传 scope 但传了 categories 时应归一化为 custom');
    assert.match(result.fileName, /_custom_/, '文件名应包含 custom 段');
    assert.deepEqual(result.categories, ['settings']);

    const entries = unzipEntries(client.storage.get(result.remotePath));
    const names = Object.keys(entries);
    assert.ok(names.includes('settings.json'), '应打包 settings.json');
    assert.ok(names.includes('backup_manifest.json'), '应包含备份清单');
    assert.equal(names.some(n => n.startsWith('worlds/')), false, 'custom 打包不应包含未选择的 worlds');
    assert.equal(names.some(n => n.startsWith('characters/')), false, 'custom 打包不应包含未选择的 characters');

    const manifest = JSON.parse(fflate.strFromU8(entries['backup_manifest.json']));
    assert.equal(manifest.scope, 'custom', '清单记录的 scope 与实际归档内容一致');
    assert.deepEqual(manifest.categories, ['settings']);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Backup 契约: 显式 scope=core 时忽略 categories，仍按核心配置打包', async () => {
  const fixture = createFixture();
  try {
    const { backupService, client } = createServices(fixture);
    const result = await backupService.runBackup({
      scope: 'core',
      categories: ['settings'],
      requestUser: requestUserFor(fixture.userDir),
    });

    assert.equal(result.scope, 'core');
    const entries = unzipEntries(client.storage.get(result.remotePath));
    const names = Object.keys(entries);
    assert.ok(names.includes('worlds/lore.json'), 'core 应包含核心目录 worlds');
    assert.equal(names.some(n => n.startsWith('characters/')), false, 'core 不包含 characters');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Backup 契约: 未传 scope 与 categories 时回落配置的 backupScope', async () => {
  const fixture = createFixture();
  try {
    const { backupService } = createServices(fixture, { backupScope: 'core' });
    const result = await backupService.runBackup({
      requestUser: requestUserFor(fixture.userDir),
    });
    assert.equal(result.scope, 'core');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Backup 契约: 同一用户并发备份抛出 409 JobBusyError', async () => {
  const fixture = createFixture();
  try {
    const { backupService } = createServices(fixture);
    backupService.activeBackups.add('default-user');
    try {
      await assert.rejects(
        backupService.runBackup({ scope: 'core', requestUser: requestUserFor(fixture.userDir) }),
        err => err instanceof JobBusyError && err.status === HTTP_CONFLICT,
      );
    } finally {
      backupService.activeBackups.delete('default-user');
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Restore 契约: 同一用户并发还原抛出 409 JobBusyError', async () => {
  const fixture = createFixture();
  try {
    const { restoreService } = createServices(fixture);
    restoreService.activeRestores.add('default-user');
    try {
      await assert.rejects(
        restoreService.restoreBackup({
          remoteFileName: 'ST_Backup_core_20260101_000000.zip',
          requestUser: requestUserFor(fixture.userDir),
        }),
        err => err instanceof JobBusyError && err.status === HTTP_CONFLICT,
      );
    } finally {
      restoreService.activeRestores.delete('default-user');
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('JobLock 契约: 重复获取同类型/异类型锁均抛 409，释放后可重新获取', () => {
  const handle = `contract-lock-${Date.now()}`;
  const release = JobLock.acquire(handle, 'backup');
  try {
    assert.throws(
      () => JobLock.acquire(handle, 'backup'),
      err => err instanceof JobBusyError && err.status === HTTP_CONFLICT,
    );
    assert.throws(
      () => JobLock.acquire(handle, 'restore'),
      err => err instanceof JobBusyError && err.status === HTTP_CONFLICT,
    );
  } finally {
    release();
  }
  const again = JobLock.acquire(handle, 'backup');
  again();
  assert.equal(JobLock.peek(handle), null);
});

