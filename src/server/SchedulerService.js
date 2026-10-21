import fs from 'node:fs';
import path from 'node:path';
import { ConfigManager } from './ConfigManager.js';
import { WebDavClient } from './WebDavClient.js';

export class SchedulerService {
  /**
   * @param {object} options
   * @param {import('./BackupService.js').BackupService} options.backupService
   * @param {import('./ConfigManager.js').ConfigManager} options.configManager
   */
  constructor({ backupService, configManager }) {
    this.backupService = backupService;
    this.configManager = configManager;
    this.timer = null;
    this.initTimeout = null;
    this.checkIntervalMs = 30 * 60 * 1000; // 每 30 分钟检查一次是否满足备份间隔
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkAndRun(), this.checkIntervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref(); // 避免阻止 Node.js 进程自然退出
    }

    // 启动 10 秒后执行一次初始判断，妥善保存 timer 句柄
    this.initTimeout = setTimeout(() => {
      this.initTimeout = null;
      this.checkAndRun();
    }, 10000);
    if (typeof this.initTimeout.unref === 'function') {
      this.initTimeout.unref();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.initTimeout) {
      clearTimeout(this.initTimeout);
      this.initTimeout = null;
    }
  }

  async checkAndRun() {
    try {
      const dataRoot = globalThis.DATA_ROOT || path.join(process.cwd(), 'data');
      const targets = [];

      // 1. 默认用户账号
      const defaultUserDir = path.join(dataRoot, 'default-user');
      targets.push({
        handle: 'default-user',
        directories: { root: fs.existsSync(defaultUserDir) ? defaultUserDir : dataRoot },
      });

      // 2. 多用户环境下的全部独立账号 (_users/*)
      const multiUsersDir = path.join(dataRoot, '_users');
      if (fs.existsSync(multiUsersDir)) {
        try {
          const entries = await fs.promises.readdir(multiUsersDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              targets.push({
                handle: entry.name,
                directories: { root: path.join(multiUsersDir, entry.name) },
              });
            }
          }
        } catch {}
      }

      for (const targetUser of targets) {
        await this.checkAndRunForUser(targetUser);
      }
    } catch (err) {
      console.warn('[ST-WebDAV] 自动化定时备份巡检异常:', err.message);
    }
  }

  async checkAndRunForUser(targetUser) {
    try {
      const userConfig = ConfigManager.forUser(targetUser);
      const enabled = Boolean(userConfig.get('autoBackupEnabled'));
      const url = userConfig.get('webdavUrl');
      if (!enabled || !url) return;

      const intervalHours = Number(userConfig.get('autoBackupIntervalHours')) || 24;
      const lastTimeStr = userConfig.get('lastBackupTime');

      if (lastTimeStr) {
        const lastTime = new Date(lastTimeStr).getTime();
        const now = Date.now();
        const diffHours = (now - lastTime) / (3600 * 1000);
        if (diffHours < intervalHours) {
          return; // 尚未到达下次备份周期
        }
      }

      // 为每个用户构造独立的 WebDavClient
      // 避免使用全局单例（原地 updateConfig 会导致多租户凭据串扰）
      const userClient = new WebDavClient({
        url: userConfig.get('webdavUrl'),
        username: userConfig.get('webdavUsername'),
        password: userConfig.get('webdavPassword'),
        timeoutMs: userConfig.get('timeoutMs') || 15000,
      });

      console.log(`[ST-WebDAV] 触发用户 [${targetUser.handle}] 的自动化定时备份任务...`);
      await this.backupService.runBackup({
        note: '自动化定时备份',
        requestUser: targetUser,
        configManager: userConfig,
        webDavClient: userClient,
      });
    } catch (err) {
      console.warn(`[ST-WebDAV] 用户 [${targetUser.handle}] 定时备份异常:`, err.message);
    }
  }
}
