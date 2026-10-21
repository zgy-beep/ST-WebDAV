/**
 * 跨模块共享的常量定义
 * ------------------------------------------------------------------
 * 独立成文件以避免 BackupService 与 RestoreService 之间的循环依赖。
 */

/** 本插件自身的本地配置文件名（含明文凭据，禁止进入备份包） */
export const LOCAL_CONFIG_FILE = 'st_webdav_config.json';

/** 用户备份目录下的远端元数据索引文件名 */
export const REMOTE_META_FILE = 'st_backups_meta.json';

/** 跨账号共享区的远端元数据索引文件名 */
export const SHARED_META_FILE = 'st_shared_meta.json';

/** 跨账号共享区的固定目录名 */
export const SHARED_DIR_NAME = '_shared';
