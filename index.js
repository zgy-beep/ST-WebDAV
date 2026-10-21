import express from 'express';
import path from 'node:path';
import { ConfigManager } from './src/server/ConfigManager.js';
import { WebDavClient } from './src/server/WebDavClient.js';
import { BackupService } from './src/server/BackupService.js';
import { RestoreService } from './src/server/RestoreService.js';
import { SchedulerService } from './src/server/SchedulerService.js';
import { BACKUP_CATEGORIES } from './src/server/BackupCategories.js';
import { getUserInfo, resolveRemoteDirectory } from './src/server/UserHelper.js';

export const info = {
  id: 'st-webdav',
  name: 'ST-WebDAV',
  description: 'SillyTavern WebDAV 全量备份与恢复插件',
  version: '1.0.0',
};

let configManager = null;
let webDavClient = null;
let backupService = null;
let restoreService = null;
let schedulerService = null;

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

  // 3. 启动定时任务
  schedulerService.start();

  // 4. 注册 Express API 路由 (/api/plugins/st-webdav/*)
  registerRoutes(router);

  console.log(`[${info.name}] Plugin initialized successfully.`);
}

/**
 * 服务端卸载/退出清理钩子
 */
export async function exit() {
  if (schedulerService) {
    schedulerService.stop();
  }
  console.log(`[${info.name}] Plugin unloaded.`);
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
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // —— 2. 更新配置 ——
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
      res.status(500).json({ error: err.message });
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

  // —— 7. 从 WebDAV 恢复指定备份 ——
  router.post('/restore', async (req, res) => {
    try {
      const remoteFileName = req.body?.fileName;
      const password = req.body?.password;
      const createRollback = req.body?.createRollback !== false;

      if (!remoteFileName) {
        return res.status(400).json({ error: '请指定需要恢复的文件名' });
      }

      const cfg = ConfigManager.forUser(req.user);
      const userClient = getClientForUser(cfg);

      const result = await restoreService.restoreBackup({
        remoteFileName,
        password,
        createRollback,
        requestUser: req.user,
        configManager: cfg,
        webDavClient: userClient,
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // —— 8. 删除远端指定备份 ——
  router.post('/delete', async (req, res) => {
    try {
      const fileName = req.body?.fileName;
      if (!fileName) return res.status(400).json({ error: '未指定文件名' });

      const cfg = ConfigManager.forUser(req.user);
      const userClient = getClientForUser(cfg);
      const isolate = cfg.get('isolateUserDirectory') !== false;
      const remoteDir = resolveRemoteDirectory(cfg.get('remoteDirectory') || 'SillyTavern_Backups', req.user, isolate);
      const cleanName = path.basename(fileName); // 防路径遍历
      const remotePath = `${remoteDir}/${cleanName}`;

      await userClient.delete(remotePath);
      // 同步清理远端元数据字典
      await backupService.removeRemoteMeta(remoteDir, [cleanName], userClient);

      res.json({ success: true, message: `已从 WebDAV 删除 ${cleanName}` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
