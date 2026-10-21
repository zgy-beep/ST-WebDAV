import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import archiver from 'archiver';
import { CryptoHelper } from './CryptoHelper.js';
import { BACKUP_CATEGORIES } from './BackupCategories.js';
import { resolveUserDir, getUserInfo, resolveRemoteDirectory } from './UserHelper.js';

export class BackupService {
  /**
   * @param {object} options
   * @param {import('./WebDavClient.js').WebDavClient} options.webDavClient
   * @param {import('./ConfigManager.js').ConfigManager} options.configManager
   */
  constructor({ webDavClient, configManager }) {
    this.webDavClient = webDavClient;
    this.configManager = configManager;
    this.userStatuses = new Map();
    this.activeBackups = new Set();
    this.metaCache = new Map(); // 远端元数据短期缓存
  }

  get isBackingUp() {
    return this.activeBackups.size > 0;
  }

  getStatus(requestUser = null) {
    const userInfo = getUserInfo(requestUser);
    const handle = userInfo.handle || 'default-user';
    return this.userStatuses.get(handle) || {
      running: false,
      phase: 'idle',
      progress: 0,
      detail: '',
      error: null,
      lastSuccess: null,
    };
  }

  get status() {
    return this.getStatus();
  }

  /**
   * 获取当前生效的用户数据根目录
   * @param {object} [requestUser] 
   * @returns {string}
   */
  resolveUserDir(requestUser = null) {
    return resolveUserDir(requestUser);
  }

  /**
   * 执行 WebDAV 备份 (流式磁盘暂存，杜绝 V8 Heap OOM，多租户隔离)
   * @param {object} [options]
   * @param {'core'|'full'|'custom'} [options.scope]
   * @param {string[]} [options.categories]
   * @param {boolean} [options.encrypt]
   * @param {string} [options.password]
   * @param {string} [options.note]
   * @param {object} [options.requestUser]
   * @param {import('./ConfigManager.js').ConfigManager} [options.configManager]
   * @param {import('./WebDavClient.js').WebDavClient} [options.webDavClient]
   */
  async runBackup(options = {}) {
    const userInfo = getUserInfo(options.requestUser);
    const handle = userInfo.handle || 'default-user';

    if (this.activeBackups.has(handle)) {
      throw new Error('另一个备份任务正在进行中，请勿重复触发');
    }

    const cfg = options.configManager || this.configManager;
    const client = options.webDavClient || this.webDavClient;

    const webdavUrl = cfg.get('webdavUrl');
    if (!webdavUrl) {
      throw new Error('WebDAV 服务端 URL 尚未配置，请先在「服务设置」中填写并保存配置');
    }

    // 同步客户端最新参数
    client.updateConfig({
      url: webdavUrl,
      username: cfg.get('webdavUsername'),
      password: cfg.get('webdavPassword'),
      timeoutMs: cfg.get('timeoutMs') || 15000,
    });

    const scope = options.scope || cfg.get('backupScope') || 'core';
    const encrypt = options.encrypt !== undefined ? Boolean(options.encrypt) : Boolean(cfg.get('encryptionEnabled'));
    const password = options.password || cfg.get('encryptionPassword') || '';
    const note = options.note || '';

    if (encrypt && !password) {
      throw new Error('已勾选端到端加密，但未提供加密密码');
    }

    const userDir = userInfo.userDir;
    const isolate = cfg.get('isolateUserDirectory') !== false;
    const remoteDir = resolveRemoteDirectory(cfg.get('remoteDirectory') || 'SillyTavern_Backups', options.requestUser, isolate);

    this.activeBackups.add(handle);
    const userStatus = {
      running: true,
      phase: 'preparing',
      progress: 5,
      detail: '正在准备备份目录与远端路径...',
      error: null,
      lastSuccess: this.getStatus(options.requestUser).lastSuccess,
    };
    this.userStatuses.set(handle, userStatus);

    let tempFilePath = null;

    try {
      // 1. 确保远端备份目录存在 (MKCOL 递归探测)
      userStatus.phase = 'connecting';
      userStatus.progress = 15;
      userStatus.detail = `检查远端目录: ${remoteDir}`;
      await client.ensureDirectory(remoteDir);

      // 2. 组装归档文件名 (多用户环境下自动加注用户名，包含可读备注标识)
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const timeStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const ext = encrypt ? '.enc.zip' : '.zip';

      const cleanNote = String(note || '').trim();
      const noteSlug = cleanNote
        ? cleanNote.replace(/[/\\:*?"<>|#%&{}\\<>*?/$!'":@+`|=]/g, '_').replace(/\s+/g, '_').slice(0, 30)
        : '';
      const userPrefix = (userInfo.isMultiUser && userInfo.handle) ? `${userInfo.handle}_` : '';
      const fileName = `ST_Backup_${userPrefix}${scope}_${timeStr}${noteSlug ? '__' + noteSlug : ''}${ext}`;
      const remotePath = `${remoteDir}/${fileName}`;

      // 3. 构建元数据清单 backup_manifest.json (记录所属用户与环境)
      const manifest = {
        plugin: 'st-webdav',
        version: '1.0.0',
        createdAt: now.toISOString(),
        user: {
          handle: userInfo.handle,
          displayName: userInfo.displayName,
          isMultiUser: userInfo.isMultiUser,
        },
        scope,
        categories: options.categories || [],
        encrypted: encrypt,
        note: cleanNote,
        userDirName: path.basename(userDir),
      };

      // 4. 关键架构改进：流式落盘暂存 (Spool to Temporary File)
      // 避免全量 Buffer 在 Node.js 内存堆中拼接引发 OOM 崩溃
      userStatus.phase = 'archiving';
      userStatus.progress = 30;
      userStatus.detail = '正在流式打包与压缩酒馆文件...';

      const tempDir = path.join(os.tmpdir(), 'st_webdav_spool');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      tempFilePath = path.join(tempDir, `backup_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
      const fileWriteStream = fs.createWriteStream(tempFilePath);

      const archive = archiver('zip', {
        zlib: { level: 6 }, // 平衡压缩比与 CPU 占用
      });

      // 写入清单文件
      archive.append(JSON.stringify(manifest, null, 2), { name: 'backup_manifest.json' });

      const filterGit = entry => {
        const n = entry.name;
        if (n.includes('/.git') || n.includes('\\.git') || n.startsWith('.git') || n.startsWith('/.git') || n.startsWith('\\.git')) {
          return false;
        }
        if (n.includes('node_modules')) {
          return false;
        }
        return entry;
      };

      const addDirSafe = (fullDirPath, targetRel) => {
        if (!fs.existsSync(fullDirPath)) return;
        archive.directory(fullDirPath, targetRel, filterGit);
      };

      // 根据 scope 决定包含的文件
      if (scope === 'core') {
        const coreFiles = ['settings.json', 'secrets.json'];
        for (const file of coreFiles) {
          const fullPath = path.join(userDir, file);
          if (fs.existsSync(fullPath)) {
            archive.file(fullPath, { name: file });
          }
        }

        const coreDirs = [
          'worlds',
          'themes',
          'movingUI',
          'instruct',
          'context',
          'sysprompt',
          'reasoning',
          'QuickReplies',
          'extensions',
        ];

        for (const dir of coreDirs) {
          addDirSafe(path.join(userDir, dir), dir);
        }
      } else if (scope === 'custom') {
        const selectedCatIds = Array.isArray(options.categories) && options.categories.length > 0
          ? options.categories
          : BACKUP_CATEGORIES.filter(c => c.defaultSelected).map(c => c.id);

        const selectedCats = BACKUP_CATEGORIES.filter(c => selectedCatIds.includes(c.id));
        if (!selectedCats.length) {
          throw new Error('未选择任何自定义备份项，请至少勾选一个数据分类');
        }

        for (const cat of selectedCats) {
          for (const file of cat.files) {
            const fullPath = path.join(userDir, file);
            if (fs.existsSync(fullPath)) {
              archive.file(fullPath, { name: file });
            }
          }
          for (const dir of cat.dirs) {
            addDirSafe(path.join(userDir, dir), dir);
          }
        }
      } else {
        // 全量备份
        archive.glob('**/*', {
          cwd: userDir,
          dot: true,
          ignore: [
            'backups/**',
            'thumbnails/**',
            '**/node_modules/**',
            '**/.git/**',
            '**/*.tmp*',
          ],
        });
      }

      // 组装管道：archive -> (encryptStream) -> fileWriteStream
      if (encrypt) {
        const encryptStream = CryptoHelper.createEncryptStream(password);
        archive.pipe(encryptStream).pipe(fileWriteStream);
      } else {
        archive.pipe(fileWriteStream);
      }

      const finalizePromise = archive.finalize();
      const writePromise = new Promise((resolve, reject) => {
        fileWriteStream.on('finish', resolve);
        fileWriteStream.on('error', reject);
        archive.on('error', reject);
      });

      await Promise.all([finalizePromise, writePromise]);

      const stat = await fs.promises.stat(tempFilePath);
      const fileSize = stat.size;
      const sizeMb = (fileSize / (1024 * 1024)).toFixed(2);

      userStatus.phase = 'uploading';
      userStatus.progress = 60;
      userStatus.detail = `正在推送到 WebDAV: ${fileName} (${sizeMb} MB)...`;

      // 上传至 WebDAV：小于 32MB 时使用 Buffer (保持单元测试 mock 兼容)，超大文件采用流式传输直推
      if (fileSize < 32 * 1024 * 1024) {
        const payloadBuffer = await fs.promises.readFile(tempFilePath);
        await client.put(remotePath, payloadBuffer, fileSize);
      } else {
        const fileReadStream = fs.createReadStream(tempFilePath);
        await client.put(remotePath, fileReadStream, fileSize);
      }

      // 5. 同步远端元数据清单索引
      await this.saveRemoteMeta(remoteDir, fileName, {
        note: cleanNote,
        scope,
        categories: options.categories || [],
        createdAt: now.toISOString(),
        size: fileSize,
        encrypted: encrypt,
        user: {
          handle: userInfo.handle,
          displayName: userInfo.displayName,
          isMultiUser: userInfo.isMultiUser,
        },
      }, client);

      userStatus.progress = 90;
      userStatus.detail = '备份上传完成，正在执行历史备份轮转...';

      // 6. 历史轮转与清理
      await this.rotateBackups(remoteDir, client, cfg);

      const result = {
        success: true,
        fileName,
        remotePath,
        scope,
        categories: options.categories || [],
        note: cleanNote,
        encrypted: encrypt,
        createdAt: now.toISOString(),
      };

      userStatus.phase = 'success';
      userStatus.progress = 100;
      userStatus.detail = `备份成功: ${fileName}`;
      userStatus.lastSuccess = result;

      // 更新配置中的最近备份时间
      cfg.update({
        lastBackupTime: now.toISOString(),
        lastBackupStatus: `成功 (${fileName})`,
      });

      return result;
    } catch (err) {
      console.error('[ST-WebDAV] 备份失败:', err);
      userStatus.phase = 'failed';
      userStatus.error = err.message;
      userStatus.detail = `备份失败: ${err.message}`;

      cfg.update({
        lastBackupStatus: `失败 (${err.message})`,
      });

      throw err;
    } finally {
      this.activeBackups.delete(handle);
      userStatus.running = false;

      // 清理临时落盘文件
      if (tempFilePath) {
        try {
          if (fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath);
          }
        } catch {}
      }
    }
  }

  /**
   * 自动清理超出保留上限的旧备份文件
   * @param {string} remoteDir 
   * @param {import('./WebDavClient.js').WebDavClient} [client]
   * @param {import('./ConfigManager.js').ConfigManager} [cfg]
   */
  async rotateBackups(remoteDir, client = null, cfg = null) {
    try {
      const activeCfg = cfg || this.configManager;
      const activeClient = client || this.webDavClient;
      const retentionCount = Number(activeCfg.get('retentionCount')) || 10;
      if (retentionCount <= 0) return; // 0 表示不限制

      const list = await activeClient.listFiles(remoteDir);
      const backupFiles = list.filter(item => !item.isDirectory && item.name.startsWith('ST_Backup_'));

      if (backupFiles.length <= retentionCount) return;

      // 按修改时间升序排列（最旧的在前面）
      backupFiles.sort((a, b) => new Date(a.lastModified).getTime() - new Date(b.lastModified).getTime());

      const deleteCount = backupFiles.length - retentionCount;
      const toDelete = backupFiles.slice(0, deleteCount);

      for (const item of toDelete) {
        try {
          const deletePath = `${remoteDir}/${item.name}`;
          await activeClient.delete(deletePath);
          console.info(`[ST-WebDAV] 历史轮转：已自动清理过期备份 ${item.name}`);
        } catch (delErr) {
          console.warn(`[ST-WebDAV] 清理旧备份失败: ${item.name}`, delErr.message);
        }
      }

      await this.removeRemoteMeta(remoteDir, toDelete.map(item => item.name), activeClient);
    } catch (err) {
      console.warn('[ST-WebDAV] 历史轮转检查失败:', err.message);
    }
  }

  /**
   * 读取远端元数据索引字典 (附带 30 秒缓存)
   * @param {string} remoteDir 
   * @param {import('./WebDavClient.js').WebDavClient} [client]
   * @returns {Promise<Record<string, any>>}
   */
  async getRemoteMeta(remoteDir, client = null) {
    const cached = this.metaCache.get(remoteDir);
    if (cached && (Date.now() - cached.timestamp < 30000)) {
      return { ...cached.data };
    }

    try {
      const activeClient = client || this.webDavClient;
      const metaPath = `${remoteDir}/st_backups_meta.json`;
      const buf = await activeClient.getBuffer(metaPath);
      const data = JSON.parse(buf.toString('utf-8'));
      this.metaCache.set(remoteDir, { timestamp: Date.now(), data });
      return { ...data };
    } catch {
      return {};
    }
  }

  /**
   * 保存单个备份项元数据至远端索引
   * @param {string} remoteDir 
   * @param {string} fileName 
   * @param {object} metaEntry 
   * @param {import('./WebDavClient.js').WebDavClient} [client]
   */
  async saveRemoteMeta(remoteDir, fileName, metaEntry, client = null) {
    try {
      const activeClient = client || this.webDavClient;
      const metaPath = `${remoteDir}/st_backups_meta.json`;
      const existing = await this.getRemoteMeta(remoteDir, activeClient);
      existing[fileName] = metaEntry;
      const content = Buffer.from(JSON.stringify(existing, null, 2), 'utf-8');
      await activeClient.put(metaPath, content, content.length);
      this.metaCache.set(remoteDir, { timestamp: Date.now(), data: existing });
    } catch (err) {
      console.warn('[ST-WebDAV] 保存远端元数据索引异常 (不影响备份包):', err.message);
    }
  }

  /**
   * 从远端元数据索引中移除已删除的文件条目
   * @param {string} remoteDir 
   * @param {string[]} fileNames 
   * @param {import('./WebDavClient.js').WebDavClient} [client]
   */
  async removeRemoteMeta(remoteDir, fileNames, client = null) {
    if (!fileNames?.length) return;
    try {
      const activeClient = client || this.webDavClient;
      const metaPath = `${remoteDir}/st_backups_meta.json`;
      const existing = await this.getRemoteMeta(remoteDir, activeClient);
      let changed = false;
      for (const name of fileNames) {
        if (existing[name]) {
          delete existing[name];
          changed = true;
        }
      }
      if (changed) {
        const content = Buffer.from(JSON.stringify(existing, null, 2), 'utf-8');
        await activeClient.put(metaPath, content, content.length);
        this.metaCache.set(remoteDir, { timestamp: Date.now(), data: existing });
      }
    } catch (err) {
      console.warn('[ST-WebDAV] 同步清理远端元数据索引异常:', err.message);
    }
  }
}
