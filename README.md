# ☁️ ST-WebDAV (SillyTavern WebDAV 全量备份与还原插件)

> 📦 **流式零内存挤压 · 端到端 AES-256-GCM 加密 · Zip-Slip 深度防御 · 现代 Flat Glass 界面**
> 
> 专为 [SillyTavern (酒馆)](https://github.com/SillyTavern/SillyTavern) 打造的 WebDAV 全量备份、版本历史管理与灾备还原插件。支持将酒馆的配置（`settings.json`、API Key、预设、世界书、主题）或全量资产（角色卡、聊天记录、用户文件）自动无损同步至你的私有云或云盘。

---

## ✨ 核心特性

- ⚡ **零临时落盘 · 零 OOM 流式打包**：基于 Node.js 管道流与 `archiver`，一边扫描压缩、一边通过 HTTP PUT 推送到 WebDAV，常驻内存仅几十 KB，即使面对上 GB 的大型角色卡与长对话历史也不会吃满内存或导致酒馆崩溃。
- 🛡️ **端到端加密保护 (E2EE)**：支持开启 **AES-256-GCM + PBKDF2** 强加密。敏感 API 密钥与私密对话在推离本地前完成加密，在第三方网盘上为完全不可读密文，即便网盘泄露也无惧数据曝光。
- 🚫 **Zip-Slip 漏洞终结者**：在解包还原备份时强制进行绝对路径与归属沙箱校验，彻底杜绝恶意构造的 `../../` 路径穿越逃逸与任意系统文件覆写攻击。
- 🌐 **严格的 SSRF 拦截防御**：WebDAV 连接强制实施协议白名单与云厂商元数据服务（`169.254.169.254` 等）拦截，杜绝内网穿透探测隐患。
- 🔄 **自动安全回滚快照 (Rollback Snapshot)**：在执行远端还原覆写前，服务端会自动在本地打包一份即时回滚快照；若还原异常可无损倒退。
- ⏰ **定时备份与历史自动轮转**：支持配置定时自动备份周期（如每 24 小时）与远端备份保留份数（如保留最新 10 份），超额自动清理远端最旧备份，防止占满网盘空间。
- 🎨 **最新在线 UI Kit（Flat Glass 扁平玻璃设计）**：前端界面采用在线动态加载模式，实时跟随 [`zgy-beep/ui-kit`](https://github.com/zgy-beep/ui-kit) 仓库迭代；原生适配桌面端居中浮层（880px）与手机端底部抽屉 + 底部导航栏自适应切换。

---

## 兼容 WebDAV 服务端

经过实机测试兼容以下标准 WebDAV 服务端：
- **坚果云 (Jianguoyun)**：支持应用密码授权
- **Alist**：支持挂载的各类网盘（阿里云盘、百度网盘、115、夸克等）
- **群晖 NAS (Synology WebDAV Server)**
- **Nextcloud / ownCloud**
- **InfiniCLOUD (原 TeraCLOUD)**
- **自建 Nginx / Apache / Caddy WebDAV 模块**

---

## 快速安装与使用

### 1. 开启酒馆服务端插件功能

编辑酒馆根目录的 `config.yaml`：

```yaml
enableServerPlugins: true
```

### 2. 部署插件

将本仓库克隆或软链接至酒馆插件目录：

**作为服务端插件与前端扩展（推荐软链接）：**
```bash
# 在 SillyTavern 根目录下执行：
cd plugins
git clone https://github.com/zgy-beep/ST-WebDAV.git st-webdav
cd st-webdav
pnpm install # 或 npm install
```

同时在酒馆前端扩展目录建立软链接（使酒馆识别前端 UI）：
```bash
# Windows (管理员 PowerShell):
New-Item -ItemType SymbolicLink -Path "public/scripts/extensions/third-party/ST-WebDAV" -Target "plugins/st-webdav"

# Linux / macOS:
ln -s ../../../plugins/st-webdav public/scripts/extensions/third-party/ST-WebDAV
```

### 3. 重启 SillyTavern

启动酒馆后：
1. 点击酒馆右上角的 **扩展菜单（魔法棒图标）**；
2. 找到并点击 **「WebDAV 备份」** 按钮；
3. 在弹出的现代化 Flat Glass 面板中前往 **「服务设置」**，填入你的 WebDAV 地址与账号密码，点击「测试连接」验证通过即可！

---

## 备份范围说明

| 范围模式 | 包含的数据内容 | 推荐场景 |
| :--- | :--- | :--- |
| **核心配置 (Core)** | `settings.json`、`secrets.json`、世界书 (`worlds/`)、提示词预设 (`instruct/`, `context/`, `sysprompt/`, `reasoning/`)、主题与界面布局 (`themes/`, `movingUI/`)、快速回复 (`QuickReplies/`)、扩展配置 (`extensions/`) | 日常定时备份、轻量秒级同步、多端快速对齐 API 与预设 |
| **全量数据 (Full)** | 包含上述核心配置全部内容 + 全部角色卡 (`characters/`)、全部聊天记录 (`chats/`)、群组设定 (`groups/`, `group chats/`)、用户自定义媒体与文件 (`user/`) | 整机数据迁移、重装系统前灾备归档 |

---

## 安全防护与设计规范

1. **凭据脱敏存储**：
   - 配置文件持久化时，密码以保护模式存储；前端拉取配置接口一律返回 `********` 掩码，杜绝屏幕录制或网络拦截泄露。
2. **端到端加密**：
   - 加密格式采用 **AES-256-GCM**，头部包含 8 字节 Magic Marker (`STWBDV01`)、16 字节随机盐 (Salt) 与 12 字节 IV，末尾追加 16 字节 Auth Tag。每次加密均派生完全不同的一次性密钥与向量，密文具备不可延展性（Non-malleability）。
3. **Zip-Slip 零容忍拦截**：
   - 解压每个文件前均强制执行 `path.resolve` 与沙箱根路径比对，严禁跳出当前用户数据根目录。

---

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源发布。
UI 规范遵守 [SillyTavern NVUI Kit](https://github.com/zgy-beep/ui-kit) 设计契约。
