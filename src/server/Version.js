import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 插件版本号读取
 * ------------------------------------------------------------------
 * 唯一事实来源是 package.json。此前版本号分散硬编码在多个位置
 * （index.js 的 info.version、manifest.json、BackupService 的备份清单、
 *   前端面板标题旁的版本徽章），每次升级都要手动同步，极易漏改
 *   —— v1.1.0 升级时就漏掉了前端徽章与备份清单两处。
 *
 * 现在统一由本模块读取，其余位置一律引用。
 */

const PACKAGE_NAME = 'st-webdav';
const FALLBACK_VERSION = 'unknown';

let cachedVersion = null;

/**
 * 定位插件根目录下的 package.json
 * @returns {string | null}
 */
function locatePackageJson() {
  // 1) 以本文件位置为准（src/server/Version.js → 上溯两级即插件根）
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.resolve(here, '..', '..', 'package.json');
    if (fs.existsSync(candidate)) return candidate;
  } catch {}

  // 2) 从 cwd 逐级回溯（酒馆可能以任意工作目录启动）
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        if (pkg?.name === PACKAGE_NAME) return candidate;
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/**
 * 获取插件版本号
 * @returns {string}
 */
export function getPluginVersion() {
  if (cachedVersion) return cachedVersion;

  try {
    const pkgPath = locatePackageJson();
    if (pkgPath) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (typeof pkg?.version === 'string' && pkg.version.trim()) {
        cachedVersion = pkg.version.trim();
        return cachedVersion;
      }
    }
  } catch (err) {
    console.warn('[ST-WebDAV] 读取插件版本号失败:', err.message);
  }

  cachedVersion = FALLBACK_VERSION;
  return cachedVersion;
}
