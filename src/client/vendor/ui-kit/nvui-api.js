/**
 * SillyTavern NVUI Kit · 可选运行时 API（零依赖）
 * ------------------------------------------------------------------
 * 版本：ui-kit v2.8.0（与 package.json / tokens.css / components.css 版本号保持一致）
 * 用途：给插件/其它软件一个「可调用的设计接口」——用函数创建符合本 Kit 规范的面板、
 *       标签页、折叠分组、开关行、输入行、进度条、吐司，自动带上布局标准、无障碍属性、
 *       动效降级与焦点管理，避免每个插件各写一套 DOM。
 *
 * 设计约束（本文件由 test/test-ui-kit.js 守护）：
 *   1. 零依赖、无网络请求、无 emoji；不 import 任何框架。
 *   2. 加载时不访问 DOM（在 Node 里 require 只拿到 API 对象），所有 DOM 操作都在函数调用时发生。
 *   3. 只使用 nvui- 前缀类名与 CSS 变量 token，绝不硬编码颜色。
 *   4. 生成的 DOM 必须与 README 的「面板布局标准」「无障碍契约」一致：
 *      dialog.nvui-tl > .nvui-overlay.is-panel > .nvui-panel（role=dialog / aria-modal / aria-labelledby），
 *      顶部 tabs 与手机底部导航共享状态，Esc / 点遮罩关闭，关闭后焦点归还触发元素。
 *   5. 默认尊重 prefers-reduced-motion / prefers-reduced-transparency（交给 CSS 门禁）；
 *      本 API 只负责切换类名与属性。
 *
 * 用法（浏览器，插件内）：
 *   <script src="./ui-kit/nvui-api.js"></script>
 *   const panel = NVUI.createPanel({
 *       id: 'my_plugin_panel',
 *       title: '我的插件设置',
 *       version: 'v1.0.0',
 *       tabs: [
 *           { key: 'basic', label: '基本设置', icon: 'fa-solid fa-sliders' },
 *           { key: 'advanced', label: '高级', icon: 'fa-solid fa-wrench' }
 *       ],
 *       actions: [{ icon: 'fa-solid fa-wand-magic-sparkles', label: '更多', onClick: function () {} }],
 *       footer: [{ label: '取消', variant: 'ghost', onClick: function () { panel.close(); } }]
 *   });
 *   panel.addSwitch('basic', { label: '启用功能', value: true, onChange: function (v) {} });
 *   panel.addAccordion('basic', {
 *       title: '基本设置', summary: '默认值',
 *       content: [panel.addInput('basic', { label: '上限 (MB)', type: 'number', value: 80 })]
 *   });
 *   panel.open();
 *
 * 用法（Node 侧做规范测试/静态生成时）：
 *   const NVUI = require('./nvui-api.js');
 *   NVUI.version; NVUI.PANEL_CLASS; NVUI.createPanel; // 只检查导出，不触发 DOM
 */
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.NVUI = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    'use strict';

    var VERSION = '2.8.0';
    var PANEL_CLASS = 'nvui-panel';
    var TOAST_LAYER_ID = 'nvui-api-toast-layer';

    /* ---------------------- 调试开关与日志 ---------------------- */
    /*
     * v2.4.0 起提供可观测性（NEW-19）：
     *   NVUI.config.debug = true  → 打开关键路径的详细日志（面板创建、宿主模态同步、玻璃探测等）
     *   NVUI.config.logger        → 可替换为宿主自己的日志总线（默认 console）
     * 分级约定：
     *   debug 级 —— 只在 debug 打开时输出（正常路径的细节）
     *   warn  级 —— 异常但已降级处理，**始终输出**（不得静默吞掉）
     *   error 级 —— 运行失败，**始终输出**
     */
    var config = {
        debug: false,
        logger: (typeof console !== 'undefined' && console) ? console : null,
    };

    function logAt(level, message, detail) {
        var logger = (config && config.logger)
            || (typeof console !== 'undefined' ? console : null);
        if (!logger) return;
        var fn = null;
        if (level === 'error') fn = logger.error;
        else if (level === 'warn') fn = logger.warn;
        else fn = logger.log;
        if (typeof fn !== 'function') return;
        /* debug 级只在开关打开时输出；warn / error 始终输出 */
        if (level === 'debug' && !(config && config.debug)) return;
        try {
            fn.call(logger, '[NVUI] ' + message, detail === undefined ? '' : detail);
        } catch (err) {
            /* 日志自身失败不得影响主流程 */
        }
    }

    function debug(message, detail) {
        logAt('debug', message, detail);
    }

    function warn(message, detail) {
        logAt('warn', message, detail);
    }

    /* v2.8.0：默认值缺失类告警只提示一次，避免每次创建组件都刷屏。 */
    var onceWarnings = Object.create(null);
    function warnOnce(key, message, detail) {
        if (onceWarnings[key]) return;
        onceWarnings[key] = true;
        warn(message, detail);
    }

    function error(message, detail) {
        logAt('error', message, detail);
    }

    /* ----------------------------- 工具 ----------------------------- */

    function isDomAvailable() {
        return typeof document !== 'undefined' && !!document.createElement;
    }

    /* 属性白名单：只允许「语义 / 无障碍 / 表单」类属性透传。
     * 任何 on* 事件属性、style、srcdoc 等可执行 / 可注入通道一律丢弃，
     * 避免调用方（或被污染的宿主数据）借属性通道塞入事件处理器。
     * href / src 不在白名单内：它们能承载 javascript: 伪协议，属注入面。 */
    var ALLOWED_ATTRS = [
        'id', 'title', 'role', 'type', 'hidden', 'tabindex', 'for', 'value',
        'name', 'placeholder', 'disabled', 'checked', 'readonly', 'required',
        'multiple', 'min', 'max', 'step', 'rows', 'cols', 'span',
        'alt', 'width', 'height', 'lang', 'dir', 'closing',
    ];

    function attrAllowed(key) {
        if (typeof key !== 'string' || !key) return false;
        var lower = key.toLowerCase();
        /* 事件属性（onclick / onerror / onload …）一律拒绝 */
        if (lower.indexOf('on') === 0) return false;
        /* style / srcdoc 等可直接注入脚本或样式的通道一律拒绝 */
        if (lower === 'style' || lower === 'srcdoc' || lower === 'formaction') return false;
        /* NEW-38：aria-* 与 data-* 严格匹配合法命名正则，拒绝空格等非法字符引发 InvalidCharacterError */
        if (lower.indexOf('aria-') === 0) return /^aria-[a-z0-9_-]+$/.test(lower);
        if (lower.indexOf('data-') === 0) return /^data-[a-z0-9_-]+$/.test(lower);
        return ALLOWED_ATTRS.indexOf(lower) !== -1;
    }

    var FORBIDDEN_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'meta', 'link', 'base'];

    function el(tag, className, attrs) {
        var safeTag = tag;
        /* NEW-45：危险标签名隔离（如 script/iframe） */
        if (!safeTag || typeof safeTag !== 'string' || FORBIDDEN_TAGS.indexOf(safeTag.toLowerCase()) !== -1) {
            warn('el(): 拒绝创建非法或危险标签 "' + tag + '"');
            safeTag = 'div';
        }
        var node = document.createElement(safeTag);
        if (className) node.className = (typeof className === 'symbol') ? '' : String(className);
        if (attrs) {
            Object.keys(attrs).forEach(function (k) {
                var v = attrs[k];
                if (v === null || v === undefined) return;
                /* 只允许 textContent 通道：绝不接受原始 HTML 片段，防范 XSS */
                if (k === 'text') {
                    if (typeof v === 'symbol') v = '';
                    node.textContent = String(v);
                    return;
                }
                /* 白名单之外的属性静默丢弃并记一条 warn */
                if (!attrAllowed(k)) {
                    warn('el(): 已丢弃白名单外的属性 "' + k + '"');
                    return;
                }
                if (typeof v === 'symbol') v = '';
                try {
                    node.setAttribute(k, String(v));
                } catch (err) {
                    warn('el(): setAttribute 失败，已忽略属性 "' + k + '"');
                }
            });
        }
        return node;
    }

    /** 生成一个在文档内唯一的元素 id（仅在冲突时加后缀，保持 base 可预测）
     *  面板会用 base 派生出 -layer / -overlay / -title / -tab-* / -pane-* 等多个 id，
     *  所以冲突检测必须按「派生子 id」判断，而不是只看裸 base。 */
    var idSeq = 0;
    function idTaken(base) {
        if (typeof document === 'undefined') return false;
        return !!(document.getElementById(base)
            || document.getElementById(base + '-layer')
            || document.getElementById(base + '-overlay')
            || document.getElementById(base + '-title'));
    }
    function uniqueId(base) {
        if (!idTaken(base)) return base;
        idSeq += 1;
        var candidate = base + '-' + idSeq.toString(36);
        while (idTaken(candidate)) {
            idSeq += 1;
            candidate = base + '-' + idSeq.toString(36);
        }
        return candidate;
    }

    function append(parent, children) {
        if (!parent || typeof parent.appendChild !== 'function') return parent;
        (Array.isArray(children) ? children : [children]).forEach(function (c) {
            if (!c && c !== 0) return;
            /* NEW-45：非 Node 参数安全归一化，防范原生 appendChild 抛未捕获 TypeError */
            if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') {
                parent.appendChild(document.createTextNode(String(c)));
            } else if (typeof Node !== 'undefined' && c instanceof Node) {
                parent.appendChild(c);
            } else if (c && typeof c.nodeType === 'number') {
                parent.appendChild(c);
            } else {
                warn('append(): 子元素不是有效 DOM 节点，已忽略');
            }
        });
        return parent;
    }

    function iconNode(iconClass) {
        if (!iconClass) return null;
        if (typeof iconClass === 'string') return el('i', iconClass, { 'aria-hidden': 'true' });
        /* 允许调用方直接传入一个已构造好的 DOM 节点（例如自定义 SVG 图标），
           但必须是真正的 Node；否则 appendChild 会抛 TypeError 并让整块面板创建失败。 */
        if (typeof Node !== 'undefined' && iconClass instanceof Node) return iconClass;
        if (iconClass && typeof iconClass.nodeType === 'number' && typeof iconClass.appendChild === 'function') {
            return iconClass;
        }
        warn('iconNode(): 图标既不是类名字符串也不是 DOM 节点，已忽略');
        return null;
    }

    function on(target, type, handler, options) {
        target.addEventListener(type, handler, options || false);
        return handler;
    }

    /**
     * 把任意字符串折算成「可安全拼进 DOM id」的片段。
     * 只保留 [A-Za-z0-9_-]，其余字符（含空格 / 引号 / < >）一律替换为下划线；
     * 空串回退到 fallback。这样拼出来的 id 一定满足 HTML5 的 id 语法，
     * 也不会让 ARIA 的 IDREF（aria-controls / aria-labelledby）断链。
     */
    function sanitizeIdPart(raw, fallback) {
        var s = (raw === null || raw === undefined) ? '' : String(raw);
        var safe = s.replace(/[^A-Za-z0-9_-]/g, '_');
        if (!safe) safe = fallback || 'x';
        /* id 不能以数字开头（CSS 选择器与部分工具链不接受） */
        if (/^[0-9]/.test(safe)) safe = '_' + safe;
        return safe;
    }

    /** URL 安全协议校验（拒绝 javascript: / data: / vbscript: 伪协议注入通道） */
    function isSafeUrl(rawUrl) {
        if (typeof rawUrl !== 'string' || !rawUrl) return false;
        var normalized = rawUrl.replace(/[\u0000-\u0020\u007f-\u009f\s]+/g, '').toLowerCase();
        if (!normalized) return false;
        if (normalized.indexOf('javascript:') === 0 ||
            normalized.indexOf('data:') === 0 ||
            normalized.indexOf('vbscript:') === 0) {
            return false;
        }
        return true;
    }

    /**
     * 焦点兜底选择器解析（NEW-03）：
     *   - README 公开契约是「CSS 选择器 或元素」，所以这里**不**把选择器收窄成只认 #id
     *     （那会破坏既有调用方），而是：
     *       1) 纯 #id 走 getElementById —— 完全不经 CSS 解析，零注入面；
     *       2) 其余选择器先做字符白名单校验（拒绝 < > ; { } \ 等可逃逸字符），再走 querySelector；
     *       3) querySelector 包 try/catch —— 非法选择器会抛 SyntaxError，
     *          若不吞掉会打断「焦点归还链」，让键盘用户彻底失去焦点位置。
     *     校验不通过时静默降级为 null，调用方继续走「面板容器」这级兜底。
     */
    var FOCUS_SELECTOR_FORBIDDEN = /[<>;{}\\]/;

    function resolveFocusFallback(selector) {
        var sel = String(selector).trim();
        if (!sel) return null;
        /* 纯 #id 走 getElementById：不经选择器解析，零注入面 */
        if (/^#[A-Za-z][A-Za-z0-9_-]*$/.test(sel)) {
            return document.getElementById(sel.slice(1));
        }
        if (FOCUS_SELECTOR_FORBIDDEN.test(sel)) {
            warn('focusFallback: 选择器 "' + sel + '" 含不允许的字符，已忽略');
            return null;
        }
        try {
            return document.querySelector(sel);
        } catch (err) {
            /* 非法选择器会让 querySelector 抛 SyntaxError —— 必须吞掉，
               否则焦点归还链被打断，焦点彻底丢失。 */
            warn('focusFallback: 选择器 "' + sel + '" 解析失败，已忽略');
            return null;
        }
    }

    function q(sel, scope) {
        return (scope || document).querySelector(sel);
    }

    /** 元素当前是否可聚焦（可见 + 未 disabled + 在文档中） */
    function isFocusable(node) {
        if (!node || !node.isConnected) return false;
        if (node.disabled) return false;
        /* NEW-43：优先使用原生 checkVisibility 判定可见性（硬件加速且同时检查 display 与 visibility:hidden） */
        if (typeof node.checkVisibility === 'function') {
            try {
                return node.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
            } catch (err) { /* 回退下述检测 */ }
        }
        var cs = window.getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (node.offsetWidth === 0 && node.offsetHeight === 0) return false;
        return true;
    }

    /**
     * 节点是否位于「当前收起的折叠体」内部（Issue #13）。
     * `.nvui-acc-body` 收起时是 visibility:hidden + 0fr（宽度仍在），
     * 因此不能只靠 offsetWidth 判断。折叠体的 visibility 会被显式设为
     * visible，若只用继承可见性判断，嵌套在收起折叠体里的展开折叠体仍会
     * 被误判为可见 —— 这里沿 .nvui-acc-body 祖先链逐层检查。
     */
    function isInsideCollapsedAccordion(node) {
        if (!node || typeof node.closest !== 'function') return false;
        var body = node.closest('.nvui-acc-body');
        while (body) {
            var acc = body.parentElement;
            if (acc && acc.classList && acc.classList.contains('nvui-acc')
                && !acc.classList.contains('is-open')) {
                return true;
            }
            body = (acc && typeof acc.closest === 'function') ? acc.closest('.nvui-acc-body') : null;
        }
        return false;
    }

    /**
     * 焦点陷阱专用可聚焦判定（Issue #13）：在 isFocusable 的基础上再排除
     * inert 子树和收起折叠体里的控件，保证 Tab 边界只由真正可见的控件组成。
     */
    function isTrapFocusable(node) {
        if (!isFocusable(node)) return false;
        if (isInsideCollapsedAccordion(node)) return false;
        if (typeof node.closest === 'function' && node.closest('[inert]')) return false;
        return true;
    }

    /** 收起折叠体时，若焦点在即将隐藏的正文里，把焦点交还折叠触发器（Issue #13）。 */
    function restoreFocusFromCollapsedAccordion(accNode) {
        if (!accNode || typeof accNode.contains !== 'function') return;
        var active = document.activeElement;
        if (!active || active === accNode || !accNode.contains(active)) return;
        var head = accNode.head || (accNode.querySelector ? accNode.querySelector('.nvui-acc-head') : null);
        if (!head || active === head || typeof head.focus !== 'function') return;
        head.focus();
    }

    /* ---------------------- 设计令牌读取（含缓存） ---------------------- */
    /*
     * v2.4.0（NEW-10）：getToken() 原本每次调用都执行
     * getComputedStyle(host).getPropertyValue(name) —— 没有任何缓存。
     * getCarrierState() 每次都会调它，业务侧若在渲染循环里取值，
     * 会持续触发样式解析（style recalc），拖慢整页。
     *
     * 缓存策略（刻意做得保守，避免读到过期值）：
     *   - 键 = name + '|' + scopeId（scope 为元素时给元素分配一个稳定 id）；
     *   - 缓存项同时记下当时的 host.className 与 style 属性；
     *     再次读取时若两者变了（主题类切换 / 内联样式改动）→ 直接重算。
     *     这样「切主题」「加 .nvui-solid」这类靠 class 的变更不会读到旧值；
     *   - setTheme() 主动清空缓存（它会切 .nvui-theme-light / .nvui-solid）；
     *   - 另导出 invalidateTokenCache()，供宿主在外部改了样式表后手动失效。
     */
    var tokenCache = Object.create(null);
    var tokenScopeSeq = 0;

    function tokenScopeId(scope) {
        if (!scope) return 'root';
        if (!scope.__nvuiTokenScopeId) {
            tokenScopeSeq += 1;
            try { scope.__nvuiTokenScopeId = tokenScopeSeq; } catch (err) { return 'root'; }
        }
        return 's' + scope.__nvuiTokenScopeId;
    }

    /** 读取当前作用域里的设计令牌（CSS 自定义属性，带缓存） */
    function getToken(name, scope) {
        if (!isDomAvailable()) return '';
        var host = scope || document.documentElement;
        var key = name + '|' + tokenScopeId(host);
        /* 签名：class + 内联样式。两者任一变化都说明令牌可能已改 → 重算 */
        var sig = (host.className || '') + '' + (host.getAttribute ? (host.getAttribute('style') || '') : '');
        var hit = tokenCache[key];
        if (hit && hit.sig === sig) return hit.value;
        var value = getComputedStyle(host).getPropertyValue(name).trim();
        tokenCache[key] = { value: value, sig: sig };
        return value;
    }

    /** 让令牌缓存失效（外部改了样式表 / 需要强制重读时调用） */
    function invalidateTokenCache() {
        tokenCache = Object.create(null);
    }

    /** 主题/实心切换：仅切类名，不写死任何颜色。
     *  v2.7.2：不再无条件清除 `.nvui-solid`（那是用户主动的实心偏好，不能被切主题抹掉）；
     *  只有显式传 `options.solid` 时才切换实心类。 */
    function setTheme(theme, options) {
        var host = (options && options.host) || (isDomAvailable() ? document.body : null);
        if (!host || !host.classList) { warn('setTheme(): 无效 host'); return; }
        host.classList.remove('nvui-theme-light');
        if (theme === 'light') host.classList.add('nvui-theme-light');
        else if (theme && theme !== 'dark') warn('setTheme(): 未知主题');
        if (options && typeof options.solid === 'boolean') {
            if (options.solid) host.classList.add('nvui-solid');
            else host.classList.remove('nvui-solid');
        }
        invalidateTokenCache();
    }

    /* ---------------------- 玻璃能力探测 ---------------------- */
    /*
     * v2.2.0（ISSUES.md #15）：部分宿主（如 SillyTavern 的 Fast UI）会用
     * `body.no-blur * { backdrop-filter: unset !important }` 全局关掉模糊。
     * 浏览器仍然「支持」backdrop-filter，所以 @supports 探测不到，必须读渲染后的实际计算值。
     *
     * v2.7.2（ISSUES.md #16/#17）修正三件事：
     *   1. 回退不再整块不透明：宿主禁用模糊时给根节点加 `.nvui-glass-fallback`，
     *      CSS 用 `--nvui-glass-bg-strong`（0.80）做半透明回退，保留玻璃观感且 AA 安全；
     *      `.nvui-solid` 只保留给「用户主动要全不透明」。
     *   2. 三态探测：`supported` / `unsupported` / `unknown`。unknown 表示 kit CSS 尚未就绪，
     *      此时不写缓存、不落回退，并安排有限次重探（load / fonts / 定时器）。
     *   3. 可逆与「不自杀」：探测前临时摘掉 `.nvui-solid` 与 `.nvui-glass-fallback`，避免探针被 kit
     *      自己的降级规则压成 none 而永久误判；恢复支持时移除自动回退。
     */
    var GLASS_FALLBACK_CLASS = 'nvui-glass-fallback';
    var glassState = { state: null, reason: '', key: '' };
    var glassRecheckTimer = null;
    var glassRecheckAttempts = 0;

    function kitCssReady() {
        if (!isDomAvailable()) return true;
        try {
            return !!getComputedStyle(document.documentElement).getPropertyValue('--nvui-glass-blur').trim();
        } catch (err) {
            return false;
        }
    }

    function hasUserSolid() {
        if (!isDomAvailable()) return false;
        var de = document.documentElement;
        var body = document.body;
        return !!((de && de.classList && de.classList.contains('nvui-solid'))
            || (body && body.classList && body.classList.contains('nvui-solid')));
    }

    function glassSignature() {
        if (!isDomAvailable()) return 'node';
        var reduce = '0';
        try {
            if (window.matchMedia && window.matchMedia('(prefers-reduced-transparency: reduce)').matches) reduce = '1';
        } catch (err) { /* matchMedia 不可用时忽略 */ }
        var rootClass = (document.documentElement.className || '').replace(/\bnvui-glass-fallback\b/, '').replace(/\s+/g, ' ').trim();
        return [
            rootClass,
            (document.body && document.body.className) || '',
            reduce,
            kitCssReady() ? 'css' : 'nocss',
            hasUserSolid() ? 'solid' : 'nosolid',
        ].join('|');
    }

    function applyGlassFallback(root) {
        if (root && root.classList) root.classList.add(GLASS_FALLBACK_CLASS);
    }

    function clearGlassFallback(root) {
        if (root && root.classList && root.classList.contains(GLASS_FALLBACK_CLASS)) {
            root.classList.remove(GLASS_FALLBACK_CLASS);
        }
    }

    /** 探测一次玻璃能力；探测前后恢复用户的 `.nvui-solid` / 自动回退属性（避免自锁）。 */
    function probeGlassState() {
        if (!isDomAvailable() || !document.body) return { state: 'supported', reason: 'no-dom' };
        if (!kitCssReady()) return { state: 'unknown', reason: 'kit-css-not-ready' };
        var de = document.documentElement;
        var body = document.body;
        var restoreSolid = [];
        var restoreFallback = false;
        if (de && de.classList && de.classList.contains(GLASS_FALLBACK_CLASS)) {
            de.classList.remove(GLASS_FALLBACK_CLASS);
            restoreFallback = true;
        }
        if (de && de.classList && de.classList.contains('nvui-solid')) { de.classList.remove('nvui-solid'); restoreSolid.push(de); }
        if (body && body.classList && body.classList.contains('nvui-solid')) { body.classList.remove('nvui-solid'); restoreSolid.push(body); }
        var probe = document.createElement('div');
        probe.className = 'nvui-glass';
        probe.setAttribute('aria-hidden', 'true');
        probe.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:0;';
        document.body.appendChild(probe);
        var state = 'supported';
        var reason = '';
        try {
            var cs = window.getComputedStyle(probe);
            var bf = cs.backdropFilter || cs.webkitBackdropFilter || '';
            if (bf === 'none' || bf === 'unset') { state = 'unsupported'; reason = 'backdrop-filter-disabled'; }
            else if (bf === '') { state = 'unknown'; reason = 'no-computed-backdrop-filter'; }
        } catch (err) {
            state = 'unknown';
            reason = 'probe-failed';
        }
        try { probe.parentNode.removeChild(probe); } catch (err) { /* 忽略移除失败 */ }
        for (var i = 0; i < restoreSolid.length; i++) restoreSolid[i].classList.add('nvui-solid');
        if (de && restoreFallback) de.classList.add(GLASS_FALLBACK_CLASS);
        return { state: state, reason: reason };
    }

    /** 有限次重探：覆盖「脚本先于 kit CSS 执行」的加载顺序竞争（CDN / 模块顶层调用）。 */
    function scheduleGlassRecheck() {
        if (!isDomAvailable() || glassRecheckTimer || glassRecheckAttempts >= 5) return;
        glassRecheckTimer = setTimeout(function () {
            glassRecheckTimer = null;
            glassRecheckAttempts += 1;
            glassState = { state: null, reason: '', key: '' };
            syncGlassFallback();
        }, 120);
        if (glassRecheckAttempts === 0) {
            if (window.addEventListener && document.readyState !== 'complete') {
                window.addEventListener('load', function onLoad() {
                    window.removeEventListener('load', onLoad);
                    syncGlassFallback({ force: true });
                }, { once: true });
            }
            if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
                document.fonts.ready.then(function () { syncGlassFallback({ force: true }); });
            }
        }
    }

    /**
     * 玻璃能力探测（公开 API，返回值保持布尔以兼容 v2.7.1）：
     * true = 模糊可用或暂未确定（unknown 不落回退）；false = 确定被宿主/浏览器禁用。
     * 结果按「根/body class + 减少透明度偏好 + CSS 就绪 + 用户实心偏好」签名缓存。
     */
    function detectGlassSupport(options) {
        if (!isDomAvailable() || !document.body) return true;
        var force = !!(options && options.force);
        var key = glassSignature();
        if (!force && glassState.state !== null && glassState.key === key) return glassState.state !== 'unsupported';
        var result = probeGlassState();
        glassState = { state: result.state, reason: result.reason, key: key };
        glassRecheckAttempts = 0;
        if (result.state === 'unknown') scheduleGlassRecheck();
        return result.state !== 'unsupported';
    }

    /**
     * 探测玻璃能力并同步自动回退：
     * - unsupported（宿主禁用模糊，如 SillyTavern Fast UI 默认 body.no-blur）：
     *   给根节点加 `.nvui-glass-fallback`，CSS 用半透明 strong 档回退；用户 `.nvui-solid` 优先。
     * - supported：移除自动回退（可逆）。
     * - unknown：保持现状，等待重探。
     * 返回 true 表示模糊可用（与 v2.7.1 兼容）。
     */
    function syncGlassFallback(options) {
        var supported = detectGlassSupport(options);
        if (!isDomAvailable()) return supported;
        var root = (options && options.host) || document.documentElement;
        if (!root) return supported;
        var state = glassState.state;
        if (state === 'unsupported' && !hasUserSolid()) applyGlassFallback(root);
        else if (state === 'supported') clearGlassFallback(root);
        return supported;
    }

    /* ---------------------- v2.8.0 玻璃模式（面板级） ---------------------- */

    var GLASS_MODES = ['auto', 'force', 'solid'];

    function normalizeGlassMode(value) {
        if (value === undefined || value === null || value === '') return 'auto';
        var mode = String(value).toLowerCase();
        if (GLASS_MODES.indexOf(mode) === -1) {
            warn('glass 模式 "' + value + '" 无效，已回退 auto（可选 auto/force/solid）');
            return 'auto';
        }
        return mode;
    }

    function browserSupportsBackdrop() {
        if (typeof window === 'undefined' || !window.CSS || typeof window.CSS.supports !== 'function') {
            return true;
        }
        try {
            return !!(window.CSS.supports('backdrop-filter', 'blur(1px)')
                || window.CSS.supports('-webkit-backdrop-filter', 'blur(1px)'));
        } catch (err) {
            return true;
        }
    }

    function glassPreferenceBlocksForce() {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
        try {
            return !!(window.matchMedia('(prefers-reduced-transparency: reduce)').matches
                || window.matchMedia('(forced-colors: active)').matches);
        } catch (err) {
            return false;
        }
    }

    function resolveEffectiveGlassMode(mode) {
        if (mode === 'solid') return 'solid';
        if (mode === 'force') {
            if (!browserSupportsBackdrop() || glassPreferenceBlocksForce()) return 'auto';
            return 'force';
        }
        return 'auto';
    }

    function applyPanelGlassMode(dialogEl, mode) {
        if (!dialogEl || !dialogEl.setAttribute) return 'auto';
        var effective = resolveEffectiveGlassMode(mode);
        /* data-nvui-glass 是「实际生效」模式，供 CSS 使用；请求模式另存，便于 getGlassState 解释。 */
        dialogEl.setAttribute('data-nvui-glass-mode', mode);
        dialogEl.setAttribute('data-nvui-glass', effective);
        if (effective === 'solid') dialogEl.classList.add('nvui-solid');
        else dialogEl.classList.remove('nvui-solid');
        if (effective === 'auto') {
            /* 回到 auto 时重新同步宿主回退；force 时保留全局回退，让其它 auto 面板继续生效 */
            if (typeof syncGlassFallback === 'function') syncGlassFallback();
        }
        return effective;
    }

    function versionTag() {
        return String(VERSION);
    }

    function stampVersion(root) {
        if (!isDomAvailable()) return;
        try {
            if (document.documentElement) document.documentElement.setAttribute('data-nvui-version', versionTag());
            if (root && root.setAttribute) root.setAttribute('data-nvui-version', versionTag());
        } catch (err) { /* 属性写入失败不影响主流程 */ }
    }

    /* ---------------------- 浮层开合（top-layer 载体） ---------------------- */

    /**
     * 打开浮层：非模态 dialog.show()（避免 inert，遵守酒馆 transform 红线），
     * overlay.hidden=false 触发 CSS 进出场。
     */
    function openLayer(dialogEl, overlayEl) {
        if (!dialogEl || !overlayEl) return;
        /* NEW-44：取消尚未完成的关闭定时器，防快速重开被旧定时器意外关闭 */
        if (overlayEl.__nvuiCloseTimer) {
            clearTimeout(overlayEl.__nvuiCloseTimer);
            overlayEl.__nvuiCloseTimer = null;
        }
        overlayEl.classList.remove('is-closing');
        /* 打开瞬间同步一次宿主模态降级态与玻璃能力（v2.7.2：宿主可能在面板创建后才切换 Fast UI） */
        syncHostModalState();
        syncGlassFallback();
        if (dialogEl.open) {
            overlayEl.hidden = false;
            return;
        }
        try {
            dialogEl.show();
        } catch (err) {
            dialogEl.setAttribute('open', '');
        }
        overlayEl.hidden = false;
    }

    /**
     * 退场动画兜底时长：优先从设计令牌 --nvui-duration-base 派生，
     * 保证与 CSS 里的退场动画时长保持一致（额外加 60ms 余量等待 animationend 到达）。
     * 令牌读不到时退回默认 260ms（= 200ms base + 60ms 余量）。
     */
    function animationFallbackMs(extraMs) {
        var raw = getToken('--nvui-duration-base');
        var base = 200;
        if (raw) {
            var parsed = parseFloat(raw);
            if (!isNaN(parsed) && parsed > 0) base = parsed;
        }
        return Math.round(base + (typeof extraMs === 'number' ? extraMs : 60));
    }

    /**
     * 关闭浮层：先加 .is-closing 播放退场动画，animationend（或令牌派生的兜底时长）后 hidden + close。
     */
    function closeLayer(dialogEl, overlayEl, done) {
        if (!dialogEl || !overlayEl) return;
        if (overlayEl.hidden || overlayEl.classList.contains('is-closing')) return;
        overlayEl.classList.add('is-closing');
        var finished = false;
        function finish() {
            if (finished) return;
            finished = true;
            if (overlayEl.__nvuiCloseTimer) {
                clearTimeout(overlayEl.__nvuiCloseTimer);
                overlayEl.__nvuiCloseTimer = null;
            }
            /* NEW-44：若在退场期间已被重新 open，中止关闭流程 */
            if (!overlayEl.classList.contains('is-closing')) return;
            /* 退场监听必须摘除，防止监听器累积 */
            try { overlayEl.removeEventListener('animationend', onAnimEnd); } catch (err) { /* 忽略 */ }
            overlayEl.hidden = true;
            overlayEl.classList.remove('is-closing');
            if (dialogEl.open) {
                try { dialogEl.close(); } catch (err) { dialogEl.removeAttribute('open'); }
            }
            if (typeof done === 'function') done();
        }
        function onAnimEnd(event) {
            /* animationend 冒泡：只认 overlay 自身动画 */
            if (event && event.target !== overlayEl) return;
            finish();
        }
        on(overlayEl, 'animationend', onAnimEnd);
        overlayEl.__nvuiCloseTimer = setTimeout(finish, animationFallbackMs(60));
    }

    /* ---------------------- 标签指示器（粘连滑动） ---------------------- */

    /**
     * 标签指示器几何同步。
     *   NOTE：这里保持「读 offset* → 写 CSS 变量」的原实现，不再改成 getBoundingClientRect。
     *   实机取证（QA，帧间隔判据 README §13.6）显示切 tab 的 p95 帧间隔与静止基线差 0.00ms，
     *   超预算帧 0 —— 强制同步布局在此场景不可感知，改写反而引入行为差异（滚动补偿语义），故保持原样。
     */
    function syncTabsIndicator(tabs, animate) {
        var indicator = q('.nvui-tabs-indicator', tabs);
        var active = q('.nvui-tab.is-active', tabs);
        if (!indicator || !active) return;
        var x = active.offsetLeft;
        var y = active.offsetTop;
        var w = active.offsetWidth;
        var h = active.offsetHeight;
        var had = tabs.classList.contains('is-indicator');
        var prevX = parseFloat(indicator.style.getPropertyValue('--nvui-tab-ind-x')) || 0;
        var prevW = parseFloat(indicator.style.getPropertyValue('--nvui-tab-ind-w')) || 0;
        function set(nx, ny, nw, nh) {
            indicator.style.setProperty('--nvui-tab-ind-x', nx + 'px');
            indicator.style.setProperty('--nvui-tab-ind-y', ny + 'px');
            indicator.style.setProperty('--nvui-tab-ind-w', nw + 'px');
            indicator.style.setProperty('--nvui-tab-ind-h', nh + 'px');
        }
        if (!had || !animate) {
            set(x, y, w, h);
            tabs.classList.add('is-indicator');
            return;
        }
        var left = Math.min(prevX, x);
        var right = Math.max(prevX + prevW, x + w);
        if (left === right && prevX === x) return;
        set(left, y, right - left, h);
        requestAnimationFrame(function () {
            requestAnimationFrame(function () { set(x, y, w, h); });
        });
    }

    /* ---------------------- 基础行组件 ---------------------- */

    /** 胶囊开关行：<label class="nvui-switch-row"><input type="checkbox"><span>…</span></label> */
    function switchRow(options) {
        var opts = options || {};
        if (!opts.label) warnOnce('switchRow-label', 'switchRow(): 缺少 label，将渲染空标签行');
        var row = el('label', 'nvui-switch-row' + (opts.feature ? ' is-feature' : ''));
        var input = el('input', null, { type: 'checkbox' });
        input.checked = !!opts.value;
        if (opts.disabled) input.disabled = true;
        var text = el('span', null, { text: opts.label || '' });
        row.appendChild(input);
        row.appendChild(text);
        if (typeof opts.onChange === 'function') {
            on(input, 'change', function () { opts.onChange(input.checked); });
        }
        return row;
    }

    /* 输入类型白名单：
       - 原生 input 支持的类型直接放行；
       - 'path' 是 kit 的伪类型（路径框：DOM 上仍是 text，只是加 .is-path 样式），
         它在 README / preview 里是公开用法，必须保留；
       - 白名单外的类型（如 'pathway'、'richtext'）静默回退为 text 并记一条 warn。 */
    var INPUT_TYPES = [
        'text', 'number', 'password', 'email', 'url', 'tel', 'search',
        'date', 'time', 'datetime-local', 'month', 'week', 'color', 'range', 'file',
    ];
    var KIT_INPUT_TYPES = ['path'];

    function normalizeInputType(type) {
        if (typeof type !== 'string' || !type) return 'text';
        var t = type.toLowerCase();
        if (INPUT_TYPES.indexOf(t) !== -1) return t;
        if (KIT_INPUT_TYPES.indexOf(t) !== -1) return t;
        warn('inputRow(): 不支持的 type "' + type + '"，已回退为 text');
        return 'text';
    }

    /** 输入行：<label class="nvui-input-row"><input class="nvui-input"><span>…</span></label>
     *
     *  v2.4.0（NEW-05，QA 实测修正）：修复前 `input.type = opts.type === 'number' ? 'number' : 'text'`
     *  会把 10 种请求类型里的 8 种静默改写成 text —— 其中 file / color / date 是**用户可感知的功能消失**
     *  （文件选择器 / 取色器 / 日期选择器直接没了）。现在：
     *    - 原生 input 支持的类型（email / url / tel / search / date / time / color / file / number …）
     *      原样落到 DOM type 属性上；
     *    - 'path' 是 kit 的伪类型：浏览器不支持 type="path"，写进属性会被规范化为 text
     *      （规范：type IDL 属性只反映「已知值」，未知值一律回退 text），
     *      所以 DOM 上就是 type="text" + .is-path —— 这与 preview.html 里手写的路径框
     *      （<input class="nvui-input is-path" type="text">）以及 README §7.6（输入行）完全一致，
     *      **DOM 契约不变**；
     *      调用方若需要知道自己请求的是伪类型，读 input.dataset.nvuiType（= 'path'）——
     *      这与 kit 其它地方用 data-* 承载扩展信息的做法一致，且完全无侵入；
     *    - 白名单外的类型（'pathway'、'richtext' …）静默回退 text 并记一条 warn。 */
    function inputRow(options) {
        var opts = options || {};
        if (!opts.label) warnOnce('inputRow-label', 'inputRow(): 缺少 label，将渲染空标签行');
        var row = el('label', 'nvui-input-row');
        var type = normalizeInputType(opts.type);
        /* 伪类型 path：DOM 类型仍是 text，只靠 .is-path 类表现「路径框」 */
        var domType = type === 'path' ? 'text' : type;
        var input = el('input', 'nvui-input' + (type === 'number' ? ' is-number' : (type === 'path' ? ' is-path' : '')));
        input.type = domType;
        if (type === 'path') {
            /* 伪类型的意图用 data-* 承载：
               不覆盖 input.type 的 IDL 访问器 —— 覆盖会造成「DOM 属性是 text、JS 读出 path」
               的双真值，序列化 / cloneNode / 表单提交看到的是 text，而业务代码读到 path；
               且 setter 语义会错乱（写 number 后 getter 仍返回 path，读写永久不一致）。
               现在 DOM 与手写的 .is-path 路径框完全同构，意图由 dataset.nvuiType 暴露。 */
            input.setAttribute('data-nvui-type', 'path');
        }
        if (opts.value !== undefined && opts.value !== null) {
            try {
                input.value = opts.value;
            } catch (err) {
                /* file 类型不允许程序赋非空值，赋值会抛 InvalidStateError —— 忽略即可 */
                warn('inputRow(): type="' + type + '" 不接受程序赋值，已忽略 value');
            }
        }
        if (opts.placeholder) input.placeholder = opts.placeholder;
        if (opts.min !== undefined && typeof opts.min !== 'symbol' && isFinite(Number(opts.min))) input.min = opts.min;
        if (opts.max !== undefined && typeof opts.max !== 'symbol' && isFinite(Number(opts.max))) input.max = opts.max;
        if (opts.step !== undefined && typeof opts.step !== 'symbol' && isFinite(Number(opts.step))) input.step = opts.step;
        if (opts.disabled) input.disabled = true;
        var text = el('span', null, { text: opts.label || '' });
        row.appendChild(input);
        row.appendChild(text);
        if (typeof opts.onChange === 'function') {
            on(input, 'change', function () {
                /* number 类型回传数字（与 input.value 的字符串语义区分开）；
                   其余类型仍回传字符串，保持既有契约。 */
                if (type === 'number') {
                    var n = Number(input.value);
                    opts.onChange(isFinite(n) ? n : 0);
                    return;
                }
                opts.onChange(input.value);
            });
        }
        row.input = input;
        return row;
    }

    /** 折叠分组：button.nvui-acc-head + .nvui-acc-body > .nvui-acc-inner */
    function accordion(options) {
        var opts = options || {};
        if (!opts.title) warnOnce('accordion-title', 'accordion(): 缺少 title，将渲染空标题折叠组');
        var root = el('div', 'nvui-acc' + (opts.open ? ' is-open' : ''));
        var head = el('button', 'nvui-acc-head nvui-acc-header', { type: 'button', 'aria-expanded': opts.open ? 'true' : 'false' });
        var title = el('span', 'nvui-acc-title', { text: opts.title || '' });
        var summary = el('span', 'nvui-acc-summary', { text: opts.summary || '' });
        var chev = el('i', 'nvui-acc-chev', { 'aria-hidden': 'true' });
        append(head, [title, summary, chev]);
        var body = el('div', 'nvui-acc-body');
        var inner = el('div', 'nvui-acc-inner');
        append(inner, opts.content || []);
        body.appendChild(inner);
        append(root, [head, body]);
        on(head, 'click', function () {
            var open = root.classList.toggle('is-open');
            head.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        root.head = head;
        root.inner = inner;
        root.setOpen = function (v) {
            root.classList.toggle('is-open', !!v);
            head.setAttribute('aria-expanded', v ? 'true' : 'false');
            /* Issue #13：收起时焦点若在正文里会随 visibility:hidden 一起失踪，
               先把焦点还给仍然可见的折叠触发器。 */
            if (!v) restoreFocusFromCollapsedAccordion(root);
        };
        root.setSummary = function (text) { summary.textContent = text || ''; };
        return root;
    }

    /**
     * 进度值归一化：把任意输入（字符串 / NaN / 越界 / null）折算成 [0,100] 的有限数。
     * 初始渲染与 setValue 共用同一份归一化结果，
     * 保证 aria-valuenow 与 .nvui-progress-bar 的 width 永远一致（自愈）。
     */
    function normalizeProgressValue(value) {
        /* NEW-45：防范 Symbol 转换抛错 */
        if (typeof value === 'symbol' || value === null || value === undefined) return 0;
        var n = Number(value);
        if (!isFinite(n)) n = 0;
        if (n < 0) n = 0;
        if (n > 100) n = 100;
        return n;
    }

    /** 线性进度条：role=progressbar + .nvui-progress-bar（宽度由 API 设置） */
    function progress(options) {
        var opts = options || {};
        if (opts.indeterminate && !opts.label) warnOnce('progress-label', 'progress({indeterminate:true}): 缺少 label/aria-label，屏幕阅读器无法获知进度含义');
        var initial = normalizeProgressValue(opts.value);
        var trackAttrs = {
            role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
            'aria-valuenow': opts.indeterminate ? null : String(initial),
        };
        /* NEW-42：只要调用方提供了 label，不论确定与不确定进度均赋予 aria-label（符合 WAI-ARIA 规范） */
        if (opts.label) trackAttrs['aria-label'] = (typeof opts.label === 'symbol') ? '' : String(opts.label);
        var track = el('div', 'nvui-progress', trackAttrs);
        /* NEW-34：variant 类名过滤校验，防带空格字符引发未捕获 DOMException */
        if (opts.variant) {
            var safeVariant = sanitizeIdPart(opts.variant, '');
            if (safeVariant) {
                track.classList.add('is-' + safeVariant);
            } else {
                warn('progress(): variant 含有非法字符，已忽略');
            }
        }
        if (opts.indeterminate) track.classList.add('is-indeterminate');
        var bar = el('span', 'nvui-progress-bar');

        /* v2.2.0 修订补丁（ISSUES.md #11）：0% 与 100% 时停掉扫光动画。
         * 扫光是「进行中」的装饰，0%/100% 继续跑无限循环纯属浪费合成层资源。
         * 不确定进度永远保持扫光（它本身就表示进行中）。 */
        function syncActivity(n) {
            if (track.classList.contains('is-indeterminate')) {
                track.classList.remove('is-idle', 'is-complete');
                return;
            }
            if (n <= 0) {
                track.classList.add('is-idle');
                track.classList.remove('is-complete');
            } else if (n >= 100) {
                track.classList.add('is-complete');
                track.classList.remove('is-idle');
            } else {
                track.classList.remove('is-idle', 'is-complete');
            }
        }

        /* 初始渲染与 setValue 必须共用同一份归一化值：
           否则 aria-valuenow（字符串 '80' → 80）与 bar 宽度（仍是 0）会长期不一致。 */
        if (!opts.indeterminate) {
            bar.style.width = initial + '%';
            syncActivity(initial);
        } else {
            /* 不确定进度：宽度由 CSS 的 40% + 扫光动画接管，不写内联 width */
            syncActivity(initial);
        }
        track.appendChild(bar);
        track.setValue = function (v) {
            var n = normalizeProgressValue(v);
            bar.style.width = n + '%';
            track.setAttribute('aria-valuenow', String(n));
            syncActivity(n);
        };
        return track;
    }

    /* ---------------------- Esc 全局单例调度 ---------------------- */
    /*
     * 面板数量不定，若每个面板各自 addEventListener('keydown', …, {document})，
     * 监听器会随面板创建无限累积（且多面板时任一 Esc 会关闭全部）。
     * 这里改为：全局只挂一个 document 级监听器，维护一个「打开顺序栈」，
     * Esc 只交给栈顶（最上层）的面板；面板 destroy() 时把自己从栈里摘掉。
     */

    var escapeStack = [];
    var escapeBound = false;

    function onEscapeKey(event) {
        if (event.key !== 'Escape') return;
        /* Issue #14：宿主用 dialog.showModal() 打开原生模态时，宿主处于 top layer，
           Esc 属于最上层宿主。Kit 只做视觉/指针让位（.is-host-modal）不够，
           键盘调度也必须暂停；这里不调用 preventDefault，宿主 cancel 的默认行为
           保持原样。已被别处处理（defaultPrevented）的 Esc 同样让行。 */
        if (event.defaultPrevented) return;
        if (countHostModals() > 0) return;
        for (var i = escapeStack.length - 1; i >= 0; i--) {
            var entry = escapeStack[i];
            if (!entry) continue;
            /* NEW-37：若关联宿主已脱离文档树，自动驱逐孤儿 entry，防止劫持合法可见面板 */
            if (entry.isConnected && !entry.isConnected()) {
                escapeStack.splice(i, 1);
                continue;
            }
            if (entry.isVisible && entry.isVisible()) {
                entry.handler(event);
                return;
            }
        }
    }

    function registerEscapeHandler(handler, isVisible, isConnected) {
        if (!escapeBound) {
            document.addEventListener('keydown', onEscapeKey);
            escapeBound = true;
        }
        /* NEW-29：支持 promote 动态将 entry 提升到栈顶；NEW-37：支持 isConnected 自动清理孤儿 */
        var entry = {
            handler: handler,
            isVisible: isVisible || function () { return true; },
            isConnected: isConnected || function () { return true; },
            promote: function () {
                var idx = escapeStack.indexOf(entry);
                if (idx !== -1 && idx !== escapeStack.length - 1) {
                    escapeStack.splice(idx, 1);
                    escapeStack.push(entry);
                }
            }
        };
        escapeStack.push(entry);
        return entry;
    }

    function unregisterEscapeHandler(handler) {
        for (var i = escapeStack.length - 1; i >= 0; i--) {
            if (escapeStack[i] && escapeStack[i].handler === handler) {
                escapeStack.splice(i, 1);
                break;
            }
        }
        if (escapeStack.length === 0 && escapeBound) {
            document.removeEventListener('keydown', onEscapeKey);
            escapeBound = false;
        }
    }

    /* ---------------------- 浮层载体与宿主模态 ---------------------- */

    /** 当前文档里处于模态状态的原生 dialog 数量。
     *  浏览器支持 `:modal` 伪类时用它判定（Chrome 105+ / Edge 105+ / Safari 17.4+）；
     *  不支持时退化为「存在 open 的 dialog 且非 kit 自身载体」。 */
    /* NEW-27：静态平台能力一次性检测缓存，避免频繁运行时重复执行 CSS.supports 解析 */
    var isModalSelectorSupported = (function () {
        try {
            return typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
                && CSS.supports('selector(:modal)');
        } catch (err) {
            return false;
        }
    })();

    /** 当前文档里处于模态状态的原生 dialog 数量。
     *  浏览器支持 `:modal` 伪类时用它判定（Chrome 105+ / Edge 105+ / Safari 17.4+）；
     *  不支持时退化为「存在 open 的 dialog 且非 kit 自身载体」。 */
    function countHostModals() {
        if (!isDomAvailable()) return 0;
        if (isModalSelectorSupported) {
            var modals = document.querySelectorAll('dialog:modal');
            var n = 0;
            for (var i = 0; i < modals.length; i++) {
                /* 排除 kit 自己的载体（kit 载体是非模态 show()，理论上不会是 :modal，
                   但若宿主误用 showModal 打开 kit 载体，这里也排除以免自我降级） */
                if (modals[i].classList.contains('nvui-tl')) continue;
                n += 1;
            }
            return n;
        }
        /* 回退：kit 载体永远用非模态 show()，所以任何 :modal 的 dialog 都视为宿主模态 */
        var all = document.querySelectorAll('dialog[open]');
        var count = 0;
        for (var j = 0; j < all.length; j++) {
            if (all[j].classList.contains('nvui-tl')) continue;
            count += 1;
        }
        return count;
    }

    /** 同步「宿主模态」降级态到所有 kit 载体。
     *  宿主用 showModal() 打开弹窗时，会给整个文档加 inert —— kit 浮层**无法**
     *  压过它（不是 z-index 问题，popover=manual 也一样，见 README §13.7）。
     *  正确做法是主动让位：给 kit 载体加 `.is-host-modal`（不可点 + 压暗）。
     *  返回当前宿主模态数量。 */
    function syncHostModalState() {
        if (!isDomAvailable()) return 0;
        installHostModalWatcher();
        var modalCount = countHostModals();
        var degraded = modalCount > 0;
        debug('syncHostModalState(): 宿主模态数量=' + modalCount + '，kit 载体降级=' + degraded);
        var carriers = document.querySelectorAll('dialog.nvui-tl');
        for (var i = 0; i < carriers.length; i++) {
            if (degraded) carriers[i].classList.add('is-host-modal');
            else carriers[i].classList.remove('is-host-modal');
        }
        return modalCount;
    }

    /** 自动监听宿主模态的开关（幂等，只装一次）。
     *  两条触发源：
     *   1. MutationObserver 监听 <dialog> 的 open 属性变化（showModal() / show() / close()）；
     *   2. document 捕获阶段的 'close' 事件（dialog 关闭不冒泡，需捕获）。
     *  命中后调用 syncHostModalState()，使 kit 载体在宿主模态期间自动降级。
     *
     *  v2.4.0（NEW-07）：观察面从「documentElement 全文档 subtree+attributes」
     *  收窄为「逐个 dialog 元素 + 仅 childList 的轻量发现器」——
     *  全文档属性观察会让宿主每一次 DOM 属性变化都进入观察器队列，开销与宿主规模成正比。 */
    var hostModalWatcherInstalled = false;
    var hostModalOpenObserver = null;
    var hostModalScanObserver = null;

    function observeDialogOpen(dialog) {
        if (!dialog || !hostModalOpenObserver) return;
        /* NEW-25：去除全局强引用数组 observedDialogs，改用私有标记，
           节点脱离 DOM 销毁时可被 GC 正常回收，彻底消除 Detached DOM 内存泄漏 */
        if (dialog.__nvuiObserved) return;
        dialog.__nvuiObserved = true;
        try {
            hostModalOpenObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] });
        } catch (err) {
            /* 单个 dialog 观察失败不影响其它 */
        }
    }

    /** 递归扫描子树中的 dialog（NEW-30：返回是否发现 dialog；NEW-28：跳过纯文本内联叶子节点） */
    function scanForDialogs(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return false;
        var list = root.querySelectorAll('dialog');
        if (!list || !list.length) return false;
        for (var i = 0; i < list.length; i++) observeDialogOpen(list[i]);
        return true;
    }

    function installHostModalWatcher() {
        if (hostModalWatcherInstalled || !isDomAvailable()) return;
        hostModalWatcherInstalled = true;
        try {
            /* 观察器 A：只观察「具体某个 dialog」的 open 属性 —— 观察面最小 */
            hostModalOpenObserver = new MutationObserver(function (records) {
                for (var i = 0; i < records.length; i++) {
                    if (records[i].type === 'attributes' && records[i].attributeName === 'open') {
                        syncHostModalState();
                        return;
                    }
                }
            });
            /* 观察器 B：只做 childList，发现宿主新建或移除的 dialog */
            hostModalScanObserver = new MutationObserver(function (records) {
                var sawDialog = false;
                for (var i = 0; i < records.length; i++) {
                    if (records[i].type !== 'childList') continue;
                    var added = records[i].addedNodes;
                    for (var j = 0; j < added.length; j++) {
                        var node = added[j];
                        if (!node || node.nodeType !== 1) continue;
                        if (node.tagName === 'DIALOG') {
                            observeDialogOpen(node);
                            sawDialog = true;
                        } else if (node.children && node.children.length > 0) {
                            /* NEW-28：快速跳过不可能包含 dialog 的纯文本内联标签 */
                            var tn = node.tagName;
                            if (tn !== 'SPAN' && tn !== 'P' && tn !== 'CODE' && tn !== 'EM' && tn !== 'STRONG' && tn !== 'I' && tn !== 'B') {
                                /* NEW-30：子树中若存在 dialog，向上标记 sawDialog = true */
                                if (scanForDialogs(node)) sawDialog = true;
                            }
                        }
                    }
                    /* NEW-35：宿主模态直接从 DOM 移除时同步让位状态，防 kit 载体永久锁死 */
                    var removed = records[i].removedNodes;
                    for (var k = 0; k < removed.length; k++) {
                        var rNode = removed[k];
                        if (!rNode || rNode.nodeType !== 1) continue;
                        if (rNode.tagName === 'DIALOG' || (rNode.querySelector && rNode.querySelector('dialog'))) {
                            sawDialog = true;
                        }
                    }
                }
                if (sawDialog) syncHostModalState();
            });
            /* 已有 dialog：逐个挂上 open 属性观察 */
            scanForDialogs(document);
            hostModalScanObserver.observe(document.documentElement, { childList: true, subtree: true });
            document.addEventListener('close', function () { syncHostModalState(); }, true);
        } catch (err) {
            /* 观察器不可用时降级为「仅手动调用 syncHostModalState()」，不影响功能 */
            hostModalWatcherInstalled = false;
            hostModalOpenObserver = null;
            hostModalScanObserver = null;
            error('installHostModalWatcher(): 观察器不可用，已降级为手动同步', err);
        }
    }

    /** 查询浮层载体与宿主模态的层级关系快照（诊断 / 宿主集成用）。
     *  返回 { carrierZ, hostModalCount, degraded, carriers: [{ id, className, zIndex, degraded }] } */
    function getCarrierState() {
        if (!isDomAvailable()) {
            return { carrierZ: '', hostModalCount: 0, degraded: false, carriers: [] };
        }
        var modalCount = countHostModals();
        var carriers = [];
        var list = document.querySelectorAll('dialog.nvui-tl');
        for (var i = 0; i < list.length; i++) {
            var cs = window.getComputedStyle(list[i]);
            carriers.push({
                id: list[i].id || '',
                className: list[i].className,
                zIndex: cs.zIndex,
                degraded: list[i].classList.contains('is-host-modal'),
                open: list[i].hasAttribute('open'),
            });
        }
        return {
            carrierZ: getToken('--nvui-z-layer'),
            hostModalCount: modalCount,
            degraded: modalCount > 0,
            carriers: carriers,
        };
    }

    /* ---------------------- 表现层布局状态持久化 (Issue #5) ---------------------- */

    var PERSIST_DEBOUNCE_MS = 250;

    /**
     * 默认存储适配器：基于 window.localStorage，
     * 键名带沙箱前缀 nvui_state_${id}。
     * 所有读写均受 try/catch 保护，吸纳 QuotaExceededError 与 SecurityError 并记录 warn。
     */
    var defaultStorageAdapter = {
        get: function (key) {
            try {
                if (typeof window !== 'undefined' && window.localStorage) {
                    var raw = window.localStorage.getItem(key);
                    return raw ? JSON.parse(raw) : null;
                }
            } catch (err) {
                warn('defaultStorageAdapter.get(): 无法读取 localStorage', err);
            }
            return null;
        },
        set: function (key, val) {
            try {
                if (typeof window !== 'undefined' && window.localStorage) {
                    if (val === null || val === undefined) {
                        window.localStorage.removeItem(key);
                    } else {
                        window.localStorage.setItem(key, JSON.stringify(val));
                    }
                }
            } catch (err) {
                warn('defaultStorageAdapter.set(): 无法写入 localStorage', err);
            }
        },
        delete: function (key) {
            try {
                if (typeof window !== 'undefined' && window.localStorage) {
                    window.localStorage.removeItem(key);
                }
            } catch (err) {
                warn('defaultStorageAdapter.delete(): 无法清除 localStorage', err);
            }
        }
    };

    /**
     * 辅助清理接口：清除指定面板在存储中的历史布局记忆。
     * 可选传入自定义 storageAdapter，默认使用 defaultStorageAdapter。
     */
    function clearLayoutState(id, storageAdapter) {
        if (!id) return;
        var key = 'nvui_state_' + sanitizeIdPart(String(id), 'nvui-panel');
        var storage = storageAdapter || defaultStorageAdapter;
        try {
            if (typeof storage.delete === 'function') {
                var delResult = storage.delete(key);
                if (delResult && typeof delResult.catch === 'function') {
                    delResult.catch(function (err) {
                        warn('clearLayoutState(): 异步清除存储状态失败', err);
                    });
                }
            } else if (typeof storage.set === 'function') {
                var sResult = storage.set(key, null);
                if (sResult && typeof sResult.catch === 'function') {
                    sResult.catch(function (err) {
                        warn('clearLayoutState(): 异步清除存储状态失败', err);
                    });
                }
            }
        } catch (e) {
            warn('clearLayoutState(): 清理存储状态失败', e);
        }
    }

    /** 读取当前视口尺寸，优先以 window.innerWidth/innerHeight 为准以适配移动端模拟与缩放 */
    function getViewport() {
        var vw = (typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth > 0)
            ? window.innerWidth
            : ((typeof document !== 'undefined' && document.documentElement && document.documentElement.clientWidth) || 0);
        var vh = (typeof window !== 'undefined' && typeof window.innerHeight === 'number' && window.innerHeight > 0)
            ? window.innerHeight
            : ((typeof document !== 'undefined' && document.documentElement && document.documentElement.clientHeight) || 0);
        return { vw: vw, vh: vh, isMobile: vw <= 600 };
    }

    /** 辅助比较两个持久化状态是否实质一致（避免冗余写入） */
    function isStateEqual(a, b) {
        if (!a || !b) return false;
        if (a.tab !== b.tab) return false;
        var aSize = a.size;
        var bSize = b.size;
        if (!aSize !== !bSize) return false;
        if (aSize && bSize) {
            if (aSize.width !== bSize.width) return false;
            if (aSize.height !== bSize.height) return false;
            if (!!aSize.isMaximized !== !!bSize.isMaximized) return false;
        }
        var aAcc = a.accordion;
        var bAcc = b.accordion;
        if (!aAcc !== !bAcc) return false;
        if (aAcc && bAcc) {
            var aKeys = Object.keys(aAcc);
            var bKeys = Object.keys(bAcc);
            if (aKeys.length !== bKeys.length) return false;
            for (var i = 0; i < aKeys.length; i++) {
                var k = aKeys[i];
                if (aAcc[k] !== bAcc[k]) return false;
            }
        }
        return true;
    }

    /**
     * 多分辨率跨屏视口越界钳制防护数学模型 (Viewport Clamping)。
     * - 手机端（<=600px）强制清空内联固定像素，交由 CSS 100% 抽屉规范接管；
     * - 桌面端钳制宽在 [min(320, vw-32), vw-32]，高在 [min(240, vh-32), vh-32]；
     * - 默认 targetW 采用 720px 黄金尺寸（支持 opts.width 自定义）；
     * - 坐标自愈钳制在安全可视边距 (margin >= 16px) 范围内，确保标题栏与关闭按钮绝对可达。
     */
    function clampPanelLayout(savedSize, savedPos, options) {
        if (!isDomAvailable()) {
            return { isMobile: false, width: null, height: null, styleWidth: '', styleHeight: '' };
        }

        var vp = getViewport();
        var vw = vp.vw;
        var vh = vp.vh;
        var isMobile = vp.isMobile;

        // 移动端安全降级：必须遵守手机端底部抽屉标准规范
        if (isMobile) {
            return {
                isMobile: true,
                width: null,
                height: null,
                styleWidth: '',
                styleHeight: '',
            };
        }

        var margin = 16;
        var minW = Math.min(320, Math.max(0, vw - margin * 2));
        var minH = Math.min(240, Math.max(0, vh - margin * 2));
        var maxW = Math.max(minW, Math.max(0, vw - margin * 2));
        var maxH = Math.max(minH, Math.max(0, vh - margin * 2));

        var fallbackW = (options && typeof options.width === 'number' && !isNaN(options.width)) ? options.width : 720;
        var targetW = (savedSize && typeof savedSize.width === 'number' && !isNaN(savedSize.width)) ? savedSize.width : fallbackW;
        var targetH = (savedSize && typeof savedSize.height === 'number' && !isNaN(savedSize.height)) ? savedSize.height : null;

        var clampedW = Math.max(minW, Math.min(targetW, maxW));
        var clampedH = targetH ? Math.max(minH, Math.min(targetH, maxH)) : null;

        var res = {
            isMobile: false,
            width: clampedW,
            height: clampedH,
            styleWidth: clampedW + 'px',
            styleHeight: clampedH ? (clampedH + 'px') : '',
        };

        if (savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number' && !isNaN(savedPos.x) && !isNaN(savedPos.y)) {
            var clampedX = Math.max(margin, Math.min(savedPos.x, vw - clampedW - margin));
            var clampedY = Math.max(margin, Math.min(savedPos.y, vh - (clampedH || 400) - margin));
            res.x = clampedX;
            res.y = clampedY;
        }
        return res;
    }

    /* ---------------------- 面板（布局标准） ---------------------- */

    /**
     * createPanel(options) 生成完整面板并返回控制器。
     * options:
     *   id            根 id 前缀（默认 nvui-panel-<n>）
     *   title         标题（aria-labelledby 指向它）
     *   version       右上角版本徽标文字（可选）
     *   tabs          [{ key, label, icon }]；为空时无导航（单页面板）
     *   active        初始 tab key（默认第一个）
     *   actions       标题栏右侧额外图标按钮 [{ icon, label, onClick }]
     *   footer        底部按钮 [{ label, variant, onClick, close }]
     *   mount         挂载节点（默认 document.body）
     *   onClose       关闭后回调
     *   destroy       面板销毁后回调（destroy() 被调用时触发）
     */
    function restoreForeignNodes(d) {
        try {
            if (d && d.childNodes && document.body) {
                var list = Array.from(d.childNodes);
                for (var i = 0; i < list.length; i++) {
                    var n = list[i];
                    if (n && n.id === 'toast-container') document.body.appendChild(n);
                }
            }
        } catch (e) {}
    }

    function createPanel(options) {
        var opts = options || {};
        /* 宿主若全局禁用了 backdrop-filter，先恢复回退态，避免玻璃只剩半透明底色 */
        syncGlassFallback();
        var glassMode = normalizeGlassMode(opts.glass);
        var effectiveGlassMode = glassMode;
        var glassMediaCleanup = null;
        /* 面板 id 会被派生出 -layer / -overlay / -title / -tab-* / -pane-* 等多个 DOM id，
           所以它本身也必须是合法 id（不能含空格 / 引号 / < >）。 */
        var id = uniqueId(sanitizeIdPart(opts.id || 'nvui-panel', 'nvui-panel'));
        var opener = null;

        /* 宿主若全局禁用了 backdrop-filter，先做实心回退，避免玻璃只剩半透明底色 */
        syncGlassFallback();
        /* 宿主若正处于模态弹窗（showModal），kit 载体应主动让位而非硬压 */
        syncHostModalState();
        /* 装一次监听：宿主模态动态开关时自动降级/还原 */
        installHostModalWatcher();

        /* 持久化配置解析 (Issue #5) */
        var persistConfig = null;
        if (opts.persist === true) {
            persistConfig = { size: true, tab: true, accordion: true, storage: defaultStorageAdapter };
        } else if (opts.persist && typeof opts.persist === 'object') {
            persistConfig = {
                size: opts.persist.size !== false,
                tab: opts.persist.tab !== false,
                accordion: opts.persist.accordion !== false,
                storage: (opts.persist.storage && typeof opts.persist.storage.get === 'function' && typeof opts.persist.storage.set === 'function')
                    ? opts.persist.storage
                    : defaultStorageAdapter,
            };
        } else if (opts.persist) {
            warn('createPanel(): 无效 persist 配置，已忽略');
        }
        var storageKey = 'nvui_state_' + sanitizeIdPart(opts.id || id, 'nvui-panel');
        var storage = persistConfig ? persistConfig.storage : null;
        var loadedState = null;
        var isRestoring = false;
        var isInitialized = false;
        var hasSaved = false;
        var persistTimer = null;
        var accList = [];
        var resizeRaf = null;
        var resizeObserver = null;
        var accBindings = [];
        var disposed = false;
        var autoKeyWarned = false;

        /* NEW-36：显式设置 closing="" 与 role="presentation"，杜绝 SillyTavern fixToastrForDialogs 劫持注入 */
        var dialogTitleStr = (typeof opts.title === 'symbol') ? '面板' : (opts.title || '面板');
        var dialog = el('dialog', 'nvui-tl', {
            id: id + '-layer',
            closing: '',
            role: 'presentation',
            'aria-label': dialogTitleStr + ' 浮层',
            'data-nvui-version': VERSION,
            'data-nvui-glass-mode': glassMode,
        });
        stampVersion(dialog);
        var overlay = el('div', 'nvui-overlay is-panel', { id: id + '-overlay', hidden: '' });
        var panel = el('div', 'nvui-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id + '-title' });
        effectiveGlassMode = applyPanelGlassMode(dialog, glassMode);

        /* force 模式需要跟随系统「减少透明度 / 强制颜色」动态让位；auto/solid 也同步一次。 */
        function refreshPanelGlassMode() {
            effectiveGlassMode = applyPanelGlassMode(dialog, glassMode);
        }
        if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
            var glassMqs = [
                window.matchMedia('(prefers-reduced-transparency: reduce)'),
                window.matchMedia('(forced-colors: active)'),
            ];
            var onGlassPrefChange = function () { refreshPanelGlassMode(); };
            glassMqs.forEach(function (mq) {
                if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', onGlassPrefChange);
            });
            glassMediaCleanup = function () {
                glassMqs.forEach(function (mq) {
                    if (mq && typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onGlassPrefChange);
                });
            };
        }

        /* 初始自定义宽度（opts.width，默认交由 CSS / token 720px） */
        if (typeof opts.width === 'number' && !isNaN(opts.width)) {
            var initClamp = clampPanelLayout({ width: opts.width }, null, opts);
            if (!initClamp.isMobile && initClamp.styleWidth) {
                panel.style.width = initClamp.styleWidth;
            }
        }

        /* 手机拖拽把手（纯视觉） */
        panel.appendChild(el('div', 'nvui-sheet-handle', { 'aria-hidden': 'true' }));

        /* 标题栏 */
        var header = el('div', 'nvui-panel-header');
        var title = el('b', 'nvui-panel-title', { id: id + '-title', text: opts.title || '面板' });
        if (opts.version) title.appendChild(el('span', 'nvui-badge', { text: opts.version }));

        /* 版本更新提示胶囊与动态点亮接口 (Issue #6) */
        var updatePill = null;
        var currentUpdateConfig = null;
        var isSuppressedForUpdate = false;

        function showUpdate(updateConfig) {
            isSuppressedForUpdate = true;
            try {
                if (!updateConfig || updateConfig.hidden === true) {
                    if (updatePill && updatePill.parentNode) {
                        updatePill.parentNode.removeChild(updatePill);
                    }
                    updatePill = null;
                    currentUpdateConfig = null;
                    return null;
                }

                if (typeof updateConfig !== 'object') {
                    warn('showUpdate(): 无效 update 配置，已忽略');
                    return null;
                }

                currentUpdateConfig = updateConfig;
                var verStr = (updateConfig.version === null || updateConfig.version === undefined) ? '' : String(updateConfig.version);
                var labelStr = (updateConfig.label !== null && updateConfig.label !== undefined)
                    ? String(updateConfig.label)
                    : (verStr ? ('v' + verStr + ' 可用') : '新版本可用');

                if (!updatePill) {
                    updatePill = el('span', 'nvui-badge is-accent nvui-update-pill', {
                        role: 'button',
                        tabindex: '0',
                        'aria-label': updateConfig.ariaLabel || (verStr ? ('发现新版本: ' + verStr) : '版本更新可用'),
                    });

                    var handleUpdateTrigger = function (e) {
                        if (!currentUpdateConfig) return;
                        var handled = false;
                        if (typeof currentUpdateConfig.onClick === 'function') {
                            handled = true;
                            try {
                                currentUpdateConfig.onClick(e);
                            } catch (err) {
                                warn('showUpdate onClick error', err);
                            }
                        }
                        if (!handled && currentUpdateConfig.url) {
                            var urlStr = String(currentUpdateConfig.url).trim();
                            if (!isSafeUrl(urlStr)) {
                                warn('showUpdate(): 已拒绝非法的 URL 协议: ' + urlStr);
                                return;
                            }
                            try {
                                if (typeof window !== 'undefined' && window.open) {
                                    window.open(urlStr, '_blank', 'noopener,noreferrer');
                                }
                            } catch (err) {
                                warn('showUpdate(): 打开更新链接失败', err);
                            }
                        }
                    };

                    on(updatePill, 'click', handleUpdateTrigger);
                    on(updatePill, 'keydown', function (e) {
                        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                            e.preventDefault();
                            handleUpdateTrigger(e);
                        }
                    });

                    title.appendChild(updatePill);
                } else {
                    updatePill.setAttribute('aria-label', updateConfig.ariaLabel || (verStr ? ('发现新版本: ' + verStr) : '版本更新可用'));
                }

                // 严格采用 textContent 写入文本，杜绝 XSS 注入通道
                updatePill.textContent = labelStr;
                return updatePill;
            } finally {
                setTimeout(function () {
                    isSuppressedForUpdate = false;
                }, 100);
            }
        }

        if (opts.update) {
            showUpdate(opts.update);
        }

        /* 头部操作流区：严格保证 [自定义 actions...] -> [主题切换 themeToggle] -> [关闭 closeBtn] */
        var actions = el('span', 'nvui-panel-actions');
        (opts.actions || []).forEach(function (a) {
            var btn = el('button', 'nvui-icon-btn', { type: 'button', 'aria-label': a.label || '操作' });
            var ic = iconNode(a.icon);
            if (ic) btn.appendChild(ic);
            if (typeof a.onClick === 'function') on(btn, 'click', a.onClick);
            actions.appendChild(btn);
        });

        /* 预置主题切换按钮 (Issue #6) */
        var themeToggleBtn = null;
        var hasThemeToggle = (opts.themeToggle === true) || (opts.themeToggle && typeof opts.themeToggle === 'object');
        var isCurrentLight = function () {
            return isDomAvailable() && document.body && document.body.classList.contains('nvui-theme-light');
        };
        var updateThemeToggleUi = null;

        if (hasThemeToggle) {
            if (opts.themeToggle && typeof opts.themeToggle === 'object' && (opts.themeToggle.initial === 'dark' || opts.themeToggle.initial === 'light')) {
                setTheme(opts.themeToggle.initial);
            }
            var curLight = isCurrentLight();
            themeToggleBtn = el('button', 'nvui-icon-btn nvui-theme-toggle', {
                type: 'button',
                title: '切换主题',
                'aria-label': curLight ? '切换为深色主题' : '切换为浅色主题',
            });
            var themeIcon = el('i', curLight ? 'fa-solid fa-moon' : 'fa-solid fa-sun', { 'aria-hidden': 'true' });
            themeToggleBtn.appendChild(themeIcon);

            updateThemeToggleUi = function (light) {
                if (!themeToggleBtn) return;
                themeToggleBtn.setAttribute('aria-label', light ? '切换为深色主题' : '切换为浅色主题');
                if (themeIcon) {
                    themeIcon.className = light ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
                }
            };

            on(themeToggleBtn, 'click', function () {
                var nextTheme = isCurrentLight() ? 'dark' : 'light';
                setTheme(nextTheme);
                updateThemeToggleUi(nextTheme === 'light');
                if (typeof opts.onThemeChange === 'function') {
                    try { opts.onThemeChange(nextTheme); } catch (e) { warn('onThemeChange error', e); }
                }
                if (opts.themeToggle && typeof opts.themeToggle.onThemeChange === 'function') {
                    try { opts.themeToggle.onThemeChange(nextTheme); } catch (e) { warn('themeToggle.onThemeChange error', e); }
                }
            });

            actions.appendChild(themeToggleBtn);
        }

        var closeBtn = el('button', 'nvui-icon-btn', { type: 'button', 'aria-label': '关闭面板' });
        closeBtn.appendChild(el('i', 'fa-solid fa-xmark', { 'aria-hidden': 'true' }));
        actions.appendChild(closeBtn);
        append(header, [title, actions]);
        panel.appendChild(header);

        /* 标签导航 + 内容面板
         *
         * v2.4.0 起对 tabs[].key 做归一化（NEW-02）：
         *   - key 会被拼进 DOM id（`<id>-tab-<key>` / `<id>-pane-<key>`），
         *     含空格 / 引号 / < > 时会产生非法 id 并让 ARIA 的 IDREF 断链；
         *   - 重复 key 会让 panes 映射互相覆盖，第一个面板静默丢失。
         * 归一化策略：对外仍然使用调用方给的原始 key（addNode/setTab 契约不变），
         * 内部另建一个「合法且唯一」的 domKey 用于 DOM id 与面板映射。 */
        var tabsNav = null;
        var bottomNav = null;
        /* pane 集合用 Map（NEW-09）：
           - O(1) 查表，且天然没有原型链 —— 普通对象上 '__proto__' / 'constructor'
             这类 key 会命中 Object.prototype，导致 keyMap 赋值失效、panes 覆盖出错；
           - Map 是语言内置数据结构，不引入任何依赖，也不改变 ES5 语法风格
             （本文件仍只用 var + 经典 function）。 */
        var panes = new Map();      /* domKey -> pane 元素 */
        var keyMap = new Map();     /* 原始 key -> domKey（重复 key 取第一个） */
        var domKeySet = new Map();  /* domKey -> true（去重用） */
        var rawTabs = Array.isArray(opts.tabs) ? opts.tabs : [];
        var tabs = [];
        rawTabs.forEach(function (t, index) {
            if (!t) return;
            var origKey = (t.key === null || t.key === undefined) ? '' : String(t.key);
            var base = sanitizeIdPart(origKey, 'tab-' + (index + 1));
            var domKey = base;
            var seq = 2;
            while (domKeySet.has(domKey)) {
                domKey = base + '-' + seq;
                seq += 1;
            }
            domKeySet.set(domKey, true);
            if (!keyMap.has(origKey)) keyMap.set(origKey, domKey);
            tabs.push({ key: origKey, domKey: domKey, label: t.label, icon: t.icon });
        });

        /* active 归一化：只接受确实存在于 tabs 的 key，否则回退到第一个（NEW-15） */
        var activeDom = null;     /* 当前激活标签的内部 domKey */
        if (tabs.length) {
            var wantActive = (opts.active === null || opts.active === undefined) ? '' : String(opts.active);
            var matched = null;
            for (var ti = 0; ti < tabs.length; ti++) {
                if (tabs[ti].key === wantActive || tabs[ti].domKey === wantActive) { matched = tabs[ti]; break; }
            }
            if (!matched) {
                if (wantActive) warn('createPanel(): active "' + wantActive + '" 不存在，已回退到第一个标签');
                matched = tabs[0];
            }
            activeDom = matched.domKey;
        }
        debug('createPanel(): id=' + id + '，标签数=' + tabs.length + '，激活=' + (activeDom || '(无)'));

        if (tabs.length) {
            tabsNav = el('nav', 'nvui-tabs', { role: 'tablist', 'aria-label': '面板分区' });
            tabsNav.appendChild(el('span', 'nvui-tabs-indicator', { 'aria-hidden': 'true' }));
            tabs.forEach(function (t) {
                var tab = el('button', 'nvui-tab' + (t.domKey === activeDom ? ' is-active' : ''), {
                    type: 'button', role: 'tab', id: id + '-tab-' + t.domKey,
                    'data-tab': t.key,
                    'data-key': t.key,
                    'aria-selected': t.domKey === activeDom ? 'true' : 'false',
                    'aria-controls': id + '-pane-' + t.domKey,
                    tabindex: t.domKey === activeDom ? '0' : '-1',
                });
                var ic = iconNode(t.icon);
                if (ic) tab.appendChild(ic);
                var tabLabelStr = (typeof t.label === 'symbol' || typeof t.key === 'symbol') ? '标签' : String(t.label || t.key);
                tab.appendChild(document.createTextNode(tabLabelStr));
                on(tab, 'click', function () { setTabByDom(t.domKey); });
                tabsNav.appendChild(tab);
            });
            /* NEW-41：符合 WAI-ARIA APG Tabs Pattern 的方向键与 Home/End 键盘导航 */
            on(tabsNav, 'keydown', function (e) {
                if (!tabs.length) return;
                var curIdx = -1;
                for (var i = 0; i < tabs.length; i++) {
                    if (tabs[i].domKey === activeDom) { curIdx = i; break; }
                }
                var nextIdx = -1;
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    nextIdx = (curIdx + 1) % tabs.length;
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    nextIdx = (curIdx - 1 + tabs.length) % tabs.length;
                } else if (e.key === 'Home') {
                    nextIdx = 0;
                } else if (e.key === 'End') {
                    nextIdx = tabs.length - 1;
                }
                if (nextIdx !== -1 && nextIdx !== curIdx) {
                    e.preventDefault();
                    setTabByDom(tabs[nextIdx].domKey);
                    var targetTab = tabsNav.querySelector('#' + id + '-tab-' + tabs[nextIdx].domKey);
                    if (targetTab && typeof targetTab.focus === 'function') targetTab.focus();
                }
            });
            panel.appendChild(tabsNav);
        }

        var body = el('div', 'nvui-panel-body');
        panes = new Map();
        tabs.forEach(function (t) {
            var pane = el('div', 'nvui-tabpane' + (t.domKey === activeDom ? ' is-active' : ''), {
                role: 'tabpanel', id: id + '-pane-' + t.domKey, 'aria-labelledby': id + '-tab-' + t.domKey,
            });
            panes.set(t.domKey, pane);
            body.appendChild(pane);
        });
        panel.appendChild(body);

        /* 可选底部操作区 */
        if (opts.footer && opts.footer.length) {
            var footer = el('div', 'nvui-panel-footer');
            opts.footer.forEach(function (b) {
                if (!b) return;
                var safeV = (typeof b.variant === 'symbol' || !b.variant) ? '' : String(b.variant);
                var btn = el('button', 'nvui-btn' + (safeV ? ' is-' + safeV : ''), { type: 'button', text: b.label || '' });
                on(btn, 'click', function () {
                    if (typeof b.onClick === 'function') b.onClick();
                    if (b.close) closePanel();
                });
                footer.appendChild(btn);
            });
            panel.appendChild(footer);
        }

        /* 手机底部导航（与顶部 tabs 同一份状态） */
        if (tabs.length) {
            bottomNav = el('nav', 'nvui-bottom-nav', { 'aria-label': '面板分区（手机）' });
            tabs.forEach(function (t) {
                var item = el('button', 'nvui-bottom-nav-item' + (t.domKey === activeDom ? ' is-active' : ''), {
                    type: 'button', 'aria-label': t.label || t.key,
                    'data-tab': t.key,
                    'data-key': t.key,
                });
                if (t.domKey === activeDom) item.setAttribute('aria-current', 'page');
                var ic = iconNode(t.icon);
                if (ic) item.appendChild(ic);
                item.appendChild(el('span', null, { text: t.label || t.key }));
                on(item, 'click', function () { setTabByDom(t.domKey); });
                bottomNav.appendChild(item);
            });
            panel.appendChild(bottomNav);
        }

        append(overlay, panel);
        dialog.appendChild(overlay);
        /* 挂载点兜底（NEW-18）：opts.mount 可能是无效节点，
           document.body 也可能尚未就绪（脚本在 <head> 内同步执行）。
           直接 appendChild 会抛 TypeError 且无提示 —— 这里显式降级并报错。 */
        var mountNode = opts.mount;
        if (!mountNode || typeof mountNode.appendChild !== 'function') {
            if (opts.mount) warn('createPanel(): opts.mount 不是有效节点，已回退到 document.body');
            mountNode = document.body;
        }
        if (!mountNode || typeof mountNode.appendChild !== 'function') {
            error('createPanel(): 挂载点不可用（opts.mount 与 document.body 均无效），已中止创建');
            return null;
        }
        /* 挂载动作本身也可能抛错（NEW-18 补充）：
           上面的「类型检查」只能挡住「不是节点」的情况，挡不住
           「是节点但 appendChild 会失败」—— 例如宿主把 body 换成了
           自定义元素代理、节点已在一个会被拒绝的文档（XML / 已废弃的
           HTMLCollection 场景）、或 appendChild 被宿主重写成抛错的实现。
           无论哪种情况，异常都**不得穿透到调用方**（createPanel 的契约是
           「失败时返回 null」），否则调用方的 try/catch 会被迫处理一个
           本该被 kit 内部吸收的错误。失败时显式报 error 级日志并返回 null。 */
        try {
            mountNode.appendChild(dialog);
        } catch (err) {
            error('createPanel(): 面板挂载失败（mountNode.appendChild 抛错），已中止创建', err);
            return null;
        }

        /* 持久化调度与视口钳制方法 */
        function anyPersistEnabled() {
            return !!(persistConfig && (persistConfig.size || persistConfig.tab || persistConfig.accordion));
        }

        function schedulePersistSave() {
            if (!persistConfig || isRestoring || disposed || !anyPersistEnabled()) return;
            if (persistTimer) clearTimeout(persistTimer);
            persistTimer = setTimeout(function () {
                persistTimer = null;
                flushPersistSave();
            }, PERSIST_DEBOUNCE_MS);
        }

        function flushPersistSave(force) {
            if (!persistConfig || disposed || !anyPersistEnabled()) {
                return;
            }
            var hadTimer = !!persistTimer;
            if (persistTimer) {
                clearTimeout(persistTimer);
                persistTimer = null;
            }
            try {
                var defaultW = (opts && typeof opts.width === 'number' && !isNaN(opts.width)) ? opts.width : 720;
                var currentW = defaultW;
                var currentH = null;
                var isMax = panel.classList.contains('is-maximized');
                var vp = getViewport();
                var isMobile = vp.isMobile;

                if (isMobile && loadedState && loadedState.size) {
                    currentW = loadedState.size.width;
                    currentH = loadedState.size.height;
                    isMax = !!loadedState.size.isMaximized;
                } else {
                    if (panel.style.width && panel.style.width.indexOf('px') !== -1) {
                        currentW = parseInt(panel.style.width, 10);
                    } else if (panel.offsetWidth > 0) {
                        currentW = panel.offsetWidth;
                    } else if (loadedState && loadedState.size && typeof loadedState.size.width === 'number') {
                        currentW = loadedState.size.width;
                    }

                    if (panel.style.height && panel.style.height.indexOf('px') !== -1) {
                        currentH = parseInt(panel.style.height, 10);
                    } else if (panel.offsetHeight > 0 && !isMobile) {
                        currentH = panel.offsetHeight;
                    } else if (loadedState && loadedState.size && typeof loadedState.size.height === 'number') {
                        currentH = loadedState.size.height;
                    }
                }

                var currentTabKey = null;
                if (tabs.length) {
                    for (var i = 0; i < tabs.length; i++) {
                        if (tabs[i].domKey === activeDom) {
                            currentTabKey = tabs[i].key;
                            break;
                        }
                    }
                }

                /* 原始键可能是 "__proto__" / "constructor" 等，必须用无原型对象承接，
                   否则普通对象赋值会走原型 setter 而不是写入持久键。 */
                var currentAccState = Object.create(null);
                for (var a = 0; a < accList.length; a++) {
                    var item = accList[a];
                    /* 已脱离本面板的旧节点不参与保存；否则重渲染后旧状态会反写新节点。 */
                    if (!isAccordionItemLive(item)) continue;
                    currentAccState[item.id] = item.node.classList.contains('is-open');
                }
                if (loadedState && loadedState.accordion) {
                    var savedAccKeys = Object.keys(loadedState.accordion);
                    for (var ki = 0; ki < savedAccKeys.length; ki++) {
                        var k = savedAccKeys[ki];
                        if (currentAccState[k] === undefined && Object.prototype.hasOwnProperty.call(loadedState.accordion, k)) {
                            currentAccState[k] = loadedState.accordion[k];
                        }
                    }
                }

                var toSave = {
                    version: 1,
                    timestamp: Date.now(),
                    size: persistConfig.size ? {
                        width: currentW,
                        height: currentH,
                        isMaximized: isMax,
                    } : (loadedState ? loadedState.size : null),
                    tab: persistConfig.tab ? currentTabKey : (loadedState ? loadedState.tab : null),
                    accordion: persistConfig.accordion ? currentAccState : (loadedState ? loadedState.accordion : null),
                };

                if (!hadTimer && hasSaved && !force && isStateEqual(toSave, loadedState)) {
                    return;
                }

                loadedState = toSave;
                hasSaved = true;
                var saveResult = storage.set(storageKey, toSave);
                if (saveResult && typeof saveResult.catch === 'function') {
                    saveResult.catch(function (err) {
                        warn('flushPersistSave(): 异步保存状态失败', err);
                    });
                }
                debug('flushPersistSave(): 已保存面板状态 key=' + storageKey);
            } catch (e) {
                warn('flushPersistSave(): 保存布局状态失败', e);
            }
        }

        function applyLoadedState(saved) {
            if (!saved || typeof saved !== 'object') {
                isInitialized = true;
                return;
            }
            isRestoring = true;
            try {
                // 1. 恢复尺寸
                if (persistConfig && persistConfig.size && saved.size) {
                    if (saved.size.isMaximized) {
                        panel.classList.add('is-maximized');
                    } else {
                        panel.classList.remove('is-maximized');
                    }
                    var clamped = clampPanelLayout(saved.size, saved.position, opts);
                    if (clamped.isMobile) {
                        panel.style.width = '';
                        panel.style.height = '';
                    } else {
                        if (saved.size.isMaximized) {
                            panel.style.width = 'calc(100vw - 32px)';
                            panel.style.height = 'calc(100vh - 32px)';
                        } else {
                            if (clamped.styleWidth) panel.style.width = clamped.styleWidth;
                            if (clamped.styleHeight) panel.style.height = clamped.styleHeight;
                        }
                    }
                }

                // 2. 恢复 Tab（支持数值 0 及失效/删除 key 优雅回退）
                if (persistConfig && persistConfig.tab && saved.tab !== undefined && saved.tab !== null) {
                    var rawSavedKey = String(saved.tab);
                    var hasTabKey = keyMap.has(rawSavedKey);
                    if (!hasTabKey) {
                        for (var tIdx = 0; tIdx < tabs.length; tIdx++) {
                            if (tabs[tIdx].domKey === rawSavedKey) {
                                hasTabKey = true;
                                break;
                            }
                        }
                    }
                    if (hasTabKey) {
                        setTab(saved.tab);
                    } else if (tabs.length) {
                        warn('applyLoadedState(): 存储中的标签 key "' + rawSavedKey + '" 不存在或已失效，已回退到首个可用标签');
                        setTabByDom(tabs[0].domKey);
                    }
                }

                // 3. 恢复 Accordion
                if (persistConfig && persistConfig.accordion && saved.accordion) {
                    for (var a = 0; a < accList.length; a++) {
                        var item = accList[a];
                        if (Object.prototype.hasOwnProperty.call(saved.accordion, item.id)
                            && typeof saved.accordion[item.id] === 'boolean') {
                            item.node.setOpen(saved.accordion[item.id]);
                        }
                    }
                }
            } finally {
                isRestoring = false;
                isInitialized = true;
            }
        }

        function applyClamping() {
            if (!isDomAvailable()) return;
            var vp = getViewport();
            if (vp.isMobile) {
                panel.style.width = '';
                panel.style.height = '';
                return;
            }
            var isMax = panel.classList.contains('is-maximized');
            if (isMax) {
                panel.style.width = 'calc(100vw - 32px)';
                panel.style.height = 'calc(100vh - 32px)';
                return;
            }

            var targetW = null;
            if (panel.style.width && panel.style.width.indexOf('px') !== -1) {
                targetW = parseInt(panel.style.width, 10);
            } else if (loadedState && loadedState.size && typeof loadedState.size.width === 'number') {
                targetW = loadedState.size.width;
            } else if (typeof opts.width === 'number' && !isNaN(opts.width)) {
                targetW = opts.width;
            }

            var targetH = null;
            if (panel.style.height && panel.style.height.indexOf('px') !== -1) {
                targetH = parseInt(panel.style.height, 10);
            } else if (loadedState && loadedState.size && typeof loadedState.size.height === 'number') {
                targetH = loadedState.size.height;
            }

            if (targetW !== null || targetH !== null) {
                var clamped = clampPanelLayout({ width: targetW, height: targetH }, null, opts);
                if (clamped.styleWidth) panel.style.width = clamped.styleWidth;
                if (clamped.styleHeight) panel.style.height = clamped.styleHeight;
            }
        }

        /* ------------------------------------------------------------------
         * Issue #11：折叠条接管（公开注册入口 panel.trackAccordion / adoptAccordions）
         *
         * 原实现只认两条注册路径：panel.addAccordion()，以及 panel.addNode() 且
         * 节点自带 setOpen —— 而 setOpen 只有 accordion() 工厂产物才有。插件用
         * HTML 字符串注入 .nvui-acc（最常见写法）因此永远进不了 accList，
         * 存下来的 accordion 是空对象。这里把「注册」改成调用方可显式声明：
         *   1) 幂等：同一节点重复 track / adopt 只登记一次，返回既有 id；
         *   2) 键优先级：显式 id > node.id > data-nvui-acc-key > 面板内 DOM 顺序；
         *      三者都缺失时生成 acc_auto_<n> 并只警告一次（顺序变化会错位）；
         *   3) 与已有行为共存：节点已自带 setOpen（工厂产物或调用方自管）时**不**
         *      接管点击，只包一层保存钩子，避免双重 toggle；
         *   4) 纯 DOM 折叠条（没有 setOpen）：补齐 setOpen（恢复 / 清除需要），
         *      **默认不绑定点击** —— 调用方常已有委托监听，kit 不猜测，避免双重
         *      toggle；确实需要 kit 提供默认开合时显式传 { bind: true }；
         *   5) persist.accordion 关闭时：只补行为，不登记、不写存储；
         *   6) destroy() 后统一解绑，避免脱离 DOM 的节点继续触发落盘。
         * ------------------------------------------------------------------ */

        function accordionHeadOf(accNode) {
            if (accNode.head) return accNode.head;
            return (accNode.querySelector ? accNode.querySelector('.nvui-acc-head') : null);
        }

        function bindAccordionEvent(target, type, handler, owner) {
            if (!target || typeof target.addEventListener !== 'function') return null;
            target.addEventListener(type, handler, false);
            var binding = { target: target, type: type, handler: handler };
            if (owner) {
                if (!owner.bindings) owner.bindings = [];
                owner.bindings.push(binding);
            } else {
                accBindings.push(binding);
            }
            return binding;
        }

        function unbindAccordionBinding(binding) {
            if (!binding) return;
            try { binding.target.removeEventListener(binding.type, binding.handler, false); } catch (e) {}
        }

        function unbindAccordionItem(item) {
            if (!item) return;
            if (item.bindings) {
                for (var i = 0; i < item.bindings.length; i++) {
                    unbindAccordionBinding(item.bindings[i]);
                }
                item.bindings = [];
            }
            var node = item.node;
            if (node && item.wrappedSetOpen && node.setOpen === item.wrappedSetOpen) {
                try {
                    if (item.hadSetOpenProp) node.setOpen = item.origSetOpen;
                    else delete node.setOpen;
                } catch (e) {}
            }
        }

        function unbindAccordionEvents() {
            for (var i = 0; i < accBindings.length; i++) {
                unbindAccordionBinding(accBindings[i]);
            }
            accBindings = [];
            for (var j = 0; j < accList.length; j++) {
                unbindAccordionItem(accList[j]);
            }
            accList = [];
        }

        /* 纯 DOM 折叠条的行为补齐：只切 .is-open 与 aria-expanded，不重建 DOM。
         * 注意：setOpen 一定要补（恢复 / clearLayoutState 要调用它），但**点击**只在
         * 调用方显式要求（bind: true）时才接管 —— 否则极易与插件自己的委托监听叠加成
         * 双重 toggle。节点已有 setOpen 时一律不接管点击，只包保存钩子。 */
        function ensureAccordionBehavior(accNode, bindClick, owner) {
            if (typeof accNode.setOpen === 'function') return false;
            accNode.setOpen = function (v) {
                var open = !!v;
                accNode.classList.toggle('is-open', open);
                var h = accordionHeadOf(accNode);
                if (h && typeof h.setAttribute === 'function') {
                    h.setAttribute('aria-expanded', open ? 'true' : 'false');
                }
                if (!open) restoreFocusFromCollapsedAccordion(accNode);
            };
            if (bindClick === true) {
                bindAccordionEvent(accordionHeadOf(accNode), 'click', function () {
                    accNode.setOpen(!accNode.classList.contains('is-open'));
                }, owner);
            }
            return true;
        }

        function findAccordionItem(accNode) {
            for (var i = 0; i < accList.length; i++) {
                if (accList[i].node === accNode) return accList[i];
            }
            return null;
        }

        function findAccordionItemById(accId) {
            for (var i = 0; i < accList.length; i++) {
                if (accList[i].id === accId) return accList[i];
            }
            return null;
        }

        function accordionIdTaken(candidate) {
            return !!findAccordionItemById(candidate);
        }

        function isAccordionItemLive(item) {
            return !!(item && item.node && panel.contains && panel.contains(item.node));
        }

        /** 稳定键推导：显式 id > DOM id > data-nvui-acc-key；都没有返回 null。
         *  持久化键只是普通对象键，不需要满足 DOM id 语法；这里保留原始键，
         *  否则不同中文/非 ASCII 键会被 sanitizeIdPart 折叠成同一个键。 */
        function deriveAccordionId(accNode, explicitId) {
            if (explicitId !== undefined && explicitId !== null && String(explicitId) !== '') {
                return String(explicitId);
            }
            if (accNode.id) return String(accNode.id);
            if (typeof accNode.getAttribute === 'function') {
                var dataKey = accNode.getAttribute('data-nvui-acc-key');
                if (dataKey) return String(dataKey);
            }
            return null;
        }

        /** 兜底键：面板内 .nvui-acc 的 DOM 顺序，比 accList.length+1 更可复现 */
        function autoAccordionId(accNode) {
            var all = panel.querySelectorAll ? panel.querySelectorAll('.nvui-acc') : null;
            var idx = all ? Array.prototype.indexOf.call(all, accNode) : -1;
            if (idx < 0) idx = accList.length;
            return 'acc_auto_' + (idx + 1);
        }

        /** 生成键的唯一化：已被活动节点占用时追加序号；只被脱离节点占用时
         *  返回原键，由 panelTrackAccordion 走「替换旧条目」路径。 */
        function uniqueAccordionId(base) {
            var rootId = String(base || 'acc');
            var candidate = rootId;
            var suffix = 2;
            while (true) {
                var item = findAccordionItemById(candidate);
                if (!item || !isAccordionItemLive(item)) return candidate;
                candidate = rootId + '-' + suffix;
                suffix += 1;
            }
        }

        /** 工厂标题兜底键：ASCII 标题保留 v2.5 的 sanitize 结果（避免无谓迁移），
         *  含非 ASCII 的标题保留原始标题（中文标题不再全部折叠成 "__"）。 */
        function titleAccordionId(title, fallback) {
            var raw = (title === null || title === undefined) ? '' : String(title);
            if (!raw) return uniqueAccordionId(fallback);
            if (/[^\x00-\x7F]/.test(raw)) return uniqueAccordionId(raw);
            return uniqueAccordionId(sanitizeIdPart(raw, fallback));
        }

        function removeAccordionItem(item) {
            var idx = accList.indexOf(item);
            if (idx >= 0) accList.splice(idx, 1);
            unbindAccordionItem(item);
        }

        function registerAccordionItem(item) {
            var accNode = item.node;
            accList.push(item);
            if (persistConfig && persistConfig.accordion && loadedState && loadedState.accordion
                && Object.prototype.hasOwnProperty.call(loadedState.accordion, item.id)
                && typeof loadedState.accordion[item.id] === 'boolean') {
                accNode.setOpen(loadedState.accordion[item.id]);
            }
            var head = accordionHeadOf(accNode);
            if (head) {
                /* 只负责「点击后落盘」；开合行为由工厂或 ensureAccordionBehavior 提供 */
                bindAccordionEvent(head, 'click', function () {
                    if (persistConfig && persistConfig.accordion && !isRestoring && !disposed) {
                        schedulePersistSave();
                    }
                }, item);
            }
            var baseSetOpen = accNode.setOpen;
            var wrappedSetOpen = function (v) {
                baseSetOpen.call(accNode, v);
                /* 调用方自带的 setOpen 未必处理焦点回收，这里统一兜底（Issue #13）。 */
                if (!v) restoreFocusFromCollapsedAccordion(accNode);
                if (persistConfig && persistConfig.accordion && !isRestoring && !disposed) {
                    schedulePersistSave();
                }
            };
            accNode.setOpen = wrappedSetOpen;
            item.wrappedSetOpen = wrappedSetOpen;
        }

        function panelTrackAccordion(accNode, explicitId, options) {
            if (!accNode || accNode.nodeType !== 1 || !accNode.classList || !accNode.classList.contains('nvui-acc')) {
                warn('trackAccordion(): 传入节点不是 .nvui-acc 元素，已忽略');
                return null;
            }
            /* 已挂在别的 kit 面板里的折叠条不越界接管（尚未插入 DOM 的节点不受影响） */
            if (typeof accNode.closest === 'function') {
                var ownerPanel = accNode.closest('.nvui-panel');
                if (ownerPanel && ownerPanel !== panel) {
                    warn('trackAccordion(): 该折叠条属于另一个面板，已忽略（每个面板只接管自己的内容）');
                    return null;
                }
            }
            /* 已连接却不在本面板：外部容器 / 其它文档，拒绝；
               detached 节点保持既有契约（允许插入前预注册）。 */
            if (accNode.isConnected && !panel.contains(accNode)) {
                warn('trackAccordion(): 该折叠条不在本面板内，已忽略（每个面板只接管自己的内容）');
                return null;
            }
            /* 已销毁的面板不再接受新接管，也不再挂任何监听 */
            if (disposed) return null;
            /* 允许省略 id：trackAccordion(node, { bind: false }) */
            if (explicitId && typeof explicitId === 'object') {
                options = options || explicitId;
                explicitId = undefined;
            }
            var existing = findAccordionItem(accNode);
            if (existing) {
                var wanted = deriveAccordionId(accNode, explicitId);
                if (wanted && wanted !== existing.id) {
                    warn('trackAccordion(): 节点已注册为 "' + existing.id + '"，忽略新 id "' + wanted + '"（首次注册优先）');
                }
                return existing.id;
            }
            var opt = (options && typeof options === 'object') ? options : {};
            /* 行为补齐与持久化分离：即使不持久化，注入的折叠条也应该点得动 */
            if (!persistConfig || !persistConfig.accordion) {
                ensureAccordionBehavior(accNode, opt.bind, null);
                return null;
            }

            var accId = deriveAccordionId(accNode, explicitId);
            if (!accId) {
                accId = uniqueAccordionId(autoAccordionId(accNode));
                if (!autoKeyWarned) {
                    autoKeyWarned = true;
                    warn('trackAccordion(): 折叠条缺少稳定键（id / data-nvui-acc-key），已按面板内顺序生成 "' + accId + '"；DOM 顺序变化会导致状态错位，建议注入时给出 id');
                }
            }
            var idItem = findAccordionItemById(accId);
            if (idItem) {
                if (isAccordionItemLive(idItem)) {
                    warn('trackAccordion(): id "' + accId + '" 已被另一折叠条占用，本条不注册（避免状态互相覆盖）');
                    return null;
                }
                /* 同稳定键的新节点替换已经脱离本面板的旧条目：
                   先解绑旧节点的 kit 监听并恢复它的 setOpen，再登记新节点。 */
                removeAccordionItem(idItem);
            }

            var item = {
                id: accId,
                node: accNode,
                bindings: [],
                hadSetOpenProp: Object.prototype.hasOwnProperty.call(accNode, 'setOpen'),
                origSetOpen: accNode.setOpen,
                wrappedSetOpen: null,
            };
            ensureAccordionBehavior(accNode, opt.bind, item);
            registerAccordionItem(item);
            return accId;
        }

        function panelAdoptAccordions(root, options) {
            if (!root || typeof root.querySelectorAll !== 'function') {
                warn('adoptAccordions(): 需要传入元素 / DocumentFragment 容器，已忽略');
                return 0;
            }
            var doc = panel.ownerDocument;
            if (root === doc || (doc && (root === doc.documentElement || root === doc.body))) {
                warn('adoptAccordions(): 拒绝扫描 document / body，请传入本面板的容器（如 panel.body）');
                return 0;
            }
            /* 已连接的外部容器拒绝；detached 元素 / DocumentFragment 允许预注册。 */
            if (root.isConnected && root !== panel && !panel.contains(root)) {
                warn('adoptAccordions(): 容器不在本面板内，已忽略（每个面板只接管自己的内容）');
                return 0;
            }
            var count = 0;
            function adoptNode(node) {
                var known = !!findAccordionItem(node);
                var id = panelTrackAccordion(node, undefined, options);
                if (id && !known) count += 1;
            }
            /* root 自身就是折叠条时也要接管（不能只扫后代） */
            if (root.nodeType === 1 && root.classList && root.classList.contains('nvui-acc')) {
                adoptNode(root);
            }
            var nodes = root.querySelectorAll('.nvui-acc');
            for (var i = 0; i < nodes.length; i++) {
                adoptNode(nodes[i]);
            }
            return count;
        }

        function cleanupPersist() {
            if (persistConfig) {
                try { window.removeEventListener('resize', onWindowResize); } catch (e) {}
                if (resizeRaf) { cancelAnimationFrame(resizeRaf); resizeRaf = null; }
                /* 先冲刷最后一次状态，再置 disposed —— 顺序不能反，否则 flush 会被拦掉 */
                flushPersistSave();
                if (resizeObserver) {
                    try { resizeObserver.disconnect(); } catch (e) {}
                    resizeObserver = null;
                }
            }
            disposed = true;
            unbindAccordionEvents();
        }

        function panelClearLayoutState() {
            if (persistTimer) {
                clearTimeout(persistTimer);
                persistTimer = null;
            }
            clearLayoutState(opts.id || id, storage);
            loadedState = null;
            hasSaved = false;
            panel.style.width = '';
            panel.style.height = '';
            panel.classList.remove('is-maximized');
            if (tabs.length) {
                setTabByDom(tabs[0].domKey);
            }
            for (var a = 0; a < accList.length; a++) {
                if (isAccordionItemLive(accList[a])) accList[a].node.setOpen(false);
            }
            if (tabsNav) syncTabsIndicator(tabsNav, false);
        }

        var onWindowResize = function () {
            if (overlay.hidden || overlay.classList.contains('is-closing')) return;
            if (resizeRaf) cancelAnimationFrame(resizeRaf);
            resizeRaf = requestAnimationFrame(function () {
                resizeRaf = null;
                applyClamping();
                if (tabsNav) syncTabsIndicator(tabsNav, false);
            });
        };

        if (persistConfig) {
            try {
                var raw = storage.get(storageKey);
                if (raw && typeof raw.then === 'function') {
                    raw.then(function (val) {
                        loadedState = val;
                        applyLoadedState(loadedState);
                    }).catch(function (err) {
                        warn('createPanel(): 异步读取存储失败', err);
                        isInitialized = true;
                    });
                } else {
                    loadedState = raw;
                    applyLoadedState(loadedState);
                }
            } catch (err) {
                warn('createPanel(): 读取存储异常', err);
                isInitialized = true;
            }

            var lastObservedW = null;
            var lastObservedH = null;

            if (persistConfig.size && typeof ResizeObserver !== 'undefined' && isDomAvailable()) {
                try {
                    resizeObserver = new ResizeObserver(function () {
                        if (isRestoring || !isInitialized) return;
                        if (overlay.hidden || overlay.classList.contains('is-closing')) return;
                        var vp = getViewport();
                        if (vp.isMobile) return;
                        var curW = Math.round(panel.offsetWidth);
                        var curH = Math.round(panel.offsetHeight);
                        if (lastObservedW === null) {
                            lastObservedW = curW;
                            lastObservedH = curH;
                            return;
                        }
                        if (isSuppressedForUpdate) {
                            lastObservedW = curW;
                            lastObservedH = curH;
                            return;
                        }
                        if (curW === lastObservedW && curH === lastObservedH) return;
                        lastObservedW = curW;
                        lastObservedH = curH;
                        schedulePersistSave();
                    });
                    resizeObserver.observe(panel);
                } catch (e) {
                    warn('createPanel(): ResizeObserver 注册失败', e);
                }
            }
        }

        /** 按 domKey 切换标签（内部用） */
        function setTabByDom(domKey) {
            if (!panes.get(domKey)) return;
            var prevDom = activeDom;
            activeDom = domKey;
            if (tabsNav) {
                Array.prototype.forEach.call(tabsNav.querySelectorAll('.nvui-tab'), function (tab) {
                    var on_ = tab.id === id + '-tab-' + domKey;
                    tab.classList.toggle('is-active', on_);
                    tab.setAttribute('aria-selected', on_ ? 'true' : 'false');
                    tab.setAttribute('tabindex', on_ ? '0' : '-1');
                });
                syncTabsIndicator(tabsNav, true);
            }
            if (bottomNav) {
                Array.prototype.forEach.call(bottomNav.querySelectorAll('.nvui-bottom-nav-item'), function (item, index) {
                    var on_ = tabs[index] && tabs[index].domKey === domKey;
                    item.classList.toggle('is-active', on_);
                    if (on_) item.setAttribute('aria-current', 'page');
                    else item.removeAttribute('aria-current');
                });
            }
            /* 只切换「旧 pane → 新 pane」两个元素（NEW-09）：
               原实现每次全量遍历所有 pane 并逐个 classList.toggle，
               tabs 数量 N 时切换成本 O(N) 且每个 pane 都触发样式失效。 */
            var prevPane = panes.get(prevDom);
            var nextPane = panes.get(domKey);
            if (prevPane && prevPane !== nextPane) prevPane.classList.remove('is-active');
            if (nextPane) nextPane.classList.add('is-active');
            if (persistConfig && persistConfig.tab && !isRestoring) {
                schedulePersistSave();
            }
        }

        /**
         * 按调用方给的原始 key 切换标签（对外契约不变）。
         * 重复 key 取第一个（与 keyMap 一致），非法 key 静默忽略。
         */
        function setTab(key) {
            if (key === null || key === undefined) return;
            var raw = String(key);
            var domKey = keyMap.get(raw);
            if (!domKey) {
                /* 也允许直接传内部 domKey */
                for (var i = 0; i < tabs.length; i++) {
                    if (tabs[i].domKey === raw) { domKey = raw; break; }
                }
            }
            if (!domKey) {
                warn('setTab(): 未知标签 key "' + raw + '"，已忽略');
                return;
            }
            setTabByDom(domKey);
        }

        /** 在 scope 内取第一个「焦点陷阱认可」的可聚焦元素 */
        function firstTrapFocusable(scope) {
            if (!scope || typeof scope.querySelectorAll !== 'function') return null;
            var list = scope.querySelectorAll(FOCUSABLE);
            for (var i = 0; i < list.length; i++) {
                if (isTrapFocusable(list[i])) return list[i];
            }
            return null;
        }

        /**
         * 打开面板后的初始焦点（Issue #13）。
         * 只在**当前激活 pane** 里选目标：持久化恢复到非首 tab 时，
         * 不能在整块 panel 里找 .is-primary —— 那会命中隐藏 pane，
         * focus() 静默失败后焦点停在 Kit 载体上。
         * 回退链：当前 pane 的 primary → 当前 pane 首个可见控件 →
         * 当前 tab 按钮 → panel 内其它 primary → 关闭按钮 → 面板容器。
         */
        function focusBody() {
            requestAnimationFrame(function () {
                var pane = activeDom ? panes.get(activeDom) : null;
                var target = null;
                if (pane) {
                    var primary = q('.nvui-btn.is-primary', pane);
                    if (primary && isTrapFocusable(primary)) target = primary;
                    if (!target) target = firstTrapFocusable(pane);
                }
                if (!target && activeDom) {
                    var tabBtn = document.getElementById(id + '-tab-' + activeDom);
                    if (tabBtn && isTrapFocusable(tabBtn)) target = tabBtn;
                }
                if (!target) {
                    var anyPrimary = q('.nvui-btn.is-primary', panel);
                    if (anyPrimary && isTrapFocusable(anyPrimary)) target = anyPrimary;
                }
                if (!target && closeBtn && isTrapFocusable(closeBtn)) target = closeBtn;
                if (target && typeof target.focus === 'function') {
                    target.focus();
                    if (document.activeElement === target) return;
                }
                /* 末级兜底：面板容器本身，确保焦点不留在 Kit 载体 / BODY */
                if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
                if (typeof panel.focus === 'function' && isFocusable(panel)) panel.focus();
            });
        }

        function openPanel() {
            opener = document.activeElement;
            overlay.classList.remove('is-closing');
            openLayer(dialog, overlay);
            /* NEW-29：打开面板时提升 Esc 调度栈位置至最顶层 */
            if (escapeEntry && typeof escapeEntry.promote === 'function') {
                escapeEntry.promote();
            }
            if (hasThemeToggle && themeToggleBtn && typeof updateThemeToggleUi === 'function') {
                updateThemeToggleUi(isCurrentLight());
            }
            if (persistConfig) {
                applyClamping();
                on(window, 'resize', onWindowResize);
            }
            focusBody();
            if (tabsNav) {
                setTimeout(function () { syncTabsIndicator(tabsNav, false); }, 0);
            }
        }

        function closePanel() {
            if (persistConfig) {
                try { window.removeEventListener('resize', onWindowResize); } catch (e) {}
                if (resizeRaf) { cancelAnimationFrame(resizeRaf); resizeRaf = null; }
                flushPersistSave();
            }
            closeLayer(dialog, overlay, function () {
                restoreFocus();
                opener = null;
                if (typeof opts.onClose === 'function') opts.onClose();
            });
        }

        /**
         * 焦点归还：优先还给触发元素。
         * 但触发元素可能已经不可聚焦了 —— 典型场景是 SillyTavern 的 wand 扩展菜单：
         * 点击菜单项后菜单会自动收起，触发按钮变成不可见，focus() 静默失败，
         * 焦点就掉到了 body，键盘用户彻底失去位置。
         * 所以这里做三级兜底：触发元素 -> 备用元素(focusFallback) -> 面板容器。
         */
        function restoreFocus() {
            if (opener && typeof opener.focus === 'function' && isFocusable(opener)) {
                opener.focus();
                if (document.activeElement === opener) return;
            }
            var fb = opts.focusFallback;
            var target = null;
            if (typeof fb === 'string') {
                target = resolveFocusFallback(fb);
            } else if (fb && typeof fb.focus === 'function') {
                target = fb;
            }
            if (target && isFocusable(target)) {
                target.focus();
                if (document.activeElement === target) return;
            }
            /* 第三级：面板容器。
               注意此时 overlay 已被 hidden / dialog 已 close，
               面板容器不在渲染树里，focus() 会静默失败 —— 焦点就会掉到 BODY。
               所以这里先做可见性判定，失败则继续降级。 */
            if (typeof panel.focus === 'function' && isFocusable(panel)) {
                if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
                panel.focus();
                if (document.activeElement === panel) return;
            }
            /* 第四级（NEW-03 补强）：焦点归还链全部落空时，
               绝不能让焦点掉到 BODY —— 键盘用户会彻底失去位置。
               这里退到宿主文档里第一个「可见且可聚焦」的元素上。 */
            focusFirstVisible();
        }

        /**
         * 把焦点交给宿主页面里第一个可见可聚焦的元素（末级兜底）。
         * 若宿主页面一个都没有，则保持现状（焦点留在 BODY）并告警。
         */
        function focusFirstVisible() {
            var list = document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
            for (var i = 0; i < list.length; i++) {
                var cand = list[i];
                if (!cand || !isFocusable(cand)) continue;
                try { cand.focus(); } catch (err) { continue; }
                if (document.activeElement === cand) return;
            }
            warn('restoreFocus(): 所有焦点归还兜底均不可用，焦点可能停留在 body');
        }

        on(closeBtn, 'click', closePanel);
        on(overlay, 'click', function (event) { if (event.target === overlay) closePanel(); });

        /* 焦点陷阱（focus trap）
           宿主红线禁止 showModal()（会给文档加 inert），所以「模态」是半手动实现的：
           面板声明了 aria-modal="true"，就必须真的把键盘焦点圈在面板内，
           否则读屏按模态处理、键盘却能跑到背景页 —— 声明与行为不符。
           这里监听面板内的 Tab / Shift+Tab，在首尾之间循环。 */
        var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
        on(panel, 'keydown', function (event) {
            if (event.key !== 'Tab' || overlay.hidden) return;
            var items = Array.prototype.filter.call(
                panel.querySelectorAll(FOCUSABLE),
                isTrapFocusable
            );
            if (!items.length) return;
            var first = items[0];
            var last = items[items.length - 1];
            var current = document.activeElement;
            if (event.shiftKey && (current === first || !panel.contains(current))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (current === last || !panel.contains(current))) {
                event.preventDefault();
                first.focus();
            }
        });

        /* Esc 关闭：走全局单例调度器，而不是给每个面板挂一个永久的
           document 级监听器（旧实现会导致监听器与 DOM 无限累积，
           且多面板时任一 Esc 会关闭全部可见面板）。
           调度器只把 Esc 交给「最上层可见面板」。 */
        var escapeEntry = registerEscapeHandler(
            closePanel,
            function () { return overlay.isConnected && !overlay.hidden && !overlay.classList.contains('is-closing'); },
            function () { return overlay.isConnected; }
        );

        /**
         * 把节点追加到指定标签的面板。
         * key 用调用方给的原始 key（契约不变）；找不到时回退到当前激活面板，
         * 再回退到第一个面板，最后才落到 body（无标签的单页面板）。
         */
        function appendToPane(key, node) {
            var domKey = null;
            if (key !== null && key !== undefined) {
                var raw = String(key);
                domKey = keyMap.get(raw) || null;
                if (!domKey) {
                    for (var i = 0; i < tabs.length; i++) {
                        if (tabs[i].domKey === raw) { domKey = raw; break; }
                    }
                }
                if (!domKey) {
                    warn('addNode(): 未知标签 key "' + raw + '"，已回退到可见面板');
                }
            }
            /* 回退链（NEW-15）：有效 key → 当前激活 pane → 第一个 pane → body。
               报告原文建议「回退第一个 pane」，但首个 pane 往往处于未激活（不可见）状态，
               内容落进去等于「看不见」；当前激活 pane 一定可见，
               且同样满足报告的真正诉求 —— 绝不落到 body（body 不属于任何 tabpane，
               内容会既不在导航语义下、也不在任何标签的可见区域内）。 */
            var pane = null;
            if (domKey && panes.get(domKey)) pane = panes.get(domKey);
            else if (activeDom && panes.get(activeDom)) pane = panes.get(activeDom);
            else if (tabs.length && panes.get(tabs[0].domKey)) pane = panes.get(tabs[0].domKey);
            if (!pane) pane = body;
            append(pane, node);
            return node;
        }

        function addNode(key, node) {
            appendToPane(key, node);
            if (!disposed && persistConfig && persistConfig.accordion
                && node && node.classList && node.classList.contains('nvui-acc')
                && typeof node.setOpen === 'function' && !findAccordionItem(node)) {
                var accId = node.id ? String(node.id) : uniqueAccordionId('acc-' + (accList.length + 1));
                panelTrackAccordion(node, accId, { bind: false });
            }
            return node;
        }

        /**
         * 销毁面板（NEW-16：让宿主能收到 dialog 的 close 事件）。
         *
         * 直接 removeChild 不会触发 close 事件，宿主若依赖该事件做清理就会漏收。
         * 但光调 close() 还不够：dialog.close() 派发的 close 事件是**异步 task**
         * （实测同步调用后立刻读计数为 0，稍后才变 1）。若在 close() 之后同步
         * removeChild，事件派发时节点已经脱离文档树 —— close 事件不冒泡，
         * 只有捕获阶段的祖先监听才能收到，节点一脱离，document 上的委托监听
         * （宿主最常见的姿势「document.addEventListener('close', …, true)」）
         * 就什么都收不到，等于改了个寂寞。
         *
         * 故：把「摘除节点」推迟到 close 事件真正派发之后再做：
         *   1. 先挂一次性 close 监听；
         *   2. 调用 close()；
         *   3. 事件派发后（再让出一个 task）摘除；
         *   4. 另留一个兜底定时器 —— 极端情况下 close 事件未派发时也要摘干净，
         *      绝不让节点泄漏在 DOM 里。
         * 摘除动作本身幂等（removed 标志），重复触发无害。
         */
        function destroy() {
            if (glassMediaCleanup) { glassMediaCleanup(); glassMediaCleanup = null; }
            restoreForeignNodes(dialog);
            unregisterEscapeHandler(closePanel);
            var removed = false;
            var onClose = function () {
                dialog.removeEventListener('close', onClose);
                setTimeout(remove, 0);
            };
            if (dialog && dialog.open) {
                try { dialog.addEventListener('close', onClose); dialog.close(); }
                catch (err) { remove(); }
                setTimeout(remove, 50);
            } else { remove(); }
            function remove() {
                if (removed) return;
                removed = true;
                if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog);
                if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
                if (updatePill && updatePill.parentNode) {
                    updatePill.parentNode.removeChild(updatePill);
                }
                updatePill = null;
                currentUpdateConfig = null;
            }
            opener = null;
            cleanupPersist();
            if (typeof opts.destroy === 'function') opts.destroy();
        }

        var controller = {
            id: id,
            dialog: dialog,
            overlay: overlay,
            panel: panel,
            body: body,
            tabs: tabsNav,
            bottomNav: bottomNav,
            open: openPanel,
            close: closePanel,
            destroy: destroy,
            setTab: setTab,
            showUpdate: showUpdate,
            syncIndicator: function () { if (tabsNav) syncTabsIndicator(tabsNav, false); },
            addNode: addNode,
            addSwitch: function (key, o) { return addNode(key, switchRow(o)); },
            addInput: function (key, o) { return addNode(key, inputRow(o)); },
            addAccordion: function (key, o) {
                var acc = accordion(o);
                appendToPane(key, acc);
                if (!disposed && persistConfig && persistConfig.accordion) {
                    var accId;
                    if (o && o.id) {
                        accId = String(o.id);
                    } else if (o && o.title) {
                        accId = titleAccordionId(o.title, 'acc-' + (accList.length + 1));
                    } else {
                        accId = uniqueAccordionId('acc-' + (accList.length + 1));
                    }
                    panelTrackAccordion(acc, accId, { bind: false });
                }
                return acc;
            },
            trackAccordion: panelTrackAccordion,
            adoptAccordions: panelAdoptAccordions,
            addProgress: function (key, o) { return addNode(key, progress(o)); },
            addSectionTitle: function (key, text) { return addNode(key, el('div', 'nvui-section-title', { text: text })); },
            clearLayoutState: panelClearLayoutState,
            flushPersistSave: flushPersistSave,
            setSize: function (w, h) {
                if (typeof w === 'number') panel.style.width = w + 'px';
                if (typeof h === 'number') panel.style.height = h + 'px';
                applyClamping();
                if (persistConfig && persistConfig.size) schedulePersistSave();
            },
            setMaximized: function (v) {
                panel.classList.toggle('is-maximized', !!v);
                applyClamping();
                if (persistConfig && persistConfig.size) schedulePersistSave();
            },
            setGlassMode: function (mode) {
                glassMode = normalizeGlassMode(mode);
                effectiveGlassMode = applyPanelGlassMode(dialog, glassMode);
                return effectiveGlassMode;
            },
            getGlassState: function () {
                var reason = '';
                if (glassMode === 'force' && effectiveGlassMode !== 'force') {
                    reason = !browserSupportsBackdrop() ? 'backdrop-unsupported' : 'preference-blocked';
                } else if (effectiveGlassMode === 'auto' && isDomAvailable() && document.body
                    && document.body.classList.contains('no-blur')) {
                    reason = 'host-no-blur';
                }
                return {
                    mode: glassMode,
                    effective: effectiveGlassMode,
                    fastUI: !!(isDomAvailable() && document.body && document.body.classList.contains('no-blur')),
                    browserSupports: browserSupportsBackdrop(),
                    preferenceBlocked: glassPreferenceBlocksForce(),
                    reason: reason,
                };
            },
        };

        Object.defineProperty(controller, 'activeTab', {
            get: function () {
                if (!tabs.length) return null;
                for (var i = 0; i < tabs.length; i++) {
                    if (tabs[i].domKey === activeDom) {
                        return tabs[i].key;
                    }
                }
                return tabs[0].key;
            },
            enumerable: true,
            configurable: true,
        });

        return controller;
    }

    /* ---------------------- 吐司 ---------------------- */

    function ensureToastLayer() {
        /* NEW-31：防御 document.body 未就绪或异常挂载环境 */
        if (!isDomAvailable() || !document.body) {
            error('showToast(): document.body 不可用，无法创建通知层');
            return null;
        }
        var layer = document.getElementById(TOAST_LAYER_ID);
        /* NEW-39：防 DOM Cloaking 伪造普通 div 节点破坏通知层 */
        if (layer && (layer.tagName !== 'DIALOG' || !layer.classList.contains('nvui-tl'))) {
            warn('ensureToastLayer(): 发现同名非载体节点，已重命名避让');
            layer.id = TOAST_LAYER_ID + '-cloaked';
            layer = null;
        }
        if (layer) {
            if (!layer.open) {
                try { layer.show(); } catch (err) { layer.setAttribute('open', ''); }
            }
            layer.hidden = false;
            return layer;
        }
        /* NEW-36：显式增加 closing="" 与 role="presentation" */
        var dialog = el('dialog', 'nvui-tl nvui-tl-toast', { id: TOAST_LAYER_ID, closing: '', role: 'presentation', 'aria-label': '通知层' });
        var stack = el('div', 'nvui-toast-stack');
        dialog.appendChild(stack);
        try {
            document.body.appendChild(dialog);
        } catch (err) {
            error('showToast(): 通知层挂载到 document.body 失败', err);
            return null;
        }
        try { dialog.show(); } catch (err) { dialog.setAttribute('open', ''); }
        return dialog;
    }

    /**
     * showToast({ message, type, duration, icon })
     * type: 'success' | 'warn' | 'danger' | 'info' | undefined（默认中性）
     * 返回 { element, dismiss }。
     */
    function showToast(options) {
        var opts = options || {};
        if (!opts.message) warnOnce('showToast-message', 'showToast(): 缺少 message，将弹出空通知');
        syncGlassFallback();
        var layer = ensureToastLayer();
        if (!layer) return { element: null, dismiss: function () {} };
        /* 吐司层可能在宿主模态之后才创建，需在其存在后同步降级态 */
        syncHostModalState();
        installHostModalWatcher();
        var stack = q('.nvui-toast-stack', layer);
        if (!stack) return { element: null, dismiss: function () {} };
        var toast = el('div', 'nvui-toast' + (opts.type ? ' is-' + opts.type : ''), { role: 'status', 'data-nvui-version': VERSION });
        stampVersion(toast);
        var ic = iconNode(opts.icon || 'fa-solid fa-circle-info');
        if (ic) toast.appendChild(ic);
        var text = el('span', null, { text: opts.message || '' });
        toast.appendChild(text);
        if (opts.dismissible !== false) {
            var close = el('button', 'nvui-icon-btn', { type: 'button', 'aria-label': '关闭通知' });
            close.appendChild(el('i', 'fa-solid fa-xmark', { 'aria-hidden': 'true' }));
            toast.appendChild(close);
            on(close, 'click', dismiss);
        }
        stack.appendChild(toast);
        var timer = null;

        function dismiss() {
            if (!toast.parentNode || toast.classList.contains('is-closing')) return;
            if (timer) clearTimeout(timer);
            toast.classList.add('is-closing');
            var removed = false;
            var fallback = null;
            function done() {
                if (removed) return;
                removed = true;
                if (fallback) { clearTimeout(fallback); fallback = null; }
                /* 退场监听必须摘除，否则同一条吐司反复 dismiss 会叠加监听器 */
                try { toast.removeEventListener('animationend', onAnimEnd); } catch (err) { /* 忽略 */ }
                if (toast.parentNode) toast.parentNode.removeChild(toast);
                /* 承载层保持常驻开启：一旦在这里 close()，
                   后续 showToast 会拿到一个已关闭的载体，第二条及以后的吐司全部不可见。
                   载体本身是 pointer-events:none 的空壳，常驻不产生交互副作用。 */
            }
            function onAnimEnd(event) {
                /* animationend 冒泡：只认吐司自身的退场动画 */
                if (event && event.target !== toast) return;
                if (event && event.animationName && event.animationName.indexOf('out') === -1) return;
                done();
            }
            on(toast, 'animationend', onAnimEnd);
            fallback = setTimeout(done, animationFallbackMs(60));
        }

        /* NEW-32：duration 有效数值归一化防护，非有限正数安全回退默认 3200ms */
        if (opts.duration !== 0) {
            var rawDur = Number(opts.duration);
            var dur = (isFinite(rawDur) && rawDur > 0) ? rawDur : 3200;
            timer = setTimeout(dismiss, dur);
        }
        return { element: toast, dismiss: dismiss };
    }

    /* ---------------------- v2.8.0 自检 / 默认值 ---------------------- */

    var DEFAULTS = Object.freeze({
        switchRow: Object.freeze({ label: '', value: false, disabled: false, feature: false }),
        inputRow: Object.freeze({ label: '', type: 'text', placeholder: '', value: null, disabled: false }),
        accordion: Object.freeze({ title: '', summary: '', open: false, content: Object.freeze([]) }),
        progress: Object.freeze({ value: 0, indeterminate: false, label: '', variant: null }),
        createPanel: Object.freeze({
            id: 'nvui-panel', title: '面板', version: null, tabs: Object.freeze([]), active: null,
            actions: Object.freeze([]), footer: null, mount: null, persist: false, width: null,
            themeToggle: false, update: null, glass: 'auto',
        }),
        showToast: Object.freeze({
            message: '', type: null, icon: 'fa-solid fa-circle-info', duration: 3200, dismissible: true,
        }),
        actions: Object.freeze({ className: 'nvui-actions' }),
    });

    function semverTuple(value) {
        var raw = String(value === undefined || value === null ? '' : value).replace(/^v/i, '').split('-')[0];
        var parts = raw.split('.');
        var out = [];
        for (var i = 0; i < 3; i++) {
            var n = parseInt(parts[i], 10);
            out.push(isFinite(n) ? n : 0);
        }
        return out;
    }

    function compareSemver(a, b) {
        var pa = semverTuple(a);
        var pb = semverTuple(b);
        for (var i = 0; i < 3; i++) {
            if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
        }
        return 0;
    }

    function checkCompatibility(options) {
        var opts = options || {};
        var reason = '';
        if (opts.min && compareSemver(VERSION, opts.min) < 0) reason = 'below-min';
        else if (opts.max && compareSemver(VERSION, opts.max) > 0) reason = 'above-max';
        return { compatible: !reason, actual: VERSION, reason: reason };
    }

    function selfCheck(options) {
        var opts = options || {};
        var issues = [];
        if (!isDomAvailable()) {
            return {
                ok: false, kitVersion: VERSION, expect: opts.expect || null,
                cssLoaded: false, glass: { state: 'unknown', autoFallback: false, reason: 'no-dom' },
                carrierZ: null, hostModalCount: 0, tokens: {}, issues: ['no-dom'],
            };
        }
        var cssLoaded = !!getToken('--nvui-glass-blur');
        var cssVersion = String(getToken('--nvui-kit-version') || '').trim().replace(/^["']|["']$/g, '');
        if (opts.expect && String(opts.expect) !== VERSION) issues.push('version-mismatch');
        if (!cssLoaded) issues.push('css-not-loaded');
        if (cssVersion && cssVersion !== VERSION) issues.push('css-version-mismatch');
        try { detectGlassSupport({ force: true }); } catch (err) { /* 探测失败不影响自检返回 */ }
        var fallback = false;
        try { fallback = document.documentElement.classList.contains(GLASS_FALLBACK_CLASS); } catch (err) { /* 忽略 */ }
        if (fallback) issues.push('glass-auto-fallback');
        var zRaw = getToken('--nvui-z-layer');
        var zNum = parseFloat(zRaw);
        return {
            ok: issues.length === 0,
            kitVersion: VERSION,
            expect: opts.expect || null,
            cssLoaded: cssLoaded,
            cssVersion: cssVersion,
            glass: {
                state: glassState.state || 'unknown',
                autoFallback: fallback,
                reason: glassState.reason || '',
            },
            carrierZ: isFinite(zNum) ? zNum : null,
            hostModalCount: countHostModals(),
            tokens: { accent: getToken('--nvui-accent') },
            issues: issues,
        };
    }

    /* ---------------------- 导出 ---------------------- */

    return {
        version: VERSION,
        VERSION: VERSION,
        PANEL_CLASS: PANEL_CLASS,
        config: config,
        classes: {
            panel: 'nvui-panel',
            overlayPanel: 'nvui-overlay is-panel',
            tabs: 'nvui-tabs',
            tab: 'nvui-tab',
            tabpane: 'nvui-tabpane',
            bottomNav: 'nvui-bottom-nav',
            bottomNavItem: 'nvui-bottom-nav-item',
            accordion: 'nvui-acc',
            switchRow: 'nvui-switch-row',
            inputRow: 'nvui-input-row',
            toast: 'nvui-toast',
        },
        getToken: getToken,
        invalidateTokenCache: invalidateTokenCache,
        setTheme: setTheme,
        selfCheck: selfCheck,
        checkCompatibility: checkCompatibility,
        defaults: DEFAULTS,
        detectGlassSupport: detectGlassSupport,
        syncGlassFallback: syncGlassFallback,
        countHostModals: countHostModals,
        syncHostModalState: syncHostModalState,
        getCarrierState: getCarrierState,
        openLayer: openLayer,
        closeLayer: closeLayer,
        switchRow: switchRow,
        inputRow: inputRow,
        accordion: accordion,
        progress: progress,
        createPanel: createPanel,
        showToast: showToast,
        clearLayoutState: clearLayoutState,
        clampPanelLayout: clampPanelLayout,
        defaultStorageAdapter: defaultStorageAdapter,
    };
});
