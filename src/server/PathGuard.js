import path from 'node:path';

/**
 * 远端备份文件名校验工具
 * ------------------------------------------------------------------
 * 背景：/restore 与 /delete 接口接收来自客户端的远端文件名，若不做净化，
 *      攻击者可通过 `../` 拼接逃逸出当前用户的远端子目录，读取或删除
 *      他人备份（多租户越权）。本模块提供纵深防御的统一入口。
 */

/** 本插件备份文件的强制前缀 */
export const BACKUP_FILE_PREFIX = 'ST_Backup_';

/** 允许的归档扩展名（加密包为 .enc.zip） */
const ALLOWED_SUFFIXES = ['.zip', '.enc.zip'];

/** 单个文件名最大长度（对齐主流文件系统单文件名上限） */
const MAX_FILE_NAME_LENGTH = 255;

/** 控制字符（0x00-0x1F 与 0x7F），含 NULL 字节 */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * 净化并校验远端备份文件名
 * 校验通过返回原始文件名，失败抛出带明确原因的错误。
 * @param {unknown} rawName
 * @returns {string}
 */
export function sanitizeBackupFileName(rawName) {
  if (typeof rawName !== 'string' || !rawName.trim()) {
    throw new Error('备份文件名无效：必须是非空字符串');
  }

  const name = rawName.trim();

  if (name.length > MAX_FILE_NAME_LENGTH) {
    throw new Error(`备份文件名过长：超出 ${MAX_FILE_NAME_LENGTH} 字符上限`);
  }

  if (CONTROL_CHARS.test(name)) {
    throw new Error('备份文件名无效：包含控制字符');
  }

  if (name.includes('/') || name.includes('\\')) {
    throw new Error('备份文件名无效：不允许包含路径分隔符');
  }

  if (name.includes('..')) {
    throw new Error('备份文件名无效：不允许包含路径穿越片段 ".."');
  }

  // 双重保险：basename 归一后必须与原名一致
  if (path.basename(name) !== name) {
    throw new Error('备份文件名无效：必须是纯文件名，不含目录层级');
  }

  if (!name.startsWith(BACKUP_FILE_PREFIX)) {
    throw new Error(`备份文件名无效：必须以 "${BACKUP_FILE_PREFIX}" 开头`);
  }

  const lower = name.toLowerCase();
  const hasAllowedSuffix = ALLOWED_SUFFIXES.some(suffix => lower.endsWith(suffix));
  if (!hasAllowedSuffix) {
    throw new Error(`备份文件名无效：必须以 ${ALLOWED_SUFFIXES.join(' 或 ')} 结尾`);
  }

  return name;
}

/**
 * 判断文件名是否属于本插件的备份归档
 * @param {string} name
 * @returns {boolean}
 */
export function isBackupFileName(name) {
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  return name.startsWith(BACKUP_FILE_PREFIX) && ALLOWED_SUFFIXES.some(suffix => lower.endsWith(suffix));
}
