import fs from 'node:fs';
import path from 'node:path';
import { resolveUserDir } from './UserHelper.js';

const MASKED = '********';

const DEFAULT_CONFIG = {
  webdavUrl: '',
  webdavUsername: '',
  webdavPassword: '',
  remoteDirectory: 'SillyTavern_Backups',
  isolateUserDirectory: true, // 多用户隔离：自动为各账号划分专属独立子目录
  timeoutMs: 15000,
  backupScope: 'core', // 'core' | 'full' | 'custom'
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
  static instances = new Map();

  /**
   * 为指定请求用户获取独立的 ConfigManager 实例 (具备多用户隔离与全局底座模板兜底)
   * @param {object} [requestUser] 
   * @returns {ConfigManager}
   */
  static forUser(requestUser = null) {
    const userDir = resolveUserDir(requestUser);
    const userConfigPath = path.join(userDir, 'st_webdav_config.json');

    if (!ConfigManager.instances.has(userConfigPath)) {
      const mgr = new ConfigManager(userConfigPath);

      // 如果用户个人配置文件尚未生成，尝试从全局 dataRoot 配置文件继承模板参数
      const dataRoot = globalThis.DATA_ROOT || path.join(process.cwd(), 'data');
      const globalConfigPath = path.join(dataRoot, 'st_webdav_config.json');
      if (!fs.existsSync(userConfigPath) && fs.existsSync(globalConfigPath) && userConfigPath !== globalConfigPath) {
        try {
          const globalRaw = fs.readFileSync(globalConfigPath, 'utf-8');
          const globalParsed = JSON.parse(globalRaw);
          mgr.config = { ...DEFAULT_CONFIG, ...globalParsed };
        } catch {}
      }

      ConfigManager.instances.set(userConfigPath, mgr);
    }

    return ConfigManager.instances.get(userConfigPath);
  }

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

      const tempFile = `${this.filePath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2)}`;
      try {
        fs.writeFileSync(tempFile, JSON.stringify(this.config, null, 2), 'utf-8');
        fs.renameSync(tempFile, this.filePath);
      } catch (writeErr) {
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch {}
        throw writeErr;
      }
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
   * 安全更新配置（如果前端提交的是脱敏掩码，则保留原有真实密码；防御原型链污染与非法字段注入）
   * @param {Partial<typeof DEFAULT_CONFIG>} newValues 
   */
  update(newValues = {}) {
    if (!newValues || typeof newValues !== 'object') {
      return this.getMasked();
    }

    const allowedKeys = Object.keys(DEFAULT_CONFIG);

    for (const [key, val] of Object.entries(newValues)) {
      if (val === undefined || !allowedKeys.includes(key)) continue;
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;

      // 密码脱敏防冲刷处理
      if ((key === 'webdavPassword' || key === 'encryptionPassword') && val === MASKED) {
        continue; // 保留原密码
      }

      if (key === 'timeoutMs') {
        const num = Number(val);
        this.config[key] = (!isNaN(num) && num > 0) ? Math.max(3000, Math.min(120000, num)) : 15000;
      } else if (key === 'autoBackupIntervalHours') {
        const num = Number(val);
        this.config[key] = (!isNaN(num) && num > 0) ? Math.max(1, Math.min(168, Math.floor(num))) : 24;
      } else if (key === 'retentionCount') {
        const num = Number(val);
        this.config[key] = (!isNaN(num) && num >= 0) ? Math.min(100, Math.floor(num)) : 10;
      } else if (key === 'autoBackupEnabled' || key === 'isolateUserDirectory' || key === 'encryptionEnabled') {
        this.config[key] = Boolean(val);
      } else if (key === 'backupScope') {
        const validScopes = ['core', 'full', 'custom'];
        this.config[key] = validScopes.includes(val) ? val : 'core';
      } else if (key === 'remoteDirectory') {
        // 过滤潜在危险字符与路径逃逸
        const clean = String(val || 'SillyTavern_Backups')
          .replace(/\\/g, '/')
          .replace(/^\/+|\/+$/g, '')
          .replace(/\.\./g, '');
        this.config[key] = clean || 'SillyTavern_Backups';
      } else if (key === 'webdavUrl') {
        const trimmed = String(val || '').trim();
        if (trimmed) {
          try {
            const parsed = new URL(trimmed);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
              throw new Error('只允许 http:// 或 https:// 协议');
            }
          } catch (e) {
            throw new Error(`无效的 WebDAV 地址: ${e.message}`);
          }
        }
        this.config[key] = trimmed;
      } else if (key === 'cdnBase') {
        const trimmed = String(val || '').trim();
        if (trimmed) {
          try {
            const parsed = new URL(trimmed);
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
              throw new Error('CDN 协议必须为 http 或 https');
            }
          } catch (e) {
            throw new Error(`无效的 CDN 地址: ${e.message}`);
          }
        }
        this.config[key] = trimmed;
      } else {
        this.config[key] = val;
      }
    }
    this.save();
    return this.getMasked();
  }
}
