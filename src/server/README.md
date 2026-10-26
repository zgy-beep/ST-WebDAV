# 服务端模块（src/server/）

本目录按职责拆分服务端逻辑。入口是**根目录 `index.js`**（导出 `init` / `exit` / `info`，
注册 `/api/plugins/st-webdav/*` 路由），本目录模块不得反向 import 入口。

## 模块职责与边界

| 模块 | 职责 | 边界 / 注意事项 |
|---|---|---|
| `BackupService.js` | 流式打包、暂存、上传、远端元数据与历史轮转 | 不解析 HTTP 请求；scope/categories 归一化在此完成 |
| `RestoreService.js` | 下载、两阶段校验解压、写盘、回滚快照 | Zip-Slip / Zip-Bomb / 凭据排除的校验都在此 |
| `SharedService.js` | 共享区复制、索引维护、权限判定 | 索引写操作必须走 per-directory 锁 |
| `ConfigManager.js` | per-user 配置读写、默认值、密码脱敏 | 配置接口只回 `********` |
| `WebDavClient.js` | WebDAV HTTP 客户端（PROPFIND/PUT/GET/COPY/DELETE） | SSRF 校验在 `UrlGuard`，重定向逐跳复核 |
| `SchedulerService.js` | 定时备份巡检 | 只读 `lastBackupTime` 判断间隔 |
| `CryptoHelper.js` | AES-256-GCM 加密（v02，兼容 v01 解密） | 格式版本、KDF 强度不得削弱 |
| `PathGuard.js` | 备份文件名白名单 | `ST_Backup_` 前缀、禁 `..` 与路径分隔符 |
| `UrlGuard.js` | URL 协议白名单与云元数据地址拦截 | 任何放宽都视为安全降级 |
| `JobLock.js` | per-handle 备份/还原互斥锁 | 冲突抛 `JobBusyError` |
| `JobBusyError.js` | 并发冲突错误类型（携带 HTTP 409 语义） | 路由据此区分 409 与 500 |
| `UserHelper.js` | 用户句柄、userDir、远端目录解析 | 用户目录不存在时**不得**回退 `default-user` |
| `Version.js` | 从 `package.json` 读取插件版本 | 唯一版本事实来源 |
| `Constants.js` | 跨模块常量 | 用于打断 `BackupService` ↔ `RestoreService` 循环依赖 |
| `BackupCategories.js` | 备份分类目录定义 | 分类 id 是服务端白名单 |

## HTTP 接口约定（`/api/plugins/st-webdav`）

| 路由 | 语义 | 关键状态码 |
|---|---|---|
| `GET /config`、`/categories`、`/backups`、`/backup/status`、`/shared` | 只读查询 | `200` |
| `POST /config` | 保存配置 | `200` / `400` |
| `POST /test` | WebDAV 连通性探测（按用户限流） | `200`（`ok=false` 表示失败） |
| `POST /backup` | 触发备份（当前实现同步完成） | `200` / `400` / `409` / `500` |
| `POST /restore` | 从备份或共享区还原 | `200` / `400` / `409` / `500` |
| `POST /delete` | 删除备份 / 撤回共享 | `200` / `400` / `403` / `404` / `500` |
| `POST /share`、`POST /unshare` | 分享 / 取消分享 | `200` / `400` / `403` / `409` / `500` |

### 备份 scope 解析顺序（v1.2.1 起）

1. 显式传 `scope`（`core` / `full` / `custom`）→ 以它为准；
2. 只传 `categories` 未传 `scope` → 按 `custom`，避免「归档内容按配置 scope、元数据却记 categories」的不一致；
3. 两者都未传 → 使用配置项 `backupScope`。

### 并发与错误语义

- 同一用户的备份与还原共用一把 per-handle 互斥锁；冲突统一返回 **409**（`JobBusyError`），
  文案形如「另一个备份任务正在进行中，请勿重复触发」；
- 其余内部错误返回 **500**，不要把可重试的任务占用与真正故障混为一谈；
- 配置接口永不回传明文密码（固定 `********` 掩码）。

> 修改上述任何模块前，先读 `docs/engineering/` 的规范与 `CODE_REVIEW.md` 对应章节；
> 安全敏感模块（PathGuard / UrlGuard / CryptoHelper / RestoreService / BackupService /
> UserHelper / 共享区权限）禁止任何校验降级。
