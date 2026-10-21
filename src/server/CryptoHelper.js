import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { promisify } from 'node:util';

/**
 * 端到端备份加密助手 (AES-256-GCM + PBKDF2-HMAC-SHA256)
 * ------------------------------------------------------------------
 * 密文格式 v02（当前写入格式）：
 *   [8B MAGIC 'STWBDV02'][4B uint32BE 迭代次数][16B SALT][12B IV][密文...][16B GCM TAG]
 * 密文格式 v01（历史格式，仅读取兼容）：
 *   [8B MAGIC 'STWBDV01'][16B SALT][12B IV][密文...][16B GCM TAG]
 *
 * v02 变更要点：
 *   1. 头部携带迭代次数，未来可平滑调整 KDF 强度而无需再改格式；
 *   2. PBKDF2 迭代提升至 210,000（对齐 OWASP 对 HMAC-SHA256 的建议基线）；
 *   3. 密钥派生改用异步 API（deriveKeyAsync），避免阻塞 Node 事件循环。
 */

const MAGIC_V01 = Buffer.from('STWBDV01'); // 8 bytes
const MAGIC_V02 = Buffer.from('STWBDV02'); // 8 bytes
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/** v01 历史格式的固定迭代次数 */
const PBKDF2_ITERATIONS_V01 = 100000;
/** v02 当前格式的默认迭代次数 */
const PBKDF2_ITERATIONS_V02 = 210000;

/**
 * 读取头部声明的迭代次数时的合法区间
 * 上下界用于防御恶意密文把迭代次数拉高到 CPU 消耗型攻击（DoS），
 * 或拉低到削弱 KDF 强度。
 * 上限定为 1,000,000：实测约 330ms CPU（libuv 线程池默认 4 线程），
 * 更高会打满线程池导致全进程回调停摆。
 */
const MIN_PBKDF2_ITERATIONS = 100000;
const MAX_PBKDF2_ITERATIONS = 1000000;

const pbkdf2Async = promisify(crypto.pbkdf2);

export class CryptoHelper {
  /**
   * 基于密码和盐派生 256 位密钥 (同步版本)
   * @param {string} password
   * @param {Buffer} salt
   * @param {number} [iterations]
   * @returns {Buffer}
   */
  static deriveKey(password, salt, iterations = PBKDF2_ITERATIONS_V02) {
    return crypto.pbkdf2Sync(String(password || ''), salt, iterations, KEY_LEN, 'sha256');
  }

  /**
   * 基于密码和盐异步派生密钥 (避免阻塞主事件循环)
   * @param {string} password
   * @param {Buffer} salt
   * @param {number} [iterations]
   * @returns {Promise<Buffer>}
   */
  static async deriveKeyAsync(password, salt, iterations = PBKDF2_ITERATIONS_V02) {
    return pbkdf2Async(String(password || ''), salt, iterations, KEY_LEN, 'sha256');
  }

  /**
   * 创建流式加密 Transform
   * 输出格式 v02：[MAGIC][iterations][SALT][IV][密文][TAG]
   *
   * 注意：派生密钥在流内部异步完成，因此本方法返回的 Transform 在
   * 首次写入时才会真正开始 KDF 计算；调用方无需 await。
   *
   * @param {string} password
   * @returns {Transform}
   */
  static createEncryptStream(password) {
    if (!password) {
      throw new Error('创建加密流失败：必须提供非空加密口令');
    }

    const salt = crypto.randomBytes(SALT_LEN);
    const iv = crypto.randomBytes(IV_LEN);

    let cipher = null;
    let headerWritten = false;

    /**
     * 写出 v02 头部
     * @param {Transform} stream
     */
    const writeHeader = (stream) => {
      if (headerWritten) return;
      const iterBuf = Buffer.alloc(4);
      iterBuf.writeUInt32BE(PBKDF2_ITERATIONS_V02, 0);
      stream.push(Buffer.concat([MAGIC_V02, iterBuf, salt, iv]));
      headerWritten = true;
    };

    const stream = new Transform({
      transform(chunk, encoding, callback) {
        const finish = (err) => {
          if (err) return callback(err);
          try {
            writeHeader(this);
            const encrypted = cipher.update(chunk);
            if (encrypted.length) this.push(encrypted);
            callback();
          } catch (e) {
            callback(e);
          }
        };

        if (cipher) return finish();

        // 首次写入：异步派生密钥，避免 pbkdf2Sync 阻塞事件循环
        CryptoHelper.deriveKeyAsync(password, salt, PBKDF2_ITERATIONS_V02)
          .then(key => {
            cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
            finish();
          })
          .catch(err => callback(err));
      },
      flush(callback) {
        try {
          if (!cipher) {
            // 空内容也需要先派生密钥才能拿到 GCM Tag
            return CryptoHelper.deriveKeyAsync(password, salt, PBKDF2_ITERATIONS_V02)
              .then(key => {
                cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
                writeHeader(this);
                cipher.final();
                this.push(cipher.getAuthTag());
                callback();
              })
              .catch(err => callback(err));
          }
          writeHeader(this);
          cipher.final();
          this.push(cipher.getAuthTag()); // 末尾写入 GCM Auth Tag
          callback();
        } catch (err) {
          callback(err);
        }
      },
    });

    return stream;
  }

  /**
   * 创建流式解密 Transform（自动兼容 v01 与 v02 密文格式）
   *
   * ⚠️ 安全红线：本流在 GCM Auth Tag 校验通过前就会 push 明文。
   *    当前插件用法是「全量收集后再解压」，是安全的；
   *    若要改为「边解密边写盘」，必须在写盘前先验证 Auth Tag，
   *    否则会引入 unauthenticated plaintext 释放漏洞。
   *
   * @param {string} password
   * @returns {Transform}
   */
  static createDecryptStream(password) {
    if (!password) {
      throw new Error('创建解密流失败：必须提供非空解密口令');
    }

    let headerBuffer = Buffer.alloc(0);
    let decipher = null;
    let trailingBuffer = Buffer.alloc(0);
    let headerParsed = false;
    let pendingChunk = null;

    /**
     * 解析头部并派生密钥
     * @returns {Promise<void>}
     */
    const parseHeader = async () => {
      const magic = headerBuffer.subarray(0, 8);
      const isV01 = magic.equals(MAGIC_V01);
      const isV02 = magic.equals(MAGIC_V02);

      if (!isV01 && !isV02) {
        throw new Error('无效的加密备份文件：Magic Header 不匹配');
      }

      let iterations;
      let salt;
      let iv;
      let headerSize;

      if (isV02) {
        if (headerBuffer.length < 40) {
          throw new Error('加密文件过短或损坏，未能读取完整头信息');
        }
        iterations = headerBuffer.readUInt32BE(8);
        if (iterations < MIN_PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS) {
          throw new Error(`加密文件头部声明的迭代次数异常 (${iterations})，拒绝处理`);
        }
        salt = headerBuffer.subarray(12, 12 + SALT_LEN);
        iv = headerBuffer.subarray(12 + SALT_LEN, 12 + SALT_LEN + IV_LEN);
        headerSize = 12 + SALT_LEN + IV_LEN;
      } else {
        iterations = PBKDF2_ITERATIONS_V01;
        if (headerBuffer.length < 36) {
          throw new Error('加密文件过短或损坏，未能读取完整头信息');
        }
        salt = headerBuffer.subarray(8, 8 + SALT_LEN);
        iv = headerBuffer.subarray(8 + SALT_LEN, 8 + SALT_LEN + IV_LEN);
        headerSize = 8 + SALT_LEN + IV_LEN;
      }

      const key = await CryptoHelper.deriveKeyAsync(password, salt, iterations);
      decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      headerParsed = true;

      const rest = headerBuffer.subarray(headerSize);
      headerBuffer = null;
      pendingChunk = rest.length > 0 ? rest : null;
    };

    const stream = new Transform({
      transform(chunk, encoding, callback) {
        const proceed = () => {
          try {
            // 累积流式解密，同时保留末尾 16 字节作为 GCM Auth Tag
            trailingBuffer = Buffer.concat([trailingBuffer, chunk]);
            if (trailingBuffer.length > TAG_LEN) {
              const decryptableChunk = trailingBuffer.subarray(0, trailingBuffer.length - TAG_LEN);
              // 复制保留后 16 字节，防止大切片内存泄漏
              trailingBuffer = Buffer.from(trailingBuffer.subarray(trailingBuffer.length - TAG_LEN));
              const decrypted = decipher.update(decryptableChunk);
              if (decrypted.length) {
                this.push(decrypted);
              }
            }
            callback();
          } catch (err) {
            callback(err);
          }
        };

        if (headerParsed) return proceed();

        headerBuffer = Buffer.concat([headerBuffer, chunk]);

        // 先判断 magic 以确定头部总长
        if (headerBuffer.length >= 8) {
          const magic = headerBuffer.subarray(0, 8);
          const isV01 = magic.equals(MAGIC_V01);
          const isV02 = magic.equals(MAGIC_V02);
          if (!isV01 && !isV02) {
            return callback(new Error('无效的加密备份文件：Magic Header 不匹配'));
          }
          const headerSize = isV02 ? 40 : 36;
          if (headerBuffer.length < headerSize) {
            return callback(); // 数据不够，继续等待
          }
        } else {
          return callback(); // magic 尚未收全
        }

        parseHeader()
          .then(() => {
            const rest = pendingChunk;
            pendingChunk = null;
            if (rest) {
              trailingBuffer = Buffer.concat([trailingBuffer, rest]);
              if (trailingBuffer.length > TAG_LEN) {
                const decryptableChunk = trailingBuffer.subarray(0, trailingBuffer.length - TAG_LEN);
                trailingBuffer = Buffer.from(trailingBuffer.subarray(trailingBuffer.length - TAG_LEN));
                const decrypted = decipher.update(decryptableChunk);
                if (decrypted.length) this.push(decrypted);
              }
            }
            callback();
          })
          .catch(err => callback(err));
      },
      flush(callback) {
        if (!decipher) {
          return callback(new Error('加密文件过短或损坏，未能读取有效头信息'));
        }
        if (trailingBuffer.length !== TAG_LEN) {
          return callback(new Error('加密文件损坏，缺少 GCM 认证标签 (Auth Tag)'));
        }
        try {
          decipher.setAuthTag(trailingBuffer);
          const finalData = decipher.final();
          if (finalData.length) {
            this.push(finalData);
          }
          callback();
        } catch (err) {
          callback(new Error('解密认证失败：密码错误或备份数据已被篡改 (' + err.message + ')'));
        }
      },
    });

    return stream;
  }

  /**
   * 判断一个 Buffer 是否包含加密头部 (兼容 v01 / v02)
   * @param {Buffer} buffer
   * @returns {boolean}
   */
  static isEncrypted(buffer) {
    if (!buffer || buffer.length < MAGIC_V01.length) return false;
    const magic = buffer.subarray(0, MAGIC_V01.length);
    return magic.equals(MAGIC_V01) || magic.equals(MAGIC_V02);
  }
}
