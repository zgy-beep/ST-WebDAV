/**
 * ST-WebDAV 前端扩展 · 基于 SillyTavern NVUI Kit v2.4.0 规范
 * -------------------------------------------------------------
 * 1. 优先加载本地 Vendored UI-Kit (tokens.css, components.css, nvui-api.js)，支持离线并安全降级；
 * 2. 严格遵循面板布局标准与无障碍契约 (dialog.nvui-tl, role, aria-*)；
 * 3. 规范使用 NVUI 设计令牌与原子组件 (nvui-panel-heading, nvui-alert, nvui-switch-row, nvui-acc)；
 * 4. 彻底消除表情符号 (Emoji)，采用 Font Awesome 图标规范；
 * 5. 去除破坏性 z-index 硬编码与多层滚动条，原生兼容桌面端居中与移动端底部抽屉。
 */

(function () {
  'use strict';

  const DEFAULT_CDN = 'https://cdn.jsdelivr.net/gh/zgy-beep/ui-kit@main';
  let NVUI = null;
  let panel = null;
  let currentConfig = {};
  let isBackingUp = false;

  // ---------- 1. 加载 UI Kit (优先本地 Vendored，安全降级 CDN) ----------
  function loadCss(id, href) {
    return new Promise(resolve => {
      if (document.getElementById(id)) return resolve();
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = link.onerror = () => resolve();
      document.head.appendChild(link);
      setTimeout(resolve, 6000); // 防网络悬挂
    });
  }

  async function ensureNVUI(cdnBase = DEFAULT_CDN) {
    if (window.NVUI && typeof window.NVUI.createPanel === 'function') {
      NVUI = window.NVUI;
      return NVUI;
    }

    // 优先从本地 Vendored 目录直接加载 (零网络延迟、100% 离线支持、杜绝外部脚本注入)
    const localVendorBase = '/scripts/extensions/third-party/ST-WebDAV/src/client/vendor/ui-kit';
    try {
      await Promise.all([
        loadCss('nvui-css-tokens', `${localVendorBase}/tokens.css`),
        loadCss('nvui-css-components', `${localVendorBase}/components.css`),
      ]);

      if (!window.NVUI || typeof window.NVUI.createPanel !== 'function') {
        await new Promise((resolve, reject) => {
          if (document.getElementById('nvui-js-api-local')) return resolve();
          const script = document.createElement('script');
          script.id = 'nvui-js-api-local';
          script.src = `${localVendorBase}/nvui-api.js`;
          script.onload = () => resolve();
          script.onerror = () => reject();
          document.head.appendChild(script);
        });
      }

      if (window.NVUI && typeof window.NVUI.createPanel === 'function') {
        NVUI = window.NVUI;
        return NVUI;
      }
    } catch {
      // 本地若不可用，则安全降级到受信 CDN
    }

    // 安全降级：仅允许安全受信的 jsDelivr CDN
    let safeCdn = DEFAULT_CDN;
    try {
      const u = new URL(cdnBase);
      if (u.protocol === 'https:' && (u.hostname === 'cdn.jsdelivr.net' || u.hostname === 'fastly.jsdelivr.net')) {
        safeCdn = cdnBase.replace(/\/+$/, '');
      }
    } catch {}

    await Promise.all([
      loadCss('nvui-css-tokens', `${safeCdn}/tokens.css`),
      loadCss('nvui-css-components', `${safeCdn}/components.css`),
    ]);

    if (!window.NVUI || typeof window.NVUI.createPanel !== 'function') {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.id = 'nvui-js-api';
        script.src = `${safeCdn}/nvui-api.js`;
        script.onload = () => {
          NVUI = window.NVUI;
          resolve(NVUI);
        };
        script.onerror = () => reject(new Error('UI Kit 加载失败，请检查网络连接'));
        document.head.appendChild(script);
      });
    }

    NVUI = window.NVUI;
    return NVUI;
  }

  // 吐司提示统一封装
  function toast(message, type = 'info', icon = null) {
    if (NVUI && typeof NVUI.showToast === 'function') {
      const iconMap = {
        ok: 'fa-solid fa-circle-check',
        danger: 'fa-solid fa-circle-exclamation',
        warn: 'fa-solid fa-triangle-exclamation',
        info: 'fa-solid fa-circle-info',
      };
      NVUI.showToast({
        message,
        type,
        icon: icon || iconMap[type] || 'fa-solid fa-circle-info',
      });
    } else if (typeof toastr !== 'undefined') {
      toastr[type === 'danger' ? 'error' : (type === 'ok' ? 'success' : type)](message);
    } else {
      console.log(`[ST-WebDAV] [${type.toUpperCase()}] ${message}`);
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

    // 如果因 CSRF Token 失效导致 403，则自动刷新 Token 重试一次
    if (resp.status === 403 && method !== 'GET' && !isRetry) {
      console.warn('[ST-WebDAV] CSRF Token 可能已失效，正在刷新并重试...');
      cachedCsrfToken = '';
      const refreshedToken = await getCsrfToken(true);
      if (refreshedToken) {
        return apiCall(endpoint, method, body, true);
      }
    }

    if (resp.status === 404) {
      throw new Error('未检测到服务端插件：请在酒馆根目录 config.yaml 中将 enableServerPlugins 设置为 true 并重启酒馆。');
    }

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.error || data.message || `请求失败: HTTP ${resp.status}`);
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

  // 默认备份数据分类项
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

  // 辅助格式化字节大小
  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i] || 'B'}`;
  }

  // 辅助格式化时间
  function formatDate(isoStr) {
    if (!isoStr) return '未知时间';
    try {
      const d = new Date(isoStr);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch {
      return isoStr;
    }
  }

  // ---------- 3. 构建 UI Kit 标准面板 ----------
  async function initUI() {
    if (panel) return panel;

    // 先从服务端拉取配置以获取指定的 CDN 基础路径
    let cdnBase = DEFAULT_CDN;
    try {
      currentConfig = await apiCall('/config');
      if (currentConfig.cdnBase) cdnBase = currentConfig.cdnBase;
    } catch (err) {
      console.warn('[ST-WebDAV] 预取配置提示:', err.message);
    }

    // 加载 UI Kit 核心库
    await ensureNVUI(cdnBase);

    // 注入业务附加 CSS
    await loadCss('st-webdav-css', '/scripts/extensions/third-party/ST-WebDAV/style.css');

    // 使用 NVUI API 创建标准面板 (附带 focusFallback 防止焦点丢失)
    panel = NVUI.createPanel({
      id: 'st-webdav',
      title: 'WebDAV 备份与恢复',
      version: 'v1.0.0',
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

    // 填充各个分区内容
    buildBackupTab();
    buildHistoryTab();
    buildSettingsTab();

    // 绑定标签页切换事件 (桌面 tabs 与手机 bottomNav 同步)
    bindTabListeners();

    return panel;
  }

  // 辅助获取指定 tab 的内容 DOM 容器
  function getTabPane(key) {
    return panel.body.querySelector(`#${panel.id}-pane-${key}`) || panel.body;
  }

  // 绑定 Tab 切换监听：切换至各标签页时自动刷新对应数据
  function bindTabListeners() {
    if (!panel || !panel.dialog) return;
    const tabButtons = panel.dialog.querySelectorAll('.nvui-tab, .nvui-bottom-nav-item');
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.id || '';
        const text = btn.textContent || '';
        if (id.includes('history') || text.includes('历史')) {
          loadHistoryList();
        } else if (id.includes('settings') || text.includes('设置')) {
          loadSettingsForm();
        } else if (id.includes('backup') || text.includes('备份')) {
          checkWebDavHealth();
        }
      });
    });
  }

  // 刷新当前活动标签页
  function refreshCurrentTab() {
    loadHistoryList();
    loadSettingsForm();
    checkWebDavHealth();
    toast('已刷新数据', 'info');
  }

  // —— 分区 1：备份操作 (Backup Tab) ——
  function buildBackupTab() {
    const pane = getTabPane('backup');
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
            <div class="st-webdav-radio-btn" data-scope="full" role="radio" aria-checked="false" tabindex="0">
              <i class="fa-solid fa-box-archive" aria-hidden="true"></i>
              <span>全量数据 (Full)</span>
            </div>
            <div class="st-webdav-radio-btn" data-scope="custom" role="radio" aria-checked="false" tabindex="0">
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
              ${DEFAULT_CATEGORIES.map(c => `
                <label class="st-webdav-cat-item">
                  <input type="checkbox" class="st-webdav-cat-cb" value="${c.id}" ${c.defaultSelected ? 'checked' : ''} data-default="${c.defaultSelected}">
                  <div class="st-webdav-cat-info">
                    <span class="st-webdav-cat-title">${c.name}</span>
                    <span class="st-webdav-cat-desc">${c.desc}</span>
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

    // 绑定范围切换事件
    let selectedScope = 'core';
    const scopeBtns = pane.querySelectorAll('.st-webdav-radio-btn');
    const scopeDesc = pane.querySelector('#st-webdav-scope-desc');
    const customBox = pane.querySelector('#st-webdav-custom-box');

    scopeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        scopeBtns.forEach(b => {
          b.classList.remove('is-active');
          b.setAttribute('aria-checked', 'false');
        });
        btn.classList.add('is-active');
        btn.setAttribute('aria-checked', 'true');
        selectedScope = btn.getAttribute('data-scope');
        if (selectedScope === 'core') {
          scopeDesc.textContent = '包含：settings.json, secrets.json, 世界书 (Lorebook), 提示词预设, 主题样式, 宏与扩展配置。体积轻巧，秒级完成。';
          if (customBox) customBox.style.display = 'none';
        } else if (selectedScope === 'full') {
          scopeDesc.textContent = '包含：核心配置全部内容 + 全部角色卡、全部聊天记录、用户上传文件。完整保留所有数据，适合全量灾备。';
          if (customBox) customBox.style.display = 'none';
        } else {
          scopeDesc.textContent = '根据下方勾选的类别进行按需备份，精确控制备份内容与体积。';
          if (customBox) customBox.style.display = 'flex';
        }
      });
    });

    // 自定义分类快速勾选操作
    const catCheckboxes = pane.querySelectorAll('.st-webdav-cat-cb');
    pane.querySelector('#st-webdav-cat-all')?.addEventListener('click', () => {
      catCheckboxes.forEach(cb => cb.checked = true);
    });
    pane.querySelector('#st-webdav-cat-none')?.addEventListener('click', () => {
      catCheckboxes.forEach(cb => cb.checked = false);
    });
    pane.querySelector('#st-webdav-cat-default')?.addEventListener('click', () => {
      catCheckboxes.forEach(cb => cb.checked = cb.getAttribute('data-default') === 'true');
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
        const checkedBoxes = Array.from(pane.querySelectorAll('.st-webdav-cat-cb:checked'));
        categories = checkedBoxes.map(cb => cb.value);
        if (!categories.length) {
          toast('请至少勾选一个自定义备份类别', 'warn');
          return;
        }
      }

      let pollTimer = null;
      try {
        isBackingUp = true;
        runBtn.disabled = true;
        runBtn.innerHTML = '<span class="nvui-spinner" aria-hidden="true"></span> 备份中...';
        progressBox.style.display = 'block';
        progressBar.setValue(20);
        progressText.textContent = '正在连接 WebDAV 并扫描待备份数据...';

        pollTimer = setInterval(async () => {
          try {
            const status = await apiCall('/backup/status');
            if (status.running) {
              progressBar.setValue(status.progress || 40);
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
        progressBar.setValue(100);
        progressText.textContent = `备份成功: ${res.fileName}`;
        toast(`备份成功：${res.fileName}`, 'ok');

        // 重新拉取历史记录
        loadHistoryList();
      } catch (err) {
        progressText.textContent = `备份失败: ${err.message}`;
        toast(`备份失败: ${err.message}`, 'danger');
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

    // 检查初始服务连通性
    checkWebDavHealth();
  }

  // 连通性测试与状态横幅更新 (严格遵循 Kit 告警条语义规范)
  async function checkWebDavHealth() {
    const banner = document.getElementById('st-webdav-status-banner');
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
    pane.innerHTML = `
      <div class="st-webdav-container">
        <!-- 分区标准标题行 -->
        <div class="nvui-panel-heading">
          <span class="nvui-section-title">远端备份历史</span>
          <span class="nvui-badge is-accent" id="st-webdav-history-count-badge">0 个备份</span>
        </div>

        <div class="st-webdav-bar" style="justify-content: space-between;">
          <span class="nvui-hint" id="st-webdav-history-dir-hint">远端路径：正在连接...</span>
          <button type="button" id="st-webdav-refresh-history" class="nvui-btn is-sm is-ghost">
            <i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i>
            刷新列表
          </button>
        </div>

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

    // 初始化时异步拉取
    loadHistoryList();
  }

  let isLoadingHistory = false;
  async function loadHistoryList(force = false) {
    if (isLoadingHistory && !force) return;

    const container = document.getElementById('st-webdav-history-list');
    const badgeEl = document.getElementById('st-webdav-history-count-badge');
    const dirHintEl = document.getElementById('st-webdav-history-dir-hint');
    if (!container) return;

    isLoadingHistory = true;
    container.innerHTML = '<div class="nvui-hint" style="text-align: center; padding: var(--nvui-space-4);"><span class="nvui-spinner" aria-hidden="true"></span> 正在拉取远端文件列表...</div>';

    try {
      const res = await apiCall('/backups');
      const backups = res.backups || [];

      if (badgeEl) badgeEl.textContent = `${backups.length} 个备份`;
      if (dirHintEl) {
        dirHintEl.textContent = res.remoteDirectory ? `远端目录: ${res.remoteDirectory}` : '远端目录已连接';
      }

      if (!backups.length) {
        container.innerHTML = `
          <div class="nvui-empty" style="text-align: center; padding: var(--nvui-space-4);">
            <div style="font-size: var(--nvui-fs-xl); margin-bottom: var(--nvui-space-2); color: var(--nvui-text-3);">
              <i class="fa-solid fa-box-open" aria-hidden="true"></i>
            </div>
            <div style="font-weight: var(--nvui-fw-medium); color: var(--nvui-text);">远端 WebDAV 暂无备份文件</div>
            <div class="nvui-hint" style="margin-top: 4px;">前往「备份操作」标签页可立即发起配置备份。</div>
          </div>
        `;
        return;
      }

      const totalSize = backups.reduce((s, b) => s + (b.size || 0), 0);
      if (dirHintEl) {
        dirHintEl.textContent = `远端目录: ${res.remoteDirectory || 'Backups'} (共 ${formatSize(totalSize)})`;
      }

      const catNamesMap = {
        settings: '核心设置',
        characters: '角色卡',
        chats: '聊天记录',
        worlds: '世界书',
        prompts: '提示词预设',
        themes: '主题外观',
        userAvatars: '用户形象壁纸',
        extensions: '扩展配置',
        vectors: '向量记忆',
      };

      container.innerHTML = backups.map(b => {
        let scopeBadge = '<span class="nvui-badge is-success">核心</span>';
        if (b.scope === 'full') {
          scopeBadge = '<span class="nvui-badge is-accent">全量</span>';
        } else if (b.scope === 'custom') {
          const catCount = b.categories?.length || 0;
          scopeBadge = `<span class="nvui-badge is-info">自定义 (${catCount}项)</span>`;
        }

        const encBadge = b.encrypted
          ? '<span class="nvui-badge is-warn"><i class="fa-solid fa-lock" aria-hidden="true"></i> 加密</span>'
          : '';

        const userBadge = (b.user?.handle && b.user.handle !== 'default-user')
          ? `<span class="nvui-badge is-subtle"><i class="fa-solid fa-user" aria-hidden="true"></i> ${escapeHtml(b.user.displayName || b.user.handle)}</span>`
          : '';

        const noteHtml = b.note
          ? `
            <div class="st-webdav-card-note">
              <i class="fa-regular fa-comment-dots" aria-hidden="true"></i>
              <span>${escapeHtml(b.note)}</span>
            </div>
          `
          : '';

        const catDesc = (b.scope === 'custom' && b.categories && b.categories.length)
          ? `<div class="nvui-hint" style="margin-top: 4px; font-size: var(--nvui-fs-xs);">包含类别：${b.categories.map(c => catNamesMap[c] || c).join('、')}</div>`
          : '';

        return `
          <div class="st-webdav-card" data-name="${escapeHtml(b.name)}">
            <div class="st-webdav-card-header">
              <span class="st-webdav-card-title">
                <i class="fa-solid fa-file-zipper" aria-hidden="true"></i>
                ${escapeHtml(b.name)}
              </span>
              <div class="st-webdav-bar">
                ${userBadge}
                ${scopeBadge}
                ${encBadge}
              </div>
            </div>

            <div class="st-webdav-card-meta">
              <span><i class="fa-regular fa-clock" aria-hidden="true"></i> ${formatDate(b.lastModified)}</span>
              <span><i class="fa-solid fa-hard-drive" aria-hidden="true"></i> ${formatSize(b.size)}</span>
            </div>

            ${noteHtml}
            ${catDesc}

            <div class="st-webdav-bar" style="margin-top: var(--nvui-space-1); justify-content: flex-end;">
              <button type="button" class="nvui-btn is-sm is-primary st-restore-btn" data-name="${escapeHtml(b.name)}" data-enc="${b.encrypted}">
                <i class="fa-solid fa-rotate-left" aria-hidden="true"></i>
                还原此备份
              </button>
              <button type="button" class="nvui-btn is-sm is-danger is-ghost st-delete-btn" data-name="${escapeHtml(b.name)}">
                <i class="fa-solid fa-trash" aria-hidden="true"></i>
                删除
              </button>
            </div>
          </div>
        `;
      }).join('');

      // 绑定恢复与删除事件
      container.querySelectorAll('.st-restore-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const fileName = btn.getAttribute('data-name');
          const isEnc = btn.getAttribute('data-enc') === 'true';
          confirmAndRestore(fileName, isEnc);
        });
      });

      container.querySelectorAll('.st-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const fileName = btn.getAttribute('data-name');
          confirmAndDelete(fileName);
        });
      });

    } catch (err) {
      if (badgeEl) badgeEl.textContent = '获取失败';
      container.innerHTML = `
        <div class="nvui-alert is-error" style="margin-top: var(--nvui-space-2);">
          <i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i>
          <span>拉取历史失败: ${escapeHtml(err.message)}</span>
        </div>
      `;
    } finally {
      isLoadingHistory = false;
    }
  }

  // 恢复确认对话框 (严格无 Emoji 规范)
  async function confirmAndRestore(fileName, isEncrypted) {
    let password = '';
    if (isEncrypted) {
      password = prompt('【安全提示】此备份文件已加密，请输入解密口令：');
      if (password === null) return; // 用户取消
      if (!password.trim()) {
        toast('解密口令不能为空', 'warn');
        return;
      }
    }

    const sure = confirm(`【安全提示】确定要从远端备份「${fileName}」恢复配置吗？\n\n- 插件会在还原前自动为当前配置制作安全回滚快照。\n- 恢复完成后建议刷新页面使新配置生效。`);
    if (!sure) return;

    try {
      toast('正在下载并还原配置...', 'info');
      const res = await apiCall('/restore', 'POST', {
        fileName,
        password,
        createRollback: true,
      });

      toast(res.message || '恢复完成！', 'ok');
      if (confirm('【恢复成功】配置已还原成功！是否立刻刷新酒馆页面以加载全新配置？')) {
        window.location.reload();
      }
    } catch (err) {
      toast(`恢复失败: ${err.message}`, 'danger');
    }
  }

  // 删除确认对话框 (严格无 Emoji 规范)
  async function confirmAndDelete(fileName) {
    if (!confirm(`【危险操作】确定要从 WebDAV 彻底删除备份「${fileName}」？此操作不可撤销。`)) return;

    try {
      await apiCall('/delete', 'POST', { fileName });
      toast('已删除远端备份', 'ok');
      loadHistoryList();
    } catch (err) {
      toast(`删除失败: ${err.message}`, 'danger');
    }
  }

  // —— 分区 3：服务设置 (Settings Tab) ——
  function buildSettingsTab() {
    const pane = getTabPane('settings');
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
              <div id="cfg-user-dir-hint" class="nvui-hint" style="margin-top: 2px;"></div>

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
                <input type="text" id="cfg-cdn-base" class="nvui-input is-path" value="${DEFAULT_CDN}">
                <span>备用 CDN 地址</span>
              </label>
              <span class="nvui-hint">当前模式：默认优先加载本地 Vendored UI-Kit（零网络延迟、100% 离线支持）。若本地缺失可使用上述 CDN 降级镜像。</span>
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
    const connSum = document.getElementById('st-webdav-conn-sum');
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

    const policySum = document.getElementById('st-webdav-policy-sum');
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
    try {
      const cfg = await apiCall('/config');
      currentConfig = cfg;

      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val !== undefined && val !== null ? val : '';
      };
      const setCheck = (id, val) => {
        const el = document.getElementById(id);
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

      const userHint = document.getElementById('cfg-user-dir-hint');
      if (userHint && cfg.currentUser) {
        if (cfg.currentUser.isMultiUser) {
          userHint.innerHTML = `<i class="fa-solid fa-user-shield" aria-hidden="true"></i> 多用户环境：当前账号「<b>${escapeHtml(cfg.currentUser.displayName || cfg.currentUser.handle)}</b>」，实际远端工作路径为：<code>${escapeHtml(cfg.effectiveRemoteDirectory || '')}</code>`;
        } else {
          userHint.innerHTML = `<i class="fa-solid fa-user" aria-hidden="true"></i> 当前运行在单用户模式，远端工作路径为：<code>${escapeHtml(cfg.effectiveRemoteDirectory || cfg.remoteDirectory || 'SillyTavern_Backups')}</code>`;
        }
      }
    } catch {}
  }

  // ---------- 4. 注册酒馆入口菜单按钮 ----------
  function registerMenuEntry() {
    if (document.getElementById('st-webdav-menu-btn')) return;

    const extensionsMenu = document.getElementById('extensionsMenu');
    if (!extensionsMenu) {
      setTimeout(registerMenuEntry, 1000);
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
        checkWebDavHealth();
        loadHistoryList();
      } catch (err) {
        toast(`打开面板失败: ${err.message}`, 'danger');
      }
    });

    extensionsMenu.appendChild(btn);
  }

  // 酒馆就绪后挂载
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registerMenuEntry);
  } else {
    registerMenuEntry();
  }
})();
