import fs from 'node:fs';
import path from 'node:path';
import { SHARED_DIR_NAME } from './Constants.js';

/**
 * 获取当前请求生效的本地数据根目录
 * ------------------------------------------------------------------
 * ⚠️ 安全要点：绝不能「用户目录不存在就回退到 default-user」。
 *    那样会让用户 B 的备份读到用户 A 的数据目录（跨用户数据泄露）。
 *    目录不存在时返回该用户自己的目录路径（后续操作因目录不存在而自然失败）。
 *
 * @param {object} [requestUser]
 * @returns {string}
 */
export function resolveUserDir(requestUser = null) {
  const dataRoot = globalThis.DATA_ROOT || path.join(process.cwd(), 'data');

  // 优先使用宿主注入的当前用户目录
  if (requestUser?.directories?.root) {
    return requestUser.directories.root;
  }

  // 多用户目录结构 (_users/<handle>)
  const rawHandle = requestUser?.handle || requestUser?.profile?.handle;
  if (rawHandle) {
    const usersDir = path.join(dataRoot, '_users');
    const candidate = path.join(usersDir, String(rawHandle));
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    // 目录尚未创建：返回其应有路径，而不是别人的目录
    return candidate;
  }

  // 单用户模式
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
  // displayName 依次取：profile.name → name → displayName → handle
  const displayName = requestUser?.profile?.name
    || requestUser?.name
    || requestUser?.displayName
    || handle;
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

/**
 * 解析跨账号共享区的远端目录
 * ------------------------------------------------------------------
 * 共享区固定为 `<基础目录>/_shared`：不带用户 handle 前缀，
 * 与 isolateUserDirectory 开关无关，所有能访问该 WebDAV 路径的
 * 用户与账号共用同一片共享空间。
 * @param {string} [baseDir='SillyTavern_Backups']
 * @returns {string}
 */
export function resolveSharedDirectory(baseDir = 'SillyTavern_Backups') {
  const cleanBase = String(baseDir || 'SillyTavern_Backups').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return `${cleanBase}/${SHARED_DIR_NAME}`;
}

/**
 * 判断当前请求用户是否具备管理员权限
 * ------------------------------------------------------------------
 * 兼容两种宿主形态：req.user.admin（SillyTavern 用户对象）与
 * req.user.profile.admin（部分版本把角色放在 profile 内）。
 * 单用户模式（req.user 缺失）视为管理员。
 * @param {object} [requestUser=null]
 * @returns {boolean}
 */
export function isAdminUser(requestUser = null) {
  if (!requestUser) return true;
  if (requestUser.admin === true) return true;
  if (requestUser.profile?.admin === true) return true;
  return false;
}
