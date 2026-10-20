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
    this.checkIntervalMs = 30 * 60 * 1000; // 每 30 分钟检查一次是否满足备份间隔
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkAndRun(), this.checkIntervalMs);
    // 启动 10 秒后执行一次初始判断
    setTimeout(() => this.checkAndRun(), 10000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async checkAndRun() {
    try {
      const enabled = Boolean(this.configManager.get('autoBackupEnabled'));
      const url = this.configManager.get('webdavUrl');
      if (!enabled || !url) return;

      const intervalHours = Number(this.configManager.get('autoBackupIntervalHours')) || 24;
      const lastTimeStr = this.configManager.get('lastBackupTime');

      if (lastTimeStr) {
        const lastTime = new Date(lastTimeStr).getTime();
        const now = Date.now();
        const diffHours = (now - lastTime) / (3600 * 1000);
        if (diffHours < intervalHours) {
          return; // 尚未到达下次备份周期
        }
      }

      console.log('[ST-WebDAV] 触发自动化定时备份任务...');
      await this.backupService.runBackup({
        note: '自动化定时备份',
      });
    } catch (err) {
      console.warn('[ST-WebDAV] 自动化定时备份执行异常:', err.message);
    }
  }
}
