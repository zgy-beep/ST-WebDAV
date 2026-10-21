import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

import { RestoreService, checkZipQuotas } from '../src/server/RestoreService.js';
import { BackupService } from '../src/server/BackupService.js';
import { SharedService } from '../src/server/SharedService.js';
import { JobLock } from '../src/server/JobLock.js';
import { WebDavClient } from '../src/server/WebDavClient.js';
import { resolveUserDir } from '../src/server/UserHelper.js';

/**
 * 本文件覆盖「独立复核」阶段发现的缺陷的回归测试。
 * 每个用例都对应一个真实可利用的攻击链或功能缺陷。
 */

function createMockWebDav() {
  const storage = new Map();
  return {
    storage,
    updateConfig: () => {},
    ensureDirectory: async () => {},
    put: async (remotePath, body) => {
      storage.set(remotePath, Buffer.isBuffer(body) ? body : Buffer.from(body));
      return { success: true, status: 201 };
    },
    getBuffer: async (remotePath) => {
      if (storage.has(remotePath)) return storage.get(remotePath);
      throw new Error(`File not found: ${remotePath}`);
    },
    listFiles: async (remoteDir = '') => {
      const list = [];
      for (const [key, val] of storage.entries()) {
        // 精确匹配目录（避免前缀匹配把子目录内容也算进来）
        const rel = key.slice(remoteDir.length).replace(/^\//, '');
        if (key.startsWith(remoteDir) && rel && !rel.includes('/')) {
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
      storage.delete(remotePath);
      return { success: true };
    },
    copy: async (src, dest) => {
      if (!storage.has(src)) throw new Error(`COPY source not found: ${src}`);
      storage.set(dest, storage.get(src));
      return { success: true, via: 'copy' };
    },
  };
}

// ------------------------------------------------------------------
// 缺陷 1：跨源重定向泄漏 Basic Auth 凭据（本轮新引入）
// ------------------------------------------------------------------

test('安全: 跨源重定向不得携带 Authorization 头', async () => {
  const hits = [];
  const attacker = http.createServer((req, res) => {
    hits.push({ url: req.url, auth: req.headers.authorization || null });
    res.writeHead(200);
    res.end('ATTACKER');
  });
  const victim = http.createServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${attacker.address().port}/stolen` });
    res.end();
  });

  await new Promise(resolve => attacker.listen(0, resolve));
  await new Promise(resolve => victim.listen(0, resolve));

  try {
    const client = new WebDavClient({
      url: `http://127.0.0.1:${victim.address().port}`,
      username: 'alice',
      password: 'SUPER_SECRET_PWD',
    });

    await client.fetchWithTimeout(`http://127.0.0.1:${victim.address().port}/start`, { method: 'GET' });

    assert.ok(hits.length > 0, '攻击者服务器应当收到请求');
    for (const hit of hits) {
      assert.equal(hit.auth, null, `跨源跳转不得携带 Authorization 头（实际收到: ${hit.auth}）`);
    }
  } finally {
    attacker.close();
    victim.close();
  }
});

test('安全: 同源重定向仍应携带 Authorization 头（保证正常可用）', async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/final' });
      res.end();
      return;
    }
    hits.push(req.headers.authorization || null);
    res.writeHead(200);
    res.end('OK');
  });

  await new Promise(resolve => server.listen(0, resolve));
  try {
    const client = new WebDavClient({
      url: `http://127.0.0.1:${server.address().port}`,
      username: 'alice',
      password: 'pw',
    });
    const resp = await client.fetchWithTimeout(`http://127.0.0.1:${server.address().port}/start`, { method: 'GET' });
    assert.equal(await resp.text(), 'OK');
    assert.equal(hits.length, 1);
    assert.ok(hits[0]?.startsWith('Basic '), '同源跳转应保留凭据');
  } finally {
    server.close();
  }
});

// ------------------------------------------------------------------
// 缺陷 2：大小写变体覆写本地凭据配置（完整攻击链）
// ------------------------------------------------------------------

test('安全: 大小写变体的凭据配置文件必须被跳过（防凭据外泄攻击链）', async () => {
  const fflate = await import('fflate');

  // 攻击者构造的包：用大写文件名投毒
  const evilZip = fflate.zipSync({
    'settings.json': fflate.strToU8('{"theme":"dark"}'),
    'ST_WEBDAV_CONFIG.JSON': fflate.strToU8(JSON.stringify({
      webdavUrl: 'https://attacker.example/dav',
      webdavUsername: 'x',
      webdavPassword: 'x',
    })),
  });

  const mock = createMockWebDav();
  mock.getBuffer = async () => Buffer.from(evilZip);

  const cfg = {
    get: (key) => {
      if (key === 'webdavUrl') return 'https://victim-nas.example/dav';
      if (key === 'remoteDirectory') return 'Backups';
      return '';
    },
    refresh: () => false,
  };

  const testUserDir = path.join(os.tmpdir(), `test_case_bypass_${Date.now()}`);
  fs.mkdirSync(testUserDir, { recursive: true });

  const service = new RestoreService({ webDavClient: mock, configManager: cfg });
  await service.restoreBackup({
    remoteFileName: 'ST_Backup_core_20261021_120000.zip',
    createRollback: false,
    requestUser: { directories: { root: testUserDir } },
  });

  // 磁盘上不得出现任何大小写变体的凭据配置
  const entries = fs.readdirSync(testUserDir);
  const poisoned = entries.filter(name => name.toLowerCase() === 'st_webdav_config.json');
  assert.equal(poisoned.length, 0, `凭据配置不得被还原（发现: ${poisoned.join(', ')}）`);

  try { fs.rmSync(testUserDir, { recursive: true, force: true }); } catch {}
});

test('安全: 嵌套目录中的大小写变体凭据配置同样被跳过', async () => {
  const fflate = await import('fflate');
  const evilZip = fflate.zipSync({
    'sub/ST_WebDAV_Config.Json': fflate.strToU8('{"webdavUrl":"https://attacker.example"}'),
    'ok.txt': fflate.strToU8('fine'),
  });

  const mock = createMockWebDav();
  mock.getBuffer = async () => Buffer.from(evilZip);

  const cfg = {
    get: (key) => (key === 'webdavUrl' ? 'https://dav.test.com' : 'Backups'),
    refresh: () => false,
  };

  const testUserDir = path.join(os.tmpdir(), `test_case_nested_${Date.now()}`);
  fs.mkdirSync(testUserDir, { recursive: true });

  const service = new RestoreService({ webDavClient: mock, configManager: cfg });
  await service.restoreBackup({
    remoteFileName: 'ST_Backup_core_20261021_120000.zip',
    createRollback: false,
    requestUser: { directories: { root: testUserDir } },
  });

  const subDir = path.join(testUserDir, 'sub');
  if (fs.existsSync(subDir)) {
    const nested = fs.readdirSync(subDir).filter(n => n.toLowerCase() === 'st_webdav_config.json');
    assert.equal(nested.length, 0, '嵌套目录中的凭据配置也不得被还原');
  }

  try { fs.rmSync(testUserDir, { recursive: true, force: true }); } catch {}
});

// ------------------------------------------------------------------
// 缺陷 3：JobLock 泄漏（前置抛错导致账号被永久锁死）
// ------------------------------------------------------------------

test('安全: 非法 URL 导致的前置抛错不得泄漏任务锁', async () => {
  const handle = 'lockleak_user';

  // 使用真实的 WebDavClient：其 updateConfig 会真正校验 URL 并在非法时抛错
  const realClient = new WebDavClient({ url: 'https://placeholder.example/dav' });

  // 配置里的 URL 非法 → updateConfig 抛错
  const cfg = {
    get: (key) => {
      if (key === 'webdavUrl') return 'INVALID-NOT-A-URL';
      if (key === 'remoteDirectory') return 'Backups';
      return '';
    },
    refresh: () => false,
  };

  const testUserDir = path.join(os.tmpdir(), `test_lockleak_${Date.now()}`);
  fs.mkdirSync(testUserDir, { recursive: true });

  const service = new RestoreService({ webDavClient: realClient, configManager: cfg });
  await assert.rejects(
    service.restoreBackup({
      remoteFileName: 'ST_Backup_core_20261021_120000.zip',
      createRollback: false,
      requestUser: { handle, directories: { root: testUserDir } },
    }),
    /无效的 WebDAV 地址|必须为有效的 URL/
  );

  // 关键断言：锁必须已释放
  assert.equal(JobLock.peek(handle), null, '前置抛错后任务锁必须已释放，否则该账号将被永久锁死');

  try { fs.rmSync(testUserDir, { recursive: true, force: true }); } catch {}
});

test('安全: 备份流程前置抛错同样不得泄漏任务锁', async () => {
  const handle = 'lockleak_backup_user';

  // 使用真实的 WebDavClient：其 updateConfig 会真正校验 URL 并在非法时抛错
  const realClient = new WebDavClient({ url: 'https://placeholder.example/dav' });

  const cfg = {
    get: (key) => {
      if (key === 'webdavUrl') return 'INVALID-NOT-A-URL';
      if (key === 'remoteDirectory') return 'Backups';
      return '';
    },
    update: () => {},
  };

  const testUserDir = path.join(os.tmpdir(), `test_lockleak_bk_${Date.now()}`);
  fs.mkdirSync(testUserDir, { recursive: true });

  const service = new BackupService({ webDavClient: realClient, configManager: cfg });
  await assert.rejects(
    service.runBackup({
      scope: 'core',
      requestUser: { handle, directories: { root: testUserDir } },
    }),
    /无效的 WebDAV 地址|必须为有效的 URL/
  );

  assert.equal(JobLock.peek(handle), null, '备份前置抛错后任务锁必须已释放');

  try { fs.rmSync(testUserDir, { recursive: true, force: true }); } catch {}
});

// ------------------------------------------------------------------
// 缺陷 4：共享区任意用户可删除他人文件
// ------------------------------------------------------------------

test('安全: 共享区无索引记录的文件不得被他人删除', async () => {
  const mock = createMockWebDav();
  const sharedService = new SharedService({});
  const sharedDir = 'SillyTavern_Backups/_shared';
  const fileName = 'ST_Backup_alice_core_20261021_120000.zip';

  // 模拟「文件被外部直接 PUT 进共享区、没有索引记录」的情形
  mock.storage.set(`${sharedDir}/${fileName}`, Buffer.from('content'));

  await assert.rejects(
    sharedService.unshare({
      fileName,
      sharedDir,
      client: mock,
      requestUser: { handle: 'bob', displayName: 'Bob' },
    }),
    (err) => err.status === 403 && /不在共享区索引中/.test(err.message)
  );

  assert.ok(mock.storage.has(`${sharedDir}/${fileName}`), '无索引记录的文件不得被删除');
});

test('安全: 共享区 409 冲突检查必须基于远端最新索引（绕过陈旧缓存）', async () => {
  const mock = createMockWebDav();
  const sharedService = new SharedService({});
  const userDir = 'SillyTavern_Backups';
  const sharedDir = 'SillyTavern_Backups/_shared';
  const fileName = 'ST_Backup_core_20261021_120000.zip';

  mock.storage.set(`${userDir}/${fileName}`, Buffer.from('content'));

  // 先让缓存被填充为「空」
  await sharedService.getSharedMeta(sharedDir, mock);

  // 模拟另一个进程写入了一条 Alice 的分享记录（本地缓存仍是空的）
  mock.storage.set(`${sharedDir}/st_shared_meta.json`, Buffer.from(JSON.stringify({
    [fileName]: { sharedBy: { handle: 'alice', displayName: 'Alice' }, sharedAt: new Date().toISOString() },
  })));

  // Bob 分享同名文件 → 必须基于远端最新索引返回 409
  await assert.rejects(
    sharedService.share({
      fileName,
      sourceRemoteDir: userDir,
      sharedDir,
      client: mock,
      cfg: { get: () => '' },
      requestUser: { handle: 'bob', displayName: 'Bob' },
    }),
    (err) => err.status === 409
  );
});

// ------------------------------------------------------------------
// 缺陷 5/6：配额 O(n²) 与 STORED 条目谎报绕过
// ------------------------------------------------------------------

test('安全: 配额检查必须使用增量计数（复杂度不退化为 O(n²)）', () => {
  // 增量模式下每次只传入当前条目，累计值由调用方携带
  let total = 0;
  let count = 0;
  const start = Date.now();
  for (let i = 0; i < 50000; i++) {
    const r = checkZipQuotas([{ name: `f${i}.txt`, originalSize: 10 }], {
      accumulatedBytes: total,
      accumulatedCount: count,
    });
    total = r.totalBytes;
    count = r.fileCount;
  }
  const elapsed = Date.now() - start;
  assert.equal(total, 500000);
  assert.equal(count, 50000);
  // 5 万条增量处理应在数百毫秒内完成（O(n²) 版本需 6 秒以上）
  assert.ok(elapsed < 2000, `增量配额检查耗时过长 (${elapsed}ms)，疑似退化为 O(n²)`);
});

test('安全: STORED 条目谎报 originalSize 不得绕过配额', () => {
  // compression=0 表示 STORED（不压缩），fflate 按压缩尺寸原样返回数据，
  // 不受 originalSize 约束 —— 必须用 size 计费
  const lied = [{ name: 'bomb.bin', size: 50 * 1024 * 1024, originalSize: 1, compression: 0 }];
  assert.throws(
    () => checkZipQuotas(lied, { maxSingleBytes: 10 * 1024 * 1024 }),
    /单个解压文件体积过大/,
    'STORED 条目谎报 originalSize 时必须被拦截'
  );

  // 若错误地只信 originalSize（=1 字节），则不会触发任何拦截 —— 这正是要防的绕过
  const notThrown = (() => {
    try { checkZipQuotas(lied, { maxSingleBytes: 10 * 1024 * 1024 }); return false; } catch { return true; }
  })();
  assert.equal(notThrown, true);

  // DEFLATE 条目仍用 originalSize（fflate 以其预分配输出缓冲）
  const deflate = [{ name: 'normal.bin', size: 100, originalSize: 2048, compression: 8 }];
  const r = checkZipQuotas(deflate);
  assert.equal(r.totalBytes, 2048);
});

// ------------------------------------------------------------------
// 缺陷 7：custom / core 模式泄漏嵌套凭据配置
// ------------------------------------------------------------------

test('安全: 自定义模式不得打包嵌套的凭据配置文件', async () => {
  const fflate = await import('fflate');

  const testUserDir = path.join(os.tmpdir(), `test_custom_cred_${Date.now()}`);
  fs.mkdirSync(testUserDir, { recursive: true });
  fs.writeFileSync(path.join(testUserDir, 'settings.json'), '{"theme":"dark"}');

  // 扩展目录下的凭据配置（extensions 分类默认被包含）
  const extDir = path.join(testUserDir, 'extensions');
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'st_webdav_config.json'), '{"webdavPassword":"LEAK_ME"}');

  const mock = createMockWebDav();
  const cfg = {
    get: (key) => {
      if (key === 'webdavUrl') return 'https://dav.test.com';
      if (key === 'remoteDirectory') return 'Backups';
      return '';
    },
    update: () => {},
  };

  const service = new BackupService({ webDavClient: mock, configManager: cfg });
  const result = await service.runBackup({
    scope: 'custom',
    categories: ['settings', 'extensions'],
    requestUser: { directories: { root: testUserDir } },
  });

  const uploaded = mock.storage.get(result.remotePath);
  const unzipped = fflate.unzipSync(new Uint8Array(uploaded));

  assert.equal('extensions/st_webdav_config.json' in unzipped, false, '自定义模式不得包含嵌套凭据配置');
  assert.equal(uploaded.toString('latin1').includes('LEAK_ME'), false, '明文口令不得出现在归档中');

  try { fs.rmSync(testUserDir, { recursive: true, force: true }); } catch {}
});

// ------------------------------------------------------------------
// 缺陷 9：filterGit 子串匹配误伤
// ------------------------------------------------------------------

test('安全: 归档过滤不得误伤 node_modules-notes 与 .github 目录', async () => {
  const fflate = await import('fflate');

  const testUserDir = path.join(os.tmpdir(), `test_filtergit_${Date.now()}`);
  fs.mkdirSync(testUserDir, { recursive: true });

  // 合法但含敏感子串的目录
  const notesDir = path.join(testUserDir, 'my-node_modules-notes');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, 'important.md'), 'keep me');

  const ghDir = path.join(testUserDir, '.github', 'workflows');
  fs.mkdirSync(ghDir, { recursive: true });
  fs.writeFileSync(path.join(ghDir, 'ci.yml'), 'keep me too');

  const mock = createMockWebDav();
  const cfg = {
    get: (key) => {
      if (key === 'webdavUrl') return 'https://dav.test.com';
      if (key === 'remoteDirectory') return 'Backups';
      return '';
    },
    update: () => {},
  };

  const service = new BackupService({ webDavClient: mock, configManager: cfg });
  const result = await service.runBackup({
    scope: 'full',
    requestUser: { directories: { root: testUserDir } },
  });

  const uploaded = mock.storage.get(result.remotePath);
  const unzipped = fflate.unzipSync(new Uint8Array(uploaded));
  const names = Object.keys(unzipped);

  assert.ok(names.some(n => n.includes('my-node_modules-notes')), 'my-node_modules-notes 不应被误排除');
  assert.ok(names.some(n => n.includes('.github')), '.github 不应被误排除');

  try { fs.rmSync(testUserDir, { recursive: true, force: true }); } catch {}
});

// ------------------------------------------------------------------
// 缺陷 8：resolveUserDir fail-open 跨用户数据泄露
// ------------------------------------------------------------------

test('安全: 用户目录不存在时不得回退到其他用户的数据目录', () => {
  const dataRoot = path.join(os.tmpdir(), `test_usrdir_${Date.now()}`);
  const defaultUserDir = path.join(dataRoot, 'default-user');
  fs.mkdirSync(defaultUserDir, { recursive: true });
  fs.writeFileSync(path.join(defaultUserDir, 'secrets.json'), '{"secret":"default-user-data"}');

  const previousRoot = globalThis.DATA_ROOT;
  globalThis.DATA_ROOT = dataRoot;

  try {
    // bob 的目录尚未创建
    const bobDir = resolveUserDir({ handle: 'bob', directories: { root: path.join(dataRoot, '_users', 'bob') } });

    // 关键断言：绝不能指向 default-user
    assert.notEqual(
      bobDir.toLowerCase(),
      defaultUserDir.toLowerCase(),
      '用户目录不存在时不得回退到 default-user（会造成跨用户数据泄露）'
    );
    assert.ok(bobDir.toLowerCase().includes('bob'), '应返回该用户自己的目录路径');
  } finally {
    globalThis.DATA_ROOT = previousRoot;
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch {}
  }
});

// ------------------------------------------------------------------
// 缺陷 13：Windows 尾部点/空格绕过
// ------------------------------------------------------------------

test('安全: Windows 尾部点与空格的路径穿越变体必须被拦截', async () => {
  const fflate = await import('fflate');

  const cases = [
    { name: '.. /escaped.txt', expect: /Zip-Slip|路径穿越|非法路径段/ },
    { name: 'CON /x.txt', expect: /保留设备名|非法路径段/ },
  ];

  for (const c of cases) {
    const evilZip = fflate.zipSync({ [c.name]: fflate.strToU8('pwned') });
    const mock = createMockWebDav();
    mock.getBuffer = async () => Buffer.from(evilZip);

    const cfg = {
      get: (key) => (key === 'webdavUrl' ? 'https://dav.test.com' : 'Backups'),
      refresh: () => false,
    };

    const testUserDir = path.join(os.tmpdir(), `test_winpath_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testUserDir, { recursive: true });

    const service = new RestoreService({ webDavClient: mock, configManager: cfg });
    await assert.rejects(
      service.restoreBackup({
        remoteFileName: 'ST_Backup_core_20261021_120000.zip',
        createRollback: false,
        requestUser: { directories: { root: testUserDir } },
      }),
      c.expect,
      `必须拦截路径穿越变体: ${c.name}`
    );

    try { fs.rmSync(testUserDir, { recursive: true, force: true }); } catch {}
  }
});

// ------------------------------------------------------------------
// 两阶段还原：被拒条目必须 0 字节落盘
// ------------------------------------------------------------------

test('安全: 归档内含恶意条目时不得有任何文件落盘（两阶段性质）', async () => {
  const fflate = await import('fflate');

  const evilZip = fflate.zipSync({
    'good.txt': fflate.strToU8('this is a normal file'),
    '../../evil.txt': fflate.strToU8('pwned'),
  });

  const mock = createMockWebDav();
  mock.getBuffer = async () => Buffer.from(evilZip);

  const cfg = {
    get: (key) => (key === 'webdavUrl' ? 'https://dav.test.com' : 'Backups'),
    refresh: () => false,
  };

  const testUserDir = path.join(os.tmpdir(), `test_twophase_${Date.now()}`);
  fs.mkdirSync(testUserDir, { recursive: true });

  const service = new RestoreService({ webDavClient: mock, configManager: cfg });
  await assert.rejects(
    service.restoreBackup({
      remoteFileName: 'ST_Backup_core_20261021_120000.zip',
      createRollback: false,
      requestUser: { directories: { root: testUserDir } },
    }),
    /Zip-Slip/
  );

  // 关键断言：磁盘上不得有任何被还原的文件
  const entries = fs.readdirSync(testUserDir);
  assert.equal(entries.length, 0, `安全拦截后不得留下任何半还原文件（发现: ${entries.join(', ')}）`);

  try { fs.rmSync(testUserDir, { recursive: true, force: true }); } catch {}
});
