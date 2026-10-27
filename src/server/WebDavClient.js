import { Readable } from 'node:stream';
import { validateHttpUrl } from './UrlGuard.js';

/**
 * 健壮的 WebDAV 客户端 (兼容 Nextcloud, Alist, 群晖 NAS, 坚果云, InfiniCLOUD)
 * 包含 SSRF 防御、流式传输、递归建目录与精准多态诊断
 */
export class WebDavClient {
  /**
   * 允许跟随的最大 HTTP 重定向跳数
   * Nextcloud / Alist 等服务端在某些部署下会正常 302，
   * 因此不能一律拒绝重定向，但必须限制跳数并逐跳校验。
   */
  static MAX_REDIRECTS = 3;

  /**
   * @param {object} options
   * @param {string} options.url WebDAV 根 URL (如 https://dav.example.com/remote.php/webdav/)
   * @param {string} [options.username] 用户名
   * @param {string} [options.password] 密码 / 应用口令
   * @param {number} [options.timeoutMs=15000] 超时时间毫秒
   */
  constructor(options = {}) {
    this.url = '';
    this.username = '';
    this.password = '';
    this.timeoutMs = 15000;
    this.updateConfig(options);
  }

  updateConfig({ url, username, password, timeoutMs } = {}) {
    if (url !== undefined) {
      this.url = this.validateAndNormalizeUrl(url);
    }
    if (username !== undefined) this.username = String(username || '').trim();
    if (password !== undefined) this.password = String(password || '').trim();
    if (timeoutMs !== undefined) {
      const parsedTimeout = Number(timeoutMs);
      this.timeoutMs = (!isNaN(parsedTimeout) && parsedTimeout > 0) ? Math.max(3000, parsedTimeout) : 15000;
    }
  }

  /**
   * 严格校验与归一化 WebDAV URL (SSRF 防御)
   * @param {string} rawUrl
   * @returns {string}
   */
  validateAndNormalizeUrl(rawUrl) {
    return validateHttpUrl(rawUrl, {
      label: 'WebDAV 地址',
      stripTrailingSlash: true,
    });
  }

  /**
   * 生成 Basic Auth 认证头
   * @returns {Record<string, string>}
   */
  getAuthHeaders() {
    if (!this.username) return {};
    const creds = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    return { Authorization: `Basic ${creds}` };
  }

  /**
   * 构造远端完整绝对 URL
   * @param {string} relPath 
   * @returns {string}
   */
  buildUrl(relPath = '') {
    if (!this.url) {
      throw new Error('WebDAV 服务端 URL 尚未配置，请先在「服务设置」中填写并保存配置');
    }
    const cleanRel = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanRel) return this.url;

    // 对各路径分段安全进行 URI 编码，避免中文与空格导致 400
    const encodedSegments = cleanRel.split('/').map(seg => encodeURIComponent(seg)).join('/');
    return `${this.url}/${encodedSegments}`;
  }

  /**
   * 带超时控制与精准错误包装的 fetch
   *
   * 安全要点 1：使用 redirect:'manual' 手动处理 3xx 跳转，
   * 每一跳的 Location 都会重新走 validateAndNormalizeUrl 做 SSRF 校验，
   * 避免「初始 URL 合法 → 302 跳到内网元数据地址」这一经典绕过手法。
   *
   * 安全要点 2：跨源跳转时**剥离 Authorization 头**。
   * 原生 fetch 自动跟随时 undici 会在跨源时剥离凭据；改为手动跟随后
   * 这个保护会丢失，必须显式补上 —— 否则恶意 WebDAV 服务器只需返回
   * 一个 302 就能把用户的 Basic 账号密码送到攻击者主机。
   *
   * @param {string} url
   * @param {RequestInit} options
   * @param {number} [customTimeout]
   */
  async fetchWithTimeout(url, options = {}, customTimeout = null) {
    const rawTimeout = (customTimeout != null && !isNaN(Number(customTimeout)) && Number(customTimeout) > 0)
      ? Number(customTimeout)
      : (Number(this.timeoutMs) || 15000);
    const timeout = Math.max(3000, rawTimeout);

    let currentUrl = url;
    let redirects = 0;
    // 基准同源：只有同源跳转才允许携带凭据
    let baseOrigin = null;
    try {
      baseOrigin = new URL(this.url || url).origin;
    } catch {
      baseOrigin = null;
    }
    let sendAuth = true;

    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      // 跨源跳转后不再附带认证头
      const requestHeaders = { ...options.headers };
      if (sendAuth) {
        Object.assign(requestHeaders, this.getAuthHeaders());
      }

      let resp;
      try {
        resp = await fetch(currentUrl, {
          ...options,
          redirect: 'manual',
          headers: requestHeaders,
          signal: controller.signal,
        });
        clearTimeout(timer);
      } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError' || err.message?.includes('aborted')) {
          throw new Error(`WebDAV 请求超时 (超过 ${timeout}ms)，请检查网络状况或服务端防火墙`);
        }
        if (err.code === 'ECONNREFUSED') {
          throw new Error('WebDAV 服务器拒绝连接 (ECONNREFUSED)，目标端口未开放或服务未运行');
        }
        if (err.code === 'ENOTFOUND') {
          throw new Error(`域名无法解析 (ENOTFOUND)，请检查 WebDAV 地址是否正确`);
        }
        if (err.message?.includes('certificate') || err.message?.includes('self-signed')) {
          throw new Error(`SSL/TLS 证书验证失败 (${err.message})`);
        }
        throw err;
      }

      // 手动处理重定向：仅在允许的次数内，且每一跳重新做 SSRF 校验
      if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
        if (redirects >= WebDavClient.MAX_REDIRECTS) {
          throw new Error(`WebDAV 重定向次数过多 (超过 ${WebDavClient.MAX_REDIRECTS} 次)，已中止请求`);
        }
        const location = resp.headers.get('location');
        let nextUrl;
        try {
          nextUrl = new URL(location, currentUrl).toString();
        } catch {
          throw new Error(`WebDAV 返回了无效的重定向地址: ${location}`);
        }
        // 关键：跳转目标必须重新通过 SSRF 校验
        this.validateAndNormalizeUrl(nextUrl);

        // 跨源跳转 → 剥离凭据，防止 Basic 账号密码被送到第三方主机
        try {
          if (baseOrigin && new URL(nextUrl).origin !== baseOrigin) {
            sendAuth = false;
            console.warn('[ST-WebDAV] 检测到跨源重定向，已剥离认证凭据以防凭据泄漏');
          }
        } catch {}

        redirects++;
        currentUrl = nextUrl;
        continue;
      }

      return resp;
    }
  }

  /**
   * 测试 WebDAV 连通性并做三态诊断
   * @returns {Promise<{ ok: boolean, status: number, message: string, server?: string }>}
   */
  async testConnection() {
    if (!this.url) {
      return { ok: false, status: 0, message: 'WebDAV 服务端 URL 尚未配置' };
    }

    try {
      // 优先使用 PROPFIND Depth: 0 测试连通性
      const resp = await this.fetchWithTimeout(this.url, {
        method: 'PROPFIND',
        headers: {
          Depth: '0',
          'Content-Type': 'application/xml; charset="utf-8"',
        },
      }, 5000);

      const serverHeader = resp.headers.get('server') || resp.headers.get('dav') || '';

      if (resp.status === 207 || resp.status === 200 || resp.status === 204) {
        return {
          ok: true,
          status: resp.status,
          message: 'WebDAV 连接正常，认证通过',
          server: serverHeader || 'WebDAV Server',
        };
      }

      if (resp.status === 401 || resp.status === 403) {
        return {
          ok: false,
          status: resp.status,
          message: '认证失败：WebDAV 用户名或密码错误，或当前用户无权限访问目标目录',
        };
      }

      if (resp.status === 404) {
        return {
          ok: false,
          status: resp.status,
          message: '远端目标路径不存在 (404)，请确认 URL 包含正确的 WebDAV 挂载根路径',
        };
      }

      // 部分非标 WebDAV 服务端（或特定反代）对根路径 PROPFIND 返回 405/501，降级尝试 OPTIONS
      if (resp.status === 405 || resp.status === 501) {
        const optResp = await this.fetchWithTimeout(this.url, { method: 'OPTIONS' }, 5000);
        if (optResp.ok) {
          return {
            ok: true,
            status: optResp.status,
            message: 'WebDAV (OPTIONS 模式) 连接正常',
            server: optResp.headers.get('server') || 'WebDAV Server',
          };
        }
      }

      return {
        ok: false,
        status: resp.status,
        message: `WebDAV 返回非预期 HTTP 状态码: ${resp.status} ${resp.statusText}`,
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        message: err.message || '连接 WebDAV 发生未知错误',
      };
    }
  }

  /**
   * 递归创建远端多级目录 (MKCOL)
   * 例如 "SillyTavern_Backups/daily" 会自动创建一级和二级目录
   * @param {string} remoteDir 
   */
  async ensureDirectory(remoteDir) {
    if (!this.url) {
      throw new Error('WebDAV 服务端 URL 尚未配置，请先在「服务设置」中填写并保存配置');
    }
    const cleanDir = String(remoteDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!cleanDir) return;

    const parts = cleanDir.split('/');
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const targetUrl = this.buildUrl(currentPath);

      // 探测该层级目录是否存在
      try {
        const checkResp = await this.fetchWithTimeout(targetUrl, {
          method: 'PROPFIND',
          headers: { Depth: '0' },
        });

        // 已经存在，无需创建
        if (checkResp.status === 207 || checkResp.status === 200) {
          continue;
        }

        if (checkResp.status === 401 || checkResp.status === 403) {
          throw new Error(`WebDAV 认证失败 (HTTP ${checkResp.status})，请检查账号密码及写入权限`);
        }

        // 不存在，发起 MKCOL 创建
        if (checkResp.status === 404 || checkResp.status === 405) {
          const mkResp = await this.fetchWithTimeout(targetUrl, {
            method: 'MKCOL',
          });
          if (mkResp.status !== 201 && mkResp.status !== 200 && mkResp.status !== 405) {
            console.warn(`[ST-WebDAV] MKCOL ${currentPath} returned ${mkResp.status}`);
          }
        }
      } catch (err) {
        if (err.message?.includes('认证失败')) throw err;
        console.warn(`[ST-WebDAV] ensureDirectory ${currentPath} error:`, err.message);
      }
    }
  }

  /**
   * 流式或整块上传文件至 WebDAV (PUT)
   * 支持 Buffer 与 Stream，自动设定 Content-Length 防止部分 WebDAV 拒绝 chunked
   * @param {string} relPath 相对路径
   * @param {ReadableStream|Readable|Buffer} body 流或 Buffer
   * @param {number} [contentLength] 内容长度字节（如果已知）
   */
  async put(relPath, body, contentLength = null) {
    const targetUrl = this.buildUrl(relPath);

    const headers = {
      'Content-Type': 'application/octet-stream',
    };
    if (contentLength != null && contentLength > 0) {
      headers['Content-Length'] = String(contentLength);
    } else if (Buffer.isBuffer(body)) {
      headers['Content-Length'] = String(body.length);
    }

    // Node 18+ 原生 fetch 对 stream 请求需 duplex: 'half'
    const fetchOptions = {
      method: 'PUT',
      headers,
      body,
      duplex: 'half',
    };

    const baseTimeout = Number(this.timeoutMs) || 15000;
    const uploadTimeout = Math.max(baseTimeout * 4, 60000);

    const resp = await this.fetchWithTimeout(targetUrl, fetchOptions, uploadTimeout);

    if (resp.ok || resp.status === 201 || resp.status === 204) {
      return { success: true, url: targetUrl, status: resp.status };
    }

    let detail = '';
    try {
      const text = await resp.text();
      detail = text.slice(0, 100).replace(/[\r\n\t]+/g, ' ');
    } catch {}
    throw new Error(`WebDAV PUT 上传失败 (HTTP ${resp.status}): ${detail || resp.statusText}`);
  }

  /**
   * 流式下载文件 (GET)
   * @param {string} relPath 
   * @returns {Promise<Response>} 返回原生 Response（可直接访问 resp.body 进行流式解密/解压）
   */
  async getStream(relPath) {
    const targetUrl = this.buildUrl(relPath);
    const resp = await this.fetchWithTimeout(targetUrl, {
      method: 'GET',
    }, Math.max(this.timeoutMs * 4, 60000));

    if (!resp.ok) {
      throw new Error(`WebDAV 下载失败: HTTP ${resp.status} ${resp.statusText}`);
    }

    return resp;
  }

  /**
   * 获取文件全量 Buffer
   * @param {string} relPath 
   * @returns {Promise<Buffer>}
   */
  async getBuffer(relPath) {
    const resp = await this.getStream(relPath);
    const arrayBuffer = await resp.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * 删除远端文件或目录 (DELETE)
   * @param {string} relPath 
   */
  async delete(relPath) {
    const targetUrl = this.buildUrl(relPath);
    const resp = await this.fetchWithTimeout(targetUrl, {
      method: 'DELETE',
    });

    if (resp.ok || resp.status === 204 || resp.status === 404) {
      return { success: true, status: resp.status };
    }

    throw new Error(`WebDAV 删除失败: HTTP ${resp.status} ${resp.statusText}`);
  }

  /**
   * 复制远端文件 (WebDAV COPY)
   * ------------------------------------------------------------------
   * 用于「分享到跨账号共享区」：服务端直接复制，避免把大文件下载到
   * 本地再上传，节省带宽与时间。
   * 某些 WebDAV 实现不支持 COPY（返回 405/501/403），此时降级为
   * 「下载 + 上传」回退方案。
   *
   * @param {string} srcRemotePath 源文件相对路径
   * @param {string} destRemotePath 目标文件相对路径
   * @returns {Promise<{ success: boolean, via: 'copy' | 'fallback', status?: number }>}
   */
  async copy(srcRemotePath, destRemotePath) {
    const srcUrl = this.buildUrl(srcRemotePath);
    const destUrl = this.buildUrl(destRemotePath);

    try {
      const resp = await this.fetchWithTimeout(srcUrl, {
        method: 'COPY',
        headers: {
          Destination: destUrl,
          Overwrite: 'T',
        },
      }, Math.max(this.timeoutMs * 4, 60000));

      if (resp.status === 201 || resp.status === 204 || resp.ok) {
        return { success: true, via: 'copy', status: resp.status };
      }

      // 405 Method Not Allowed / 501 Not Implemented / 403 Forbidden：
      // 服务端不支持 COPY，回退为下载 + 上传
      if (resp.status === 405 || resp.status === 501 || resp.status === 403) {
        console.info(`[ST-WebDAV] WebDAV COPY 不受支持 (HTTP ${resp.status})，降级为下载上传模式`);
      } else {
        throw new Error(`WebDAV COPY 失败: HTTP ${resp.status} ${resp.statusText}`);
      }
    } catch (err) {
      // 只把「COPY 请求本身异常」视为需要降级（如服务端未实现该方法导致连接中断）；
      // COPY 失败的错误直接上抛，不做降级。
      if (err.message?.includes('COPY 失败')) throw err;
      console.info(`[ST-WebDAV] WebDAV COPY 异常，降级为下载上传模式: ${err.message}`);
    }

    // 降级调用必须放在 try 之外：否则降级自身的失败会被上面的 catch 再次捕获，
    // 导致重复下载一次并误报为「COPY 异常」（大文件相当于多一份流量）。
    return await this.copyViaDownloadUpload(srcRemotePath, destRemotePath);
  }

  /**
   * COPY 的降级实现：下载源文件后重新上传到目标路径
   * @param {string} srcRemotePath
   * @param {string} destRemotePath
   * @returns {Promise<{ success: boolean, via: 'fallback' }>}
   */
  async copyViaDownloadUpload(srcRemotePath, destRemotePath) {
    const buffer = await this.getBuffer(srcRemotePath);
    await this.put(destRemotePath, buffer, buffer.length);
    return { success: true, via: 'fallback' };
  }

  /**
   * 列出远端目录下的文件列表 (PROPFIND Depth: 1)
   * @param {string} remoteDir
   * @returns {Promise<Array<{ name: string, path: string, isDirectory: boolean, size: number, lastModified: string }>>}
   */
  async listFiles(remoteDir = '') {
    const targetUrl = this.buildUrl(remoteDir);
    const resp = await this.fetchWithTimeout(targetUrl, {
      method: 'PROPFIND',
      headers: {
        Depth: '1',
        'Content-Type': 'application/xml; charset="utf-8"',
      },
    });

    if (resp.status === 404) {
      return []; // 目录不存在则返回空
    }

    if (!resp.ok && resp.status !== 207) {
      throw new Error(`WebDAV 获取文件列表失败: HTTP ${resp.status} ${resp.statusText}`);
    }

    const xml = await resp.text();
    return this.parsePropfindXml(xml, targetUrl);
  }

  /**
   * 轻量解析 WebDAV Multi-Status XML (零原生依赖，兼容各 WebDAV 产商命名空间)
   * @param {string} xmlText 
   * @param {string} requestUrl 
   */
  parsePropfindXml(xmlText, requestUrl) {
    const items = [];
    const responseRegex = /<(?:\w+:)?response[^>]*>([\s\S]*?)<\/(?:\w+:)?response>/gi;
    let match;

    const requestParsed = new URL(requestUrl);
    const reqPathNormalized = decodeURIComponent(requestParsed.pathname).replace(/\/+$/, '');

    while ((match = responseRegex.exec(xmlText)) !== null) {
      const block = match[1];

      // 提取 href
      const hrefMatch = block.match(/<(?:\w+:)?href[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/i);
      if (!hrefMatch) continue;

      let href = hrefMatch[1].trim();
      let decodedHref = '';
      try {
        decodedHref = decodeURIComponent(href);
      } catch {
        decodedHref = href;
      }

      // 如果 href 是当前查询的目录自身，则跳过
      const itemPathNormalized = decodedHref.replace(/\/+$/, '');
      if (itemPathNormalized === reqPathNormalized || itemPathNormalized === '') {
        continue;
      }

      // 判断是否为目录 (collection)
      const isDirectory = /<(?:\w+:)?resourcetype[^>]*>[\s\S]*?<(?:\w+:)?collection/i.test(block);

      // 文件大小
      const sizeMatch = block.match(/<(?:\w+:)?getcontentlength[^>]*>(\d+)<\/(?:\w+:)?getcontentlength>/i);
      const size = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;

      // 修改时间 (安全解析防 RangeError: Invalid time value)
      const modMatch = block.match(/<(?:\w+:)?getlastmodified[^>]*>([^<]+)<\/(?:\w+:)?getlastmodified>/i);
      let lastModified = new Date().toISOString();
      if (modMatch && modMatch[1]) {
        const d = new Date(modMatch[1].trim());
        if (!isNaN(d.getTime())) {
          lastModified = d.toISOString();
        }
      }

      // 文件名
      const segments = decodedHref.replace(/\/+$/, '').split('/');
      const name = segments[segments.length - 1] || 'unnamed';

      items.push({
        name,
        path: decodedHref,
        isDirectory,
        size,
        lastModified,
      });
    }

    return items;
  }
}
