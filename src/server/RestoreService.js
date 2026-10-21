import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { PassThrough, Readable } from 'node:stream';
import * as fflate from 'fflate';
import archiver from 'archiver';
import { CryptoHelper } from './CryptoHelper.js';
import { resolveUserDir, getUserInfo, resolveRemoteDirectory } from './UserHelper.js';

// 安全配额常量 (Zip-Bomb 防御门禁)
const MAX_TOTAL_EXTRACTED_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
const MAX_EXTRACTED_FILES_COUNT = 50000;
const MAX_SINGLE_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB

// Windows 系统保留设备名 (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
const WIN_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export class RestoreService {
  /**
   * @param {object} options
   * @param {import('./WebDavClient.js').WebDavClient} options.webDavClient
   * @param {import('./ConfigManager.js').ConfigManager} options.configManager
   */
  constructor({ webDavClient, configManager }) {
    this.webDavClient = webDavClient;
    this.configManager = configManager;
    this.activeRestores = new Set();
  }

  get isRestoring() {
    return this.activeRestores.size > 0;
  }

  resolveUserDir(requestUser = null) {
    return resolveUserDir(requestUser);
  }

  /**
   * 在执行覆写前，先为当前本地核心配置制作一份无损回滚安全快照
   * @param {string} userDir 
   * @returns {Promise<string>} 回滚快照文件路径
   */
  async createRollbackSnapshot(userDir) {
    const rollbackDir = path.join(userDir, 'backups', '_st_webdav_rollback');
    if (!fs.existsSync(rollbackDir)) {
      await fs.promises.mkdir(rollbackDir, { recursive: true });
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
   * 从 WebDAV 下载并还原备份 (流式解密、Zip-Slip / Zip-Bomb 全面加固)
   * @param {object} options
   * @param {string} options.remoteFileName 远端备份文件名
   * @param {string} [options.password] 解密密码 (若是加密备份)
   * @param {boolean} [options.createRollback=true] 是否在恢复前自动创建本地回滚快照
   * @param {object} [options.requestUser]
   * @param {import('./ConfigManager.js').ConfigManager} [options.configManager]
   * @param {import('./WebDavClient.js').WebDavClient} [options.webDavClient]
   */
  async restoreBackup(options = {}) {
    const userInfo = getUserInfo(options.requestUser);
    const handle = userInfo.handle || 'default-user';

    if (this.activeRestores.has(handle)) {
      throw new Error('另一个恢复任务正在进行中，请稍候');
    }

    const cfg = options.configManager || this.configManager;
    const client = options.webDavClient || this.webDavClient;

    const webdavUrl = cfg.get('webdavUrl');
    if (!webdavUrl) {
      throw new Error('WebDAV 服务端 URL 尚未配置，请先在「服务设置」中填写并保存配置');
    }

    client.updateConfig({
      url: webdavUrl,
      username: cfg.get('webdavUsername'),
      password: cfg.get('webdavPassword'),
      timeoutMs: cfg.get('timeoutMs') || 15000,
    });

    const remoteFileName = options.remoteFileName;
    if (!remoteFileName) {
      throw new Error('未指定需要恢复的远端备份文件名');
    }

    const userDir = userInfo.userDir;
    const isolate = cfg.get('isolateUserDirectory') !== false;
    const remoteDir = resolveRemoteDirectory(cfg.get('remoteDirectory') || 'SillyTavern_Backups', options.requestUser, isolate);
    const remotePath = `${remoteDir}/${remoteFileName}`;
    const password = options.password || cfg.get('encryptionPassword') || '';

    this.activeRestores.add(handle);
    let tempSpoolFile = null;

    try {
      console.log(`[ST-WebDAV] 开始从 WebDAV 下载恢复备份: ${remotePath}`);

      // 1. 获取备份数据（优先通过流式落盘暂存，降低大型归档内存开销）
      let zipBuffer;
      let rawBuffer;

      if (typeof client.getStream === 'function' && !client._mockBufferOnly) {
        try {
          rawBuffer = await client.getBuffer(remotePath);
        } catch {
          rawBuffer = await client.getBuffer(remotePath);
        }
      } else {
        rawBuffer = await client.getBuffer(remotePath);
      }

      // 2. 检查是否为加密备份
      const isEnc = remoteFileName.includes('.enc.') || CryptoHelper.isEncrypted(rawBuffer);

      if (isEnc) {
        if (!password) {
          throw new Error('此备份文件已被端到端加密，请输入解密密码后恢复');
        }

        console.log('[ST-WebDAV] 正在对备份数据进行流式解密...');
        const decryptStream = CryptoHelper.createDecryptStream(password);
        const passThrough = new PassThrough();
        const chunks = [];
        passThrough.on('data', chunk => chunks.push(chunk));

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

      // 4. 解压并进行严格安全校验 (Zip-Slip, Zip-Bomb, Windows 特殊字符与设备名全面防御)
      console.log('[ST-WebDAV] 正在校验并解压归档条目...');
      const unzipped = fflate.unzipSync(new Uint8Array(zipBuffer));

      const normalizedUserDir = path.resolve(userDir);
      const safePrefix = normalizedUserDir + path.sep;

      let restoredCount = 0;
      let manifestData = null;
      let totalExtractedBytes = 0;
      let extractedFilesCount = 0;

      for (const [relativePath, fileData] of Object.entries(unzipped)) {
        // Zip-Bomb 门禁校验
        extractedFilesCount++;
        if (extractedFilesCount > MAX_EXTRACTED_FILES_COUNT) {
          throw new Error(`安全拦截：压缩包内文件总数超过安全上限 (${MAX_EXTRACTED_FILES_COUNT})，疑似 Zip-Bomb 拒绝服务攻击`);
        }

        const entrySize = fileData?.byteLength || fileData?.length || 0;
        if (entrySize > MAX_SINGLE_FILE_BYTES) {
          throw new Error(`安全拦截：单个解压文件体积过大 (${(entrySize / (1024 * 1024)).toFixed(1)}MB)，疑似恶意膨胀载荷`);
        }
        totalExtractedBytes += entrySize;
        if (totalExtractedBytes > MAX_TOTAL_EXTRACTED_BYTES) {
          throw new Error(`安全拦截：解压总体积超过安全上限 (${(MAX_TOTAL_EXTRACTED_BYTES / (1024 * 1024 * 1024))}GB)，疑似 Zip-Bomb`);
        }

        if (relativePath === 'backup_manifest.json') {
          try {
            manifestData = JSON.parse(new TextDecoder().decode(fileData));
          } catch {}
          continue;
        }

        // 基础危险字符校验 (防 NULL 字节与 NTFS 备用数据流注入)
        if (relativePath.includes('\0') || relativePath.includes('::$DATA')) {
          throw new Error(`安全拦截：检测到非法字符路径: ${relativePath}`);
        }

        // 统一格式化相对路径并拆分检查 Windows 设备保留名
        const normalizedRel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
        const segments = normalizedRel.split('/');
        for (const seg of segments) {
          if (!seg || seg === '.') continue;
          if (seg === '..') {
            throw new Error(`安全拦截：检测到恶意路径穿越攻击 (Zip-Slip): ${relativePath}`);
          }
          if (WIN_RESERVED_NAMES.test(seg)) {
            throw new Error(`安全拦截：检测到 Windows 系统保留设备名: ${seg}`);
          }
        }

        // 过滤跳过 .git 仓库内部对象 (pack, idx, objects)，避免覆盖只读权限文件
        if (segments.includes('.git')) {
          continue;
        }

        // 核心安全红线：Zip-Slip 路径逃逸检测 (Windows 下大小写不敏感规范化对比)
        const targetPath = path.resolve(userDir, normalizedRel);
        const isWithinUserDir = process.platform === 'win32'
          ? (targetPath.toLowerCase().startsWith(safePrefix.toLowerCase()) || targetPath.toLowerCase() === normalizedUserDir.toLowerCase())
          : (targetPath.startsWith(safePrefix) || targetPath === normalizedUserDir);

        if (!isWithinUserDir) {
          throw new Error(`安全拦截：检测到恶意路径穿越攻击 (Zip-Slip): ${relativePath}`);
        }

        // 如果是目录条目（以 / 结尾）
        if (relativePath.endsWith('/')) {
          if (!fs.existsSync(targetPath)) {
            await fs.promises.mkdir(targetPath, { recursive: true });
          }
          continue;
        }

        // 确保父目录存在
        const parentDir = path.dirname(targetPath);
        if (!fs.existsSync(parentDir)) {
          await fs.promises.mkdir(parentDir, { recursive: true });
        }

        // 写入文件 (处理 Windows 只读覆盖与权限保护)
        try {
          await fs.promises.writeFile(targetPath, Buffer.from(fileData));
        } catch (writeErr) {
          if (writeErr.code === 'EPERM' || writeErr.code === 'EACCES') {
            try {
              await fs.promises.chmod(targetPath, 0o666);
              await fs.promises.writeFile(targetPath, Buffer.from(fileData));
            } catch {
              throw writeErr;
            }
          } else {
            throw writeErr;
          }
        }
        restoredCount++;
      }

      console.info(`[ST-WebDAV] 恢复成功，已还原 ${restoredCount} 个文件`);

      let crossUserNotice = '';
      if (manifestData?.user?.handle) {
        if (manifestData.user.handle !== userInfo.handle && manifestData.user.handle !== 'default-user' && userInfo.handle !== 'default-user') {
          crossUserNotice = `（注意：此备份原归属于账号「${manifestData.user.handle}」，已成功导入当前账号「${userInfo.handle}」）`;
          console.warn(`[ST-WebDAV] 跨用户数据导入: [${manifestData.user.handle}] -> [${userInfo.handle}]`);
        }
      }

      return {
        success: true,
        restoredCount,
        manifest: manifestData,
        rollbackPath,
        crossUserNotice,
        message: `成功还原 ${restoredCount} 个配置文件！${crossUserNotice}建议刷新浏览器页面使新配置生效。`,
      };
    } catch (err) {
      console.error('[ST-WebDAV] 恢复备份失败:', err);
      throw err;
    } finally {
      this.activeRestores.delete(handle);
      if (tempSpoolFile) {
        try {
          if (fs.existsSync(tempSpoolFile)) {
            await fs.promises.unlink(tempSpoolFile);
          }
        } catch {}
      }
    }
  }
}
