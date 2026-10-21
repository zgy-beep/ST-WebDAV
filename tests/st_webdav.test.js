import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { CryptoHelper } from '../src/server/CryptoHelper.js';
import { WebDavClient } from '../src/server/WebDavClient.js';
import { ConfigManager } from '../src/server/ConfigManager.js';

test('CryptoHelper: AES-256-GCM 端到端流式加解密测试', async () => {
  const secretData = 'SillyTavern Secret Settings with Anthropic & OpenAI API Keys: sk-ant-api-03-xxxxxx';
  const password = 'my-super-safe-password-1234';

  // 1. 加密
  const encryptStream = CryptoHelper.createEncryptStream(password);
  const inputStream = new PassThrough();
  const encryptedChunks = [];

  const encryptPipeline = pipeline(
    inputStream,
    encryptStream,
    new PassThrough().on('data', chunk => encryptedChunks.push(chunk))
  );

  inputStream.end(Buffer.from(secretData, 'utf-8'));
  await encryptPipeline;

  const encryptedBuffer = Buffer.concat(encryptedChunks);
  assert.ok(CryptoHelper.isEncrypted(encryptedBuffer), '密文应包含有效 Magic Header');
  assert.notEqual(encryptedBuffer.toString('utf-8'), secretData, '密文不应包含明文');

  // 2. 正确密码解密
  const decryptStream = CryptoHelper.createDecryptStream(password);
  const decInputStream = new PassThrough();
  const decryptedChunks = [];

  const decryptPipeline = pipeline(
    decInputStream,
    decryptStream,
    new PassThrough().on('data', chunk => decryptedChunks.push(chunk))
  );

  decInputStream.end(encryptedBuffer);
  await decryptPipeline;

  const decryptedData = Buffer.concat(decryptedChunks).toString('utf-8');
  assert.equal(decryptedData, secretData, '解密后的内容应与原文完全一致');

  // 3. 错误密码解密防御
  const wrongDecryptStream = CryptoHelper.createDecryptStream('wrong-password');
  const wrongInput = new PassThrough();

  const rejectPromise = assert.rejects(
    pipeline(
      wrongInput,
      wrongDecryptStream,
      new PassThrough()
    ),
    /解密认证失败/,
    '错误密码必须触发 GCM Auth Tag 认证失败并拒绝解密'
  );
  wrongInput.end(encryptedBuffer);
  await rejectPromise;
});

test('WebDavClient: URL 校验与 SSRF 防护测试', () => {
  const client = new WebDavClient();

  // 正常 URL
  assert.equal(client.validateAndNormalizeUrl('https://dav.jianguoyun.com/dav/st/'), 'https://dav.jianguoyun.com/dav/st');
  assert.equal(client.validateAndNormalizeUrl('http://192.168.1.100:5244/dav'), 'http://192.168.1.100:5244/dav');

  // 非法协议拦截
  assert.throws(() => client.validateAndNormalizeUrl('file:///etc/passwd'), /不安全的 WebDAV 协议/);
  assert.throws(() => client.validateAndNormalizeUrl('gopher://127.0.0.1:80'), /不安全的 WebDAV 协议/);

  // SSRF 云厂商元数据拦截
  assert.throws(() => client.validateAndNormalizeUrl('http://169.254.169.254/latest/meta-data'), /SSRF 安全拦截/);
  assert.throws(() => client.validateAndNormalizeUrl('http://metadata.google.internal/computeMetadata/v1'), /SSRF 安全拦截/);
});

test('WebDavClient: Multi-Status XML 解析测试', () => {
  const client = new WebDavClient({ url: 'https://dav.example.com/remote' });
  const sampleXml = `<?xml version="1.0" encoding="utf-8"?>
  <d:multistatus xmlns:d="DAV:">
    <d:response>
      <d:href>/remote/</d:href>
      <d:propstat>
        <d:prop>
          <d:resourcetype><d:collection/></d:resourcetype>
        </d:prop>
      </d:propstat>
    </d:response>
    <d:response>
      <d:href>/remote/ST_Backup_core_20261020_140000.zip</d:href>
      <d:propstat>
        <d:prop>
          <d:resourcetype/>
          <d:getcontentlength>1048576</d:getcontentlength>
          <d:getlastmodified>Tue, 20 Oct 2026 14:00:00 GMT</d:getlastmodified>
        </d:prop>
      </d:propstat>
    </d:response>
  </d:multistatus>`;

  const items = client.parsePropfindXml(sampleXml, 'https://dav.example.com/remote');
  assert.equal(items.length, 1, '应过滤掉目录自身，仅保留条目');
  assert.equal(items[0].name, 'ST_Backup_core_20261020_140000.zip');
  assert.equal(items[0].size, 1048576);
  assert.equal(items[0].isDirectory, false);
});

test('WebDavClient: 超时机制健全性与默认值防退化测试', () => {
  // 1. 默认构建时 timeoutMs 应为 15000
  const clientDefault = new WebDavClient();
  assert.equal(clientDefault.timeoutMs, 15000, '默认超时时间应为 15000ms');

  // 2. 传入空对象、undefined、无效字符时不应变为 undefined 或 NaN
  clientDefault.updateConfig({ timeoutMs: undefined });
  assert.equal(clientDefault.timeoutMs, 15000);

  clientDefault.updateConfig({ timeoutMs: 'not-a-number' });
  assert.equal(clientDefault.timeoutMs, 15000);

  clientDefault.updateConfig({ timeoutMs: 1000 });
  assert.equal(clientDefault.timeoutMs, 3000, '最低超时不得低于 3000ms');

  clientDefault.updateConfig({ timeoutMs: 25000 });
  assert.equal(clientDefault.timeoutMs, 25000);
});

test('ConfigManager: 密码脱敏与防冲刷持久化测试', () => {
  const tmpFile = path.join(os.tmpdir(), `test_cfg_${Date.now()}.json`);
  const mgr = new ConfigManager(tmpFile);

  // 1. 设置真实密码
  mgr.update({
    webdavUrl: 'https://dav.test.com',
    webdavUsername: 'alice',
    webdavPassword: 'secret-password-xyz',
    encryptionPassword: 'enc-password-123',
  });

  // 2. 读取前端脱敏视图
  const masked = mgr.getMasked();
  assert.equal(masked.webdavPassword, '********', '密码对外应脱敏为 ********');
  assert.equal(masked.encryptionPassword, '********', '加密密码对外应脱敏为 ********');

  // 3. 前端提交更新其它字段但回传脱敏掩码
  mgr.update({
    webdavUsername: 'alice-updated',
    webdavPassword: '********', // 脱敏掩码
  });

  assert.equal(mgr.get('webdavUsername'), 'alice-updated');
  assert.equal(mgr.get('webdavPassword'), 'secret-password-xyz', '原真实密码不应被掩码冲刷覆盖');

  // 清理临时文件
  try { fs.unlinkSync(tmpFile); } catch {}
});

test('RestoreService: Zip-Slip 恶意路径穿越拦截防御测试', async () => {
  const { RestoreService } = await import('../src/server/RestoreService.js');
  const fflate = await import('fflate');

  // 构建包含恶意路径穿越的 zip 数据
  const maliciousZip = fflate.zipSync({
    'settings.json': fflate.strToU8('{"theme":"dark"}'),
    '../../evil.sh': fflate.strToU8('echo pwned'),
  });

  const mockWebDav = {
    updateConfig: () => {},
    getBuffer: async () => Buffer.from(maliciousZip),
  };

  const mockConfig = {
    get: (key) => {
      if (key === 'webdavUrl') return 'https://dav.example.com/webdav';
      if (key === 'remoteDirectory') return 'Backups';
      return '';
    },
  };

  const testUserDir = path.join(os.tmpdir(), `test_user_${Date.now()}`);
  fs.mkdirSync(testUserDir, { recursive: true });

  const restoreService = new RestoreService({
    webDavClient: mockWebDav,
    configManager: mockConfig,
  });

  await assert.rejects(
    restoreService.restoreBackup({
      remoteFileName: 'ST_Backup_core_malicious.zip',
      createRollback: false,
      requestUser: { directories: { root: testUserDir } },
    }),
    /Zip-Slip/,
    '必须成功拦截并拒绝解压恶意跳出目录的文件'
  );

  // 清理
  try { fs.rmSync(testUserDir, { recursive: true, force: true }); } catch {}
});

test('BackupService: 自定义选项选择备份与文件名备注提取测试', async () => {
  const { BackupService } = await import('../src/server/BackupService.js');
  const fflate = await import('fflate');

  const testUserDir = path.join(os.tmpdir(), `test_user_custom_${Date.now()}`);
  fs.mkdirSync(testUserDir, { recursive: true });

  // 准备各类文件
  fs.writeFileSync(path.join(testUserDir, 'settings.json'), '{"theme":"glass"}');
  
  const charDir = path.join(testUserDir, 'characters');
  fs.mkdirSync(charDir, { recursive: true });
  fs.writeFileSync(path.join(charDir, 'Alice.json'), '{"name":"Alice"}');

  const chatDir = path.join(testUserDir, 'chats');
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(chatDir, 'chat_01.jsonl'), '{"msg":"hello"}');

  const storage = new Map();
  const mockWebDav = {
    updateConfig: () => {},
    ensureDirectory: async () => {},
    listFiles: async () => [],
    delete: async () => {},
    put: async (remPath, body) => {
      storage.set(remPath, body);
      return { success: true };
    },
    getBuffer: async (remPath) => {
      return storage.get(remPath) || Buffer.from('{}');
    },
  };

  const mockConfig = {
    get: (key) => {
      if (key === 'webdavUrl') return 'https://dav.test.com';
      if (key === 'remoteDirectory') return 'Backups';
      return '';
    },
    update: () => {},
  };

  const backupService = new BackupService({ webDavClient: mockWebDav, configManager: mockConfig });

  // 仅自定义备份角色与设置 (不备份聊天)
  const result = await backupService.runBackup({
    scope: 'custom',
    categories: ['settings', 'characters'],
    note: '仅备份角色和设置_阶段节点',
    requestUser: { directories: { root: testUserDir } },
  });

  assert.equal(result.success, true);
  assert.equal(result.scope, 'custom');
  assert.ok(result.fileName.includes('_custom_'), '文件名需标识 custom 范围');
  assert.ok(result.fileName.includes('仅备份角色和设置_阶段节点'), '文件名中应包含格式化后的备注 slug');

  // 验证压缩包内文件
  const uploadedZip = storage.get(result.remotePath);
  assert.ok(uploadedZip, '远端应存在归档文件');

  const unzipped = fflate.unzipSync(new Uint8Array(uploadedZip));
  assert.ok('backup_manifest.json' in unzipped, '归档中必须包含清单');
  assert.ok('settings.json' in unzipped, '选中的 settings 必须存在');
  assert.ok('characters/Alice.json' in unzipped, '选中的 characters 必须存在');
  assert.equal('chats/chat_01.jsonl' in unzipped, false, '未选中的 chats 不应存在');

  // 验证清单数据中的备注与自定义分类
  const manifest = JSON.parse(new TextDecoder().decode(unzipped['backup_manifest.json']));
  assert.equal(manifest.scope, 'custom');
  assert.equal(manifest.note, '仅备份角色和设置_阶段节点');
  assert.deepEqual(manifest.categories, ['settings', 'characters']);

  // 验证远端元数据字典 st_backups_meta.json 是否同步更新
  const metaBuf = storage.get('Backups/st_backups_meta.json');
  assert.ok(metaBuf, '远端应生成 st_backups_meta.json 索引');
  const metaObj = JSON.parse(metaBuf.toString('utf-8'));
  assert.ok(metaObj[result.fileName], '索引中应记录本次备份的文件条目');
  assert.equal(metaObj[result.fileName].note, '仅备份角色和设置_阶段节点');
  assert.deepEqual(metaObj[result.fileName].categories, ['settings', 'characters']);

  // 清理
  try { fs.rmSync(testUserDir, { recursive: true, force: true }); } catch {}
});

test('Multi-User: 多用户子目录空间隔离、配置隔离与跨用户安全提示测试', async () => {
  const { BackupService } = await import('../src/server/BackupService.js');
  const { RestoreService } = await import('../src/server/RestoreService.js');
  const { ConfigManager } = await import('../src/server/ConfigManager.js');

  const baseDir = path.join(os.tmpdir(), `test_multi_st_${Date.now()}`);
  const aliceDir = path.join(baseDir, '_users', 'alice');
  const bobDir = path.join(baseDir, '_users', 'bob');

  fs.mkdirSync(aliceDir, { recursive: true });
  fs.mkdirSync(bobDir, { recursive: true });

  fs.writeFileSync(path.join(aliceDir, 'settings.json'), '{"owner":"alice"}');
  fs.writeFileSync(path.join(bobDir, 'settings.json'), '{"owner":"bob"}');

  const reqAlice = { handle: 'alice', directories: { root: aliceDir } };
  const reqBob = { handle: 'bob', directories: { root: bobDir } };

  // 1. 测试配置隔离
  const aliceConfig = ConfigManager.forUser(reqAlice);
  aliceConfig.update({
    webdavUrl: 'https://dav.test.com/alice',
    webdavUsername: 'alice_dav',
    webdavPassword: 'alice_secret_pwd',
  });

  const bobConfig = ConfigManager.forUser(reqBob);
  bobConfig.update({
    webdavUrl: 'https://dav.test.com/bob',
    webdavUsername: 'bob_dav',
    webdavPassword: 'bob_secret_pwd',
  });

  assert.equal(aliceConfig.get('webdavUsername'), 'alice_dav');
  assert.equal(bobConfig.get('webdavUsername'), 'bob_dav');
  assert.notEqual(aliceConfig.get('webdavPassword'), bobConfig.get('webdavPassword'), '多用户密码必须完全独立隔离');

  // 2. 测试远端子目录与归档命名空间隔离
  const storage = new Map();
  const mockWebDav = {
    updateConfig: () => {},
    ensureDirectory: async () => {},
    listFiles: async () => [],
    delete: async () => {},
    put: async (remPath, body) => {
      storage.set(remPath, body);
      return { success: true };
    },
    getBuffer: async (remPath) => {
      return storage.get(remPath) || Buffer.from('{}');
    },
  };

  const backupService = new BackupService({ webDavClient: mockWebDav, configManager: aliceConfig });
  const aliceBackup = await backupService.runBackup({
    scope: 'core',
    requestUser: reqAlice,
    note: 'Alice私有核心备份',
  });

  // Alice 备份必须放置在专属命名空间子目录 Backups/alice
  assert.ok(aliceBackup.remotePath.startsWith('SillyTavern_Backups/alice/'), `Alice 远端目录必须隔离至子目录: ${aliceBackup.remotePath}`);
  assert.ok(aliceBackup.fileName.includes('_alice_'), '文件名中必须带有用户标识');

  // 3. 测试跨用户导入提醒
  const restoreService = new RestoreService({ webDavClient: mockWebDav, configManager: bobConfig });
  // 将 Alice 的备份复制到 Bob 可读取的远端路径模拟跨用户还原
  storage.set(`SillyTavern_Backups/bob/${aliceBackup.fileName}`, storage.get(aliceBackup.remotePath));

  const restoreResult = await restoreService.restoreBackup({
    remoteFileName: aliceBackup.fileName,
    createRollback: false,
    requestUser: reqBob,
  });

  assert.equal(restoreResult.success, true);
  assert.ok(restoreResult.crossUserNotice.includes('alice'), '检测到跨用户还原时应包含源用户提醒');

  // 清理
  try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch {}
});

test('WebDavClient: 增强型 SSRF 防护测试 (IPv6 IMDS 与各类云厂商元数据)', () => {
  const client = new WebDavClient();

  // AWS IPv6 IMDS
  assert.throws(() => client.validateAndNormalizeUrl('http://[fd00:ec2::254]/latest/meta-data'), /SSRF 安全拦截/);
  // 阿里云元数据
  assert.throws(() => client.validateAndNormalizeUrl('http://100.100.100.200/latest/meta-data'), /SSRF 安全拦截/);
  // 169.254 网段
  assert.throws(() => client.validateAndNormalizeUrl('http://169.254.1.1/info'), /SSRF 安全拦截/);
  // 十进制表示
  assert.throws(() => client.validateAndNormalizeUrl('http://2852039166/'), /SSRF 安全拦截/);
});

test('WebDavClient: 非法或畸形 Date XML 解析容错性测试', () => {
  const client = new WebDavClient({ url: 'https://dav.example.com/remote' });
  const sampleXml = `<?xml version="1.0" encoding="utf-8"?>
  <d:multistatus xmlns:d="DAV:">
    <d:response>
      <d:href>/remote/ST_Backup_invalid_date.zip</d:href>
      <d:propstat>
        <d:prop>
          <d:resourcetype/>
          <d:getcontentlength>1024</d:getcontentlength>
          <d:getlastmodified>This is not a valid date string</d:getlastmodified>
        </d:prop>
      </d:propstat>
    </d:response>
  </d:multistatus>`;

  // 必须安全解析，不能抛出 RangeError: Invalid time value
  const items = client.parsePropfindXml(sampleXml, 'https://dav.example.com/remote');
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'ST_Backup_invalid_date.zip');
  assert.ok(items[0].lastModified, '应包含安全兜底日期');
});

test('ConfigManager: 白名单过滤与原型链污染拦截测试', () => {
  const tmpFile = path.join(os.tmpdir(), `test_cfg_proto_${Date.now()}.json`);
  const mgr = new ConfigManager(tmpFile);

  mgr.update({
    webdavUrl: 'https://dav.test.com',
    timeoutMs: -500, // 非法负数
    retentionCount: 999999, // 超过上限
    pollutedProp: 'malicious-data', // 非白名单字段
    __proto__: { isAdmin: true },
  });

  assert.equal(mgr.get('pollutedProp'), undefined, '非白名单字段必须被丢弃');
  assert.equal(mgr.get('timeoutMs'), 15000, '非法负数超时应安全回退');
  assert.equal(mgr.get('retentionCount'), 100, '保留份数应限制在上界');
  assert.equal(({}).isAdmin, undefined, '全局原型不得被污染');

  try { fs.unlinkSync(tmpFile); } catch {}
});

test('RestoreService: Windows 保留设备名 (CON, PRN, AUX) 拦截测试', async () => {
  const { RestoreService } = await import('../src/server/RestoreService.js');
  const fflate = await import('fflate');

  const maliciousZip = fflate.zipSync({
    'con.json': fflate.strToU8('{"corrupted":true}'),
  });

  const mockWebDav = {
    updateConfig: () => {},
    getBuffer: async () => Buffer.from(maliciousZip),
  };

  const mockConfig = {
    get: (key) => key === 'webdavUrl' ? 'https://dav.example.com' : 'Backups',
  };

  const testUserDir = path.join(os.tmpdir(), `test_user_win_${Date.now()}`);
  fs.mkdirSync(testUserDir, { recursive: true });

  const restoreService = new RestoreService({
    webDavClient: mockWebDav,
    configManager: mockConfig,
  });

  await assert.rejects(
    restoreService.restoreBackup({
      remoteFileName: 'ST_Backup_core_win.zip',
      createRollback: false,
      requestUser: { directories: { root: testUserDir } },
    }),
    /Windows 系统保留设备名/,
    '必须拦截 Windows 系统保留设备名'
  );

  try { fs.rmSync(testUserDir, { recursive: true, force: true }); } catch {}
});


