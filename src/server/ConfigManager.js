import fs from 'node:fs';
import path from 'node:path';
import { resolveUserDir } from './UserHelper.js';
import { validateHttpUrl } from './UrlGuard.js';

const MASKED = '********';

/**
 * 从全局模板继承到新用户配置时**必须剔除**的字段
 * ------------------------------------------------------------------
 * 这些字段要么是凭据（越权分发给其他账号），要么是运行时状态
 * （沿用会导致新用户看到别人的备份时间与失败记录）。
 */
const TEMPLATE_EXCLUDED_KEYS = new Set([
  'webdavPassword',
  'encryptionPassword',
  'lastBackupTime',
  'lastBackupStatus',
]);

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
          // 只继承 URL / 目录 / 策略类字段，剔除凭据与运行时状态
          const inherited = {};
          for (const [key, value] of Object.entries(globalParsed)) {
            if (TEMPLATE_EXCLUDED_KEYS.has(key)) continue;
            inherited[key] = value;
          }
          mgr.config = { ...DEFAULT_CONFIG, ...inherited };
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

        // 对磁盘上的 URL 做一次安全校验：非法 URL 若被直接使用，
        // 会在 updateConfig 时抛错并让该账号的任务锁泄漏
        for (const key of ['webdavUrl', 'cdnBase']) {
          const value = this.config[key];
          if (!value) continue;
          try {
            this.config[key] = validateHttpUrl(String(value), { label: key === 'webdavUrl' ? 'WebDAV 地址' : 'CDN 地址' });
          } catch (err) {
            console.warn(`[ST-WebDAV] 配置文件中的 ${key} 无效，已忽略: ${err.message}`);
            this.config[key] = '';
          }
        }
      }
    } catch (err) {
      console.warn('[ST-WebDAV] 读取配置文件失败，使用默认配置:', err.message);
      this.config = { ...DEFAULT_CONFIG };
    }
  }

  /**
   * 从磁盘重新加载配置到内存缓存
   * ------------------------------------------------------------------
   * 还原流程会直接把磁盘上的配置文件覆盖写回，而 ConfigManager.instances
   * 中缓存的仍是旧值 —— 不刷新会出现「还原了配置但下次 update 又写回旧值」
   * 的不一致状态。
   * @returns {boolean} 是否发生了实际刷新
   */
  refresh() {
    const before = JSON.stringify(this.config);
    this.load();
    return JSON.stringify(this.config) !== before;
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tempFile = `${this.filePath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2)}`;
      try {
        // 配置文件含明文凭据，限制为仅属主可读写（POSIX；Windows 下忽略）
        fs.writeFileSync(tempFile, JSON.stringify(this.config, null, 2), { encoding: 'utf-8', mode: 0o600 });
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
        // 保存时即做完整校验（含 SSRF 黑名单），避免内网地址先入库再被使用
        const trimmed = String(val || '').trim();
        if (trimmed) {
          this.config[key] = validateHttpUrl(trimmed, { label: 'WebDAV 地址' });
        } else {
          this.config[key] = '';
        }
      } else if (key === 'cdnBase') {
        const trimmed = String(val || '').trim();
        if (trimmed) {
          this.config[key] = validateHttpUrl(trimmed, { label: 'CDN 地址' });
        } else {
          this.config[key] = '';
        }
      } else {
        this.config[key] = val;
      }
    }
    this.save();
    return this.getMasked();
  }
}
