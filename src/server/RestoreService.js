import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as fflate from 'fflate';
import archiver from 'archiver';
import { CryptoHelper } from './CryptoHelper.js';
import { resolveUserDir, getUserInfo, resolveRemoteDirectory } from './UserHelper.js';
import { JobLock } from './JobLock.js';
import { JobBusyError } from './JobBusyError.js';
import { sanitizeBackupFileName } from './PathGuard.js';
import { LOCAL_CONFIG_FILE } from './Constants.js';

// 安全配额常量 (Zip-Bomb 防御门禁)
export const MAX_TOTAL_EXTRACTED_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
export const MAX_EXTRACTED_FILES_COUNT = 50000;
export const MAX_SINGLE_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB

// Windows 系统保留设备名 (CON, PRN, AUX, NUL, COM1-9, LPT1-9, CONIN$, CONOUT$)
const WIN_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\..*)?$/i;

/** 回滚快照保留份数（超出自动清理最旧的） */
const ROLLBACK_SNAPSHOT_KEEP = 5;

/**
 * 校验 zip 条目的解压配额
 * ------------------------------------------------------------------
 * 必须在**实际解压之前**调用。若放在解压之后才检查，一个 50MB 的恶意包
 * 早已在内存里膨胀成 10GB，进程在到达检查点前就已 OOM —— 形同虚设。
 *
 * @param {{ name: string, originalSize: number, size?: number, compression?: number }[]} fileInfos fflate 的 UnzipFileInfo 列表
 * @param {object} [options]
 * @param {number} [options.maxSingleBytes]
 * @param {number} [options.maxTotalBytes]
 * @param {number} [options.maxFileCount]
 * @param {number} [options.accumulatedBytes] 已累计的字节数（增量模式）
 * @param {number} [options.accumulatedCount] 已累计的文件数（增量模式）
 * @returns {{ totalBytes: number, fileCount: number }}
 */
export function checkZipQuotas(fileInfos, options = {}) {
  const maxSingle = options.maxSingleBytes ?? MAX_SINGLE_FILE_BYTES;
  const maxTotal = options.maxTotalBytes ?? MAX_TOTAL_EXTRACTED_BYTES;
  const maxCount = options.maxFileCount ?? MAX_EXTRACTED_FILES_COUNT;

  let totalBytes = Number(options.accumulatedBytes) || 0;
  let fileCount = Number(options.accumulatedCount) || 0;

  for (const info of fileInfos) {
    fileCount++;
    if (fileCount > maxCount) {
      throw new Error(`安全拦截：压缩包内文件总数超过安全上限 (${maxCount})，疑似 Zip-Bomb 拒绝服务攻击`);
    }

    // 尺寸取值说明（fflate 的 UnzipFileInfo）：
    //   size         = 压缩后占用字节数
    //   originalSize = 中央目录声明的解压后字节数
    //   compression  = 0 表示 STORED（不压缩）
    //
    // ⚠️ 对 DEFLATE 条目，fflate 用 `new u8(originalSize)` 预分配输出缓冲，
    //    实际解压量被 originalSize 硬性截断，故用 originalSize 计费是准确的。
    // ⚠️ 但对 STORED 条目，fflate 直接按压缩尺寸切片返回原始数据，
    //    **不受 originalSize 约束** —— 攻击者可在中央目录谎报极小的
    //    originalSize 而实际携带大量数据，此时必须改用 size 计费。
    const declaredSize = Number(info?.originalSize ?? 0) || 0;
    const storedSize = Number(info?.size ?? 0) || 0;
    const isStored = Number(info?.compression) === 0;
    const effectiveSize = isStored ? Math.max(declaredSize, storedSize) : declaredSize;

    if (effectiveSize > maxSingle) {
      throw new Error(`安全拦截：单个解压文件体积过大 (${(effectiveSize / (1024 * 1024)).toFixed(1)}MB)，疑似恶意膨胀载荷`);
    }

    totalBytes += effectiveSize;
    if (totalBytes > maxTotal) {
      throw new Error(`安全拦截：解压总体积超过安全上限 (${(maxTotal / (1024 * 1024 * 1024)).toFixed(1)}GB)，疑似 Zip-Bomb`);
    }
  }

  return { totalBytes, fileCount };
}

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

    // archiver 是流对象，必须监听 error，否则异常会变成 uncaughtException 崩掉主进程
    archive.on('error', (err) => {
      console.error('[ST-WebDAV] 回滚快照打包失败:', err.message);
      output.destroy(err);
    });
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

    await this.pruneRollbackSnapshots(rollbackDir);

    return rollbackFile;
  }

  /**
   * 清理过期的回滚快照，只保留最新若干份
   * @param {string} rollbackDir
   */
  async pruneRollbackSnapshots(rollbackDir) {
    try {
      const entries = await fs.promises.readdir(rollbackDir);
      const snapshots = entries.filter(name => name.startsWith('pre_restore_') && name.endsWith('.zip'));
      if (snapshots.length <= ROLLBACK_SNAPSHOT_KEEP) return;

      // 按文件名内嵌的时间戳排序（ISO 变体，字典序即时间序）
      snapshots.sort();
      const stale = snapshots.slice(0, snapshots.length - ROLLBACK_SNAPSHOT_KEEP);
      for (const name of stale) {
        try {
          await fs.promises.unlink(path.join(rollbackDir, name));
        } catch {}
      }
    } catch {}
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
   * @param {string} [options.remoteDirOverride] 指定远端目录（共享区还原时使用）
   */
  async restoreBackup(options = {}) {
    const userInfo = getUserInfo(options.requestUser);
    const handle = userInfo.handle || 'default-user';

    if (this.activeRestores.has(handle)) {
      throw new JobBusyError('另一个恢复任务正在进行中，请稍候');
    }

    const cfg = options.configManager || this.configManager;
    const client = options.webDavClient || this.webDavClient;

    if (!client) {
      throw new Error('WebDAV 客户端未初始化，无法执行还原');
    }

    // 备份与还原共用同一把 per-user 互斥锁
    // ⚠️ acquire 之后的**所有**代码都必须被 try/finally 覆盖：
    //    若在 try 之前抛错（如 client.updateConfig 遇到非法 URL），
    //    锁会永久残留，该账号的备份与还原将被永久锁死。
    const releaseLock = JobLock.acquire(handle, 'restore');

    try {
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

      // 纵深防御：即使调用方漏做净化，此处再拦一道
      let remoteFileName;
      try {
        remoteFileName = sanitizeBackupFileName(options.remoteFileName);
      } catch (err) {
        throw err;
      }

      const userDir = userInfo.userDir;
      const isolate = cfg.get('isolateUserDirectory') !== false;
      const remoteDir = options.remoteDirOverride
        || resolveRemoteDirectory(cfg.get('remoteDirectory') || 'SillyTavern_Backups', options.requestUser, isolate);
      const remotePath = `${remoteDir}/${remoteFileName}`;
      const password = options.password || cfg.get('encryptionPassword') || '';

      this.activeRestores.add(handle);

      console.log(`[ST-WebDAV] 开始从 WebDAV 下载恢复备份: ${remotePath}`);

      // 1. 获取备份数据
      const rawBuffer = await client.getBuffer(remotePath);

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

        const inputStream = new PassThrough();
        // pipeline 会在所有环节完成后才 resolve —— 必须等待它，
        // 否则会在数据尚未流完时就 Buffer.concat，得到被截断的密文。
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

      // 4. 两阶段还原
      //    阶段一：遍历**全部**条目完成路径安全校验与配额预审（不写盘）
      //    阶段二：仅在校验全部通过后才统一写入
      //    这样任何一条目触发安全拦截时，磁盘上不会留下半还原状态。
      console.log('[ST-WebDAV] 正在校验并解压归档条目...');

      const normalizedUserDir = path.resolve(userDir);
      const safePrefix = normalizedUserDir + path.sep;

      /** @type {Map<string, { targetPath: string, isDirectory: boolean }>} */
      const validatedEntries = new Map();
      // 增量配额计数器：每次只处理当前条目，避免每条都重扫全量数组
      // （后者在 5 万条目下会产生 O(n²) 的 CPU 消耗，一次恶意还原可占用数秒 CPU）
      let quotaTotalBytes = 0;
      let quotaFileCount = 0;

      const isWithinUserDir = (targetPath) => {
        return process.platform === 'win32'
          ? (targetPath.toLowerCase().startsWith(safePrefix.toLowerCase()) || targetPath.toLowerCase() === normalizedUserDir.toLowerCase())
          : (targetPath.startsWith(safePrefix) || targetPath === normalizedUserDir);
      };

      /**
       * 校验单个归档条目的路径安全性
       * @param {string} relativePath
       * @returns {{ targetPath: string, isDirectory: boolean } | null} null 表示应跳过该条目
       */
      const validateEntry = (relativePath) => {
        // 基础危险字符校验 (防 NULL 字节)
        if (relativePath.includes('\0')) {
          throw new Error(`安全拦截：检测到非法字符路径: ${relativePath}`);
        }

        // 统一格式化相对路径
        const normalizedRel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
        const segments = normalizedRel.split('/');

        for (const seg of segments) {
          if (!seg || seg === '.') continue;

          // Windows 归一化：Win32 会剥离路径段**末尾**的点和空格。
          //   ".. "  → ".."        （等价于父目录穿越）
          //   "CON " → "CON"      （等价于设备保留名）
          //   "foo. " → "foo"
          // 注意：单个路径段内部也可能含 ".."（如 ".. /evil.txt"，
          //       整段在 Win32 下剥离尾部空格后即为 ".. /evil.txt"，
          //       但其中的 ".." 仍会被系统按目录分隔语义处理），
          //       因此这里额外做一次「去空格后再分段」的双重检查。
          const norm = seg.replace(/[. ]+$/, '');

          // 去空格后若整段变成 "." 或 ".." → 视为穿越
          if (norm === '..' || norm === '.') {
            throw new Error(`安全拦截：检测到恶意路径穿越攻击 (Zip-Slip): ${relativePath}`);
          }

          // Win32 剥离空格后，段内可能仍含 ".." 前缀（如 ".. /x"）
          const spaceStripped = seg.replace(/\s+/g, '');
          if (spaceStripped === '..' || spaceStripped.startsWith('../') || spaceStripped.startsWith('..\\')) {
            throw new Error(`安全拦截：检测到恶意路径穿越攻击 (Zip-Slip): ${relativePath}`);
          }

          if (WIN_RESERVED_NAMES.test(norm)) {
            throw new Error(`安全拦截：检测到 Windows 系统保留设备名: ${seg}`);
          }
          // 拒绝以点或空格结尾的畸形段名（Win32 会静默剥离）
          if (/[. ]$/.test(seg)) {
            throw new Error(`安全拦截：检测到以点或空格结尾的非法路径段: ${seg}`);
          }
          // Windows 上冒号无合法用途：拒绝冒号可同时阻断 NTFS 备用数据流
          // (如 "evil.txt:hidden" / "::$DATA") 注入
          if (process.platform === 'win32' && seg.includes(':')) {
            throw new Error(`安全拦截：检测到非法字符路径 (冒号): ${relativePath}`);
          }
        }

        // 过滤跳过 .git 仓库内部对象 (pack, idx, objects)，避免覆盖只读权限文件
        if (segments.includes('.git')) {
          return null;
        }

        // 核心安全红线：Zip-Slip 路径逃逸检测 (Windows 下大小写不敏感规范化对比)
        const targetPath = path.resolve(userDir, normalizedRel);
        if (!isWithinUserDir(targetPath)) {
          throw new Error(`安全拦截：检测到恶意路径穿越攻击 (Zip-Slip): ${relativePath}`);
        }

        return { targetPath, isDirectory: relativePath.endsWith('/') };
      };

      const unzipped = fflate.unzipSync(new Uint8Array(zipBuffer), {
        filter: (fileInfo) => {
          // —— 配额预审：必须在解压发生之前拦截 ——
          // 增量累加：把当前条目与已累计值一起交给校验函数
          const quota = checkZipQuotas([fileInfo], {
            accumulatedBytes: quotaTotalBytes,
            accumulatedCount: quotaFileCount,
          });
          quotaTotalBytes = quota.totalBytes;
          quotaFileCount = quota.fileCount;

          const plan = validateEntry(fileInfo.name);
          if (!plan) return false; // 跳过 .git 等条目

          validatedEntries.set(fileInfo.name, plan);
          return true;
        },
      });

      // 阶段二：统一写入
      let restoredCount = 0;
      let manifestData = null;
      let skippedConfig = false;

      for (const [relativePath, fileData] of Object.entries(unzipped)) {
        // 防御旧备份包：跳过本插件自身的配置文件（内含凭据）
        // ⚠️ 必须大小写不敏感：Windows 文件系统不区分大小写，
        //    `ST_WEBDAV_CONFIG.JSON` 会覆写同一份文件，进而把攻击者的
        //    WebDAV 地址注入受害者配置，导致后续备份全部外泄。
        const baseName = path.basename(relativePath).toLowerCase();
        if (baseName === LOCAL_CONFIG_FILE.toLowerCase()) {
          skippedConfig = true;
          continue;
        }

        if (relativePath === 'backup_manifest.json') {
          try {
            manifestData = JSON.parse(new TextDecoder().decode(fileData));
          } catch {}
          continue;
        }

        const plan = validatedEntries.get(relativePath);
        if (!plan) continue; // 未通过校验的条目不应存在，保险起见跳过
        const { targetPath, isDirectory } = plan;

        // 写盘前的最后一道防线：目标路径绝不能命中本插件的配置文件
        // （覆盖大小写、路径分隔符等一切变体）
        if (!isDirectory && path.basename(targetPath).toLowerCase() === LOCAL_CONFIG_FILE.toLowerCase()) {
          skippedConfig = true;
          continue;
        }

        // 如果是目录条目（以 / 结尾）
        if (isDirectory) {
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

      if (skippedConfig) {
        console.info(`[ST-WebDAV] 已跳过归档中的本地配置文件 (${LOCAL_CONFIG_FILE})，以保护当前账号凭据`);
      }

      console.info(`[ST-WebDAV] 恢复成功，已还原 ${restoredCount} 个文件`);

      // 还原可能覆盖了磁盘上的配置文件，刷新内存缓存使其生效
      if (typeof cfg.refresh === 'function') {
        try {
          if (cfg.refresh()) {
            console.info('[ST-WebDAV] 已刷新本地配置缓存以应用还原后的设置');
          }
        } catch (refreshErr) {
          console.warn('[ST-WebDAV] 刷新配置缓存失败:', refreshErr.message);
        }
      }

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
      releaseLock();
    }
  }
}
