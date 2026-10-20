import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { BackupService } from '../src/server/BackupService.js';
import { RestoreService } from '../src/server/RestoreService.js';
import { ConfigManager } from '../src/server/ConfigManager.js';

test('E2E 集成测试：核心配置打包加密上传至 WebDAV，再完整解密还原', async () => {
  // 1. 创建虚拟测试用户目录
  const testUserDir = path.join(os.tmpdir(), `test_st_user_${Date.now()}`);
  fs.mkdirSync(testUserDir, { recursive: true });

  const settingsContent = JSON.stringify({ theme: 'Flat Glass', fontSize: 14, activePreset: 'default' });
  const secretContent = JSON.stringify({ api_key_anthropic: 'sk-ant-test-12345' });
  const worldContent = JSON.stringify({ entries: [{ uid: 1, name: '艾琳', comment: '王国卫队长' }] });

  fs.writeFileSync(path.join(testUserDir, 'settings.json'), settingsContent);
  fs.writeFileSync(path.join(testUserDir, 'secrets.json'), secretContent);
  
  const worldsDir = path.join(testUserDir, 'worlds');
  fs.mkdirSync(worldsDir, { recursive: true });
  fs.writeFileSync(path.join(worldsDir, 'fantasy.json'), worldContent);

  // 2. 模拟远端 WebDAV 存储池
  const remoteStorage = new Map();
  const mockWebDavClient = {
    ensureDirectory: async () => {},
    put: async (remotePath, stream) => {
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      remoteStorage.set(remotePath, Buffer.concat(chunks));
      return { success: true, status: 201 };
    },
    getBuffer: async (remotePath) => {
      const buf = remoteStorage.get(remotePath);
      if (!buf) throw new Error('File not found: ' + remotePath);
      return buf;
    },
    listFiles: async (remoteDir) => {
      const list = [];
      for (const [key, val] of remoteStorage.entries()) {
        if (key.startsWith(remoteDir)) {
          list.push({
            name: path.basename(key),
            size: val.length,
            isDirectory: false,
            lastModified: new Date().toISOString(),
          });
        }
      }
      return list;
    },
    delete: async (remotePath) => {
      remoteStorage.delete(remotePath);
      return { success: true };
    },
  };

  const tmpCfgPath = path.join(os.tmpdir(), `test_cfg_${Date.now()}.json`);
  const configManager = new ConfigManager(tmpCfgPath);
  configManager.update({
    remoteDirectory: 'Test_Backups',
    backupScope: 'core',
    retentionCount: 5,
  });

  const backupService = new BackupService({ webDavClient: mockWebDavClient, configManager });
  const restoreService = new RestoreService({ webDavClient: mockWebDavClient, configManager });

  // 3. 执行端到端加密备份
  const backupPassword = 'my-e2e-strong-password';
  const backupResult = await backupService.runBackup({
    scope: 'core',
    encrypt: true,
    password: backupPassword,
    requestUser: { directories: { root: testUserDir } },
  });

  assert.equal(backupResult.success, true);
  assert.ok(remoteStorage.has(backupResult.remotePath), '远端 WebDAV 存储池中应包含备份包');

  // 4. 模拟本地配置文件被破坏或误删
  fs.writeFileSync(path.join(testUserDir, 'settings.json'), '{"corrupted": true}');
  fs.unlinkSync(path.join(testUserDir, 'secrets.json'));
  fs.unlinkSync(path.join(worldsDir, 'fantasy.json'));

  // 5. 执行恢复还原
  const restoreResult = await restoreService.restoreBackup({
    remoteFileName: backupResult.fileName,
    password: backupPassword,
    createRollback: true,
    requestUser: { directories: { root: testUserDir } },
  });

  assert.equal(restoreResult.success, true);
  assert.ok(restoreResult.restoredCount >= 3, '应成功还原 settings, secrets, worlds 等核心条目');

  // 6. 验证恢复后的文件内容与原始完全一致
  const restoredSettings = fs.readFileSync(path.join(testUserDir, 'settings.json'), 'utf-8');
  const restoredSecrets = fs.readFileSync(path.join(testUserDir, 'secrets.json'), 'utf-8');
  const restoredWorld = fs.readFileSync(path.join(worldsDir, 'fantasy.json'), 'utf-8');

  assert.equal(restoredSettings, settingsContent, 'settings.json 内容应完全还原');
  assert.equal(restoredSecrets, secretContent, 'secrets.json 内容应完全还原');
  assert.equal(restoredWorld, worldContent, '世界书设定应完全还原');

  // 验证回滚快照生成
  assert.ok(restoreResult.rollbackPath && fs.existsSync(restoreResult.rollbackPath), '应在恢复前自动创建本地回滚快照');

  // 7. 清理测试资源
  try {
    fs.rmSync(testUserDir, { recursive: true, force: true });
    fs.unlinkSync(tmpCfgPath);
  } catch {}
});
