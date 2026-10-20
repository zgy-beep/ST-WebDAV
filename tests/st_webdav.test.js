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
    getBuffer: async () => Buffer.from(maliciousZip),
  };

  const mockConfig = {
    get: (key) => key === 'remoteDirectory' ? 'Backups' : '',
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

