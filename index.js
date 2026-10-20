import express from 'express';
import { ConfigManager } from './src/server/ConfigManager.js';
import { WebDavClient } from './src/server/WebDavClient.js';
import { BackupService } from './src/server/BackupService.js';
import { RestoreService } from './src/server/RestoreService.js';
import { SchedulerService } from './src/server/SchedulerService.js';

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
 * SillyTavern 服务端插件加载入口
 * @param {import('express').Router} router
 */
export async function init(router) {
  console.log(`[${info.name}] Initializing server plugin v${info.version}...`);

  // 1. 初始化配置管理器
  configManager = new ConfigManager();

  // 2. 初始化 WebDAV 客户端
  webDavClient = new WebDavClient({
    url: configManager.get('webdavUrl'),
    username: configManager.get('webdavUsername'),
    password: configManager.get('webdavPassword'),
  });

  // 3. 初始化备份、还原与定时编排服务
  backupService = new BackupService({ webDavClient, configManager });
  restoreService = new RestoreService({ webDavClient, configManager });
  schedulerService = new SchedulerService({ backupService, configManager });

  // 4. 启动定时任务
  schedulerService.start();

  // 5. 注册 Express API 路由 (/api/plugins/st-webdav/*)
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

  // —— 1. 获取配置 (密码自动脱敏) ——
  router.get('/config', (req, res) => {
    try {
      res.json(configManager.getMasked());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // —— 2. 更新配置 ——
  router.post('/config', (req, res) => {
    try {
      const updated = configManager.update(req.body);
      // 同步更新 WebDAV 客户端配置
      webDavClient.updateConfig({
        url: configManager.get('webdavUrl'),
        username: configManager.get('webdavUsername'),
        password: configManager.get('webdavPassword'),
      });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // —— 3. 测试 WebDAV 连接状态 ——
  router.post('/test', async (req, res) => {
    try {
      // 允许请求携带即时测试参数或默认使用当前保存的配置
      const testUrl = req.body?.url !== undefined ? req.body.url : configManager.get('webdavUrl');
      const testUser = req.body?.username !== undefined ? req.body.username : configManager.get('webdavUsername');
      const testPass = req.body?.password !== undefined && req.body.password !== '********'
        ? req.body.password
        : configManager.get('webdavPassword');

      const tempClient = new WebDavClient({
        url: testUrl,
        username: testUser,
        password: testPass,
      });

      const result = await tempClient.testConnection();
      res.json(result);
    } catch (err) {
      res.json({ ok: false, status: 0, message: err.message });
    }
  });

  // —— 4. 执行备份 ——
  router.post('/backup', async (req, res) => {
    try {
      const result = await backupService.runBackup({
        scope: req.body?.scope,
        encrypt: req.body?.encrypt,
        password: req.body?.password,
        note: req.body?.note,
        requestUser: req.user,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // —— 5. 查询备份进度/状态 ——
  router.get('/backup/status', (req, res) => {
    res.json(backupService.getStatus());
  });

  // —— 6. 获取远端备份历史列表 ——
  router.get('/backups', async (req, res) => {
    try {
      const remoteDir = configManager.get('remoteDirectory') || 'SillyTavern_Backups';
      const items = await webDavClient.listFiles(remoteDir);

      // 筛选出属于本插件的备份文件
      const backups = items
        .filter(item => !item.isDirectory && item.name.startsWith('ST_Backup_'))
        .map(item => {
          const isEncrypted = item.name.includes('.enc.');
          const isFull = item.name.includes('_full_');
          const isCore = item.name.includes('_core_');
          return {
            name: item.name,
            size: item.size,
            lastModified: item.lastModified,
            scope: isFull ? 'full' : isCore ? 'core' : 'unknown',
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

      const result = await restoreService.restoreBackup({
        remoteFileName,
        password,
        createRollback,
        requestUser: req.user,
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

      const remoteDir = configManager.get('remoteDirectory') || 'SillyTavern_Backups';
      const cleanName = path.basename(fileName); // 防路径遍历
      const remotePath = `${remoteDir}/${cleanName}`;

      await webDavClient.delete(remotePath);
      res.json({ success: true, message: `已从 WebDAV 删除 ${cleanName}` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
