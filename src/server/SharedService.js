import { getUserInfo, resolveSharedDirectory, isAdminUser } from './UserHelper.js';
import { SHARED_META_FILE } from './Constants.js';
import { sanitizeBackupFileName, BACKUP_FILE_PREFIX } from './PathGuard.js';

/**
 * 跨账号跨用户共享区服务
 * ------------------------------------------------------------------
 * 设计要点：
 *   1. 共享区固定为 `<基础目录>/_shared`，不带用户 handle 前缀，
 *      所有能访问该 WebDAV 路径的用户与账号共用同一片空间；
 *   2. 分享通过 WebDAV COPY 在服务端完成，不下载到本地再上传；
 *   3. 权限模型：分享者可撤回自己的分享，管理员可撤回任意分享；
 *   4. 共享区**不受**用户备份轮转策略影响（轮转只作用于用户自身目录）。
 */
export class SharedService {
  /**
   * @param {object} options
   * @param {import('./ConfigManager.js').ConfigManager} [options.configManager]
   */
  constructor({ configManager } = {}) {
    this.configManager = configManager;
    /** @type {Map<string, Promise<void>>} 共享区元数据读-改-写互斥锁 */
    this.metaLocks = new Map();
    /** @type {Map<string, { timestamp: number, data: Record<string, any> }>} */
    this.metaCache = new Map();
  }

  /**
   * 解析当前用户生效的共享区远端目录
   * @param {object} cfg ConfigManager
   * @returns {string}
   */
  resolveSharedDir(cfg) {
    return resolveSharedDirectory(cfg.get('remoteDirectory') || 'SillyTavern_Backups');
  }

  /**
   * 以共享区为粒度串行化元数据读-改-写
   * @param {string} sharedDir
   * @param {() => Promise<any>} task
   */
  async withMetaLock(sharedDir, task) {
    const key = String(sharedDir || '');
    const previous = this.metaLocks.get(key) || Promise.resolve();
    const current = previous.then(task, task);
    this.metaLocks.set(key, current.catch(() => {}));
    try {
      return await current;
    } finally {
      if (this.metaLocks.get(key) === current) {
        this.metaLocks.delete(key);
      }
    }
  }

  /**
   * 读取共享区元数据索引
   * @param {string} sharedDir
   * @param {import('./WebDavClient.js').WebDavClient} client
   * @param {object} [options]
   * @param {boolean} [options.force] 强制绕过缓存读取远端最新值
   * @returns {Promise<Record<string, any>>}
   */
  async getSharedMeta(sharedDir, client, options = {}) {
    if (!options.force) {
      const cached = this.metaCache.get(sharedDir);
      if (cached && (Date.now() - cached.timestamp < 30000)) {
        return { ...cached.data };
      }
    }

    try {
      const buf = await client.getBuffer(`${sharedDir}/${SHARED_META_FILE}`);
      const data = JSON.parse(buf.toString('utf-8'));
      this.metaCache.set(sharedDir, { timestamp: Date.now(), data });
      return { ...data };
    } catch {
      return {};
    }
  }

  /**
   * 写入共享区元数据索引
   * @param {string} sharedDir
   * @param {Record<string, any>} data
   * @param {import('./WebDavClient.js').WebDavClient} client
   */
  async putSharedMeta(sharedDir, data, client) {
    const content = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
    await client.put(`${sharedDir}/${SHARED_META_FILE}`, content, content.length);
    this.metaCache.set(sharedDir, { timestamp: Date.now(), data });
  }

  /**
   * 从远端文件名解析备注与范围（与 /backups 的兜底逻辑保持一致）
   * @param {string} fileName
   * @returns {string}
   */
  parseNoteFromFileName(fileName) {
    const match = String(fileName || '').match(
      /^ST_Backup_(?:.+_)?(?:core|full|custom)_\d{8}_\d{6}__(.+?)(?:\.enc)?\.zip$/i
    );
    if (!match || !match[1]) return '';
    try {
      return decodeURIComponent(match[1]).replace(/_/g, ' ');
    } catch {
      return match[1].replace(/_/g, ' ');
    }
  }

  /**
   * 从远端文件名解析范围
   * @param {string} fileName
   * @returns {'core'|'full'|'custom'|'unknown'}
   */
  parseScopeFromFileName(fileName) {
    const name = String(fileName || '');
    if (name.includes('_full_')) return 'full';
    if (name.includes('_core_')) return 'core';
    if (name.includes('_custom_')) return 'custom';
    return 'unknown';
  }

  /**
   * 将某个备份分享到共享区
   * @param {object} options
   * @param {string} options.fileName 源文件名（位于用户自身远端目录）
   * @param {string} options.sourceRemoteDir 源远端目录
   * @param {string} options.sharedDir 共享区目录
   * @param {import('./WebDavClient.js').WebDavClient} options.client
   * @param {import('./ConfigManager.js').ConfigManager} options.cfg
   * @param {object} options.requestUser
   * @param {Record<string, any>} [options.sourceMeta] 用户目录下的元数据条目
   * @returns {Promise<{ success: boolean, fileName: string, sharedDirectory: string }>}
   */
  async share(options) {
    const { client, cfg, requestUser, sourceRemoteDir, sharedDir } = options;

    const fileName = sanitizeBackupFileName(options.fileName);
    const userInfo = getUserInfo(requestUser);
    const admin = isAdminUser(requestUser);

    // 1. 确认源文件确实存在于用户当前生效的远端目录
    const sourceItems = await client.listFiles(sourceRemoteDir);
    const sourceItem = sourceItems.find(item => !item.isDirectory && item.name === fileName);
    if (!sourceItem) {
      throw new Error(`未在远端目录中找到备份文件: ${fileName}`);
    }

    // 2. 确保共享区目录存在
    await client.ensureDirectory(sharedDir);

    // 3. 同名冲突检查（在锁内完成读-改-写）
    return await this.withMetaLock(sharedDir, async () => {
      // 强制绕过缓存：否则 409 冲突检查可能基于陈旧索引而失效
      const meta = await this.getSharedMeta(sharedDir, client, { force: true });
      const existing = meta[fileName];

      if (existing && existing.sharedBy?.handle && existing.sharedBy.handle !== userInfo.handle && !admin) {
        const err = new Error('同名备份已由其他用户共享');
        err.status = 409;
        throw err;
      }

      // 4. 服务端 COPY 到共享区
      const srcPath = `${sourceRemoteDir}/${fileName}`;
      const destPath = `${sharedDir}/${fileName}`;
      await client.copy(srcPath, destPath);

      // 5. 写入共享区元数据
      const sourceMeta = options.sourceMeta || {};
      meta[fileName] = {
        note: sourceMeta.note || this.parseNoteFromFileName(fileName),
        scope: sourceMeta.scope || this.parseScopeFromFileName(fileName),
        categories: Array.isArray(sourceMeta.categories) ? sourceMeta.categories : [],
        user: sourceMeta.user || null,
        encrypted: sourceMeta.encrypted ?? fileName.includes('.enc.'),
        sharedBy: {
          handle: userInfo.handle,
          displayName: userInfo.displayName || userInfo.handle,
        },
        sharedAt: new Date().toISOString(),
      };

      await this.putSharedMeta(sharedDir, meta, client);

      return {
        success: true,
        fileName,
        sharedDirectory: sharedDir,
      };
    });
  }

  /**
   * 从共享区撤回分享
   * @param {object} options
   * @param {string} options.fileName
   * @param {string} options.sharedDir
   * @param {import('./WebDavClient.js').WebDavClient} options.client
   * @param {object} options.requestUser
   * @returns {Promise<{ success: boolean, fileName: string }>}
   */
  async unshare(options) {
    const { client, sharedDir, requestUser } = options;

    const fileName = sanitizeBackupFileName(options.fileName);
    const userInfo = getUserInfo(requestUser);
    const admin = isAdminUser(requestUser);

    return await this.withMetaLock(sharedDir, async () => {
      // 写操作前强制绕过缓存读取远端最新索引，避免并发写入丢失更新
      const meta = await this.getSharedMeta(sharedDir, client, { force: true });
      const entry = meta[fileName];

      // 无索引记录时一律拒绝：否则任意用户都能删除他人分享的文件
      // （文件可能是外部直接 PUT 进共享区的，没有对应索引条目）
      if (!entry) {
        const err = new Error('该文件不在共享区索引中，拒绝操作');
        err.status = 403;
        throw err;
      }

      // 权限校验：仅分享者本人或管理员可撤回
      const owner = entry.sharedBy?.handle;
      if (owner && owner !== userInfo.handle && !admin) {
        const err = new Error('无权撤回该分享：只有分享者本人或管理员可以操作');
        err.status = 403;
        throw err;
      }

      // 删除共享区文件（不存在也视为成功，保持幂等）
      try {
        await client.delete(`${sharedDir}/${fileName}`);
      } catch (err) {
        console.warn(`[ST-WebDAV] 删除共享区文件失败（忽略）: ${fileName}`, err.message);
      }

      if (meta[fileName]) {
        delete meta[fileName];
        await this.putSharedMeta(sharedDir, meta, client);
      }

      return { success: true, fileName };
    });
  }

  /**
   * 列出共享区中的所有备份
   * @param {object} options
   * @param {string} options.sharedDir
   * @param {import('./WebDavClient.js').WebDavClient} options.client
   * @returns {Promise<{ sharedDirectory: string, backups: object[] }>}
   */
  async listShared(options) {
    const { client, sharedDir } = options;

    const items = await client.listFiles(sharedDir);
    const meta = await this.getSharedMeta(sharedDir, client);

    const backups = items
      .filter(item => !item.isDirectory && item.name.startsWith(BACKUP_FILE_PREFIX))
      .map(item => {
        const entry = meta[item.name] || {};
        return {
          name: item.name,
          size: item.size,
          lastModified: item.lastModified,
          scope: entry.scope || this.parseScopeFromFileName(item.name),
          categories: Array.isArray(entry.categories) ? entry.categories : [],
          note: entry.note || this.parseNoteFromFileName(item.name),
          user: entry.user || null,
          encrypted: entry.encrypted ?? item.name.includes('.enc.'),
          sharedBy: entry.sharedBy || null,
          sharedAt: entry.sharedAt || null,
        };
      })
      .sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

    return { sharedDirectory: sharedDir, backups };
  }
}
