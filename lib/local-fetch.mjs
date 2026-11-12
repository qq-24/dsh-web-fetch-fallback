/**
 * 本地直抓：主路失败时，用 Node 内置 fetch 直接取回目标 URL，
 * 并按 dsh-web 的 WebFetchResult 契约返回，交回同一个 web_fetch 工具渲染。
 *
 * 刻意不依赖任何宿主包（不 import @deepseek-ai/*），这样：
 *   - 插件能从任意 profile deps 目录加载，不需要宿主模块解析；
 *   - DSH 升级改了 web seam 内部实现也不会把它带崩；
 *   - 可以脱离 DSH 单独跑单元测试。
 *
 * 安全边界（与官方 dsh-web-fetch-http 对齐的部分）：
 *   - 只允许 http/https，URL 长度上限，拒绝 URL 内嵌凭据；
 *   - IP 字面量中的私网/回环/保留地址一律拒绝；
 *   - 手动跟随重定向、逐跳复核、跳数上限；
 *   - 响应字节与解码字符双上限、超时、取消透传；
 *   - 明确的二进制 MIME 拒绝。
 * 差异（诚实标注）：本插件对 content-type 更宽容（除明确二进制外按文本解码），
 * 且不校验 DNS 解析结果是否为公网地址——Clash TUN fake-IP 环境需要这样。
 */

import { isIP } from 'node:net';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BINARY_CONTENT_TYPE = /^(image\/(?!svg\+xml)|audio\/|video\/|application\/(octet-stream|pdf|zip|gzip|x-tar|wasm|protobuf))/iu;

/** 带稳定 code 的错误，便于上层按机器码分流（不 import 宿主 WebError，避免耦合）。 */
function fail(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

/** IPv4/IPv6 字面量是否属于不可对外发起的地址。 */
export function isBlockedIpLiteral(hostname) {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const family = isIP(bare);
  if (family === 0) return false; // 域名：交给 DNS / 系统网络栈
  if (family === 6) {
    const lower = bare.toLowerCase();
    return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd')
      || lower.startsWith('fe80') || lower.startsWith('::ffff:127.') || lower.startsWith('::ffff:10.')
      || lower.startsWith('::ffff:192.168.') || lower.startsWith('::ffff:0.');
  }
  const [a, b] = bare.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
    || a === 100 && b >= 64 && b <= 127 || a >= 224;
}

/** 校验并归一化一个 URL；返回 URL 对象，非法时抛带 code 的错误。 */
export function validateFetchUrl(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2048) {
    throw fail('WEB_INVALID_URL', `URL exceeds the maximum length of 2048 or is empty`);
  }
  let url;
  try { url = new URL(input); }
  catch (error) { throw fail('WEB_INVALID_URL', `invalid URL: ${input}`, error); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw fail('WEB_INVALID_URL', `unsupported URL scheme "${url.protocol}" (only http and https are allowed)`);
  }
  if (url.username || url.password) {
    throw fail('WEB_BLOCKED_URL', 'credentials in URLs are not allowed');
  }
  if (isBlockedIpLiteral(url.hostname)) {
    throw fail('WEB_BLOCKED_URL', `URL hostname "${url.hostname}" is a blocked IP literal`);
  }
  return url;
}

/** 按 content-type 决定 WebFetchBody.kind（封闭联合只有 html / text）。 */
export function classifyBody(contentType) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml' ? 'html' : 'text';
}

function charsetOf(contentType) {
  const match = /charset\s*=\s*"?([a-z0-9._-]+)"?/iu.exec(String(contentType ?? ''));
  return match?.[1] ?? 'utf-8';
}

function decodeBuffer(buffer, contentType) {
  let decoder;
  try { decoder = new TextDecoder(charsetOf(contentType)); }
  catch { decoder = new TextDecoder('utf-8'); }
  return decoder.decode(buffer);
}

/** 流式读取响应体，字节超上限就停止并标记 truncated。 */
async function readBounded(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    const truncated = buffer.byteLength > maxBytes;
    return { buffer: truncated ? buffer.slice(0, maxBytes) : buffer, truncated };
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) continue;
    const remaining = maxBytes - total;
    if (remaining <= 0) { truncated = true; await reader.cancel().catch(() => {}); break; }
    const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
    chunks.push(slice);
    total += slice.byteLength;
    if (slice.byteLength < value.byteLength) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return { buffer: merged.buffer, truncated };
}

function capChars(text, maxChars) {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return { content: text, truncated: false };
  return { content: chars.slice(0, maxChars).join(''), truncated: true };
}

/** 组合调用方 signal 与本地超时；调用方取消优先保留。 */
function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (signal.aborted) return signal;
  return AbortSignal.any([signal, timeout]);
}

/**
 * 可选代理：Node 内置 fetch 不读取 HTTP(S)_PROXY 环境变量。
 * 传入 proxyUrl 时尝试用 undici 的 ProxyAgent（DSH 自带 undici）；
 * 解析不到就直连，绝不因为代理缺失让抓取失败。
 */
async function dispatcherFor(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    const { ProxyAgent } = await import('undici');
    return new ProxyAgent(proxyUrl);
  } catch {
    return undefined;
  }
}

/**
 * 本地直抓主入口。
 * @param {{url: string}} request dsh-web 的 WebFetchRequest
 * @param {AbortSignal} [signal] 调用方取消信号
 * @param {ReturnType<import('./config.mjs').normalizeConfig>} config 归一化配置
 * @returns {Promise<{url: string, statusCode: number, body: {kind: string, content: string}, truncated: boolean}>}
 */
export async function localFetch(request, signal, config, fetchImpl = globalThis.fetch) {
  let current = validateFetchUrl(request?.url);
  const dispatcher = await dispatcherFor(config.proxyUrl);
  const timeoutMs = config.timeoutMs;
  let redirects = 0;

  for (;;) {
    if (signal?.aborted) throw fail('WEB_ABORTED', 'web fetch aborted');
    const requestSignal = combinedSignal(signal, timeoutMs);
    let response;
    try {
      response = await fetchImpl(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': config.userAgent, accept: 'text/html,text/plain,application/json,application/xml,*/*' },
        signal: requestSignal,
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        throw fail('WEB_ABORTED', 'web fetch aborted', error);
      }
      throw fail('WEB_PROVIDER_ERROR', `local fetch failed: ${String(error?.message ?? error)}`, error);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers?.get?.('location');
      await Promise.resolve(response.body?.cancel?.()).catch(() => {});
      if (!location) throw fail('WEB_REDIRECT_BLOCKED', `redirect (HTTP ${response.status}) without a Location header`);
      if (redirects >= config.maxRedirects) {
        throw fail('WEB_REDIRECT_BLOCKED', `exceeded the maximum of ${config.maxRedirects} redirects`);
      }
      let next;
      try { next = validateFetchUrl(new URL(location, current).toString()); }
      catch (error) { throw fail('WEB_REDIRECT_BLOCKED', `invalid redirect target: ${location}`, error); }
      current = next;
      redirects += 1;
      continue;
    }

    const contentType = response.headers?.get?.('content-type') ?? '';
    if (BINARY_CONTENT_TYPE.test(contentType)) {
      await Promise.resolve(response.body?.cancel?.()).catch(() => {});
      throw fail('WEB_UNSUPPORTED_CONTENT', `unsupported binary content type: ${contentType}`);
    }

    const { buffer, truncated: byteTruncated } = await readBounded(response, config.maxResponseBytes);
    const decoded = decodeBuffer(buffer, contentType);
    const { content, truncated: charTruncated } = capChars(decoded, config.maxBodyChars);
    return {
      url: current.toString(),
      statusCode: response.status,
      body: { kind: classifyBody(contentType), content },
      truncated: byteTruncated || charTruncated,
    };
  }
}
