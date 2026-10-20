/**
 * ST-WebDAV 前端扩展 · 基于 SillyTavern NVUI Kit (在线模式)
 * -------------------------------------------------------------
 * 1. 采用在线模式按需加载最新的 ui-kit (tokens.css, components.css, nvui-api.js)
 * 2. 严格满足面板布局标准与无障碍契约 (dialog.nvui-tl, role, aria-*)
 * 3. 支持桌面端居中面板与移动端底部抽屉无缝自适应
 */

(function () {
  'use strict';

  const DEFAULT_CDN = 'https://cdn.jsdelivr.net/gh/zgy-beep/ui-kit@main';
  let NVUI = null;
  let panel = null;
  let currentConfig = {};
  let isBackingUp = false;

  // ---------- 1. 在线加载 UI Kit ----------
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

    const cleanCdn = cdnBase.replace(/\/+$/, '');
    await Promise.all([
      loadCss('nvui-css-tokens', `${cleanCdn}/tokens.css`),
      loadCss('nvui-css-components', `${cleanCdn}/components.css`),
    ]);

    if (!window.NVUI || typeof window.NVUI.createPanel !== 'function') {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.id = 'nvui-js-api';
        script.src = `${cleanCdn}/nvui-api.js`;
        script.onload = () => {
          NVUI = window.NVUI;
          resolve(NVUI);
        };
        script.onerror = () => reject(new Error('UI Kit 在线加载失败，请检查网络连接'));
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

  // ---------- 3. 构建 UI Kit 面板 ----------
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

    // 在线加载 UI Kit
    await ensureNVUI(cdnBase);

    // 注入业务附加 CSS
    await loadCss('st-webdav-css', '/scripts/extensions/third-party/ST-WebDAV/style.css');

    // 使用 NVUI API 创建标准面板
    panel = NVUI.createPanel({
      id: 'st-webdav',
      title: 'WebDAV 备份与恢复',
      version: 'v1.0.0',
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

    return panel;
  }

  // 辅助获取指定 tab 的内容 DOM 容器
  function getTabPane(key) {
    return panel.body.querySelector(`#${panel.id}-pane-${key}`) || panel.body;
  }

  // 刷新当前活动标签页
  function refreshCurrentTab() {
    loadHistoryList();
    loadSettingsForm();
    toast('已刷新', 'info');
  }

  // —— 分区 1：备份操作 (Backup Tab) ——
  function buildBackupTab() {
    const pane = getTabPane('backup');
    pane.innerHTML = `
      <div class="st-webdav-container">
        <!-- WebDAV 状态条 -->
        <div id="st-webdav-status-banner" class="st-webdav-status-banner">
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

          <div class="st-webdav-radio-group">
            <div class="st-webdav-radio-btn is-active" data-scope="core">
              <i class="fa-solid fa-bolt" aria-hidden="true"></i>
              <span>核心配置 (Core)</span>
            </div>
            <div class="st-webdav-radio-btn" data-scope="full">
              <i class="fa-solid fa-box-archive" aria-hidden="true"></i>
              <span>全量数据 (Full)</span>
            </div>
          </div>

          <div class="nvui-hint" id="st-webdav-scope-desc">
            包含：settings.json, secrets.json, 世界书 (Lorebook), 提示词预设, 主题样式, 宏与扩展配置。体积轻巧，秒级完成。
          </div>
        </div>

        <!-- 端到端加密卡片 -->
        <div class="st-webdav-card">
          <div class="st-webdav-card-header">
            <span class="st-webdav-card-title">
              <i class="fa-solid fa-shield-halved" aria-hidden="true"></i>
              端到端加密保护 (AES-256-GCM)
            </span>
          </div>

          <label class="nvui-switch-row">
            <input type="checkbox" id="st-webdav-encrypt-toggle">
            <span>开启加密（在推送到 WebDAV 前在本地完成加密，防范网盘凭据泄露）</span>
          </label>

          <div id="st-webdav-password-group" style="display: none;">
            <label class="nvui-input-row">
              <input type="password" id="st-webdav-backup-pass" class="nvui-input" placeholder="输入自定义解密口令" autocomplete="new-password">
              <span>加密密码</span>
            </label>
            <span class="nvui-hint">⚠️ 请牢记此密码，远端解密与恢复时必须提供，丢失将无法还原！</span>
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

    scopeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        scopeBtns.forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        selectedScope = btn.getAttribute('data-scope');
        if (selectedScope === 'core') {
          scopeDesc.textContent = '包含：settings.json, secrets.json, 世界书 (Lorebook), 提示词预设, 主题样式, 宏与扩展配置。体积轻巧，秒级完成。';
        } else {
          scopeDesc.textContent = '包含：核心配置全部内容 + 全部角色卡、全部聊天记录、用户上传文件。完整保留所有数据，适合全量灾备。';
        }
      });
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
        toast('请填写备份加密密码', 'warn');
        pane.querySelector('#st-webdav-backup-pass').focus();
        return;
      }

      try {
        isBackingUp = true;
        runBtn.disabled = true;
        runBtn.innerHTML = '<span class="nvui-spinner" aria-hidden="true"></span> 备份中...';
        progressBox.style.display = 'block';
        progressBar.setValue(20);
        progressText.textContent = '正在连接 WebDAV 并扫描待备份数据...';

        const pollTimer = setInterval(async () => {
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
          encrypt,
          password,
          note,
        });

        clearInterval(pollTimer);
        progressBar.setValue(100);
        progressText.textContent = `备份成功: ${res.fileName}`;
        toast(`备份成功：${res.fileName}`, 'ok');

        // 重新拉取历史记录
        loadHistoryList();
      } catch (err) {
        progressText.textContent = `备份失败: ${err.message}`;
        toast(`备份失败: ${err.message}`, 'danger');
      } finally {
        isBackingUp = false;
        runBtn.disabled = false;
        runBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i> 立即备份到 WebDAV';
      }
    });

    // 检查初始状态
    checkWebDavHealth();
  }

  // 连通性测试与状态横幅更新
  async function checkWebDavHealth() {
    const banner = document.getElementById('st-webdav-status-banner');
    if (!banner) return;

    try {
      const res = await apiCall('/test', 'POST', {});
      if (res.ok) {
        banner.className = 'st-webdav-status-banner is-ok';
        banner.innerHTML = `<i class="fa-solid fa-circle-check" aria-hidden="true"></i> <span>WebDAV 连接正常 (${res.server || 'Server Ready'})</span>`;
      } else {
        banner.className = 'st-webdav-status-banner is-warn';
        banner.innerHTML = `<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> <span>${res.message || 'WebDAV 尚未连通，请前往「服务设置」完善配置'}</span>`;
      }
    } catch (err) {
      banner.className = 'st-webdav-status-banner is-danger';
      banner.innerHTML = `<i class="fa-solid fa-circle-xmark" aria-hidden="true"></i> <span>${err.message}</span>`;
    }
  }

  // —— 分区 2：远端备份历史 (History Tab) ——
  function buildHistoryTab() {
    const pane = getTabPane('history');
    pane.innerHTML = `
      <div class="st-webdav-container">
        <div class="st-webdav-bar" style="justify-content: space-between;">
          <span class="nvui-hint" id="st-webdav-history-count">正在加载远端备份...</span>
          <button type="button" id="st-webdav-refresh-history" class="nvui-btn is-sm is-ghost">
            <i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i>
            刷新列表
          </button>
        </div>

        <div id="st-webdav-history-list" style="display: flex; flex-direction: column; gap: var(--nvui-space-2);">
          <div class="nvui-hint" style="text-align: center; padding: var(--nvui-space-4);">加载中...</div>
        </div>
      </div>
    `;

    pane.querySelector('#st-webdav-refresh-history').addEventListener('click', () => {
      loadHistoryList();
    });
  }

  async function loadHistoryList() {
    const container = document.getElementById('st-webdav-history-list');
    const countEl = document.getElementById('st-webdav-history-count');
    if (!container) return;

    container.innerHTML = '<div class="nvui-hint" style="text-align: center; padding: var(--nvui-space-4);"><span class="nvui-spinner" aria-hidden="true"></span> 正在拉取远端文件列表...</div>';

    try {
      const res = await apiCall('/backups');
      const backups = res.backups || [];

      if (!backups.length) {
        countEl.textContent = `远端目录: ${res.remoteDirectory} (0 个备份)`;
        container.innerHTML = '<div class="nvui-empty">远端 WebDAV 暂无备份文件，前往「备份操作」发起首次备份。</div>';
        return;
      }

      const totalSize = backups.reduce((s, b) => s + (b.size || 0), 0);
      countEl.textContent = `远端目录: ${res.remoteDirectory} (${backups.length} 个备份，共 ${formatSize(totalSize)})`;

      container.innerHTML = backups.map(b => {
        const scopeBadge = b.scope === 'full' 
          ? '<span class="nvui-badge is-accent">全量</span>' 
          : '<span class="nvui-badge is-ok">核心</span>';
        const encBadge = b.encrypted 
          ? '<span class="nvui-badge is-warn"><i class="fa-solid fa-lock" aria-hidden="true"></i> 加密</span>' 
          : '';

        return `
          <div class="st-webdav-card" data-name="${b.name}">
            <div class="st-webdav-card-header">
              <span class="st-webdav-card-title">
                <i class="fa-solid fa-file-zipper" aria-hidden="true"></i>
                ${b.name}
              </span>
              <div class="st-webdav-bar">
                ${scopeBadge}
                ${encBadge}
              </div>
            </div>

            <div class="st-webdav-card-meta">
              <span><i class="fa-regular fa-clock" aria-hidden="true"></i> ${formatDate(b.lastModified)}</span>
              <span><i class="fa-solid fa-hard-drive" aria-hidden="true"></i> ${formatSize(b.size)}</span>
            </div>

            <div class="st-webdav-bar" style="margin-top: var(--nvui-space-1); justify-content: flex-end;">
              <button type="button" class="nvui-btn is-sm is-primary st-restore-btn" data-name="${b.name}" data-enc="${b.encrypted}">
                <i class="fa-solid fa-rotate-left" aria-hidden="true"></i>
                还原此备份
              </button>
              <button type="button" class="nvui-btn is-sm is-danger is-ghost st-delete-btn" data-name="${b.name}">
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
      container.innerHTML = `<div class="nvui-alert is-danger"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i><span>拉取历史失败: ${err.message}</span></div>`;
    }
  }

  // 恢复确认对话框
  async function confirmAndRestore(fileName, isEncrypted) {
    let password = '';
    if (isEncrypted) {
      password = prompt(`【安全提示】此备份文件已加密，请输入解密口令：`);
      if (password === null) return; // 用户取消
      if (!password.trim()) {
        toast('解密密码不能为空', 'warn');
        return;
      }
    }

    const sure = confirm(`⚠️ 确定要从远端备份「${fileName}」恢复配置吗？\n\n- 插件会在还原前自动为当前配置制作安全回滚快照。\n- 恢复完成后建议刷新页面使新配置生效。`);
    if (!sure) return;

    try {
      toast('正在下载并还原配置...', 'info');
      const res = await apiCall('/restore', 'POST', {
        fileName,
        password,
        createRollback: true,
      });

      toast(res.message || '恢复完成！', 'ok');
      if (confirm('配置还原成功！是否立刻刷新酒馆页面以加载全新配置？')) {
        window.location.reload();
      }
    } catch (err) {
      toast(`恢复失败: ${err.message}`, 'danger');
    }
  }

  // 删除确认对话框
  async function confirmAndDelete(fileName) {
    if (!confirm(`确定要从 WebDAV 彻底删除备份「${fileName}」？此操作不可撤销。`)) return;

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
        <!-- WebDAV 连接设置 -->
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
                  <span>远端备份目录</span>
                </label>
                <label class="nvui-input-row">
                  <input type="number" id="cfg-timeout" class="nvui-input is-number" placeholder="15000" min="3000" step="1000">
                  <span>超时时间 (毫秒)</span>
                </label>
              </div>

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
            <span class="nvui-acc-summary">定时任务与保留份数</span>
            <i class="nvui-acc-chev" aria-hidden="true"></i>
          </button>
          <div class="nvui-acc-body">
            <div class="nvui-acc-inner">
              <label class="nvui-switch-row">
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

        <!-- UI Kit 在线模式设置 -->
        <div class="nvui-acc" id="st-webdav-acc-uikit">
          <button type="button" class="nvui-acc-head" aria-expanded="false">
            <span class="nvui-acc-title"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> UI Kit 在线模式</span>
            <span class="nvui-acc-summary">CDN 源地址</span>
            <i class="nvui-acc-chev" aria-hidden="true"></i>
          </button>
          <div class="nvui-acc-body">
            <div class="nvui-acc-inner">
              <label class="nvui-input-row">
                <input type="text" id="cfg-cdn-base" class="nvui-input is-path" value="${DEFAULT_CDN}">
                <span>CDN 地址</span>
              </label>
              <span class="nvui-hint">当前模式：实时加载最新 ui-kit 规范与 API。若在无外网环境下，可配置局域网镜像或本地路径。</span>
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
          autoBackupEnabled: pane.querySelector('#cfg-auto-enabled').checked,
          autoBackupIntervalHours: Number(pane.querySelector('#cfg-auto-interval').value) || 24,
          retentionCount: Number(pane.querySelector('#cfg-retention').value) || 10,
          cdnBase: pane.querySelector('#cfg-cdn-base').value.trim() || DEFAULT_CDN,
        };

        const saved = await apiCall('/config', 'POST', newCfg);
        currentConfig = saved;
        toast('配置已成功保存！', 'ok');
        checkWebDavHealth();
      } catch (err) {
        toast(`保存失败: ${err.message}`, 'danger');
      } finally {
        saveBtn.disabled = false;
      }
    });

    loadSettingsForm();
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
      setCheck('cfg-auto-enabled', cfg.autoBackupEnabled);
      setVal('cfg-auto-interval', cfg.autoBackupIntervalHours || 24);
      setVal('cfg-retention', cfg.retentionCount || 10);
      setVal('cfg-cdn-base', cfg.cdnBase || DEFAULT_CDN);
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
        if (p.dialog) p.dialog.style.zIndex = '2147483647';
        if (p.overlay) p.overlay.style.zIndex = '2147483647';
        checkWebDavHealth();
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
