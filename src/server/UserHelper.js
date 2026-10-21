import fs from 'node:fs';
import path from 'node:path';

/**
 * 获取当前请求生效的本地数据根目录
 * @param {object} [requestUser] 
 * @returns {string}
 */
export function resolveUserDir(requestUser = null) {
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
 * 提取用户规范化元信息
 * @param {object} [requestUser] 
 * @returns {{ handle: string, displayName: string, isMultiUser: boolean, userDir: string }}
 */
export function getUserInfo(requestUser = null) {
  const userDir = resolveUserDir(requestUser);
  let rawHandle = requestUser?.handle || requestUser?.profile?.handle;

  if (!rawHandle) {
    // 检查是否处于 SillyTavern 多用户数据目录结构 (_users/<handle>)
    const normalized = userDir.replace(/\\/g, '/');
    const usersMatch = normalized.match(/\/_users\/([^/]+)$/i);
    if (usersMatch) {
      rawHandle = usersMatch[1];
    } else {
      rawHandle = 'default-user';
    }
  }

  const handle = String(rawHandle || 'default-user').replace(/[/\\:*?"<>|#%&{}\\<>*?/$!'":@+`|=]/g, '_').trim();
  const displayName = requestUser?.profile?.name || requestUser?.name || handle;
  const isMultiUser = handle !== 'default-user';

  return {
    handle,
    displayName,
    isMultiUser,
    userDir,
  };
}

/**
 * 根据多用户隔离策略解析生效的 WebDAV 远端目标目录
 * @param {string} [baseDir='SillyTavern_Backups'] 
 * @param {object} [requestUser=null] 
 * @param {boolean} [isolate=true] 
 * @returns {string}
 */
export function resolveRemoteDirectory(baseDir = 'SillyTavern_Backups', requestUser = null, isolate = true) {
  const cleanBase = String(baseDir || 'SillyTavern_Backups').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!isolate) return cleanBase;

  const info = getUserInfo(requestUser);
  // 多用户环境下，为每个账号自动分配专属子目录命名空间
  if (info.handle && info.handle !== 'default-user') {
    return `${cleanBase}/${info.handle}`;
  }

  return cleanBase;
}
