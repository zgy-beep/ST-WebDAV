import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import archiver from 'archiver';
import { CryptoHelper } from './CryptoHelper.js';

export class BackupService {
  /**
   * @param {object} options
   * @param {import('./WebDavClient.js').WebDavClient} options.webDavClient
   * @param {import('./ConfigManager.js').ConfigManager} options.configManager
   */
  constructor({ webDavClient, configManager }) {
    this.webDavClient = webDavClient;
    this.configManager = configManager;
    this.isBackingUp = false;
    this.status = {
      running: false,
      phase: 'idle',
      progress: 0,
      detail: '',
      error: null,
      lastSuccess: null,
    };
  }

  getStatus() {
    return { ...this.status };
  }

  /**
   * 获取当前生效的用户数据根目录
   * @param {object} [requestUser] 
   * @returns {string}
   */
  resolveUserDir(requestUser = null) {
    if (requestUser?.directories?.root && fs.existsSync(requestUser.directories.root)) {
      return requestUser.directories.root;
    }
    const dataRoot = globalThis.DATA_ROOT || path.join(process.cwd(), 'data');
    const defaultUserDir = path.join(dataRoot, 'default-user');
    if (fs.existsSync(defaultUserDir)) {
      return defaultUserDir;
    }
    return dataRoot;
  }

  /**
   * 执行 WebDAV 备份
   * @param {object} [options]
   * @param {'core'|'full'} [options.scope]
   * @param {boolean} [options.encrypt]
   * @param {string} [options.password]
   * @param {string} [options.note]
   * @param {object} [options.requestUser]
   */
  async runBackup(options = {}) {
    if (this.isBackingUp) {
      throw new Error('另一个备份任务正在进行中，请勿重复触发');
    }

    const scope = options.scope || this.configManager.get('backupScope') || 'core';
    const encrypt = options.encrypt !== undefined ? Boolean(options.encrypt) : Boolean(this.configManager.get('encryptionEnabled'));
    const password = options.password || this.configManager.get('encryptionPassword') || '';
    const note = options.note || '';

    if (encrypt && !password) {
      throw new Error('已勾选端到端加密，但未提供加密密码');
    }

    const remoteDir = this.configManager.get('remoteDirectory') || 'SillyTavern_Backups';
    const userDir = this.resolveUserDir(options.requestUser);

    this.isBackingUp = true;
    this.status = {
      running: true,
      phase: 'preparing',
      progress: 5,
      detail: '正在准备备份目录与远端路径...',
      error: null,
      lastSuccess: this.status.lastSuccess,
    };

    try {
      // 1. 确保远端备份目录存在 (MKCOL 递归探测)
      this.status.phase = 'connecting';
      this.status.progress = 15;
      this.status.detail = `检查远端目录: ${remoteDir}`;
      await this.webDavClient.ensureDirectory(remoteDir);

      // 2. 组装归档文件名
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const timeStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const ext = encrypt ? '.enc.zip' : '.zip';
      const fileName = `ST_Backup_${scope}_${timeStr}${ext}`;
      const remotePath = `${remoteDir}/${fileName}`;

      // 3. 构建元数据清单 backup_manifest.json
      const manifest = {
        plugin: 'st-webdav',
        version: '1.0.0',
        createdAt: now.toISOString(),
        scope,
        encrypted: encrypt,
        note,
        userDirName: path.basename(userDir),
      };

      // 4. 初始化 archiver 流
      this.status.phase = 'archiving';
      this.status.progress = 30;
      this.status.detail = '正在流式打包与压缩酒馆文件...';

      const archive = archiver('zip', {
        zlib: { level: 6 }, // 平衡压缩比与 CPU 占用
      });

      // 写入清单文件
      archive.append(JSON.stringify(manifest, null, 2), { name: 'backup_manifest.json' });

      // 根据 scope 决定包含的文件
      if (scope === 'core') {
        // 核心配置：只备份 settings, secrets, worlds, themes, templates 等
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
          const fullDirPath = path.join(userDir, dir);
          if (fs.existsSync(fullDirPath)) {
            archive.directory(fullDirPath, dir);
          }
        }
      } else {
        // 全量备份：用户目录下除了临时缓存/已有备份外的全部内容
        archive.glob('**/*', {
          cwd: userDir,
          dot: true,
          ignore: [
            'backups/**',
            'thumbnails/**',
            '**/node_modules/**',
            '**/*.tmp*',
          ],
        });
      }

      // 5. 组装流管道：archive -> (CryptoHelper.encrypt) -> PassThrough
      const uploadPipe = new PassThrough();

      if (encrypt) {
        const encryptStream = CryptoHelper.createEncryptStream(password);
        archive.pipe(encryptStream).pipe(uploadPipe);
      } else {
        archive.pipe(uploadPipe);
      }

      archive.on('warning', err => {
        console.warn('[ST-WebDAV] Archiver warning:', err);
      });

      archive.on('error', err => {
        uploadPipe.destroy(err);
      });

      // 6. 并发发起流式 WebDAV PUT 推送
      this.status.phase = 'uploading';
      this.status.progress = 60;
      this.status.detail = `正在流式推送到 WebDAV: ${fileName}...`;

      // 开启归档打包
      const finalizePromise = archive.finalize();

      // 执行流式上传
      const uploadPromise = this.webDavClient.put(remotePath, uploadPipe);

      await Promise.all([finalizePromise, uploadPromise]);

      this.status.progress = 90;
      this.status.detail = '备份上传完成，正在执行历史备份轮转...';

      // 7. 历史轮转与清理 (Retention Policy)
      await this.rotateBackups(remoteDir);

      const result = {
        success: true,
        fileName,
        remotePath,
        scope,
        encrypted: encrypt,
        createdAt: now.toISOString(),
      };

      this.status.phase = 'success';
      this.status.progress = 100;
      this.status.detail = `备份成功: ${fileName}`;
      this.status.lastSuccess = result;

      // 更新配置中的最近备份时间
      this.configManager.update({
        lastBackupTime: now.toISOString(),
        lastBackupStatus: `成功 (${fileName})`,
      });

      return result;
    } catch (err) {
      console.error('[ST-WebDAV] 备份失败:', err);
      this.status.phase = 'failed';
      this.status.error = err.message;
      this.status.detail = `备份失败: ${err.message}`;

      this.configManager.update({
        lastBackupStatus: `失败 (${err.message})`,
      });

      throw err;
    } finally {
      this.isBackingUp = false;
      this.status.running = false;
    }
  }

  /**
   * 自动清理超出保留上限的旧备份文件
   * @param {string} remoteDir 
   */
  async rotateBackups(remoteDir) {
    try {
      const retentionCount = Number(this.configManager.get('retentionCount')) || 10;
      if (retentionCount <= 0) return; // 0 表示不限制

      const list = await this.webDavClient.listFiles(remoteDir);
      const backupFiles = list.filter(item => !item.isDirectory && item.name.startsWith('ST_Backup_'));

      if (backupFiles.length <= retentionCount) return;

      // 按修改时间升序排列（最旧的在前面）
      backupFiles.sort((a, b) => new Date(a.lastModified).getTime() - new Date(b.lastModified).getTime());

      const deleteCount = backupFiles.length - retentionCount;
      const toDelete = backupFiles.slice(0, deleteCount);

      for (const item of toDelete) {
        try {
          const deletePath = `${remoteDir}/${item.name}`;
          await this.webDavClient.delete(deletePath);
          console.info(`[ST-WebDAV] 历史轮转：已自动清理过期备份 ${item.name}`);
        } catch (delErr) {
          console.warn(`[ST-WebDAV] 清理旧备份失败: ${item.name}`, delErr.message);
        }
      }
    } catch (err) {
      console.warn('[ST-WebDAV] 历史轮转检查失败:', err.message);
    }
  }
}
