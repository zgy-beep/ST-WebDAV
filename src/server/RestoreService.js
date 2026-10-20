import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import * as fflate from 'fflate';
import archiver from 'archiver';
import { CryptoHelper } from './CryptoHelper.js';

export class RestoreService {
  /**
   * @param {object} options
   * @param {import('./WebDavClient.js').WebDavClient} options.webDavClient
   * @param {import('./ConfigManager.js').ConfigManager} options.configManager
   */
  constructor({ webDavClient, configManager }) {
    this.webDavClient = webDavClient;
    this.configManager = configManager;
    this.isRestoring = false;
  }

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
   * 在执行覆写前，先为当前本地核心配置制作一份无损回滚安全快照
   * @param {string} userDir 
   * @returns {Promise<string>} 回滚快照文件路径
   */
  async createRollbackSnapshot(userDir) {
    const rollbackDir = path.join(userDir, 'backups', '_st_webdav_rollback');
    if (!fs.existsSync(rollbackDir)) {
      fs.mkdirSync(rollbackDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rollbackFile = path.join(rollbackDir, `pre_restore_${timestamp}.zip`);
    const output = fs.createWriteStream(rollbackFile);
    const archive = archiver('zip', { zlib: { level: 4 } });

    archive.pipe(output);

    // 重点保护 settings.json, secrets.json 与当前主要配置
    const criticalFiles = ['settings.json', 'secrets.json'];
    for (const f of criticalFiles) {
      const p = path.join(userDir, f);
      if (fs.existsSync(p)) archive.file(p, { name: f });
    }

    const criticalDirs = ['worlds', 'themes', 'instruct', 'context', 'QuickReplies'];
    for (const d of criticalDirs) {
      const dp = path.join(userDir, d);
      if (fs.existsSync(dp)) archive.directory(dp, d);
    }

    await archive.finalize();
    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
    });

    return rollbackFile;
  }

  /**
   * 从 WebDAV 下载并还原备份
   * @param {object} options
   * @param {string} options.remoteFileName 远端备份文件名
   * @param {string} [options.password] 解密密码 (若是加密备份)
   * @param {boolean} [options.createRollback=true] 是否在恢复前自动创建本地回滚快照
   * @param {object} [options.requestUser]
   */
  async restoreBackup(options = {}) {
    if (this.isRestoring) {
      throw new Error('另一个恢复任务正在进行中，请稍候');
    }

    const remoteFileName = options.remoteFileName;
    if (!remoteFileName) {
      throw new Error('未指定需要恢复的远端备份文件名');
    }

    const remoteDir = this.configManager.get('remoteDirectory') || 'SillyTavern_Backups';
    const remotePath = `${remoteDir}/${remoteFileName}`;
    const userDir = this.resolveUserDir(options.requestUser);
    const password = options.password || this.configManager.get('encryptionPassword') || '';

    this.isRestoring = true;

    try {
      console.log(`[ST-WebDAV] 开始从 WebDAV 下载恢复备份: ${remotePath}`);

      // 1. 下载备份数据为 Buffer
      const rawBuffer = await this.webDavClient.getBuffer(remotePath);

      // 2. 检查是否为加密备份
      const isEnc = remoteFileName.includes('.enc.') || CryptoHelper.isEncrypted(rawBuffer);
      let zipBuffer;

      if (isEnc) {
        if (!password) {
          throw new Error('此备份文件已被端到端加密，请输入解密密码后恢复');
        }

        console.log('[ST-WebDAV] 正在对备份数据进行流式解密...');
        const decryptStream = CryptoHelper.createDecryptStream(password);
        const passThrough = new PassThrough();

        const chunks = [];
        passThrough.on('data', chunk => chunks.push(chunk));

        // 流式解密
        const inputStream = new PassThrough();
        const pipelinePromise = pipeline(inputStream, decryptStream, passThrough);
        inputStream.end(rawBuffer);
        await pipelinePromise;

        zipBuffer = Buffer.concat(chunks);
      } else {
        zipBuffer = rawBuffer;
      }

      // 3. 在解包写入前，先制作本地安全回滚快照
      let rollbackPath = null;
      if (options.createRollback !== false) {
        try {
          rollbackPath = await this.createRollbackSnapshot(userDir);
          console.info(`[ST-WebDAV] 已自动创建恢复前回滚快照: ${rollbackPath}`);
        } catch (rbErr) {
          console.warn('[ST-WebDAV] 创建回滚快照失败，继续执行恢复:', rbErr.message);
        }
      }

      // 4. 使用 fflate 进行内存解压并进行路径安全校验 (Zip-Slip 终结)
      console.log('[ST-WebDAV] 正在校验并解压归档条目...');
      const unzipped = fflate.unzipSync(new Uint8Array(zipBuffer));

      const normalizedUserDir = path.resolve(userDir);
      const safePrefix = normalizedUserDir + path.sep;

      let restoredCount = 0;
      let manifestData = null;

      for (const [relativePath, fileData] of Object.entries(unzipped)) {
        if (relativePath === 'backup_manifest.json') {
          try {
            manifestData = JSON.parse(new TextDecoder().decode(fileData));
          } catch {}
          continue;
        }

        // 核心安全红线：Zip-Slip 路径逃逸检测
        const targetPath = path.resolve(userDir, relativePath);
        if (!targetPath.startsWith(safePrefix) && targetPath !== normalizedUserDir) {
          throw new Error(`安全拦截：检测到恶意路径穿越攻击 (Zip-Slip): ${relativePath}`);
        }

        // 如果是目录条目（以 / 结尾）
        if (relativePath.endsWith('/')) {
          if (!fs.existsSync(targetPath)) {
            fs.mkdirSync(targetPath, { recursive: true });
          }
          continue;
        }

        // 确保父目录存在
        const parentDir = path.dirname(targetPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        // 写入文件
        fs.writeFileSync(targetPath, Buffer.from(fileData));
        restoredCount++;
      }

      console.info(`[ST-WebDAV] 恢复成功，已还原 ${restoredCount} 个文件`);

      return {
        success: true,
        restoredCount,
        manifest: manifestData,
        rollbackPath,
        message: `成功还原 ${restoredCount} 个配置文件！建议刷新浏览器页面使新配置生效。`,
      };
    } catch (err) {
      console.error('[ST-WebDAV] 恢复备份失败:', err);
      throw err;
    } finally {
      this.isRestoring = false;
    }
  }
}
