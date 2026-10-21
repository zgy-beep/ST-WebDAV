/**
 * URL 安全校验（SSRF 防御）
 * ------------------------------------------------------------------
 * 抽出为独立纯函数，供 WebDavClient（实际发起请求前）与
 * ConfigManager（保存配置时）共用 —— 后者此前只校验了 http/https 协议，
 * 未做 SSRF 黑名单检查，导致内网地址可以先被存进配置再被使用。
 *
 * ⚠️ 已知且刻意接受的残余风险：
 *   本模块只拦截云厂商元数据服务与链路本地地址，**刻意放行**
 *   10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、127.0.0.0/8 等内网地址，
 *   以支持群晖 NAS / Alist 自建服务等核心使用场景。
 *   因此本模块**无法防御**「用户把 URL 指向内网其他服务」这一 SSRF 变体；
 *   该残余风险由 /test 接口的频率限制（index.js）部分缓解。
 */

/**
 * 云厂商元数据服务与链路本地地址的识别
 * @param {string} rawHost 原始 hostname
 * @returns {boolean}
 */
export function isBlockedMetadataHost(rawHost) {
  const cleanHost = String(rawHost || '').toLowerCase().replace(/^\[|\]$/g, '');

  // IPv4-mapped IPv6 (::ffff:169.254.169.254) 会被 URL 解析器归一化为
  // ::ffff:a9fe:a9fe 这类十六进制形式，必须显式识别前缀
  const isIpv4Mapped = cleanHost.startsWith('::ffff:');
  const mappedTail = isIpv4Mapped ? cleanHost.slice('::ffff:'.length) : '';

  // 归一化后的十六进制 IPv4-mapped 形式 (::ffff:a9fe:a9fe)
  const isMappedHexLinkLocal = isIpv4Mapped && /^a9fe:[0-9a-f]{1,4}$/.test(mappedTail);
  // 归一化后的十进制点分形式 (::ffff:169.254.169.254)
  const isMappedDottedLinkLocal = isIpv4Mapped && mappedTail.startsWith('169.254.');

  return (
    cleanHost === '169.254.169.254' ||
    cleanHost.startsWith('169.254.') ||
    cleanHost === '2852039166' || // 169.254.169.254 的十进制表示
    cleanHost === '0xa9fea9fe' || // 169.254.169.254 的十六进制表示
    cleanHost === '100.100.100.200' || // 阿里云元数据
    cleanHost === 'metadata.google.internal' ||
    cleanHost === 'instance-data' ||
    cleanHost === 'fd00:ec2::254' || // AWS IPv6 IMDS
    cleanHost.startsWith('fe80:') || // IPv6 link-local
    cleanHost === '::1' || // IPv6 本机回环
    cleanHost === '::' || // IPv6 未指定地址
    cleanHost === '0.0.0.0' || // IPv4 未指定地址
    isMappedHexLinkLocal ||
    isMappedDottedLinkLocal
  );
}

/**
 * 校验并归一化一个 WebDAV / CDN 类的 http(s) 地址
 * @param {string} rawUrl
 * @param {object} [options]
 * @param {string} [options.label] 错误提示中使用的名称，默认 "WebDAV 地址"
 * @param {boolean} [options.stripTrailingSlash] 是否去掉末尾斜杠
 * @returns {string}
 */
export function validateHttpUrl(rawUrl, options = {}) {
  const label = options.label || 'WebDAV 地址';
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`无效的 ${label}: "${trimmed}"，必须为有效的 URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // 保持与历史错误文案一致：label 形如 "WebDAV 地址" 时输出 "不安全的 WebDAV 协议"
    const protoLabel = label.replace(/\s*地址$/, '');
    throw new Error(`不安全的 ${protoLabel} 协议: "${parsed.protocol}"，只允许 http:// 或 https://`);
  }

  if (isBlockedMetadataHost(parsed.hostname)) {
    throw new Error(`SSRF 安全拦截：禁止访问云厂商元数据服务 (${parsed.hostname})`);
  }

  return options.stripTrailingSlash ? trimmed.replace(/\/+$/, '') : trimmed;
}
