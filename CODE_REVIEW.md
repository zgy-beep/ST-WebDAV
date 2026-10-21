# ST-WebDAV 代码审查报告

> 版本基线：`v1.0.0` → `v1.1.0`
> 审查范围：根 `index.js`、`src/server/**`（8 → 14 个模块）、`src/client/index.js`、`style.css`、`src/client/vendor/ui-kit/**`、`tests/**`
> 审查方式：逐行精读 + 独立复核代理交叉验证 + 真实网络/文件系统实测复现

---

## 一、总体结论

本轮改动在**修复既有缺陷**的同时引入了**新功能**（跨账号跨用户共享备份）与**新的依赖**（ui-kit v2.5.0）。

关键结论：

1. **前序审查的修复从未落地**。仓库中 `doc/` 保留的 4 份审查报告（服务端 agent-5 / 前端 agent-6）与 2 份修复任务书（agent-7 / agent-8）表明：审查报告已产出，但两份修复任务均以失败告终（`subagent.failed` × 2、`turn.step.interrupted` × 3）。修复前 `git log` 仅有 `f77a73c`，代码仍是 2.4.0 状态，`PathGuard.js` / `JobLock.js` 等文件根本不存在。
2. **本轮修复过程中新引入 3 个阻塞级缺陷**，由独立复核代理实测复现并已全部修复。**测试全绿 ≠ 安全** —— 这 3 个缺陷恰好全部落在测试盲区。
3. 最终测试规模从 **13 个扩展至 48 个**，全部通过。

| 维度 | 修复前 | 修复后 |
| :--- | :--- | :--- |
| 阻塞级 (Blocker) | 3 | **0** |
| 高危 (High) | 3 | **0** |
| 中危 (Medium) | 6 | 1（残余风险，已文档化） |
| 低危 (Low) | 16 | 6（多为有意保留的产品权衡） |
| 测试数量 | 13 | **48** |
| 加密格式 | v01 | **v02**（KDF 强度 210k + 迭代次数入头） |
| UI Kit | v2.4.0 双副本漂移 | **v2.5.0 单一事实来源** |

---

## 二、阻塞级问题（已全部修复）

### B1 · 远端路径穿越导致跨用户越权读取/删除

- **位置**：`index.js` `/restore`、`/delete` 路由 → `RestoreService.restoreBackup`
- **问题**：`fileName` 参数未经净化直接拼入远端路径。`buildUrl` 对路径段做 `encodeURIComponent`，但 `.` 不属于被编码字符，`..` 段原样保留，经 WHATWG URL 解析后被消解。攻击者提交 `{"fileName": "../bob/ST_Backup_bob_core_xxx.zip"}` 即可让服务端用 A 的凭据下载 **B 的备份包**并解压写入 A 的数据目录。
- **修复**：新增 `src/server/PathGuard.js`，`sanitizeBackupFileName()` 强制：非空字符串、长度 ≤ 255、禁控制字符、禁 `/` 与 `\`、禁 `..`、`path.basename` 一致性、必须以 `ST_Backup_` 开头、必须以 `.zip` / `.enc.zip` 结尾。路由层与 `RestoreService` 内部**双层调用**。
- **附带收益**：`/delete` 同步获得白名单保护，无法再删除 `st_backups_meta.json` / `st_shared_meta.json`。
- **回归测试**：`tests/share.test.js` 3 个用例（10 组断言）。

### B2 · 全量备份把明文凭据打进压缩包

- **位置**：`BackupService.runBackup` 的 `scope === 'full'` 分支
- **问题**：`st_webdav_config.json`（含明文 `webdavPassword` 与 `encryptionPassword`）位于用户数据目录根部，被 `archive.glob('**/*')` 一并打包。三重后果：① 未加密时凭据明文上传至第三方网盘；② 跨用户还原会把 A 的凭据导入 B 的本地配置；③ 还原覆写磁盘后 `ConfigManager` 内存缓存不刷新，造成"还原了又没还原"。
- **修复**：
  - 三种备份模式（full / core / custom）**统一**在归档出口排除凭据文件（`filterGit` + `archive.file` 双重过滤，大小写不敏感）；
  - 还原时跳过该文件（大小写不敏感 + 写盘前绝对路径二次比对）；
  - `ConfigManager` 新增 `refresh()`，还原后刷新内存缓存；
  - 模板继承时剔除 `webdavPassword` / `encryptionPassword` / `lastBackupTime` / `lastBackupStatus`。
- **回归测试**：`tests/share.test.js` + `tests/security.test.js` 共 4 个用例，含字节级 grep 断言明文口令不泄漏。

### B3 · Zip-Bomb 防御在解压后才执行，形同虚设

- **位置**：`RestoreService.restoreBackup`
- **问题**：`fflate.unzipSync()` 一次性将全部条目解压进内存，返回后才逐条检查配额。50MB 的恶意包膨胀成 10GB 时，进程在到达检查点前就已 OOM。
- **修复**：改用 `unzipSync` 的 `filter` 回调做**解压前**预审 —— 实测确认 fflate 的 `filter` 在 `inflateSync` **之前**调用（`node_modules/fflate/esm/browser.js:2652-2694`），抛错可正确冒泡。
- **实测校正**：前序任务书写的是 `UnzipFileInfo.size`，但该字段是**压缩后**尺寸；`originalSize` 才是解压后声明尺寸。本轮按实测修正，否则配额检查完全失效。
- **附带修复**：
  - 增量计数（消除 O(n²)：5 万条目从 6122ms 降至 <100ms）；
  - STORED 条目按 `max(originalSize, size)` 计费（防谎报尺寸绕过，实测原逻辑被绕过后 4MB 数据完全逃逸检查）；
  - 两阶段还原（先全量校验再统一写盘），实测恶意包触发拦截时磁盘 0 字节落盘。

---

## 三、本轮新引入并已修复的缺陷

> 以下 3 项由独立复核代理**实测复现**发现，修复前测试同样全绿（33/33），说明绿灯无法覆盖这些路径。

### N1 · 跨源重定向泄漏 Basic Auth 凭据

- **成因**：为修复 SSRF 绕过而改用 `redirect: 'manual'` 手动跟随跳转，丢失了 undici 原生的"跨源自动剥离 Authorization"保护。
- **实测证据**：攻击者服务器完整收到 `Basic YWxpY2U6U1VQRVJfU0VDUkVUX1BXRA==`（解码即 `alice:SUPER_SECRET_PWD`）。
- **修复**：`WebDavClient.fetchWithTimeout` 记录基准 origin，跨源跳转即剥离认证头并告警；同源跳转仍保留凭据（保证正常可用）。
- **回归测试**：`tests/security.test.js` 2 个用例（跨源必须无凭据 / 同源必须保留凭据）。

### N2 · 大小写变体覆写本地凭据 → 完整凭据外泄攻击链

- **成因**：还原时按**精确文件名**跳过 `st_webdav_config.json`，但 Windows 文件系统不区分大小写。
- **完整攻击链**（实测复现）：
  1. 攻击者向共享区投递含 `ST_WEBDAV_CONFIG.JSON` 的备份包，其中 `webdavUrl` 指向攻击者服务器；
  2. 受害者从共享区还原该包 → 磁盘上的本地配置被覆写；
  3. `ConfigManager.refresh()` 使内存缓存生效；
  4. 受害者此后**每一次备份**都上传到攻击者服务器。
- **修复**：跳过判定改为大小写不敏感（`path.basename().toLowerCase()`）+ 写盘前对目标绝对路径二次比对。
- **回归测试**：`tests/security.test.js` 2 个用例（根目录 + 嵌套目录）。

### N3 · JobLock 泄漏导致账号被永久锁死

- **成因**：`JobLock.acquire()` 之后的 `client.updateConfig()` 位于 `try` 块**之外**，而 `updateConfig` 在 URL 非法时抛错（`validateAndNormalizeUrl`）。锁永不释放，该账号的备份与还原被永久锁死，且错误信息极具误导性（显示"另一个备份任务正在进行中"）。
- **触发条件**：用户手工编辑配置文件写错 URL、旧版本迁移、磁盘损坏。
- **修复**：`acquire` 之后的**全部**代码纳入 `try/finally`；状态对象声明提升到 try 外；`ConfigManager.load()` 增加 URL 校验（非法 URL 直接忽略并告警）。
- **回归测试**：`tests/security.test.js` 2 个用例（备份与还原各一）。

---

## 四、中危问题（已修复）

| # | 问题 | 位置 | 修复方式 |
| :-- | :--- | :--- | :--- |
| M1 | 共享目录模式下轮转会删除他人备份 | `BackupService.rotateBackups` | 按 `ST_Backup_${handle}_` 前缀限定归属；新增 `handle` / `isolate` 参数 |
| M2 | 共享目录下 `/delete` 可删任意文件 | `index.js` | 非隔离模式校验文件归属前缀（管理员除外） |
| M3 | 共享区任意用户可删除他人文件 | `SharedService.unshare` | 无索引记录时一律拒绝（403）；此前整个权限校验被跳过 |
| M4 | meta 读-改-写并发丢更新 | `BackupService` / `SharedService` | per-remoteDir 异步互斥锁；共享区写操作**强制绕过 30s 缓存**读远端最新值 |
| M5 | 共享目录模式下用户 A 可分享 B 的文件 | `SharedService.share` | 源文件必须存在于调用者自己生效的远端目录 |
| M6 | 备份与还原对同一用户无互斥 | `BackupService` / `RestoreService` | 新增 `JobLock`，per-handle 跨类型互斥 |
| M7 | Scheduler 使用全局单例 client 原地改凭据 | `SchedulerService` | 每用户构造独立 `WebDavClient` |
| M8 | `resolveUserDir` fail-open 跨用户数据泄露 | `UserHelper` | 用户目录不存在时返回**该用户自己的**路径，绝不回退到 `default-user` |
| M9 | `filterGit` 子串匹配误伤 | `BackupService` | 改为路径段匹配（`my-node_modules-notes`、`.github` 不再被误删） |
| M10 | SSRF 可被 HTTP 重定向绕过 | `WebDavClient` | `redirect: 'manual'` + 逐跳重新校验 + 最多 3 跳 |

---

## 五、低危问题（已修复）

| # | 问题 | 修复方式 |
| :-- | :--- | :--- |
| L1 | PBKDF2 迭代 100k 低于 OWASP 建议 | 提升至 210k（v02），异步派生不阻塞事件循环；v01 保持兼容 |
| L2 | 迭代次数可被密文恶意拉高做 CPU DoS | 头部声明值 clamp 到 `[100000, 1000000]`（实测 5,000,000 次 = 1.66s CPU） |
| L3 | `createRollbackSnapshot` 缺 `archive.on('error')` | 补上（未监听的流错误会变成 uncaughtException 崩主进程） |
| L4 | 回滚快照无限累积 | 只保留最新 5 份 |
| L5 | `exit()` 不等待在途任务 | 最多等待 10 秒，让上传完成 |
| L6 | `note` 无长度上限 | 限制 200 字符 |
| L7 | `/test` 可被当作内网扫描器 | 按用户限流（10 次 / 60 秒）+ 桶 TTL 回收 |
| L8 | 配置文件权限过宽 | 写入时 `mode: 0o600` |
| L9 | 死代码（`tempSpoolFile`、无意义 catch 重试、`_mockBufferOnly` 钩子、`deriveKeyAsync`） | 全部清理 |
| L10 | `getUserInfo` 不认 `displayName` 字段 | 补兜底链 `profile.name → name → displayName → handle` |

---

## 六、保留的残余风险（有意为之，已文档化）

| 风险 | 原因 | 缓解措施 |
| :--- | :--- | :--- |
| **内网地址被放行**（10.x / 172.16.x / 192.168.x / 127.x） | 群晖 NAS、Alist 自建服务是核心使用场景 | `UrlGuard.js` 顶部显式声明该残余风险；`/test` 限流部分缓解 |
| **同源共享目录下的元数据缓存** | 30s TTL 提升读性能 | 写操作强制绕过缓存；多实例部署下建议关闭共享模式 |
| **还原链非完全流式** | fflate 的 `unzipSync` 内存模型 | 5GB 总量配额 + 单文件 1GB 上限（内存峰值受配额约束） |
| **错误信息回传本地路径** | 便于用户自助排查 | 详细信息已过滤为用户可见摘要；服务端日志保留完整栈 |

---

## 七、测试有效性评估

新增 35 个测试（`tests/share.test.js` 20 个 + `tests/security.test.js` 15 个），全部为**行为断言**而非恒真断言：

- **真实构造**：`tests/security.test.js` 的跨源重定向测试会启动两个真实 HTTP 服务器（受害者 302 → 攻击者），断言攻击者收到的请求中 `authorization` 为 `null`；同源测试断言凭据**必须**保留。
- **真实攻击链**：大小写变体测试构造含 `ST_WEBDAV_CONFIG.JSON` 的恶意 zip，验证还原后磁盘与内存配置均未被污染。
- **真实复现**：STORED 谎报测试手工构造 `compression: 0` 的条目，验证按 `size` 计费才能拦截。
- **复杂度断言**：增量配额测试跑满 5 万条目并断言耗时 < 2000ms（O(n²) 实现需 6 秒以上）。
- **两阶段断言**：恶意包触发拦截后断言用户目录**条目数为 0**。

已修正的测试盲区（原报告指出）：`validateEntry` 的归档内条目 Zip-Slip 校验、两阶段落盘性质、重定向凭据剥离、JobLock 释放窗口、共享区无索引越权、大小写变体、custom 模式嵌套凭据 —— 均已补齐。

---

## 八、新增模块清单

| 模块 | 职责 |
| :--- | :--- |
| `src/server/PathGuard.js` | 远端备份文件名净化（白名单 + 防路径穿越） |
| `src/server/JobLock.js` | per-handle 备份/还原互斥锁 |
| `src/server/SharedService.js` | 跨账号共享区业务逻辑（分享 / 撤回 / 列表） |
| `src/server/Constants.js` | 跨模块共享常量（避免循环依赖） |
| `src/server/UrlGuard.js` | SSRF 校验纯函数（`WebDavClient` 与 `ConfigManager` 共用） |

---

## 九、ui-kit v2.5.0 规范变更

| 变更 | 说明 |
| :--- | :--- |
| **单一事实来源** | 删除根目录 `ui-kit/` 副本与 `style.css` 的双 `@import`；`src/client/vendor/ui-kit/` 成为唯一副本 |
| `destroy()` 强化 | close 事件真正派发后再摘除 DOM 节点，保留 50ms 兜底定时器 |
| `.nvui-hint.is-ok` / `.is-danger` | 补齐语义色提示类（原仅支持 `is-warn`） |
| `.nvui-btn.is-xs` | 补齐尺寸阶梯 `is-default → is-sm → is-xs` |
| `.nvui-badge.is-subtle` | 低强调徽标变体 |
| `.nvui-progress.is-primary` | 主色进度条变体 |

这 4 个类名此前**前端已在使用但 CSS 缺失**，导致成功/失败提示着色、分类全选按钮、加密徽章等样式静默失效。v2.5.0 正式合法化。

---

## 十、跨账号跨用户共享功能

### 设计

- 共享区：`<远端备份根目录>/_shared/`，**不带用户标识**，所有能访问该 WebDAV 路径的账号共用。
- 分享：服务端 WebDAV `COPY`（不支持时降级为下载+上传），不落地本地。
- 索引：`_shared/st_shared_meta.json`，记录 `sharedBy` / `sharedAt` / 备注 / 范围 / 分类。

### API

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| `POST` | `/share` | `{ fileName }` → `{ success, fileName, sharedDirectory }`；409 = 同名已被他人分享 |
| `POST` | `/unshare` | `{ fileName }` → `{ success }`；403 = 非分享者且非管理员 |
| `GET` | `/shared` | → `{ sharedDirectory, backups[] }` |
| `POST` | `/restore` | 新增 `fromShared: true` |
| `POST` | `/delete` | 新增 `fromShared: true` |

### 权限模型

| 操作 | 允许者 |
| :--- | :--- |
| 分享 / 查看 / 还原 | 任意已登录用户 |
| 取消分享 / 删除共享文件 | **仅分享者本人或管理员** |

---

## 十一、验收

```bash
$ npm test
# tests 48
# suites 0
# pass 48
# fail 0
```

语法检查全通过：`index.js`、`src/server/*.js`、`src/client/index.js`。
