import fs from 'node:fs';
import path from 'node:path';

const MASKED = '********';

const DEFAULT_CONFIG = {
  webdavUrl: '',
  webdavUsername: '',
  webdavPassword: '',
  remoteDirectory: 'SillyTavern_Backups',
  backupScope: 'core', // 'core' | 'full'
  autoBackupEnabled: false,
  autoBackupIntervalHours: 24,
  retentionCount: 10,
  encryptionEnabled: false,
  encryptionPassword: '',
  cdnBase: 'https://cdn.jsdelivr.net/gh/zgy-beep/ui-kit@main',
  lastBackupTime: null,
  lastBackupStatus: null,
};

export class ConfigManager {
  /**
   * @param {string} [configFilePath] 
   */
  constructor(configFilePath = null) {
    if (configFilePath) {
      this.filePath = configFilePath;
    } else {
      // 优先存放在酒馆 DATA 根目录，若未就绪则保存在插件自身目录下
      const dataRoot = globalThis.DATA_ROOT || path.join(process.cwd(), 'data');
      this.filePath = path.join(dataRoot, 'st_webdav_config.json');
    }
    this.config = { ...DEFAULT_CONFIG };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.config = { ...DEFAULT_CONFIG, ...parsed };
      }
    } catch (err) {
      console.warn('[ST-WebDAV] 读取配置文件失败，使用默认配置:', err.message);
      this.config = { ...DEFAULT_CONFIG };
    }
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tempFile = `${this.filePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tempFile, JSON.stringify(this.config, null, 2), 'utf-8');
      fs.renameSync(tempFile, this.filePath);
    } catch (err) {
      console.error('[ST-WebDAV] 保存配置文件失败:', err);
      throw err;
    }
  }

  get(key) {
    return this.config[key];
  }

  getAll() {
    return { ...this.config };
  }

  /**
   * 获取脱敏后的安全配置对象（返回给前端面板使用）
   */
  getMasked() {
    const copy = { ...this.config };
    if (copy.webdavPassword) copy.webdavPassword = MASKED;
    if (copy.encryptionPassword) copy.encryptionPassword = MASKED;
    return copy;
  }

  /**
   * 安全更新配置（如果前端提交的是脱敏掩码，则保留原有真实密码）
   * @param {Partial<typeof DEFAULT_CONFIG>} newValues 
   */
  update(newValues = {}) {
    for (const [key, val] of Object.entries(newValues)) {
      if (val === undefined) continue;

      // 密码脱敏防冲刷处理
      if ((key === 'webdavPassword' || key === 'encryptionPassword') && val === MASKED) {
        continue; // 保留原密码
      }

      this.config[key] = val;
    }
    this.save();
    return this.getMasked();
  }
}
