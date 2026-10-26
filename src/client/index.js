/**
 * ST-WebDAV 前端扩展 · 基于 SillyTavern NVUI Kit v2.8.0 规范
 * -------------------------------------------------------------
 * 1. 优先加载本地 Vendored UI-Kit (tokens.css, components.css, nvui-api.js)，支持离线并安全降级；
 * 2. 严格遵循面板布局标准与无障碍契约 (dialog.nvui-tl, role, aria-*)；
 * 3. 规范使用 NVUI 设计令牌与原子组件 (nvui-panel-heading, nvui-alert, nvui-switch-row, nvui-acc)；
 * 4. 彻底消除表情符号 (Emoji)，采用 Font Awesome 图标规范；
 * 5. 去除破坏性 z-index 硬编码与多层滚动条，原生兼容桌面端居中与移动端底部抽屉；
 * 6. 所有远端数据进入 innerHTML 前统一转义，破坏性操作改用面板内联确认区（弃用原生 prompt / confirm）；
 * 7. 支持共享备份区：同一远端目录下所有用户与账号可见、可还原。
 */

(function () {
  'use strict';

  const DEFAULT_CDN = 'https://cdn.jsdelivr.net/gh/zgy-beep/ui-kit@main';
  const NVUI_MIN_VERSION = '2.8.0';
  // 标签页顺序固定，桌面 tabs 与手机 bottomNav 共用同一份 key 顺序
  const TAB_KEYS = ['backup', 'history', 'settings'];

  /**
   * 插件版本号
   * ------------------------------------------------------------------
   * 三级来源，逐级降级：
   *   1) 服务端 /config 响应中的 pluginVersion（权威，来自 package.json）
   *   2) 浏览器直接读取 manifest.json（次选，覆盖服务端未升级的情况）
   *   3) 内联字面量（最后的兜底）
   * 早期版本这里直接硬编码 'v1.0.0'，导致升级到 v1.1.0 时面板标题旁的
   * 版本徽章仍显示旧版本号（版本号漂移）。
   */
  const PLUGIN_VERSION_FALLBACK = '1.2.2';
  let PLUGIN_VERSION = PLUGIN_VERSION_FALLBACK;

  /**
   * 解析插件版本号（服务端下发值优先）
   * @param {object} config /config 接口响应
   * @returns {string}
   */
  function resolvePluginVersion(config) {
    const fromServer = config?.pluginVersion;
    if (typeof fromServer === 'string' && fromServer.trim() && fromServer !== 'unknown') {
      return fromServer.trim();
    }
    return PLUGIN_VERSION;
  }

  /**
   * 从浏览器直接读取 manifest.json 作为版本号的次级来源
   * 服务端与前端分属两个部署单元，版本不一致时以此处为准
   * @returns {Promise<string>}
   */
  async function loadVersionFromManifest() {
    try {
      const resp = await fetch('/scripts/extensions/third-party/ST-WebDAV/manifest.json', {
        credentials: 'same-origin',
      });
      if (!resp.ok) return PLUGIN_VERSION;
      const manifest = await resp.json();
      const v = typeof manifest?.version === 'string' ? manifest.version.trim() : '';
      if (v) PLUGIN_VERSION = v;
    } catch {
      // 静默回退：版本号显示失败不应影响面板功能
    }
    return PLUGIN_VERSION;
  }

  let NVUI = null;
  let panel = null;
  let initPromise = null;
  let currentConfig = {};
  let isBackingUp = false;
  let activeTabKey = 'backup';
  let historyMode = 'mine';
  let categoryCatalog = null;
  let sharedFileNames = new Set();
  let isLoadingHistory = false;
  let historyLoadToken = 0;
  let sharedSyncPending = false;
  let progressCollapseTimer = null;
  let vendoredScriptLoaded = false;

  // ---------- 1. 加载 UI Kit (优先本地 Vendored，安全降级 CDN) ----------
  const cssLoadState = new Map();

  function loadCss(id, href) {
    return new Promise(resolve => {
      const state = cssLoadState.get(id);
      if (state === 'loaded') return resolve();

      const existing = document.getElementById(id);
      if (existing) {
        // 已存在但状态未知：可能仍在加载，也可能是加载失败的空壳
        if (existing.sheet) {
          cssLoadState.set(id, 'loaded');
          return resolve();
        }
        // 视为仍在加载：等它自己的 load / error 事件，不重复插入
        cssLoadState.set(id, 'loading');
        existing.addEventListener('load', () => { cssLoadState.set(id, 'loaded'); resolve(); }, { once: true });
        existing.addEventListener('error', () => { cssLoadState.set(id, 'failed'); resolve(); }, { once: true });
        setTimeout(resolve, 6000); // 防网络悬挂
        return;
      }

      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = href;
      cssLoadState.set(id, 'loading');
      link.onload = () => { cssLoadState.set(id, 'loaded'); resolve(); };
      link.onerror = () => { cssLoadState.set(id, 'failed'); resolve(); };
      document.head.appendChild(link);
      setTimeout(resolve, 6000); // 防网络悬挂
    });
  }

  function loadScript(src, id, force) {
    return new Promise((resolve, reject) => {
      const existing = document.getElementById(id);
      if (existing && !force) return resolve();
      if (existing && force) existing.remove();

      const script = document.createElement('script');
      script.id = id;
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => {
        // 摘除失败节点：否则下次重试会被「已存在」短路，脚本永远装不上
        if (script.parentNode) script.parentNode.removeChild(script);
        reject(new Error('UI Kit 加载失败，请检查网络连接'));
      };
      document.head.appendChild(script);
    });
  }

  // 语义化版本比较：version >= minVersion 返回 true
  function isVersionAtLeast(version, minVersion) {
    const parse = (v) => String(v === null || v === undefined ? '' : v)
      .replace(/^v/i, '')
      .split('.')
      .map(n => parseInt(n, 10) || 0);
    const a = parse(version);
    const b = parse(minVersion);
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const x = a[i] || 0;
      const y = b[i] || 0;
      if (x !== y) return x > y;
    }
    return true;
  }

  // 校验 CDN 基础地址：仅允许受信 jsDelivr 域名的 https 地址
  function sanitizeCdnBase(base) {
    if (!base) return '';
    const raw = String(base).trim();
    if (!raw) return '';
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:' && (u.hostname === 'cdn.jsdelivr.net' || u.hostname === 'fastly.jsdelivr.net')) {
        return raw.replace(/\/+$/, '');
      }
    } catch {}
    return '';
  }

  /**
   * UI Kit 运行时自检（ui-kit v2.8.0+）
   * ------------------------------------------------------------------
   * 多扩展共存 / CDN 降级 / 缓存命中时，kit 的 CSS 与 JS 版本可能不一致，
   * 这类问题不抛错，只表现为样式静默失效。调用 kit 的 selfCheck 把
   * 版本、令牌、玻璃回退状态收敛为一条可观测告警；kit 不支持时静默跳过。
   * `glass-auto-fallback` 是宿主禁用模糊时的预期行为，不算异常，排除。
   * @param {object} kit
   */
  function runKitSelfCheck(kit) {
    try {
      if (!kit || typeof kit.selfCheck !== 'function') return;
      const result = kit.selfCheck({ expect: NVUI_MIN_VERSION });
      const issues = (Array.isArray(result?.issues) ? result.issues : [])
        .filter(issue => issue !== 'glass-auto-fallback');
      if (issues.length > 0) {
        console.warn('[ST-WebDAV] UI Kit 自检发现问题:', issues.join(', '), result);
      }
    } catch (err) {
      // 自检失败不应阻断面板初始化
      console.warn('[ST-WebDAV] UI Kit 自检执行失败:', err?.message || err);
    }
  }

  async function ensureNVUI(cdnBase = DEFAULT_CDN) {
    const hostReady = () => !!(window.NVUI && typeof window.NVUI.createPanel === 'function');

    // 宿主已提供且版本达标时直接复用
    if (hostReady() && isVersionAtLeast(window.NVUI.version, NVUI_MIN_VERSION)) {
      NVUI = window.NVUI;
      runKitSelfCheck(NVUI);
      return NVUI;
    }
    if (hostReady()) {
      console.warn(`[ST-WebDAV] 宿主 UI Kit 版本 ${window.NVUI.version} 低于 ${NVUI_MIN_VERSION}，改用本地 Vendored 版本`);
    }

    // 优先从本地 Vendored 目录直接加载 (零网络延迟、100% 离线支持、杜绝外部脚本注入)
    const localVendorBase = '/scripts/extensions/third-party/ST-WebDAV/src/client/vendor/ui-kit';
    try {
      await Promise.all([
        loadCss('nvui-css-tokens', `${localVendorBase}/tokens.css`),
        loadCss('nvui-css-components', `${localVendorBase}/components.css`),
      ]);

      if (!vendoredScriptLoaded) {
        // 强制重载：以本地 2.8.0 覆盖宿主的旧版本
        await loadScript(`${localVendorBase}/nvui-api.js`, 'nvui-js-api-local', true);
        vendoredScriptLoaded = true;
      }

      if (hostReady() && isVersionAtLeast(window.NVUI.version, NVUI_MIN_VERSION)) {
        NVUI = window.NVUI;
        runKitSelfCheck(NVUI);
        return NVUI;
      }
    } catch (err) {
      console.warn('[ST-WebDAV] 本地 Vendored UI-Kit 加载失败:', err?.message || err);
      // 本地不可用但宿主旧版仍可用时降级使用
      if (hostReady()) {
        console.warn(`[ST-WebDAV] 降级使用宿主已加载的 UI Kit v${window.NVUI.version}`);
        NVUI = window.NVUI;
        runKitSelfCheck(NVUI);
        return NVUI;
      }
    }

    // 安全降级：仅允许安全受信的 jsDelivr CDN
    const safeCdn = sanitizeCdnBase(cdnBase) || DEFAULT_CDN;

    // CDN 样式用独立 id：本地样式加载失败时不能被「已存在」短路
    await Promise.all([
      loadCss('nvui-css-tokens-cdn', `${safeCdn}/tokens.css`),
      loadCss('nvui-css-components-cdn', `${safeCdn}/components.css`),
    ]);

    if (!hostReady()) {
      await loadScript(`${safeCdn}/nvui-api.js`, 'nvui-js-api', false);
    }

    NVUI = window.NVUI;
    runKitSelfCheck(NVUI);
    return NVUI;
  }

  // 注入业务附加 CSS（宿主 manifest 已注入时跳过，避免 style.css 双份加载）
  async function ensureBusinessCss() {
    if (document.querySelector('link[href*="ST-WebDAV/style.css"]')) return;
    await loadCss('st-webdav-css', '/scripts/extensions/third-party/ST-WebDAV/style.css');
  }

  // 吐司提示统一封装
  function toast(message, type = 'info', icon = null) {
    const text = message === null || message === undefined ? '' : String(message);
    if (NVUI && typeof NVUI.showToast === 'function') {
      const iconMap = {
        ok: 'fa-solid fa-circle-check',
        success: 'fa-solid fa-circle-check',
        danger: 'fa-solid fa-circle-exclamation',
        warn: 'fa-solid fa-triangle-exclamation',
        info: 'fa-solid fa-circle-info',
      };
      // Kit 的吐司类型契约是 success | warn | danger | info，业务层的 'ok' 需映射为 'success'
      const kitType = type === 'ok' ? 'success' : type;
      NVUI.showToast({
        message: text,
        type: kitType,
        icon: icon || iconMap[type] || iconMap[kitType] || 'fa-solid fa-circle-info',
      });
    } else if (typeof toastr !== 'undefined') {
      // toastr 默认按 HTML 解析消息，必须先转义，防止远端文本被当作标签注入
      toastr[type === 'danger' ? 'error' : (type === 'ok' ? 'success' : type)](escapeHtml(text));
    } else {
      console.log(`[ST-WebDAV] [${type.toUpperCase()}] ${text}`);
    }
  }

  // ---------- 2. 后端 API 通信与 CSRF Token 获取 ----------
  let cachedCsrfToken = '';

  async function getCsrfToken(forceRefresh = false) {
    if (cachedCsrfToken && !forceRefresh) return cachedCsrfToken;

    // 1. 尝试从酒馆全局函数 getRequestHeaders 获取
    if (typeof window.getRequestHeaders === 'function') {
      try {
        const h = window.getRequestHeaders();
        const t = h?.['X-CSRF-Token'] || h?.['x-csrf-token'];
        if (t) {
          cachedCsrfToken = t;
          return cachedCsrfToken;
        }
      } catch {}
    }

    // 2. 尝试从 getContext().getRequestHeaders 获取
    const ctx = window.SillyTavern?.getContext?.();
    if (typeof ctx?.getRequestHeaders === 'function') {
      try {
        const h = ctx.getRequestHeaders();
        const t = h?.['X-CSRF-Token'] || h?.['x-csrf-token'];
        if (t) {
          cachedCsrfToken = t;
          return cachedCsrfToken;
        }
      } catch {}
    }

    // 3. 尝试从 DOM meta 标签获取
    const metaToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
    if (metaToken) {
      cachedCsrfToken = metaToken;
      return cachedCsrfToken;
    }

    // 4. 尝试动态加载酒馆核心 /scripts/script.js 获取
    try {
      const coreScript = await import('/scripts/script.js').catch(() => null);
      if (typeof coreScript?.getRequestHeaders === 'function') {
        const h = coreScript.getRequestHeaders();
        const t = h?.['X-CSRF-Token'] || h?.['x-csrf-token'];
        if (t) {
          cachedCsrfToken = t;
          return cachedCsrfToken;
        }
      }
    } catch {}

    // 5. 兜底方案：直接向服务端 /csrf-token 发起 GET 请求获取
    try {
      const resp = await fetch('/csrf-token', { credentials: 'same-origin' });
      if (resp.ok) {
        const data = await resp.json();
        if (data?.token) {
          cachedCsrfToken = data.token;
          return cachedCsrfToken;
        }
      }
    } catch {}

    return '';
  }

  async function apiCall(endpoint, method = 'GET', body = null, isRetry = false) {
    const headers = { 'Content-Type': 'application/json' };

    // 非 GET 请求自动附带有效的 CSRF Token
    if (method !== 'GET') {
      const token = await getCsrfToken();
      if (token) headers['X-CSRF-Token'] = token;
    }

    const options = {
      method,
      headers,
      credentials: 'same-origin', // 必须携带 session cookie
    };
    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const resp = await fetch(`/api/plugins/st-webdav${endpoint}`, options);
    const data = await resp.json().catch(() => ({}));

    // 如果因 CSRF Token 失效导致 403，则自动刷新 Token 重试一次。
    // 权限类 403（如「无权取消分享」）不是 Token 问题，必须直接抛出，避免无谓重试。
    if (resp.status === 403 && method !== 'GET' && !isRetry) {
      const isPermission = /权限|无权|not permitted|forbidden|permission/i.test(String(data?.error || data?.message || ''));
      if (!isPermission) {
        console.warn('[ST-WebDAV] CSRF Token 可能已失效，正在刷新并重试...');
        cachedCsrfToken = '';
        const refreshedToken = await getCsrfToken(true);
        if (refreshedToken) {
          return apiCall(endpoint, method, body, true);
        }
      }
    }

    if (resp.status === 404) {
      const err = new Error('未检测到服务端插件：请在酒馆根目录 config.yaml 中将 enableServerPlugins 设置为 true 并重启酒馆。');
      err.status = 404;
      throw err;
    }

    if (!resp.ok) {
      const err = new Error(data.error || data.message || `请求失败: HTTP ${resp.status}`);
      err.status = resp.status;
      throw err;
    }

    return data;
  }

  // 辅助防 XSS 转义
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // 默认备份数据分类项（服务端 /categories 不可用时的回退表）
  const DEFAULT_CATEGORIES = [
    { id: 'settings', name: '核心设置与密钥', desc: 'settings.json, secrets.json, stats.json', defaultSelected: true },
    { id: 'characters', name: '角色卡片 (Characters)', desc: '全部角色卡 PNG / JSON 及其头像与配置', defaultSelected: true },
    { id: 'chats', name: '聊天记录与群组 (Chats)', desc: '单聊历史、群组会话、群聊定义', defaultSelected: true },
    { id: 'worlds', name: '世界书 (Lorebooks)', desc: '世界设定、关联词条库与知识条目', defaultSelected: true },
    { id: 'prompts', name: '提示词与预设模板', desc: 'context, instruct, sysprompt, reasoning, 快捷回复与模型设置', defaultSelected: true },
    { id: 'themes', name: '主题与移动界面外观', desc: 'themes/ 自定义主题样式与 movingUI 移动式界面布局', defaultSelected: false },
    { id: 'userAvatars', name: '用户形象与背景壁纸', desc: 'User Avatars, user 资料, backgrounds 背景壁纸与 assets', defaultSelected: false },
    { id: 'extensions', name: '扩展插件配置', desc: 'extensions/ 扩展持久化配置与自定义插件数据', defaultSelected: false },
    { id: 'vectors', name: '向量记忆库 (Vectors)', desc: 'vectors/ 向量嵌入数据库与相关索引文件', defaultSelected: false },
  ];

  // 拉取服务端分类字典（单一事实来源），失败回退内置表
  async function loadCategoryCatalog(force = false) {
    if (categoryCatalog && !force) return categoryCatalog;

    try {
      const res = await apiCall('/categories');
      const rawList = Array.isArray(res) ? res : (Array.isArray(res?.categories) ? res.categories : []);
      const normalized = rawList
        .filter(c => c && c.id)
        .map(c => ({
          id: String(c.id),
          name: String(c.name || c.id),
          desc: String(c.desc || ''),
          defaultSelected: !!c.defaultSelected,
        }));
      if (normalized.length) {
        categoryCatalog = normalized;
        return categoryCatalog;
      }
      console.warn('[ST-WebDAV] 服务端分类表为空，回退内置分类表');
    } catch (err) {
      console.warn('[ST-WebDAV] 获取服务端分类表失败，回退内置分类表:', err.message);
    }

    categoryCatalog = DEFAULT_CATEGORIES.map(c => ({
      id: c.id,
      name: c.name,
      desc: c.desc,
      defaultSelected: !!c.defaultSelected,
    }));
    return categoryCatalog;
  }

  // 分类 id -> 展示名（备份勾选与历史卡片共用同一份字典）
  // 使用无原型对象：避免远端传入 'constructor' / '__proto__' 等 key 时命中 Object.prototype
  function getCategoryNameMap() {
    const map = Object.create(null);
    (categoryCatalog || DEFAULT_CATEGORIES).forEach(c => {
      map[c.id] = c.name;
    });
    return map;
  }

  // 辅助格式化字节大小
  function formatSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
    return `${(n / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
  }

  // 辅助格式化时间
  function formatDate(isoStr) {
    if (!isoStr) return '未知时间';
    try {
      const d = new Date(isoStr);
      // Invalid Date 不会抛错，必须显式判定，否则会渲染出 NaN-NaN-NaN
      if (Number.isNaN(d.getTime())) return escapeHtml(String(isoStr));
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch {
      return escapeHtml(String(isoStr));
    }
  }

  // ---------- 3. 构建 UI Kit 标准面板 ----------
  async function initUI() {
    // initPromise 优先于 panel：面板创建后仍需 await buildBackupTab（拉分类表），
    // 若此时只判断 panel，后续调用方会拿到尚未填充完的半成品面板。
    if (initPromise) return initPromise;
    if (panel) return panel;

    initPromise = (async () => {
      // 先从 manifest.json 取版本号（本地静态文件，最快且不依赖服务端）
      await loadVersionFromManifest();

      // 再从服务端拉取配置（服务端版本号最权威，覆盖 manifest 的值）
      let cdnBase = DEFAULT_CDN;
      let cdnRejected = false;
      try {
        currentConfig = await apiCall('/config');
        PLUGIN_VERSION = resolvePluginVersion(currentConfig);
        if (currentConfig.cdnBase) {
          if (sanitizeCdnBase(currentConfig.cdnBase)) {
            cdnBase = currentConfig.cdnBase;
          } else {
            cdnRejected = true;
          }
        }
      } catch (err) {
        console.warn('[ST-WebDAV] 预取配置提示:', err.message);
      }

      // 加载 UI Kit 核心库
      await ensureNVUI(cdnBase);

      // 注入业务附加 CSS（宿主已注入则跳过，避免双份加载）
      await ensureBusinessCss();

      // 使用 NVUI API 创建标准面板 (附带 focusFallback 防止焦点丢失)
      const created = NVUI.createPanel({
        id: 'st-webdav',
        title: 'WebDAV 备份与恢复',
        version: `v${PLUGIN_VERSION}`,
        focusFallback: '#extensionsMenuButton',
        tabs: [
          { key: 'backup', label: '备份操作', icon: 'fa-solid fa-cloud-arrow-up' },
          { key: 'history', label: '远端历史', icon: 'fa-solid fa-clock-rotate-left' },
          { key: 'settings', label: '服务设置', icon: 'fa-solid fa-sliders' },
        ],
        actions: [
          {
            icon: 'fa-solid fa-arrows-rotate',
            label: '刷新',
            onClick: () => refreshCurrentTab(),
          },
        ],
      });
      panel = created;

      // 填充各个分区内容
      await buildBackupTab();
      buildHistoryTab();
      buildSettingsTab();

      // 绑定标签页切换事件 (桌面 tabs 与手机 bottomNav 同步)
      bindTabListeners();

      if (cdnRejected) {
        toast('自定义 CDN 地址未通过安全校验，已使用默认源', 'info');
      }

      return panel;
    })();

    try {
      return await initPromise;
    } catch (err) {
      // 失败时置回 null 以便重试；已创建的面板同步销毁，避免留下半成品 DOM
      initPromise = null;
      if (panel) {
        try { panel.destroy(); } catch {}
        panel = null;
      }
      throw err;
    }
  }

  // 辅助获取指定 tab 的内容 DOM 容器
  function getTabPane(key) {
    if (!panel || !panel.body) return null;
    return panel.body.querySelector(`#${panel.id}-pane-${key}`) || panel.body;
  }

  // 绑定 Tab 切换监听：桌面 tabs 与手机 bottomNav 均按固定顺序确定性绑定
  function bindTabListeners() {
    if (!panel || !panel.dialog) return;

    // 桌面标签：DOM id 由 Kit 固定生成 <panelId>-tab-<key>
    TAB_KEYS.forEach(key => {
      const btn = panel.dialog.querySelector(`#${panel.id}-tab-${key}`);
      btn?.addEventListener('click', () => onTabActivated(key));
    });

    // 手机底部导航：无 id，按 Kit 固定顺序（与 tabs 同序）绑定
    const bottomItems = panel.bottomNav?.querySelectorAll('.nvui-bottom-nav-item') || [];
    Array.prototype.forEach.call(bottomItems, (btn, index) => {
      const key = TAB_KEYS[index];
      if (!key) return;
      btn.addEventListener('click', () => onTabActivated(key));
    });
  }

  // 标签页激活：只刷新对应分区
  function onTabActivated(key) {
    activeTabKey = key;
    if (key === 'history') {
      loadHistoryList();
    } else if (key === 'settings') {
      loadSettingsForm();
    } else if (key === 'backup') {
      checkWebDavHealth();
    }
  }

  // 刷新当前活动标签页（只刷新当前分区，避免无谓的并发请求）
  function refreshCurrentTab() {
    if (activeTabKey === 'history') {
      loadHistoryList(true);
    } else if (activeTabKey === 'settings') {
      loadSettingsForm();
    } else {
      checkWebDavHealth();
    }
    toast('已刷新数据', 'info');
  }

  // —— 分区 1：备份操作 (Backup Tab) ——
  async function buildBackupTab() {
    const pane = getTabPane('backup');
    if (!pane) return;

    // 分类字典以服务端为准（失败回退内置表），备份勾选与历史展示共用同一份数据
    await loadCategoryCatalog();

    pane.innerHTML = `
      <div class="st-webdav-container">
        <!-- 分区标准标题行 -->
        <div class="nvui-panel-heading">
          <span class="nvui-section-title">备份操作</span>
          <span class="nvui-badge is-accent">云端同步</span>
        </div>

        <!-- WebDAV 状态警示条 (严格采用 Kit .nvui-alert 组件规范) -->
        <div id="st-webdav-status-banner" class="nvui-alert is-checking">
          <i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i>
          <span>正在检查 WebDAV 服务连接...</span>
        </div>

        <!-- 备份选项卡片 -->
        <div class="st-webdav-card">
          <div class="st-webdav-card-header">
            <span class="st-webdav-card-title">
              <i class="fa-solid fa-layer-group" aria-hidden="true"></i>
              备份范围
            </span>
            <span class="nvui-hint">推荐日常选择「核心配置」</span>
          </div>

          <div class="st-webdav-radio-group" role="radiogroup" aria-label="备份数据范围">
            <div class="st-webdav-radio-btn is-active" data-scope="core" role="radio" aria-checked="true" tabindex="0">
              <i class="fa-solid fa-bolt" aria-hidden="true"></i>
              <span>核心配置 (Core)</span>
            </div>
            <div class="st-webdav-radio-btn" data-scope="full" role="radio" aria-checked="false" tabindex="-1">
              <i class="fa-solid fa-box-archive" aria-hidden="true"></i>
              <span>全量数据 (Full)</span>
            </div>
            <div class="st-webdav-radio-btn" data-scope="custom" role="radio" aria-checked="false" tabindex="-1">
              <i class="fa-solid fa-sliders" aria-hidden="true"></i>
              <span>自定义项 (Custom)</span>
            </div>
          </div>

          <div class="nvui-hint" id="st-webdav-scope-desc">
            包含：settings.json, secrets.json, 世界书 (Lorebook), 提示词预设, 主题样式, 宏与扩展配置。体积轻巧，秒级完成。
          </div>

          <!-- 自定义选项按需挑选面板 (只在选中 Custom 时展开) -->
          <div id="st-webdav-custom-box" class="st-webdav-custom-box" style="display: none;">
            <div class="st-webdav-custom-toolbar">
              <span class="st-webdav-cat-title"><i class="fa-solid fa-list-check" aria-hidden="true"></i> 勾选需要备份的数据类别：</span>
              <div class="st-webdav-bar">
                <button type="button" class="nvui-btn is-xs is-secondary" id="st-webdav-cat-all">全选</button>
                <button type="button" class="nvui-btn is-xs is-secondary" id="st-webdav-cat-none">全不选</button>
                <button type="button" class="nvui-btn is-xs is-secondary" id="st-webdav-cat-default">推荐默认</button>
              </div>
            </div>
            <div class="st-webdav-category-grid" id="st-webdav-cat-grid">
              ${categoryCatalog.map(c => `
                <label class="st-webdav-cat-item">
                  <input type="checkbox" class="nvui-checkbox st-webdav-cat-cb" value="${escapeHtml(c.id)}" ${c.defaultSelected ? 'checked' : ''} data-default="${c.defaultSelected ? 'true' : 'false'}">
                  <div class="st-webdav-cat-info">
                    <span class="st-webdav-cat-title">${escapeHtml(c.name)}</span>
                    <span class="st-webdav-cat-desc">${escapeHtml(c.desc)}</span>
                  </div>
                </label>
              `).join('')}
            </div>
          </div>
        </div>

        <!-- 端到端加密卡片 (使用 Kit .nvui-switch-row.is-feature 特性开关) -->
        <div class="st-webdav-card">
          <div class="st-webdav-card-header">
            <span class="st-webdav-card-title">
              <i class="fa-solid fa-shield-halved" aria-hidden="true"></i>
              端到端加密保护
            </span>
            <span class="nvui-badge is-subtle">AES-256-GCM</span>
          </div>

          <label class="nvui-switch-row is-feature">
            <input type="checkbox" id="st-webdav-encrypt-toggle">
            <span>开启加密备份（推送到 WebDAV 前在本地完成加密，防范网盘凭据泄露）</span>
          </label>

          <div id="st-webdav-password-group" style="display: none; margin-top: var(--nvui-space-2);">
            <label class="nvui-input-row">
              <input type="password" id="st-webdav-backup-pass" class="nvui-input" placeholder="输入自定义解密口令" autocomplete="new-password">
              <span>加密口令</span>
            </label>
            <div class="nvui-alert is-warning" style="margin-top: var(--nvui-space-2);">
              <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
              <span>【安全提示】请牢记此口令，远端解密与恢复时必须提供，若遗失将无法还原数据！</span>
            </div>
          </div>
        </div>

        <!-- 备注与执行 -->
        <div class="st-webdav-card">
          <label class="nvui-input-row">
            <input type="text" id="st-webdav-backup-note" class="nvui-input" placeholder="例如：升级酒馆前备份 / 某重要剧情节点">
            <span>备份备注 (可选)</span>
          </label>

          <div class="st-webdav-bar" style="margin-top: var(--nvui-space-2);">
            <button type="button" id="st-webdav-run-btn" class="nvui-btn is-primary" style="flex: 1 1 auto;">
              <i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i>
              立即备份到 WebDAV
            </button>
          </div>

          <!-- 进度展示 -->
          <div id="st-webdav-progress-box" style="display: none; margin-top: var(--nvui-space-2);">
            <div id="st-webdav-progress-bar"></div>
            <div class="nvui-hint" id="st-webdav-progress-text" style="margin-top: var(--nvui-space-1); text-align: center;">
              正在准备...
            </div>
          </div>
        </div>
      </div>
    `;

    // 绑定范围切换事件（roving tabindex：仅选中项 tabindex=0）
    let selectedScope = 'core';
    const scopeBtns = Array.from(pane.querySelectorAll('.st-webdav-radio-btn'));
    const scopeDesc = pane.querySelector('#st-webdav-scope-desc');
    const customBox = pane.querySelector('#st-webdav-custom-box');

    const scopeDescText = {
      core: '包含：settings.json, secrets.json, 世界书 (Lorebook), 提示词预设, 主题样式, 宏与扩展配置。体积轻巧，秒级完成。',
      full: '包含：核心配置全部内容 + 全部角色卡、全部聊天记录、用户上传文件。完整保留所有数据，适合全量灾备。',
      custom: '根据下方勾选的类别进行按需备份，精确控制备份内容与体积。',
    };

    const selectScope = (btn, focus) => {
      scopeBtns.forEach(b => {
        const on = b === btn;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.setAttribute('tabindex', on ? '0' : '-1');
      });
      selectedScope = btn.getAttribute('data-scope');
      if (scopeDesc) scopeDesc.textContent = scopeDescText[selectedScope] || scopeDescText.core;
      if (customBox) customBox.style.display = selectedScope === 'custom' ? 'flex' : 'none';
      if (focus) btn.focus();
    };

    scopeBtns.forEach((btn, index) => {
      btn.addEventListener('click', () => selectScope(btn, false));
      btn.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          selectScope(scopeBtns[(index + 1) % scopeBtns.length], true);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          selectScope(scopeBtns[(index - 1 + scopeBtns.length) % scopeBtns.length], true);
        } else if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
          selectScope(btn, true);
        }
      });
    });

    // 自定义分类快速勾选操作
    const catBoxes = () => Array.from(pane.querySelectorAll('.st-webdav-cat-cb'));
    pane.querySelector('#st-webdav-cat-all')?.addEventListener('click', () => {
      catBoxes().forEach(cb => { cb.checked = true; });
    });
    pane.querySelector('#st-webdav-cat-none')?.addEventListener('click', () => {
      catBoxes().forEach(cb => { cb.checked = false; });
    });
    pane.querySelector('#st-webdav-cat-default')?.addEventListener('click', () => {
      catBoxes().forEach(cb => { cb.checked = cb.getAttribute('data-default') === 'true'; });
    });

    // 加密开关联动
    const encryptToggle = pane.querySelector('#st-webdav-encrypt-toggle');
    const passGroup = pane.querySelector('#st-webdav-password-group');
    encryptToggle.addEventListener('change', () => {
      passGroup.style.display = encryptToggle.checked ? 'block' : 'none';
    });

    // 立即备份按钮
    const runBtn = pane.querySelector('#st-webdav-run-btn');
    const progressBox = pane.querySelector('#st-webdav-progress-box');
    const progressText = pane.querySelector('#st-webdav-progress-text');

    // 初始化 NVUI 进度条
    const progressBar = NVUI.progress({ value: 0, variant: 'primary' });
    pane.querySelector('#st-webdav-progress-bar').appendChild(progressBar);

    const resetProgress = () => {
      if (progressCollapseTimer) {
        clearTimeout(progressCollapseTimer);
        progressCollapseTimer = null;
      }
      progressBox.style.display = 'none';
      progressBar.setValue(0);
      progressText.textContent = '正在准备...';
    };

    runBtn.addEventListener('click', async () => {
      if (isBackingUp) return;

      const encrypt = encryptToggle.checked;
      const password = pane.querySelector('#st-webdav-backup-pass').value.trim();
      const note = pane.querySelector('#st-webdav-backup-note').value.trim();

      if (encrypt && !password) {
        toast('请填写备份加密口令', 'warn');
        pane.querySelector('#st-webdav-backup-pass').focus();
        return;
      }

      let categories = [];
      if (selectedScope === 'custom') {
        const checkedBoxes = catBoxes().filter(cb => cb.checked);
        categories = checkedBoxes.map(cb => cb.value);
        if (!categories.length) {
          toast('请至少勾选一个自定义备份类别', 'warn');
          return;
        }
      }

      let pollTimer = null;
      let lastProgress = 0;
      try {
        isBackingUp = true;
        runBtn.disabled = true;
        runBtn.innerHTML = '<span class="nvui-spinner" aria-hidden="true"></span> 备份中...';
        // 每次新备份前先重置进度区与文案
        if (progressCollapseTimer) {
          clearTimeout(progressCollapseTimer);
          progressCollapseTimer = null;
        }
        progressBox.style.display = 'block';
        progressBar.setValue(0);
        lastProgress = 0;
        progressText.textContent = '正在连接 WebDAV 并扫描待备份数据...';

        pollTimer = setInterval(async () => {
          try {
            const status = await apiCall('/backup/status');
            if (status.running) {
              const value = Number(status.progress);
              // 仅在进度为有限数且不倒退时更新，避免进度条来回跳
              if (Number.isFinite(value) && value > lastProgress) {
                lastProgress = value;
                progressBar.setValue(value);
              }
              progressText.textContent = status.detail || '正在处理中...';
            }
          } catch {}
        }, 800);

        const res = await apiCall('/backup', 'POST', {
          scope: selectedScope,
          categories,
          encrypt,
          password,
          note,
        });

        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        const fileName = res?.fileName || '';
        progressBar.setValue(100);
        progressText.textContent = fileName ? `备份成功: ${fileName}` : '备份成功: 已完成';
        toast(fileName ? `备份成功：${fileName}` : '备份成功', 'ok');

        // 备份结束后 4 秒折叠进度区并重置文案
        progressCollapseTimer = setTimeout(resetProgress, 4000);

        // 重新拉取历史记录
        loadHistoryList();
      } catch (err) {
        progressText.textContent = `备份失败: ${err.message}`;
        toast(`备份失败: ${err.message}`, 'danger');
        progressCollapseTimer = setTimeout(resetProgress, 4000);
      } finally {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        isBackingUp = false;
        runBtn.disabled = false;
        runBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i> 立即备份到 WebDAV';
      }
    });
  }

  // 连通性测试与状态横幅更新 (严格遵循 Kit 告警条语义规范)
  async function checkWebDavHealth() {
    const banner = getTabPane('backup')?.querySelector('#st-webdav-status-banner');
    if (!banner) return;

    try {
      const res = await apiCall('/test', 'POST', {});
      if (res.ok) {
        banner.className = 'nvui-alert is-success';
        banner.innerHTML = `<i class="fa-solid fa-circle-check" aria-hidden="true"></i> <span>WebDAV 连接正常 (${escapeHtml(res.server || 'Server Ready')})</span>`;
      } else {
        banner.className = 'nvui-alert is-warning';
        banner.innerHTML = `<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> <span>${escapeHtml(res.message || 'WebDAV 尚未连通，请前往「服务设置」完善配置')}</span>`;
      }
    } catch (err) {
      banner.className = 'nvui-alert is-error';
      banner.innerHTML = `<i class="fa-solid fa-circle-xmark" aria-hidden="true"></i> <span>${escapeHtml(err.message)}</span>`;
    }
  }

  // —— 分区 2：远端备份历史 (History Tab) ——
  function buildHistoryTab() {
    const pane = getTabPane('history');
    if (!pane) return;

    pane.innerHTML = `
      <div class="st-webdav-container">
        <!-- 分区标准标题行 -->
        <div class="nvui-panel-heading">
          <span class="nvui-section-title">远端备份历史</span>
          <span class="nvui-badge is-accent" id="st-webdav-history-count-badge">0 个备份</span>
        </div>

        <div class="st-webdav-bar" style="justify-content: space-between;">
          <div class="st-webdav-segment" role="group" aria-label="备份来源切换">
            <button type="button" class="nvui-btn is-xs is-primary" id="st-webdav-mode-mine" aria-pressed="true">
              <i class="fa-solid fa-user" aria-hidden="true"></i>
              我的备份
            </button>
            <button type="button" class="nvui-btn is-xs is-secondary" id="st-webdav-mode-shared" aria-pressed="false">
              <i class="fa-solid fa-share-nodes" aria-hidden="true"></i>
              共享备份
            </button>
          </div>
          <button type="button" id="st-webdav-refresh-history" class="nvui-btn is-sm is-ghost">
            <i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i>
            刷新列表
          </button>
        </div>

        <div class="nvui-hint" id="st-webdav-history-dir-hint">远端路径：正在连接...</div>
        <div class="nvui-hint" id="st-webdav-shared-dir-hint" style="display: none;">共享目录：正在连接...</div>

        <div id="st-webdav-history-list" style="display: flex; flex-direction: column; gap: var(--nvui-space-2);">
          <div class="nvui-hint" style="text-align: center; padding: var(--nvui-space-4);">
            <span class="nvui-spinner" aria-hidden="true"></span> 正在连接 WebDAV 获取备份列表...
          </div>
        </div>
      </div>
    `;

    pane.querySelector('#st-webdav-refresh-history').addEventListener('click', () => {
      loadHistoryList(true);
    });
    pane.querySelector('#st-webdav-mode-mine').addEventListener('click', () => switchHistoryMode('mine'));
    pane.querySelector('#st-webdav-mode-shared').addEventListener('click', () => switchHistoryMode('shared'));

    // 初始化时异步拉取
    loadHistoryList();
  }

  // 切换「我的备份 / 共享备份」视图
  function switchHistoryMode(mode) {
    historyMode = mode;
    const pane = getTabPane('history');
    if (!pane) return;

    const mineBtn = pane.querySelector('#st-webdav-mode-mine');
    const sharedBtn = pane.querySelector('#st-webdav-mode-shared');
    if (mineBtn && sharedBtn) {
      const mine = mode === 'mine';
      mineBtn.classList.toggle('is-primary', mine);
      mineBtn.classList.toggle('is-secondary', !mine);
      mineBtn.setAttribute('aria-pressed', mine ? 'true' : 'false');
      sharedBtn.classList.toggle('is-primary', !mine);
      sharedBtn.classList.toggle('is-secondary', mine);
      sharedBtn.setAttribute('aria-pressed', mine ? 'false' : 'true');
    }

    loadHistoryList(true);
  }

  // 远端历史列表：按当前视图分派
  async function loadHistoryList(force = false) {
    if (historyMode === 'shared') return loadSharedList(force);
    return loadMyBackupList(force);
  }

  // 生成列表加载中的占位
  function renderLoadingPlaceholder(text) {
    return `<div class="nvui-hint" style="text-align: center; padding: var(--nvui-space-4);"><span class="nvui-spinner" aria-hidden="true"></span> ${escapeHtml(text)}</div>`;
  }

  // 分类徽章（历史 / 共享卡片共用）
  function renderCategoryHint(categories, catNamesMap) {
    if (!Array.isArray(categories) || !categories.length) return '';
    // 分类名同样来自远端字典，统一在出口处转义一次
    const text = categories.map(c => catNamesMap[c] || c).join('、');
    if (!text) return '';
    return `<div class="nvui-hint" style="margin-top: var(--nvui-space-1); font-size: var(--nvui-fs-xs);">包含类别：${escapeHtml(text)}</div>`;
  }

  // 备份范围徽章
  function renderScopeBadge(scope, categories) {
    if (scope === 'full') return '<span class="nvui-badge is-accent">全量</span>';
    if (scope === 'custom') {
      const catCount = Array.isArray(categories) ? categories.length : 0;
      return `<span class="nvui-badge is-info">自定义 (${catCount}项)</span>`;
    }
    return '<span class="nvui-badge is-success">核心</span>';
  }

  // 备注块
  function renderNote(note) {
    if (!note) return '';
    return `
      <div class="st-webdav-card-note">
        <i class="fa-regular fa-comment-dots" aria-hidden="true"></i>
        <span>${escapeHtml(note)}</span>
      </div>
    `;
  }

  // 我的备份卡片
  function renderMyBackupCard(b, catNamesMap) {
    const name = b?.name || '';
    const scopeBadge = renderScopeBadge(b?.scope, b?.categories);
    const encBadge = b?.encrypted
      ? '<span class="nvui-badge is-warn"><i class="fa-solid fa-lock" aria-hidden="true"></i> 加密</span>'
      : '';
    const userBadge = (b?.user?.handle && b.user.handle !== 'default-user')
      ? `<span class="nvui-badge is-subtle"><i class="fa-solid fa-user" aria-hidden="true"></i> ${escapeHtml(b.user.displayName || b.user.handle)}</span>`
      : '';
    const shared = sharedFileNames.has(name);
    const sharedBadge = shared
      ? '<span class="nvui-badge is-subtle"><i class="fa-solid fa-share-nodes" aria-hidden="true"></i> 已共享</span>'
      : '';
    const shareBtn = shared
      ? `<button type="button" class="nvui-btn is-sm is-ghost st-share-btn" data-name="${escapeHtml(name)}" disabled>
          <i class="fa-solid fa-share-nodes" aria-hidden="true"></i>
          已共享
        </button>`
      : `<button type="button" class="nvui-btn is-sm is-secondary st-share-btn" data-name="${escapeHtml(name)}">
          <i class="fa-solid fa-share-nodes" aria-hidden="true"></i>
          分享
        </button>`;

    return `
      <div class="st-webdav-card" data-name="${escapeHtml(name)}">
        <div class="st-webdav-card-header">
          <span class="st-webdav-card-title">
            <i class="fa-solid fa-file-zipper" aria-hidden="true"></i>
            ${escapeHtml(name)}
          </span>
          <div class="st-webdav-bar">
            ${userBadge}
            ${sharedBadge}
            ${scopeBadge}
            ${encBadge}
          </div>
        </div>

        <div class="st-webdav-card-meta">
          <span><i class="fa-regular fa-clock" aria-hidden="true"></i> ${formatDate(b?.lastModified)}</span>
          <span><i class="fa-solid fa-hard-drive" aria-hidden="true"></i> ${formatSize(b?.size)}</span>
        </div>

        ${renderNote(b?.note)}
        ${renderCategoryHint(b?.categories, catNamesMap)}

        <div class="st-webdav-bar" style="margin-top: var(--nvui-space-1); justify-content: flex-end;">
          <button type="button" class="nvui-btn is-sm is-primary st-restore-btn" data-name="${escapeHtml(name)}" data-enc="${b?.encrypted ? 'true' : 'false'}">
            <i class="fa-solid fa-rotate-left" aria-hidden="true"></i>
            还原此备份
          </button>
          ${shareBtn}
          <button type="button" class="nvui-btn is-sm is-danger is-ghost st-delete-btn" data-name="${escapeHtml(name)}">
            <i class="fa-solid fa-trash" aria-hidden="true"></i>
            删除
          </button>
        </div>
      </div>
    `;
  }

  // 共享备份卡片
  function renderSharedBackupCard(b, catNamesMap) {
    const name = b?.name || '';
    const scopeBadge = renderScopeBadge(b?.scope, b?.categories);
    const encBadge = b?.encrypted
      ? '<span class="nvui-badge is-warn"><i class="fa-solid fa-lock" aria-hidden="true"></i> 加密</span>'
      : '';
    const sharedBy = b?.sharedBy || {};
    const byLabel = sharedBy.displayName || sharedBy.handle || '未知用户';

    return `
      <div class="st-webdav-card st-webdav-card-shared" data-name="${escapeHtml(name)}">
        <div class="st-webdav-card-header">
          <span class="st-webdav-card-title">
            <i class="fa-solid fa-file-zipper" aria-hidden="true"></i>
            ${escapeHtml(name)}
          </span>
          <div class="st-webdav-bar">
            <span class="nvui-badge is-subtle"><i class="fa-solid fa-share-nodes" aria-hidden="true"></i> 由 ${escapeHtml(byLabel)} 分享</span>
            ${scopeBadge}
            ${encBadge}
          </div>
        </div>

        <div class="st-webdav-card-meta">
          <span><i class="fa-regular fa-clock" aria-hidden="true"></i> ${formatDate(b?.lastModified)}</span>
          <span><i class="fa-solid fa-hard-drive" aria-hidden="true"></i> ${formatSize(b?.size)}</span>
          <span><i class="fa-regular fa-share-from-square" aria-hidden="true"></i> 分享于 ${formatDate(b?.sharedAt)}</span>
        </div>

        ${renderNote(b?.note)}
        ${renderCategoryHint(b?.categories, catNamesMap)}

        <div class="st-webdav-bar" style="margin-top: var(--nvui-space-1); justify-content: flex-end;">
          <button type="button" class="nvui-btn is-sm is-primary st-shared-restore-btn" data-name="${escapeHtml(name)}" data-enc="${b?.encrypted ? 'true' : 'false'}">
            <i class="fa-solid fa-rotate-left" aria-hidden="true"></i>
            还原此备份
          </button>
          <button type="button" class="nvui-btn is-sm is-danger is-ghost st-unshare-btn" data-name="${escapeHtml(name)}">
            <i class="fa-solid fa-share-from-square" aria-hidden="true"></i>
            取消分享
          </button>
        </div>
      </div>
    `;
  }

  // 我的备份列表
  async function loadMyBackupList(force = false) {
    if (isLoadingHistory && !force) return;

    const pane = getTabPane('history');
    const container = pane?.querySelector('#st-webdav-history-list');
    if (!container) return;
    const badgeEl = pane.querySelector('#st-webdav-history-count-badge');
    const dirHintEl = pane.querySelector('#st-webdav-history-dir-hint');
    const sharedHintEl = pane.querySelector('#st-webdav-shared-dir-hint');

    // 视图令牌：切换「我的/共享」后，旧请求的迟到响应不得覆盖新视图
    const token = ++historyLoadToken;
    const isStale = () => token !== historyLoadToken;

    isLoadingHistory = true;
    container.innerHTML = renderLoadingPlaceholder('正在拉取远端文件列表...');

    try {
      // 与 /backups 并行拉取共享区名单，保证首帧渲染即可正确标记「已共享」
      const [res, sharedRes] = await Promise.all([
        apiCall('/backups'),
        apiCall('/shared').catch(() => null),
      ]);
      if (isStale()) return;
      const backups = Array.isArray(res?.backups) ? res.backups : [];

      if (sharedRes) {
        const sharedList = Array.isArray(sharedRes?.backups) ? sharedRes.backups : [];
        sharedFileNames = new Set(sharedList.map(b => b?.name).filter(Boolean));
      }

    if (badgeEl) badgeEl.textContent = `${backups.length} 个备份`;
    // 切回「我的备份」时恢复远端路径提示、隐藏共享目录提示
    if (dirHintEl) dirHintEl.style.display = '';
    if (sharedHintEl) sharedHintEl.style.display = 'none';
    if (dirHintEl) {
      dirHintEl.textContent = res?.remoteDirectory ? `远端目录: ${res.remoteDirectory}` : '远端目录已连接';
    }

      if (!backups.length) {
        container.innerHTML = `
          <div class="nvui-empty" style="text-align: center; padding: var(--nvui-space-4);">
            <div style="font-size: var(--nvui-fs-xl); margin-bottom: var(--nvui-space-2); color: var(--nvui-text-3);">
              <i class="fa-solid fa-box-open" aria-hidden="true"></i>
            </div>
            <div style="font-weight: var(--nvui-fw-medium); color: var(--nvui-text);">远端 WebDAV 暂无备份文件</div>
            <div class="nvui-hint" style="margin-top: var(--nvui-space-1);">前往「备份操作」标签页可立即发起配置备份。</div>
          </div>
        `;
        return;
      }

      const totalSize = backups.reduce((s, b) => s + (b.size || 0), 0);
      if (dirHintEl) {
        dirHintEl.textContent = `远端目录: ${res.remoteDirectory || 'Backups'} (共 ${formatSize(totalSize)})`;
      }

      const catNamesMap = getCategoryNameMap();
      container.innerHTML = backups.map(b => renderMyBackupCard(b, catNamesMap)).join('');

      bindMyBackupActions(container);
      // 共享区拉取失败时后台补一次（失败静默，不影响我的备份列表）
      if (!sharedRes) syncSharedMarks(container);
    } catch (err) {
      if (isStale()) return;
      if (badgeEl) badgeEl.textContent = '获取失败';
      container.innerHTML = `
        <div class="nvui-alert is-error" style="margin-top: var(--nvui-space-2);">
          <i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i>
          <span>拉取历史失败: ${escapeHtml(err.message)}</span>
        </div>
      `;
    } finally {
      if (!isStale()) isLoadingHistory = false;
    }
  }

  // 共享备份列表
  async function loadSharedList(force = false) {
    if (isLoadingHistory && !force) return;

    const pane = getTabPane('history');
    const container = pane?.querySelector('#st-webdav-history-list');
    if (!container) return;
    const badgeEl = pane.querySelector('#st-webdav-history-count-badge');
    const dirHintEl = pane.querySelector('#st-webdav-history-dir-hint');
    const sharedHintEl = pane.querySelector('#st-webdav-shared-dir-hint');

    // 视图令牌：切换「我的/共享」后，旧请求的迟到响应不得覆盖新视图
    const token = ++historyLoadToken;
    const isStale = () => token !== historyLoadToken;

    isLoadingHistory = true;
    container.innerHTML = renderLoadingPlaceholder('正在拉取共享区备份列表...');

    try {
      const res = await apiCall('/shared');
      if (isStale()) return;
      const backups = Array.isArray(res?.backups) ? res.backups : [];

      // 记录当前共享区文件名，用于「我的备份」卡片标记已共享
      sharedFileNames = new Set(backups.map(b => b?.name).filter(Boolean));

      if (badgeEl) badgeEl.textContent = `${backups.length} 个共享备份`;
      if (dirHintEl) dirHintEl.style.display = 'none';
      if (sharedHintEl) {
        sharedHintEl.style.display = '';
        sharedHintEl.textContent = res?.sharedDirectory
          ? `共享目录: ${res.sharedDirectory}（该目录下所有用户与账号可见）`
          : '共享目录已连接（该目录下所有用户与账号可见）';
      }

      if (!backups.length) {
        container.innerHTML = `
          <div class="nvui-empty" style="text-align: center; padding: var(--nvui-space-4);">
            <div style="font-size: var(--nvui-fs-xl); margin-bottom: var(--nvui-space-2); color: var(--nvui-text-3);">
              <i class="fa-solid fa-share-nodes" aria-hidden="true"></i>
            </div>
            <div style="font-weight: var(--nvui-fw-medium); color: var(--nvui-text);">共享区暂无备份</div>
            <div class="nvui-hint" style="margin-top: var(--nvui-space-1);">可在「我的备份」中点击「分享」把备份发布到共享区。</div>
          </div>
        `;
        return;
      }

      const catNamesMap = getCategoryNameMap();
      container.innerHTML = backups.map(b => renderSharedBackupCard(b, catNamesMap)).join('');
      bindSharedBackupActions(container);
    } catch (err) {
      if (isStale()) return;
      if (badgeEl) badgeEl.textContent = '获取失败';
      container.innerHTML = `
        <div class="nvui-alert is-error" style="margin-top: var(--nvui-space-2);">
          <i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i>
          <span>拉取共享备份失败: ${escapeHtml(err.message)}</span>
        </div>
      `;
    } finally {
      if (!isStale()) isLoadingHistory = false;
    }
  }

  // 拉取共享区名单，就地标记「已共享」按钮（失败静默）
  async function syncSharedMarks(container) {
    if (sharedSyncPending) return;
    sharedSyncPending = true;
    try {
      const res = await apiCall('/shared');
      const list = Array.isArray(res?.backups) ? res.backups : [];
      const names = new Set(list.map(b => b?.name).filter(Boolean));
      sharedFileNames = names;
      container.querySelectorAll('.st-webdav-card[data-name]').forEach(card => {
        const name = card.getAttribute('data-name');
        const btn = card.querySelector('.st-share-btn');
        if (!btn || !names.has(name)) return;
        btn.disabled = true;
        btn.classList.remove('is-secondary');
        btn.classList.add('is-ghost');
        btn.innerHTML = '<i class="fa-solid fa-share-nodes" aria-hidden="true"></i> 已共享';
      });
    } catch {
      // 共享区不可用时静默跳过，不影响「我的备份」列表
    } finally {
      sharedSyncPending = false;
    }
  }

  // —— 面板内联确认区（替代原生 confirm / prompt）——
  // 每次展开前先清理上一次遗留的确认区，保证全局同一时刻只有一处确认区
  function clearConfirmAreas() {
    const pane = getTabPane('history');
    if (!pane) return;
    pane.querySelectorAll('.st-webdav-confirm').forEach(el => el.remove());
  }

  function openConfirmArea(card, options) {
    if (!card) return;
    clearConfirmAreas();

    const area = document.createElement('div');
    area.className = 'st-webdav-confirm nvui-alert ' + (options.variant || 'is-warning');

    const icon = document.createElement('i');
    icon.className = options.icon || 'fa-solid fa-triangle-exclamation';
    icon.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    body.className = 'st-webdav-confirm-body';

    const title = document.createElement('div');
    title.className = 'st-webdav-confirm-title';
    title.textContent = options.title || '请确认操作';

    const msg = document.createElement('div');
    msg.className = 'nvui-hint';
    msg.textContent = options.message || '';

    body.appendChild(title);
    body.appendChild(msg);

    let passwordInput = null;
    if (options.needPassword) {
      passwordInput = document.createElement('input');
      passwordInput.type = 'password';
      passwordInput.className = 'nvui-input';
      passwordInput.placeholder = '输入解密口令';
      passwordInput.autocomplete = 'current-password';
      body.appendChild(passwordInput);
    }

    const bar = document.createElement('div');
    bar.className = 'st-webdav-bar';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'nvui-btn is-sm ' + (options.confirmVariant || 'is-primary');
    okBtn.textContent = options.confirmText || '确认';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'nvui-btn is-sm is-ghost';
    cancelBtn.textContent = options.cancelText || '取消';

    bar.appendChild(okBtn);
    bar.appendChild(cancelBtn);
    body.appendChild(bar);

    area.appendChild(icon);
    area.appendChild(body);
    card.appendChild(area);

    cancelBtn.addEventListener('click', () => area.remove());

    okBtn.addEventListener('click', async () => {
      const password = passwordInput ? passwordInput.value.trim() : '';
      if (passwordInput && !password) {
        toast('解密口令不能为空', 'warn');
        passwordInput.focus();
        return;
      }
      okBtn.disabled = true;
      cancelBtn.disabled = true;
      try {
        await options.onConfirm(password);
      } catch (err) {
        toast(err.message || String(err), 'danger');
      } finally {
        okBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    });

    try {
      area.scrollIntoView({ block: 'nearest' });
    } catch {}
    if (passwordInput) passwordInput.focus();
  }

  // 还原成功后的刷新确认（同样内联，不用原生 confirm）
  function openReloadConfirm(card) {
    openConfirmArea(card, {
      variant: 'is-info',
      icon: 'fa-solid fa-circle-info',
      title: '恢复完成',
      message: '配置已还原成功！是否立刻刷新酒馆页面以加载全新配置？',
      confirmText: '立刻刷新',
      cancelText: '稍后再说',
      onConfirm: async () => {
        window.location.reload();
      },
    });
  }

  // 还原流程：内联确认区 -> 调接口 -> 内联刷新确认
  function confirmAndRestore(card, fileName, isEncrypted, fromShared = false) {
    openConfirmArea(card, {
      variant: 'is-warning',
      icon: 'fa-solid fa-rotate-left',
      title: isEncrypted ? '还原加密备份' : '还原备份',
      message: `将从${fromShared ? '共享区' : '远端备份'}还原「${fileName}」。插件会在还原前自动为当前配置制作安全回滚快照。${isEncrypted ? '该备份已加密，请输入解密口令。' : ''}`,
      needPassword: isEncrypted,
      confirmText: '确认还原',
      onConfirm: async (password) => {
        const res = await apiCall('/restore', 'POST', {
          fileName,
          password,
          createRollback: true,
          fromShared: !!fromShared,
        });
        toast(res?.message || '恢复完成！', 'ok');
        openReloadConfirm(card);
      },
    });
  }

  // 删除流程：内联确认区
  function confirmAndDelete(card, fileName) {
    openConfirmArea(card, {
      variant: 'is-error',
      icon: 'fa-solid fa-triangle-exclamation',
      title: '危险操作',
      message: `确定要从 WebDAV 彻底删除备份「${fileName}」？此操作不可撤销。`,
      confirmText: '确认删除',
      confirmVariant: 'is-danger',
      onConfirm: async () => {
        try {
          await apiCall('/delete', 'POST', { fileName });
          toast('已删除远端备份', 'ok');
          loadHistoryList(true);
        } catch (err) {
          toast(`删除失败: ${err.message}`, 'danger');
        }
      },
    });
  }

  // 分享流程
  async function shareBackup(fileName) {
    try {
      const res = await apiCall('/share', 'POST', { fileName });
      sharedFileNames.add(fileName);
      toast(res?.message || '已分享到共享区', 'ok');
      loadHistoryList(true);
    } catch (err) {
      // 409 = 同名备份已由其他用户共享
      toast(err.message, err.status === 409 ? 'warn' : 'danger');
    }
  }

  // 取消分享流程
  function confirmAndUnshare(card, fileName) {
    openConfirmArea(card, {
      variant: 'is-warning',
      icon: 'fa-solid fa-share-from-square',
      title: '取消分享',
      message: `确定要取消分享备份「${fileName}」？取消后其他用户与账号将无法在共享区看到它。`,
      confirmText: '确认取消分享',
      onConfirm: async () => {
        try {
          await apiCall('/unshare', 'POST', { fileName });
          sharedFileNames.delete(fileName);
          toast('已取消分享', 'ok');
          loadHistoryList(true);
        } catch (err) {
          // 403 = 无权限（非分享者且非管理员）
          toast(err.message, err.status === 403 ? 'warn' : 'danger');
        }
      },
    });
  }

  // 绑定我的备份卡片上的操作
  function bindMyBackupActions(container) {
    container.querySelectorAll('.st-restore-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const fileName = btn.getAttribute('data-name');
        const isEnc = btn.getAttribute('data-enc') === 'true';
        confirmAndRestore(btn.closest('.st-webdav-card'), fileName, isEnc, false);
      });
    });

    container.querySelectorAll('.st-share-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        shareBackup(btn.getAttribute('data-name'));
      });
    });

    container.querySelectorAll('.st-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const fileName = btn.getAttribute('data-name');
        confirmAndDelete(btn.closest('.st-webdav-card'), fileName);
      });
    });
  }

  // 绑定共享备份卡片上的操作
  function bindSharedBackupActions(container) {
    container.querySelectorAll('.st-shared-restore-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const fileName = btn.getAttribute('data-name');
        const isEnc = btn.getAttribute('data-enc') === 'true';
        confirmAndRestore(btn.closest('.st-webdav-card'), fileName, isEnc, true);
      });
    });

    container.querySelectorAll('.st-unshare-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const fileName = btn.getAttribute('data-name');
        confirmAndUnshare(btn.closest('.st-webdav-card'), fileName);
      });
    });
  }

  // —— 分区 3：服务设置 (Settings Tab) ——
  function buildSettingsTab() {
    const pane = getTabPane('settings');
    if (!pane) return;

    pane.innerHTML = `
      <div class="st-webdav-container">
        <!-- 分区标准标题行 -->
        <div class="nvui-panel-heading">
          <span class="nvui-section-title">服务配置</span>
          <span class="nvui-badge">WebDAV &amp; 自动化</span>
        </div>

        <!-- WebDAV 连接设置 (折叠容器必须符合 Kit DOM 契约：.nvui-acc-body > .nvui-acc-inner) -->
        <div class="nvui-acc is-open" id="st-webdav-acc-conn">
          <button type="button" class="nvui-acc-head" aria-expanded="true">
            <span class="nvui-acc-title"><i class="fa-solid fa-server" aria-hidden="true"></i> WebDAV 服务器配置</span>
            <span class="nvui-acc-summary" id="st-webdav-conn-sum">连接参数</span>
            <i class="nvui-acc-chev" aria-hidden="true"></i>
          </button>
          <div class="nvui-acc-body">
            <div class="nvui-acc-inner">
              <label class="nvui-input-row">
                <input type="text" id="cfg-url" class="nvui-input is-path" placeholder="https://dav.jianguoyun.com/dav/sillytavern/">
                <span>服务端根 URL</span>
              </label>

              <div class="st-webdav-grid2">
                <label class="nvui-input-row">
                  <input type="text" id="cfg-username" class="nvui-input" placeholder="用户名 / 账号">
                  <span>用户名</span>
                </label>
                <label class="nvui-input-row">
                  <input type="password" id="cfg-password" class="nvui-input" placeholder="密码 / 授权应用口令" autocomplete="new-password">
                  <span>密码 / Token</span>
                </label>
              </div>

              <div class="st-webdav-grid2">
                <label class="nvui-input-row">
                  <input type="text" id="cfg-remotedir" class="nvui-input" placeholder="SillyTavern_Backups">
                  <span>远端备份根目录</span>
                </label>
                <label class="nvui-input-row">
                  <input type="number" id="cfg-timeout" class="nvui-input is-number" placeholder="15000" min="3000" step="1000">
                  <span>超时时间 (毫秒)</span>
                </label>
              </div>

              <label class="nvui-switch-row" style="margin-top: var(--nvui-space-1);">
                <input type="checkbox" id="cfg-isolate-user" checked>
                <span>开启多用户独立子目录空间隔离</span>
              </label>
              <div id="cfg-user-dir-hint" class="nvui-hint" style="margin-top: var(--nvui-space-05);"></div>

              <div class="st-webdav-bar" style="margin-top: var(--nvui-space-1);">
                <button type="button" id="cfg-test-btn" class="nvui-btn is-secondary">
                  <i class="fa-solid fa-plug-circle-check" aria-hidden="true"></i>
                  测试连接
                </button>
                <span id="cfg-test-result" class="nvui-hint"></span>
              </div>
            </div>
          </div>
        </div>

        <!-- 自动化与策略 -->
        <div class="nvui-acc is-open" id="st-webdav-acc-policy">
          <button type="button" class="nvui-acc-head" aria-expanded="true">
            <span class="nvui-acc-title"><i class="fa-solid fa-clock" aria-hidden="true"></i> 自动化与历史轮转策略</span>
            <span class="nvui-acc-summary" id="st-webdav-policy-sum">定时任务与保留份数</span>
            <i class="nvui-acc-chev" aria-hidden="true"></i>
          </button>
          <div class="nvui-acc-body">
            <div class="nvui-acc-inner">
              <label class="nvui-switch-row is-feature">
                <input type="checkbox" id="cfg-auto-enabled">
                <span>开启服务端自动化定时全量备份</span>
              </label>

              <div class="st-webdav-grid2">
                <label class="nvui-input-row">
                  <input type="number" id="cfg-auto-interval" class="nvui-input is-number" min="1" max="168" value="24">
                  <span>备份间隔 (小时)</span>
                </label>
                <label class="nvui-input-row">
                  <input type="number" id="cfg-retention" class="nvui-input is-number" min="1" max="100" value="10">
                  <span>远端备份保留份数 (超出自动清理)</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <!-- UI Kit 模式与扩展设置 -->
        <div class="nvui-acc" id="st-webdav-acc-uikit">
          <button type="button" class="nvui-acc-head" aria-expanded="false">
            <span class="nvui-acc-title"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> UI Kit 模式与扩展源</span>
            <span class="nvui-acc-summary" id="st-webdav-uikit-sum">本地 Vendored / CDN</span>
            <i class="nvui-acc-chev" aria-hidden="true"></i>
          </button>
          <div class="nvui-acc-body">
            <div class="nvui-acc-inner">
              <label class="nvui-input-row">
                <input type="text" id="cfg-cdn-base" class="nvui-input is-path" value="${escapeHtml(DEFAULT_CDN)}">
                <span>备用 CDN 地址</span>
              </label>
              <span class="nvui-hint">当前模式：默认优先加载本地 Vendored UI-Kit（零网络延迟、100% 离线支持）。若本地缺失可使用上述 CDN 降级镜像。</span>
              <span class="nvui-hint" id="st-webdav-version-hint" style="margin-top: var(--nvui-space-05);"></span>
            </div>
          </div>
        </div>

        <!-- 保存按钮 -->
        <div class="st-webdav-bar" style="margin-top: var(--nvui-space-2);">
          <button type="button" id="cfg-save-btn" class="nvui-btn is-primary" style="flex: 1 1 auto;">
            <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
            保存配置
          </button>
        </div>
      </div>
    `;

    // 折叠菜单展开联动
    pane.querySelectorAll('.nvui-acc-head').forEach(head => {
      head.addEventListener('click', () => {
        const acc = head.closest('.nvui-acc');
        const open = acc.classList.toggle('is-open');
        head.setAttribute('aria-expanded', String(open));
      });
    });

    // 测试连接按钮
    const testBtn = pane.querySelector('#cfg-test-btn');
    const testMsg = pane.querySelector('#cfg-test-result');
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testBtn.innerHTML = '<span class="nvui-spinner" aria-hidden="true"></span> 探测中...';
      testMsg.textContent = '';

      try {
        const res = await apiCall('/test', 'POST', {
          url: pane.querySelector('#cfg-url').value.trim(),
          username: pane.querySelector('#cfg-username').value.trim(),
          password: pane.querySelector('#cfg-password').value,
          timeoutMs: Number(pane.querySelector('#cfg-timeout')?.value) || 15000,
        });

        if (res.ok) {
          testMsg.className = 'nvui-hint is-ok';
          testMsg.textContent = `连接成功！${res.message}`;
          toast('WebDAV 测试连接成功', 'ok');
        } else {
          testMsg.className = 'nvui-hint is-danger';
          testMsg.textContent = `测试失败: ${res.message}`;
          toast(res.message, 'danger');
        }
      } catch (err) {
        testMsg.className = 'nvui-hint is-danger';
        testMsg.textContent = err.message;
        toast(err.message, 'danger');
      } finally {
        testBtn.disabled = false;
        testBtn.innerHTML = '<i class="fa-solid fa-plug-circle-check" aria-hidden="true"></i> 测试连接';
      }
    });

    // 保存配置按钮
    const saveBtn = pane.querySelector('#cfg-save-btn');
    saveBtn.addEventListener('click', async () => {
      try {
        saveBtn.disabled = true;
        const newCfg = {
          webdavUrl: pane.querySelector('#cfg-url').value.trim(),
          webdavUsername: pane.querySelector('#cfg-username').value.trim(),
          webdavPassword: pane.querySelector('#cfg-password').value,
          remoteDirectory: pane.querySelector('#cfg-remotedir').value.trim() || 'SillyTavern_Backups',
          isolateUserDirectory: pane.querySelector('#cfg-isolate-user')?.checked !== false,
          timeoutMs: Number(pane.querySelector('#cfg-timeout')?.value) || 15000,
          autoBackupEnabled: pane.querySelector('#cfg-auto-enabled').checked,
          autoBackupIntervalHours: Number(pane.querySelector('#cfg-auto-interval').value) || 24,
          retentionCount: Number(pane.querySelector('#cfg-retention').value) || 10,
          cdnBase: pane.querySelector('#cfg-cdn-base').value.trim() || DEFAULT_CDN,
        };

        const saved = await apiCall('/config', 'POST', newCfg);
        currentConfig = saved;
        toast('配置已成功保存！', 'ok');
        checkWebDavHealth();
        loadHistoryList();
        updateSettingsSummaries(saved);
      } catch (err) {
        toast(`保存失败: ${err.message}`, 'danger');
      } finally {
        saveBtn.disabled = false;
      }
    });

    loadSettingsForm();
  }

  // 动态更新 Accordion 摘要信息
  function updateSettingsSummaries(cfg) {
    const pane = getTabPane('settings');
    const connSum = pane?.querySelector('#st-webdav-conn-sum');
    if (connSum) {
      if (cfg.webdavUrl) {
        try {
          const u = new URL(cfg.webdavUrl);
          connSum.textContent = `已配置 (${u.hostname})`;
        } catch {
          connSum.textContent = '已配置';
        }
      } else {
        connSum.textContent = '未配置';
      }
    }

    const policySum = pane?.querySelector('#st-webdav-policy-sum');
    if (policySum) {
      if (cfg.autoBackupEnabled) {
        policySum.textContent = `已开启 (每 ${cfg.autoBackupIntervalHours || 24}h / 保留 ${cfg.retentionCount || 10} 份)`;
      } else {
        policySum.textContent = `已关闭 (保留 ${cfg.retentionCount || 10} 份)`;
      }
    }
  }

  // 回填设置表单
  async function loadSettingsForm() {
    const pane = getTabPane('settings');
    if (!pane) return;

    try {
      const cfg = await apiCall('/config');
      currentConfig = cfg;

      const setVal = (id, val) => {
        const el = pane.querySelector(`#${id}`);
        if (el) el.value = val !== undefined && val !== null ? val : '';
      };
      const setCheck = (id, val) => {
        const el = pane.querySelector(`#${id}`);
        if (el) el.checked = !!val;
      };

      setVal('cfg-url', cfg.webdavUrl);
      setVal('cfg-username', cfg.webdavUsername);
      setVal('cfg-password', cfg.webdavPassword);
      setVal('cfg-remotedir', cfg.remoteDirectory || 'SillyTavern_Backups');
      setCheck('cfg-isolate-user', cfg.isolateUserDirectory !== false);
      setVal('cfg-timeout', cfg.timeoutMs || 15000);
      setCheck('cfg-auto-enabled', cfg.autoBackupEnabled);
      setVal('cfg-auto-interval', cfg.autoBackupIntervalHours || 24);
      setVal('cfg-retention', cfg.retentionCount || 10);
      setVal('cfg-cdn-base', cfg.cdnBase || DEFAULT_CDN);

      updateSettingsSummaries(cfg);

      // 显示插件版本与 UI Kit 版本（排障时需要确认实际生效的版本）
      const versionHint = pane.querySelector('#st-webdav-version-hint');
      if (versionHint) {
        const pluginVer = resolvePluginVersion(cfg);
        const kitVer = (NVUI && NVUI.version) ? `v${NVUI.version}` : '未知';
        versionHint.innerHTML = `<i class="fa-solid fa-circle-info" aria-hidden="true"></i> 插件版本 <code>${escapeHtml(pluginVer)}</code> · UI Kit 版本 <code>${escapeHtml(kitVer)}</code>`;
      }
      const kitSummary = pane.querySelector('#st-webdav-uikit-sum');
      if (kitSummary) {
        kitSummary.textContent = (NVUI && NVUI.version) ? `UI Kit v${NVUI.version}` : '本地 Vendored / CDN';
      }

      const userHint = pane.querySelector('#cfg-user-dir-hint');
      if (userHint && cfg.currentUser) {
        if (cfg.currentUser.isMultiUser) {
          userHint.innerHTML = `<i class="fa-solid fa-user-shield" aria-hidden="true"></i> 多用户环境：当前账号「<b>${escapeHtml(cfg.currentUser.displayName || cfg.currentUser.handle)}</b>」，实际远端工作路径为：<code>${escapeHtml(cfg.effectiveRemoteDirectory || '')}</code>`;
        } else {
          userHint.innerHTML = `<i class="fa-solid fa-user" aria-hidden="true"></i> 当前运行在单用户模式，远端工作路径为：<code>${escapeHtml(cfg.effectiveRemoteDirectory || cfg.remoteDirectory || 'SillyTavern_Backups')}</code>`;
        }
      }
    } catch (err) {
      toast('配置加载失败，请稍后重试', 'warn');
    }
  }

  // ---------- 4. 注册酒馆入口菜单按钮 ----------
  function registerMenuEntry(attempt = 0) {
    if (document.getElementById('st-webdav-menu-btn')) return;

    const extensionsMenu = document.getElementById('extensionsMenu');
    if (!extensionsMenu) {
      // 轮询上限 30 次（约 30 秒），超限后停止并告警
      if (attempt >= 30) {
        console.warn('[ST-WebDAV] 等待酒馆扩展菜单超时（已轮询 30 次），放弃挂载入口按钮');
        return;
      }
      setTimeout(() => registerMenuEntry(attempt + 1), 1000);
      return;
    }

    const btn = document.createElement('div');
    btn.id = 'st-webdav-menu-btn';
    btn.className = 'list-group-item flex-container flexGap5';
    btn.innerHTML = '<div class="fa-solid fa-cloud-arrow-up extensionsMenuExtensionButton" aria-hidden="true"></div>WebDAV 备份';
    btn.addEventListener('click', async () => {
      try {
        const p = await initUI();
        p.open();
        // 面板打开时按当前分区做一次必要的刷新（健康检查 / 列表 / 表单）
        onTabActivated(activeTabKey);
      } catch (err) {
        toast(`打开面板失败: ${err.message}`, 'danger');
      }
    });

    extensionsMenu.appendChild(btn);
  }

  // 酒馆就绪后挂载
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => registerMenuEntry(0));
  } else {
    registerMenuEntry(0);
  }
})();
