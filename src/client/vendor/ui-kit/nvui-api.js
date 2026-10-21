/**
 * SillyTavern NVUI Kit · 可选运行时 API（零依赖）
 * ------------------------------------------------------------------
 * 版本：ui-kit v2.5.0（与 package.json / tokens.css / components.css 版本号保持一致）
 * 用途：给插件/其它软件一个「可调用的设计接口」——用函数创建符合本 Kit 规范的面板、
 *       标签页、折叠分组、开关行、输入行、进度条、吐司，自动带上布局标准、无障碍属性、
 *       动效降级与焦点管理，避免每个插件各写一套 DOM。
 *
 * v2.5.0 变更摘要：
 *   1. 新增 `.nvui-hint.is-ok` / `.nvui-hint.is-danger` 语义色提示类（原仅支持 is-warn）；
 *   2. 新增 `.nvui-btn.is-xs` 超小尺寸按钮变体（补齐尺寸阶梯 is-default → is-sm → is-xs）；
 *   3. 新增 `.nvui-badge.is-subtle` 低强调徽标变体；
 *   4. 新增 `.nvui-progress.is-primary` 主色进度条变体；
 *   5. 面板 destroy() 强化：close 事件真正派发后再摘除 DOM 节点，
 *      并保留 50ms 兜底定时器（NEW-16 补强）。
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

    var VERSION = '2.5.0';
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
        'alt', 'width', 'height', 'lang', 'dir',
    ];

    function attrAllowed(key) {
        if (typeof key !== 'string' || !key) return false;
        var lower = key.toLowerCase();
        /* 事件属性（onclick / onerror / onload …）一律拒绝 */
        if (lower.indexOf('on') === 0) return false;
        /* style / srcdoc 等可直接注入脚本或样式的通道一律拒绝 */
        if (lower === 'style' || lower === 'srcdoc' || lower === 'formaction') return false;
        /* aria-* 与 data-* 是无障碍 / 自定义数据通道，放行 */
        if (lower.indexOf('aria-') === 0) return true;
        if (lower.indexOf('data-') === 0) return true;
        return ALLOWED_ATTRS.indexOf(lower) !== -1;
    }

    function el(tag, className, attrs) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (attrs) {
            Object.keys(attrs).forEach(function (k) {
                var v = attrs[k];
                if (v === null || v === undefined) return;
                /* 只允许 textContent 通道：绝不接受原始 HTML 片段，
                   避免调用方把用户输入塞进属性时形成 XSS 缺口。 */
                if (k === 'text') { node.textContent = String(v); return; }
                /* 白名单之外的属性静默丢弃（不抛错），并记一条 warn 便于排查 */
                if (!attrAllowed(k)) {
                    warn('el(): 已丢弃白名单外的属性 "' + k + '"');
                    return;
                }
                node.setAttribute(k, String(v));
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
        (Array.isArray(children) ? children : [children]).forEach(function (c) {
            if (!c) return;
            parent.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
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
        var cs = window.getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        return true;
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

    /** 主题/实心切换：仅切类名，不写死任何颜色 */
    function setTheme(theme, options) {
        var host = (options && options.host) || document.body;
        if (!host) return;
        host.classList.remove('nvui-theme-light');
        host.classList.remove('nvui-solid');
        if (theme === 'light') host.classList.add('nvui-theme-light');
        if (options && options.solid) host.classList.add('nvui-solid');
        /* 主题类变了，作用域内的令牌值随之改变 → 缓存必须失效 */
        invalidateTokenCache();
    }

    /* ---------------------- 玻璃能力探测 ---------------------- */
    /*
     * v2.2.0 修订补丁（ISSUES.md #15）：部分宿主（如 SillyTavern 的 FastUI）
     * 会用 `body.no-blur * { backdrop-filter: unset !important }` 全局关掉模糊。
     *
     * 为什么 CSS 探测不出来：
     *   `@supports not (backdrop-filter: blur(1px))` 问的是「**浏览器**是否支持
     *   backdrop-filter」。宿主把属性 unset 之后浏览器**仍然支持**，所以
     *   `@supports` 的降级分支根本不触发 —— 结果是玻璃只剩半透明底色，
     *   下层文字直接透出来，形成重影。
     *
     * 做法：不猜宿主类名（避免与宿主耦合），而是**探测渲染后的实际计算值**：
     *   造一个带 `.nvui-glass` 的隐藏探针挂到 body，读它的 computed
     *   `backdropFilter`；若为 `none` 说明模糊已被外部禁用。
     * 命中即给根节点挂 `.nvui-solid`，kit 全部玻璃回退为不透明表面。
     */
    var glassSupportCache = null;

    function detectGlassSupport(options) {
        if (!isDomAvailable() || !document.body) return true;
        if (glassSupportCache !== null && !(options && options.force)) return glassSupportCache;
        var probe = document.createElement('div');
        probe.className = 'nvui-glass';
        probe.setAttribute('aria-hidden', 'true');
        probe.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:0;';
        document.body.appendChild(probe);
        var cs = window.getComputedStyle(probe);
        var bf = cs.backdropFilter || cs.webkitBackdropFilter || '';
        glassSupportCache = !(bf === 'none' || bf === '' || bf === 'unset');
        try {
            probe.parentNode.removeChild(probe);
        } catch (err) {
            /* 忽略：探针已从文档移除失败不影响结论 */
        }
        return glassSupportCache;
    }

    /**
     * 探测玻璃能力；模糊被宿主禁用时自动给根节点挂 `.nvui-solid`（实心回退）。
     * 返回 true 表示模糊可用。
     */
    function syncGlassFallback(options) {
        var supported = detectGlassSupport(options);
        if (!supported) {
            var root = (options && options.host) || document.documentElement;
            if (root) root.classList.add('nvui-solid');
        }
        return supported;
    }

    /* ---------------------- 浮层开合（top-layer 载体） ---------------------- */

    /**
     * 打开浮层：非模态 dialog.show()（避免 inert，遵守酒馆 transform 红线），
     * overlay.hidden=false 触发 CSS 进出场。
     */
    function openLayer(dialogEl, overlayEl) {
        if (!dialogEl || !overlayEl) return;
        /* 打开瞬间同步一次宿主模态降级态（watcher 已覆盖动态开关，这里兜底首开） */
        syncHostModalState();
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
        var fallback = null;
        function finish() {
            if (finished) return;
            finished = true;
            if (fallback) { clearTimeout(fallback); fallback = null; }
            /* 退场监听必须摘除：否则每次关闭都会在 overlay 上叠加一个 animationend
               监听器，元素复用（同一 overlay 反复开合）时监听器会无限累积。 */
            try { overlayEl.removeEventListener('animationend', onAnimEnd); } catch (err) { /* 忽略 */ }
            overlayEl.hidden = true;
            overlayEl.classList.remove('is-closing');
            if (dialogEl.open) {
                try { dialogEl.close(); } catch (err) { dialogEl.removeAttribute('open'); }
            }
            if (typeof done === 'function') done();
        }
        function onAnimEnd(event) {
            /* animationend 会冒泡：面板内部的子动画（如 .nvui-tabpane-in）
               结束时会冒泡到 overlay，若不校验 target 会提前 finish，
               把 overlay 自身的退场动画截断。 */
            if (event && event.target !== overlayEl) return;
            finish();
        }
        on(overlayEl, 'animationend', onAnimEnd);
        fallback = setTimeout(finish, animationFallbackMs(60));
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
        /* min/max/step 只接受有限数值，避免把 NaN / 垃圾串写进 DOM 属性 */
        if (isFinite(Number(opts.min)) && opts.min !== undefined && opts.min !== null) input.min = Number(opts.min);
        if (isFinite(Number(opts.max)) && opts.max !== undefined && opts.max !== null) input.max = Number(opts.max);
        if (isFinite(Number(opts.step)) && opts.step !== undefined && opts.step !== null) input.step = Number(opts.step);
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
        var root = el('div', 'nvui-acc' + (opts.open ? ' is-open' : ''));
        var head = el('button', 'nvui-acc-head', { type: 'button', 'aria-expanded': opts.open ? 'true' : 'false' });
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
        var n = Number(value);
        if (!isFinite(n)) n = 0;
        if (n < 0) n = 0;
        if (n > 100) n = 100;
        return n;
    }

    /** 线性进度条：role=progressbar + .nvui-progress-bar（宽度由 API 设置） */
    function progress(options) {
        var opts = options || {};
        var initial = normalizeProgressValue(opts.value);
        /* 不确定进度按 ARIA 规范不应带 aria-valuenow（值未知），
           其条宽由 CSS 的 40% + 扫光动画接管；确定进度才写 aria-valuenow。 */
        var trackAttrs = {
            role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
            'aria-valuenow': opts.indeterminate ? null : String(initial),
        };
        /* 不确定进度按 README 契约至少要有 aria-label */
        if (opts.indeterminate && opts.label) trackAttrs['aria-label'] = String(opts.label);
        var track = el('div', 'nvui-progress', trackAttrs);
        if (opts.variant) track.classList.add('is-' + opts.variant);
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
        for (var i = escapeStack.length - 1; i >= 0; i--) {
            var entry = escapeStack[i];
            if (!entry) continue;
            if (entry.isVisible && entry.isVisible()) {
                entry.handler(event);
                return;
            }
        }
    }

    function registerEscapeHandler(handler, isVisible) {
        if (!escapeBound) {
            document.addEventListener('keydown', onEscapeKey);
            escapeBound = true;
        }
        var entry = { handler: handler, isVisible: isVisible || function () { return true; } };
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
    function countHostModals() {
        if (!isDomAvailable()) return 0;
        var selectorSupported = false;
        try { selectorSupported = CSS.supports('selector(:modal)'); } catch (err) { selectorSupported = false; }
        if (selectorSupported) {
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
    var observedDialogs = [];

    function observeDialogOpen(dialog) {
        if (!dialog || !hostModalOpenObserver) return;
        if (observedDialogs.indexOf(dialog) !== -1) return;
        observedDialogs.push(dialog);
        try {
            hostModalOpenObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] });
        } catch (err) {
            /* 单个 dialog 观察失败不影响其它 */
        }
    }

    function scanForDialogs(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return;
        var list = root.querySelectorAll('dialog');
        for (var i = 0; i < list.length; i++) observeDialogOpen(list[i]);
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
            /* 观察器 B：只做 childList（不观察属性），用于发现宿主后续新建的 dialog */
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
                        }
                        scanForDialogs(node);
                    }
                }
                /* 新 dialog 常常是「先插入 DOM、紧接着 showModal()」，
                   它的 open 属性在我们的属性观察器挂上之前就已经设好了，
                   不会产生属性变更记录 —— 必须在这里主动同步一次，
                   否则宿主模态已开而 kit 载体没有降级让位。 */
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
            observedDialogs = [];
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
    function createPanel(options) {
        var opts = options || {};
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

        var dialog = el('dialog', 'nvui-tl', { id: id + '-layer', 'aria-label': (opts.title || '面板') + ' 浮层' });
        var overlay = el('div', 'nvui-overlay is-panel', { id: id + '-overlay', hidden: '' });
        var panel = el('div', 'nvui-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id + '-title' });

        /* 手机拖拽把手（纯视觉） */
        panel.appendChild(el('div', 'nvui-sheet-handle', { 'aria-hidden': 'true' }));

        /* 标题栏 */
        var header = el('div', 'nvui-panel-header');
        var title = el('b', 'nvui-panel-title', { id: id + '-title', text: opts.title || '面板' });
        if (opts.version) title.appendChild(el('span', 'nvui-badge', { text: opts.version }));
        var actions = el('span', 'nvui-panel-actions');
        (opts.actions || []).forEach(function (a) {
            var btn = el('button', 'nvui-icon-btn', { type: 'button', 'aria-label': a.label || '操作' });
            var ic = iconNode(a.icon);
            if (ic) btn.appendChild(ic);
            if (typeof a.onClick === 'function') on(btn, 'click', a.onClick);
            actions.appendChild(btn);
        });
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
                    'aria-selected': t.domKey === activeDom ? 'true' : 'false',
                    'aria-controls': id + '-pane-' + t.domKey,
                    tabindex: t.domKey === activeDom ? '0' : '-1',
                });
                var ic = iconNode(t.icon);
                if (ic) tab.appendChild(ic);
                tab.appendChild(document.createTextNode(t.label || t.key));
                on(tab, 'click', function () { setTabByDom(t.domKey); });
                tabsNav.appendChild(tab);
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
                var btn = el('button', 'nvui-btn' + (b.variant ? ' is-' + b.variant : ''), { type: 'button', text: b.label || '' });
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
        mountNode.appendChild(dialog);

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

        function focusBody() {
            var target = q('.nvui-btn.is-primary', panel) || closeBtn;
            if (target && typeof target.focus === 'function') {
                requestAnimationFrame(function () { target.focus(); });
            }
        }

        function openPanel() {
            opener = document.activeElement;
            overlay.classList.remove('is-closing');
            openLayer(dialog, overlay);
            focusBody();
            if (tabsNav) {
                setTimeout(function () { syncTabsIndicator(tabsNav, false); }, 0);
            }
        }

        function closePanel() {
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
                function (node) {
                    return node.offsetWidth > 0 || node.offsetHeight > 0 || node === document.activeElement;
                }
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
        registerEscapeHandler(closePanel, function () { return !overlay.hidden; });

        /**
         * 把节点追加到指定标签的面板。
         * key 用调用方给的原始 key（契约不变）；找不到时回退到当前激活面板，
         * 再回退到第一个面板，最后才落到 body（无标签的单页面板）。
         */
        function addNode(key, node) {
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

        function destroy() {
            unregisterEscapeHandler(closePanel);
            /* NEW-16：先 close() 再摘节点，让宿主能收到 dialog 的 close 事件。
               直接 removeChild 不会触发 close 事件，宿主若依赖该事件做清理就会漏收。

               但光 close() 还不够：dialog.close() 派发的 close 事件是**异步 task**
               （实测同步调用后立刻读计数为 0，稍后才变 1）。若在 close() 之后
               同步 removeChild，事件派发时节点已经脱离文档树，事件不会传播到
               document —— 宿主最常见的姿势「document.addEventListener('close', …, true)」
               仍然收不到，等于改了个寂寞。

               故：把「摘除节点」推迟到 close 事件真正派发之后再做：
                 1. 先挂一次性 close 监听（捕获阶段的委托监听此刻也能收到事件）；
                 2. 调用 close()；
                 3. 事件派发后（再让出一个 task，让冒泡阶段走完）摘除；
                 4. 另留一个兜底定时器 —— 极端情况下 close 事件未派发时也要摘干净，
                    绝不让节点泄漏在 DOM 里。
               摘除动作本身是幂等的（removed 标志），重复触发无害。 */
            var removed = false;
            var onClose = function () {
                try { dialog.removeEventListener('close', onClose); } catch (err) { /* 忽略 */ }
                /* 事件已进入目标阶段，再让出一个 task，确保冒泡阶段也走完 */
                setTimeout(removeNodes, 0);
            };
            if (dialog && dialog.open) {
                try {
                    dialog.addEventListener('close', onClose);
                    dialog.close();
                } catch (err) {
                    try { dialog.removeAttribute('open'); } catch (e) { /* 忽略 */ }
                    removeNodes();
                }
                /* 兜底：close 事件未派发时也要摘干净 */
                setTimeout(removeNodes, 50);
            } else {
                removeNodes();
            }
            /* 摘除动作定义在末尾（函数声明提升，调用点在其之前也没问题），
               目的是让上面的「close() → 等待事件 → 摘除」顺序在源码上一目了然。 */
            function removeNodes() {
                if (removed) return;
                removed = true;
                if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
                if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog);
            }
            opener = null;
            if (typeof opts.destroy === 'function') opts.destroy();
        }

        return {
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
            syncIndicator: function () { if (tabsNav) syncTabsIndicator(tabsNav, false); },
            addNode: addNode,
            addSwitch: function (key, o) { return addNode(key, switchRow(o)); },
            addInput: function (key, o) { return addNode(key, inputRow(o)); },
            addAccordion: function (key, o) { return addNode(key, accordion(o)); },
            addProgress: function (key, o) { return addNode(key, progress(o)); },
            addSectionTitle: function (key, text) { return addNode(key, el('div', 'nvui-section-title', { text: text })); },
        };
    }

    /* ---------------------- 吐司 ---------------------- */

    function ensureToastLayer() {
        var layer = document.getElementById(TOAST_LAYER_ID);
        if (layer) {
            /* 载体被关掉过（dialog.close()）时必须重新 show()，
               否则第二条及以后的吐司全都落在一个已关闭的载体里，用户完全看不到。
               这里做幂等重开：已 open 则什么都不做。 */
            if (!layer.open) {
                try { layer.show(); } catch (err) { layer.setAttribute('open', ''); }
            }
            layer.hidden = false;
            return layer;
        }
        var dialog = el('dialog', 'nvui-tl nvui-tl-toast', { id: TOAST_LAYER_ID, 'aria-label': '通知层' });
        var stack = el('div', 'nvui-toast-stack');
        dialog.appendChild(stack);
        document.body.appendChild(dialog);
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
        syncGlassFallback();
        var layer = ensureToastLayer();
        /* 吐司层可能在宿主模态之后才创建，需在其存在后同步降级态 */
        syncHostModalState();
        installHostModalWatcher();
        var stack = q('.nvui-toast-stack', layer);
        var toast = el('div', 'nvui-toast' + (opts.type ? ' is-' + opts.type : ''), { role: 'status' });
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

        if (opts.duration !== 0) {
            timer = setTimeout(dismiss, typeof opts.duration === 'number' ? opts.duration : 3200);
        }
        return { element: toast, dismiss: dismiss };
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
    };
});
