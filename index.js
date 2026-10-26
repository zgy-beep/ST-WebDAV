import express from 'express';
import path from 'node:path';
import { ConfigManager } from './src/server/ConfigManager.js';
import { WebDavClient } from './src/server/WebDavClient.js';
import { BackupService } from './src/server/BackupService.js';
import { RestoreService } from './src/server/RestoreService.js';
import { SchedulerService } from './src/server/SchedulerService.js';
import { SharedService } from './src/server/SharedService.js';
import { BACKUP_CATEGORIES } from './src/server/BackupCategories.js';
import { getUserInfo, resolveRemoteDirectory, resolveSharedDirectory, isAdminUser } from './src/server/UserHelper.js';
import { sanitizeBackupFileName, isBackupOwnedBy } from './src/server/PathGuard.js';
import { JobLock } from './src/server/JobLock.js';
import { getPluginVersion } from './src/server/Version.js';
import { isJobBusyError, HTTP_CONFLICT } from './src/server/JobBusyError.js';

export const info = {
  id: 'st-webdav',
  name: 'ST-WebDAV',
  description: 'SillyTavern WebDAV 全量备份与恢复插件',
  version: getPluginVersion(),
};

let configManager = null;
let webDavClient = null;
let backupService = null;
let restoreService = null;
let schedulerService = null;
let sharedService = null;

/**
 * 为指定配置构建独立的 WebDavClient 实例 (避免多租户并发凭据污染)
 * @param {ConfigManager} cfg
 * @returns {WebDavClient}
 */
function getClientForUser(cfg) {
  return new WebDavClient({
    url: cfg.get('webdavUrl'),
    username: cfg.get('webdavUsername'),
    password: cfg.get('webdavPassword'),
    timeoutMs: cfg.get('timeoutMs') || 15000,
  });
}

/**
 * 任务互斥冲突返回 409（客户端可稍后重试），其余错误仍为 500
 * @param {import('express').Response} res
 * @param {Error} err
 */
function sendJobError(res, err) {
  res.status(isJobBusyError(err) ? HTTP_CONFLICT : 500).json({ error: err.message });
}

/**
 * SillyTavern 服务端插件加载入口
 * @param {import('express').Router} router
 */
export async function init(router) {
  console.log(`[${info.name}] Initializing server plugin v${info.version}...`);

  // 1. 初始化基础配置管理器与全局底座服务
  configManager = new ConfigManager();
  webDavClient = getClientForUser(configManager);

  // 2. 初始化核心业务服务
  backupService = new BackupService({ webDavClient, configManager });
  restoreService = new RestoreService({ webDavClient, configManager });
  schedulerService = new SchedulerService({ backupService, configManager });
  sharedService = new SharedService({ configManager });

  // 3. 启动定时任务
  schedulerService.start();

  // 4. 注册 Express API 路由 (/api/plugins/st-webdav/*)
  registerRoutes(router);

  console.log(`[${info.name}] Plugin initialized successfully.`);
}

/**
 * 服务端卸载/退出清理钩子
 * ------------------------------------------------------------------
 * 等待在途的备份/还原任务结束，避免上传被截断后在远端留下半成品 zip
 * （半成品会占用 retention 名额，且无法被正常还原）。
 */
export async function exit() {
  if (schedulerService) {
    schedulerService.stop();
  }

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const backupBusy = backupService?.activeBackups?.size > 0;
    const restoreBusy = restoreService?.activeRestores?.size > 0;
    if (!backupBusy && !restoreBusy && !JobLock.hasActiveJobs) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  console.log(`[${info.name}] Plugin unloaded.`);
}

/**
 * 测试连接接口的节流器
 * ------------------------------------------------------------------
 * /test 允许携带任意 URL 发起 PROPFIND，理论上可被当作内网端口扫描器。
 * 这里按用户维度做简单限流（默认 10 次 / 60 秒），在保留正常排查
 * 体验的同时大幅压低扫描收益。
 */
const TEST_RATE_LIMIT = { max: 10, windowMs: 60 * 1000 };
const testRateBuckets = new Map();

/**
 * 校验当前用户是否超出测试连接频率限制
 * @param {object} requestUser
 * @returns {boolean} true 表示允许继续
 */
function allowTestRequest(requestUser) {
  const key = requestUser?.handle || requestUser?.profile?.handle || 'default-user';
  const now = Date.now();
  const bucket = testRateBuckets.get(key) || [];

  // 清理窗口外的记录
  const recent = bucket.filter(ts => now - ts < TEST_RATE_LIMIT.windowMs);
  if (recent.length >= TEST_RATE_LIMIT.max) {
    testRateBuckets.set(key, recent);
    return false;
  }
  recent.push(now);
  testRateBuckets.set(key, recent);

  // 回收长期不活跃的桶，避免 Map 无限增长
  if (testRateBuckets.size > 100) {
    for (const [k, v] of testRateBuckets) {
      if (!v.length || now - v[v.length - 1] > TEST_RATE_LIMIT.windowMs * 10) {
        testRateBuckets.delete(k);
      }
    }
  }

  return true;
}

/**
 * 注册插件 HTTP 路由
 * @param {import('express').Router} router
 */
function registerRoutes(router) {
  router.use(express.json());

  // —— 1. 获取配置 (密码自动脱敏，附带当前用户信息与实际生效路径) ——
  router.get('/config', (req, res) => {
    try {
      const cfg = ConfigManager.forUser(req.user);
      const masked = cfg.getMasked();
      const userInfo = getUserInfo(req.user);
      const isolate = cfg.get('isolateUserDirectory') !== false;
      const effectiveRemoteDir = resolveRemoteDirectory(cfg.get('remoteDirectory') || 'SillyTavern_Backups', req.user, isolate);

      res.json({
        ...masked,
        currentUser: userInfo,
        effectiveRemoteDirectory: effectiveRemoteDir,
        sharedDirectory: resolveSharedDirectory(cfg.get('remoteDirectory') || 'SillyTavern_Backups'),
        isAdmin: isAdminUser(req.user),
        pluginVersion: getPluginVersion(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // —— 2. 更新配置 ——
  // 多用户模式下每个账号都应能配置自己的 WebDAV 凭据（这是多租户隔离的
  // 核心功能），因此不对写配置做管理员限制；URL 的 SSRF 黑名单校验
  // 已在 ConfigManager.update 内完成。
  router.post('/config', (req, res) => {
    try {
      const cfg = ConfigManager.forUser(req.user);
      const updated = cfg.update(req.body);
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // —— 3. 测试 WebDAV 连接状态 ——
  router.post('/test', async (req, res) => {
    if (!allowTestRequest(req.user)) {
      return res.status(429).json({
        ok: false,
        status: 429,
        message: `测试过于频繁，请 ${Math.ceil(TEST_RATE_LIMIT.windowMs / 1000)} 秒后再试`,
      });
    }
    try {
      const cfg = ConfigManager.forUser(req.user);
      // 允许请求携带即时测试参数或默认使用当前保存的配置
      const testUrl = req.body?.url !== undefined ? req.body.url : cfg.get('webdavUrl');
      const testUser = req.body?.username !== undefined ? req.body.username : cfg.get('webdavUsername');
      const testPass = req.body?.password !== undefined && req.body.password !== '********'
        ? req.body.password
        : cfg.get('webdavPassword');
      const testTimeout = req.body?.timeoutMs !== undefined ? req.body.timeoutMs : cfg.get('timeoutMs');

      const tempClient = new WebDavClient({
        url: testUrl,
        username: testUser,
        password: testPass,
        timeoutMs: testTimeout || 15000,
      });

      const result = await tempClient.testConnection();
      res.json(result);
    } catch (err) {
      res.json({ ok: false, status: 0, message: err.message });
    }
  });

  // —— 3.1 获取支持的自定义备份数据分类 ——
  router.get('/categories', (req, res) => {
    res.json(BACKUP_CATEGORIES);
  });

  // —— 4. 执行备份 (使用当前用户独立 Client 与 Config，防多租户串扰) ——
  router.post('/backup', async (req, res) => {
    try {
      const cfg = ConfigManager.forUser(req.user);
      const userClient = getClientForUser(cfg);

      const result = await backupService.runBackup({
        scope: req.body?.scope,
        categories: req.body?.categories,
        encrypt: req.body?.encrypt,
        password: req.body?.password,
        note: req.body?.note,
        requestUser: req.user,
        configManager: cfg,
        webDavClient: userClient,
      });
      res.json(result);
    } catch (err) {
      sendJobError(res, err);
    }
  });

  // —— 5. 查询备份进度/状态 (按用户精确隔离) ——
  router.get('/backup/status', (req, res) => {
    res.json(backupService.getStatus(req.user));
  });

  // —— 6. 获取远端备份历史列表 (含多用户子目录空间过滤与完整备注) ——
  router.get('/backups', async (req, res) => {
    try {
      const cfg = ConfigManager.forUser(req.user);
      const webdavUrl = cfg.get('webdavUrl');
      const isolate = cfg.get('isolateUserDirectory') !== false;
      const remoteDir = resolveRemoteDirectory(cfg.get('remoteDirectory') || 'SillyTavern_Backups', req.user, isolate);

      if (!webdavUrl) {
        return res.json({
          remoteDirectory: remoteDir,
          backups: [],
        });
      }

      const userClient = getClientForUser(cfg);
      const items = await userClient.listFiles(remoteDir);

      // 尝试获取远端元数据清单索引
      const metaMap = await backupService.getRemoteMeta(remoteDir, userClient).catch(() => ({}));

      // 筛选出属于本插件的备份文件
      const backups = items
        .filter(item => !item.isDirectory && item.name.startsWith('ST_Backup_') && (item.name.endsWith('.zip') || item.name.endsWith('.enc.zip')))
        .map(item => {
          const isEncrypted = item.name.includes('.enc.');
          const isFull = item.name.includes('_full_');
          const isCore = item.name.includes('_core_');
          const isCustom = item.name.includes('_custom_');

          const meta = metaMap[item.name] || {};
          let note = meta.note || '';
          const categories = meta.categories || [];
          const scope = meta.scope || (isFull ? 'full' : isCore ? 'core' : isCustom ? 'custom' : 'unknown');
          const user = meta.user || null;

          // 从文件名正则解析备份备注与所属用户
          if (!note) {
            const match = item.name.match(/^ST_Backup_(?:.+_)?(?:core|full|custom)_\d{8}_\d{6}__(.+?)(?:\.enc)?\.zip$/i);
            if (match && match[1]) {
              try {
                note = decodeURIComponent(match[1]).replace(/_/g, ' ');
              } catch {
                note = match[1].replace(/_/g, ' ');
              }
            }
          }

          return {
            name: item.name,
            size: item.size,
            lastModified: item.lastModified,
            scope,
            categories,
            note,
            user,
            encrypted: isEncrypted,
          };
        })
        .sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

      res.json({
        remoteDirectory: remoteDir,
        backups,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // —— 7. 从 WebDAV 恢复指定备份 (支持从共享区还原) ——
  router.post('/restore', async (req, res) => {
    try {
      const remoteFileName = req.body?.fileName;
      const password = req.body?.password;
      const createRollback = req.body?.createRollback !== false;
      const fromShared = Boolean(req.body?.fromShared);

      if (!remoteFileName) {
        return res.status(400).json({ error: '请指定需要恢复的文件名' });
      }

      // 路径穿越防御：文件名必须是纯文件名且命中本插件备份白名单
      let safeFileName;
      try {
        safeFileName = sanitizeBackupFileName(remoteFileName);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      const cfg = ConfigManager.forUser(req.user);
      const userClient = getClientForUser(cfg);

      const restoreOptions = {
        remoteFileName: safeFileName,
        password,
        createRollback,
        requestUser: req.user,
        configManager: cfg,
        webDavClient: userClient,
      };

      // fromShared: 远端目录切换到跨账号共享区
      if (fromShared) {
        restoreOptions.remoteDirOverride = resolveSharedDirectory(cfg.get('remoteDirectory') || 'SillyTavern_Backups');
      }

      const result = await restoreService.restoreBackup(restoreOptions);

      res.json(result);
    } catch (err) {
      sendJobError(res, err);
    }
  });

  // —— 8. 删除远端指定备份 (支持删除共享区条目) ——
  router.post('/delete', async (req, res) => {
    try {
      const fileName = req.body?.fileName;
      const fromShared = Boolean(req.body?.fromShared);
      if (!fileName) return res.status(400).json({ error: '未指定文件名' });

      // 路径穿越防御 + ST_Backup_ 白名单（防止删除 st_backups_meta.json）
      let safeName;
      try {
        safeName = sanitizeBackupFileName(fileName);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      const cfg = ConfigManager.forUser(req.user);
      const userClient = getClientForUser(cfg);

      if (fromShared) {
        // 共享区删除遵循与「取消分享」一致的权限规则
        const sharedDir = resolveSharedDirectory(cfg.get('remoteDirectory') || 'SillyTavern_Backups');
        await sharedService.unshare({
          fileName: safeName,
          sharedDir,
          client: userClient,
          requestUser: req.user,
        });
        return res.json({ success: true, message: `已从共享区删除 ${safeName}` });
      }

      const isolate = cfg.get('isolateUserDirectory') !== false;
      const remoteDir = resolveRemoteDirectory(cfg.get('remoteDirectory') || 'SillyTavern_Backups', req.user, isolate);

      // 共享目录模式（未开启用户隔离）下，目录内混有各用户的备份，
      // 必须校验文件归属，避免任意用户删除他人备份。
      if (!isolate) {
        const handle = getUserInfo(req.user).handle || 'default-user';
        const isAdmin = isAdminUser(req.user);
        if (!isAdmin && !isBackupOwnedBy(safeName, handle)) {
          return res.status(403).json({ error: '权限不足：共享目录下只能删除属于本人的备份' });
        }
      }

      await userClient.delete(`${remoteDir}/${safeName}`);
      // 同步清理远端元数据字典
      await backupService.removeRemoteMeta(remoteDir, [safeName], userClient);

      res.json({ success: true, message: `已从 WebDAV 删除 ${safeName}` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // —— 9. 分享备份到跨账号共享区 ——
  router.post('/share', async (req, res) => {
    try {
      const fileName = req.body?.fileName;
      if (!fileName) return res.status(400).json({ error: '未指定文件名' });

      let safeName;
      try {
        safeName = sanitizeBackupFileName(fileName);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      const cfg = ConfigManager.forUser(req.user);
      const userClient = getClientForUser(cfg);
      const isolate = cfg.get('isolateUserDirectory') !== false;
      const remoteDir = resolveRemoteDirectory(cfg.get('remoteDirectory') || 'SillyTavern_Backups', req.user, isolate);
      const sharedDir = resolveSharedDirectory(cfg.get('remoteDirectory') || 'SillyTavern_Backups');

      // 共享目录模式（未开启用户隔离）下，目录内混有各用户的备份。
      // 与 /delete 保持一致：非管理员只能分享属于本人前缀的备份，
      // 否则可冒认归属（把他人备份记成自己分享），并反向阻塞原主分享（409）。
      if (!isolate) {
        const handle = getUserInfo(req.user).handle || 'default-user';
        if (!isAdminUser(req.user) && !isBackupOwnedBy(safeName, handle)) {
          return res.status(403).json({ error: '权限不足：共享目录下只能分享属于本人的备份' });
        }
      }

      // 取用户目录下的元数据条目，用于补全备注/范围/分类
      const metaMap = await backupService.getRemoteMeta(remoteDir, userClient).catch(() => ({}));
      const sourceMeta = metaMap[safeName] || null;

      const result = await sharedService.share({
        fileName: safeName,
        sourceRemoteDir: remoteDir,
        sharedDir,
        client: userClient,
        cfg,
        requestUser: req.user,
        sourceMeta,
      });

      res.json(result);
    } catch (err) {
      // 409 = 同名备份已由其他用户共享
      const status = err.status === 409 ? 409 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // —— 10. 从跨账号共享区撤回分享 ——
  router.post('/unshare', async (req, res) => {
    try {
      const fileName = req.body?.fileName;
      if (!fileName) return res.status(400).json({ error: '未指定文件名' });

      let safeName;
      try {
        safeName = sanitizeBackupFileName(fileName);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      const cfg = ConfigManager.forUser(req.user);
      const userClient = getClientForUser(cfg);
      const sharedDir = resolveSharedDirectory(cfg.get('remoteDirectory') || 'SillyTavern_Backups');

      const result = await sharedService.unshare({
        fileName: safeName,
        sharedDir,
        client: userClient,
        requestUser: req.user,
      });

      res.json(result);
    } catch (err) {
      const status = err.status === 403 ? 403 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // —— 11. 列出跨账号共享区中的备份 ——
  router.get('/shared', async (req, res) => {
    try {
      const cfg = ConfigManager.forUser(req.user);
      const webdavUrl = cfg.get('webdavUrl');
      const sharedDir = resolveSharedDirectory(cfg.get('remoteDirectory') || 'SillyTavern_Backups');

      if (!webdavUrl) {
        return res.json({ sharedDirectory: sharedDir, backups: [] });
      }

      const userClient = getClientForUser(cfg);
      const result = await sharedService.listShared({
        sharedDir,
        client: userClient,
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
