import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { promisify } from 'node:util';

const MAGIC_HEADER = Buffer.from('STWBDV01'); // 8 bytes magic marker
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const PBKDF2_ITERATIONS = 100000;
const KEY_LEN = 32;

const pbkdf2Async = promisify(crypto.pbkdf2);

/**
 * 端到端备份加密助手 (AES-256-GCM + PBKDF2-HMAC-SHA256)
 */
export class CryptoHelper {
  /**
   * 基于密码和盐派生 256 位密钥 (同步版本，兼顾单元测试与向后兼容)
   * @param {string} password 
   * @param {Buffer} salt 
   * @returns {Buffer}
   */
  static deriveKey(password, salt) {
    return crypto.pbkdf2Sync(String(password || ''), salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
  }

  /**
   * 基于密码和盐异步派生密钥 (避免阻塞主事件循环)
   * @param {string} password 
   * @param {Buffer} salt 
   * @returns {Promise<Buffer>}
   */
  static async deriveKeyAsync(password, salt) {
    return pbkdf2Async(String(password || ''), salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
  }

  /**
   * 创建流式加密 Transform
   * 输出格式：[8B MAGIC] + [16B SALT] + [12B IV] + [密文数据...] + [16B GCM TAG (末尾)]
   * @param {string} password
   * @returns {Transform}
   */
  static createEncryptStream(password) {
    if (!password) {
      throw new Error('创建加密流失败：必须提供非空加密口令');
    }

    const salt = crypto.randomBytes(SALT_LEN);
    const iv = crypto.randomBytes(IV_LEN);
    const key = CryptoHelper.deriveKey(password, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let headerWritten = false;

    const stream = new Transform({
      transform(chunk, encoding, callback) {
        if (!headerWritten) {
          // 在最开头写入头部信息：MAGIC + SALT + IV
          this.push(Buffer.concat([MAGIC_HEADER, salt, iv]));
          headerWritten = true;
        }
        const encrypted = cipher.update(chunk);
        if (encrypted.length) {
          this.push(encrypted);
        }
        callback();
      },
      flush(callback) {
        if (!headerWritten) {
          this.push(Buffer.concat([MAGIC_HEADER, salt, iv]));
          headerWritten = true;
        }
        cipher.final();
        const tag = cipher.getAuthTag();
        this.push(tag); // 末尾写入 GCM Auth Tag
        callback();
      }
    });

    return stream;
  }

  /**
   * 创建流式解密 Transform
   * @param {string} password
   * @returns {Transform}
   */
  static createDecryptStream(password) {
    if (!password) {
      throw new Error('创建解密流失败：必须提供非空解密口令');
    }

    let headerBuffer = Buffer.alloc(0);
    const headerSize = MAGIC_HEADER.length + SALT_LEN + IV_LEN;
    let decipher = null;
    let trailingBuffer = Buffer.alloc(0);

    return new Transform({
      transform(chunk, encoding, callback) {
        try {
          let data = chunk;

          // 1. 读取头部 MAGIC, SALT, IV
          if (!decipher) {
            headerBuffer = Buffer.concat([headerBuffer, data]);
            if (headerBuffer.length < headerSize) {
              return callback(); // 数据不够，继续等待
            }

            const magic = headerBuffer.subarray(0, MAGIC_HEADER.length);
            if (!magic.equals(MAGIC_HEADER)) {
              return callback(new Error('无效的加密备份文件：Magic Header 不匹配'));
            }

            const salt = headerBuffer.subarray(MAGIC_HEADER.length, MAGIC_HEADER.length + SALT_LEN);
            const iv = headerBuffer.subarray(MAGIC_HEADER.length + SALT_LEN, headerSize);
            const key = CryptoHelper.deriveKey(password, salt);

            decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            data = headerBuffer.subarray(headerSize);
            headerBuffer = null;
          }

          // 2. 累积流式解密，同时保留末尾 16 字节作为 GCM Auth Tag
          trailingBuffer = Buffer.concat([trailingBuffer, data]);
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
      },
      flush(callback) {
        try {
          if (!decipher) {
            return callback(new Error('加密文件过短或损坏，未能读取有效头信息'));
          }
          if (trailingBuffer.length !== TAG_LEN) {
            return callback(new Error('加密文件损坏，缺少 GCM 认证标签 (Auth Tag)'));
          }
          decipher.setAuthTag(trailingBuffer);
          const finalData = decipher.final();
          if (finalData.length) {
            this.push(finalData);
          }
          callback();
        } catch (err) {
          callback(new Error('解密认证失败：密码错误或备份数据已被篡改 (' + err.message + ')'));
        }
      }
    });
  }

  /**
   * 判断一个 Buffer 是否包含加密头部
   * @param {Buffer} buffer 
   * @returns {boolean}
   */
  static isEncrypted(buffer) {
    if (!buffer || buffer.length < MAGIC_HEADER.length) return false;
    return buffer.subarray(0, MAGIC_HEADER.length).equals(MAGIC_HEADER);
  }
}
