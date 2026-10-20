import { Readable } from 'node:stream';

/**
 * 健壮的 WebDAV 客户端 (兼容 Nextcloud, Alist, 群晖 NAS, 坚果云, InfiniCLOUD)
 * 包含 SSRF 防御、流式传输、递归建目录与精准多态诊断
 */
export class WebDavClient {
  /**
   * @param {object} options
   * @param {string} options.url WebDAV 根 URL (如 https://dav.example.com/remote.php/webdav/)
   * @param {string} [options.username] 用户名
   * @param {string} [options.password] 密码 / 应用口令
   * @param {number} [options.timeoutMs=15000] 超时时间毫秒
   */
  constructor(options = {}) {
    this.updateConfig(options);
  }

  updateConfig({ url, username, password, timeoutMs }) {
    if (url !== undefined) {
      this.url = this.validateAndNormalizeUrl(url);
    }
    if (username !== undefined) this.username = String(username || '').trim();
    if (password !== undefined) this.password = String(password || '').trim();
    if (timeoutMs !== undefined) this.timeoutMs = Math.max(3000, Number(timeoutMs) || 15000);
  }

  /**
   * 严格校验与归一化 WebDAV URL (SSRF 防御)
   * @param {string} rawUrl 
   * @returns {string}
   */
  validateAndNormalizeUrl(rawUrl) {
    const trimmed = String(rawUrl || '').trim();
    if (!trimmed) return '';

    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`无效的 WebDAV 地址: "${trimmed}"，必须为有效的 URL`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`不安全的 WebDAV 协议: "${parsed.protocol}"，只允许 http:// 或 https://`);
    }

    // SSRF 拦截：禁止云厂商元数据地址与特殊私有广播
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal' || hostname === 'instance-data') {
      throw new Error(`SSRF 安全拦截：禁止访问云厂商元数据服务 (${hostname})`);
    }

    return trimmed.replace(/\/+$/, '');
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
    if (!this.url) throw new Error('WebDAV URL 尚未配置');
    const cleanRel = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanRel) return this.url;

    // 对各路径分段安全进行 URI 编码，避免中文与空格导致 400
    const encodedSegments = cleanRel.split('/').map(seg => encodeURIComponent(seg)).join('/');
    return `${this.url}/${encodedSegments}`;
  }

  /**
   * 带超时控制与精准错误包装的 fetch
   * @param {string} url 
   * @param {RequestInit} options 
   * @param {number} [customTimeout]
   */
  async fetchWithTimeout(url, options = {}, customTimeout = null) {
    const timeout = customTimeout || this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const resp = await fetch(url, {
        ...options,
        headers: {
          ...this.getAuthHeaders(),
          ...options.headers,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      return resp;
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
        console.warn(`[ST-WebDAV] ensureDirectory ${currentPath} error:`, err.message);
      }
    }
  }

  /**
   * 流式上传文件至 WebDAV (PUT)
   * 零落盘临时文件、零 Node 堆内存积压
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
    }

    // Node 18+ 原生 fetch 对 stream 请求需 duplex: 'half'
    const fetchOptions = {
      method: 'PUT',
      headers,
      body,
      duplex: 'half',
    };

    const resp = await this.fetchWithTimeout(targetUrl, fetchOptions, this.timeoutMs * 4); // 大文件适当增加超时

    if (resp.ok || resp.status === 201 || resp.status === 204) {
      return { success: true, url: targetUrl, status: resp.status };
    }

    let detail = '';
    try { detail = await resp.text(); } catch {}
    throw new Error(`WebDAV PUT 上传失败 (HTTP ${resp.status}): ${detail.slice(0, 100) || resp.statusText}`);
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
    }, this.timeoutMs * 4);

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

      // 修改时间
      const modMatch = block.match(/<(?:\w+:)?getlastmodified[^>]*>([^<]+)<\/(?:\w+:)?getlastmodified>/i);
      const lastModified = modMatch ? new Date(modMatch[1].trim()).toISOString() : new Date().toISOString();

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
