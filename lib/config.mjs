/**
 * 配置归一化：纯函数，无宿主依赖，可单独测试。
 *
 * 插件接的是 cordis patch 层给的普通对象（不是 schemastery live config），
 * 所以所有字段都在这里做防御式归一化：非法/越界值一律回落默认值，
 * 绝不让一个拼错的配置把插件挂死。
 */

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  /** 本地直抓的单次总超时（毫秒）。 */
  timeoutMs: 30_000,
  /** 响应体字节上限（超出部分截断，truncated=true）。 */
  maxResponseBytes: 5_000_000,
  /** 解码后字符上限（按 Unicode 码点截断）。 */
  maxBodyChars: 100_000,
  /** 手动跟随重定向的最大跳数。 */
  maxRedirects: 5,
  /** 主路抛错时降级。 */
  fallbackOnError: true,
  /** 主路返回非 2xx 时降级。 */
  fallbackOnStatus: true,
  /** 主路返回空正文时降级。 */
  fallbackOnEmpty: true,
  /** 每次降级打一行日志（观测用，不含 URL 正文）。 */
  logFallback: true,
  /** 本地直抓的 User-Agent。 */
  userAgent: 'dsh-web-fetch-fallback/1.0 (+https://github.com/qq-24/dsh-web-fetch-fallback)',
  /** 可选代理（http://host:port）。留空=直连；Node 内置 fetch 不自动读环境变量代理。 */
  proxyUrl: '',
  /** 调试用：跳过主路，直接本地抓。 */
  localOnly: false,
});

const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback;
const int = (value, fallback, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : fallback;
const str = (value, fallback, maxLength = 2048) =>
  typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : fallback;

export function normalizeConfig(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: bool(input.enabled, DEFAULT_CONFIG.enabled),
    timeoutMs: int(input.timeoutMs, DEFAULT_CONFIG.timeoutMs, 1000, 300_000),
    maxResponseBytes: int(input.maxResponseBytes, DEFAULT_CONFIG.maxResponseBytes, 256, 50_000_000),
    maxBodyChars: int(input.maxBodyChars, DEFAULT_CONFIG.maxBodyChars, 32, 2_000_000),
    maxRedirects: int(input.maxRedirects, DEFAULT_CONFIG.maxRedirects, 0, 20),
    fallbackOnError: bool(input.fallbackOnError, DEFAULT_CONFIG.fallbackOnError),
    fallbackOnStatus: bool(input.fallbackOnStatus, DEFAULT_CONFIG.fallbackOnStatus),
    fallbackOnEmpty: bool(input.fallbackOnEmpty, DEFAULT_CONFIG.fallbackOnEmpty),
    logFallback: bool(input.logFallback, DEFAULT_CONFIG.logFallback),
    userAgent: str(input.userAgent, DEFAULT_CONFIG.userAgent, 512),
    proxyUrl: typeof input.proxyUrl === 'string' && /^https?:\/\//iu.test(input.proxyUrl)
      ? input.proxyUrl
      : DEFAULT_CONFIG.proxyUrl,
    localOnly: bool(input.localOnly, DEFAULT_CONFIG.localOnly),
  };
}
