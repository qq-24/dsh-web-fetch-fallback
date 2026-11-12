/**
 * dsh-web-fetch-fallback
 *
 * 目标：内置 web_fetch 主路（当前 fetchProvider）失败时，不把错误直接交给工具，
 * 改成用本机直抓，把成功的 WebFetchResult 还给同一个 web_fetch 工具。
 *
 * 做法：包装 ctx.web.fetch 这个**实例方法**（不是原型、不注册 provider、不改
 * fetchProvider、不读宿主私有字段）。因此：
 *   - "先使用这个"是真的调用当前配置的主 provider；
 *   - 装上即生效，零注册冲突；
 *   - 主路成功时原样返回它的结果，绝不改写；
 *   - dispose 时精确还原（有 own property 就还原成原值，没有就 delete 让原型方法恢复）。
 *
 * 宿主契约（DSH 0.2.1-rc.5 亲读）：
 *   - @deepseek-ai/dsh-web/lib/index.js: WebRuntime.fetch(request, signal) 在调用时
 *     解析 provider 并调用其 fetch()；provider 由 config.fetchProvider 选择。
 *   - @deepseek-ai/dsh-web/lib/types/types.d.ts: WebFetchResult =
 *     { url, statusCode, body: {kind:'html'|'text', content}, truncated }。
 *   - @deepseek-ai/dsh-tool-web/lib/index.js:616,808-811 读上述字段渲染。
 *
 * 失败策略（对齐 dsh-clash-tun-fix）：宿主升级导致接口变化时拒绝挂载、只打一行日志，
 * 绝不崩启动，降级回官方行为。
 */

import { normalizeConfig } from './lib/config.mjs';
import { localFetch } from './lib/local-fetch.mjs';
import { shouldFallback } from './lib/should-fallback.mjs';

export const name = 'dsh-web-fetch-fallback';
export const inject = ['web'];

const MARK = '__dshWebFetchFallbackWrapped';

function describePrimary(error, result) {
  if (error) return `${error?.code ?? error?.name ?? 'Error'}: ${String(error?.message ?? error).slice(0, 200)}`;
  const empty = !String(result?.body?.content ?? '').trim();
  return `unusable result (status=${String(result?.statusCode ?? 'n/a')}, emptyBody=${empty})`;
}

function unusableResultError(result) {
  const error = new Error(`primary web_fetch returned an unusable result (status=${String(result?.statusCode ?? 'n/a')})`);
  error.code = 'WEB_PROVIDER_ERROR';
  return error;
}

function combinedError(primary, local) {
  const error = new Error(
    `web_fetch primary failed and local fallback also failed. primary: ${String(primary?.message ?? primary).slice(0, 300)} | local: ${String(local?.message ?? local).slice(0, 300)}`,
    { cause: primary },
  );
  error.code = primary?.code ?? local?.code ?? 'WEB_PROVIDER_ERROR';
  error.primaryCode = primary?.code ?? null;
  error.localCode = local?.code ?? null;
  return error;
}

/**
 * 包装一个 web 服务实例的 fetch 方法。导出为纯函数以便脱离 DSH 单独测试。
 * @returns {{ok: boolean, reason?: string, wrapped?: Function, dispose: Function}}
 */
export function createFetchWrapper({ web, config, localFetchImpl = localFetch, log = () => {} }) {
  if (!web || typeof web.fetch !== 'function') {
    return { ok: false, reason: 'ctx.web.fetch is unavailable', dispose() {} };
  }
  if (web[MARK] === true) {
    return { ok: false, reason: 'ctx.web.fetch is already wrapped', dispose() {} };
  }

  const hadOwn = Object.prototype.hasOwnProperty.call(web, 'fetch');
  const ownFetch = hadOwn ? web.fetch : undefined;
  const original = web.fetch.bind(web);
  let disposed = false;

  const wrapped = async (request, signal) => {
    const urlHint = String(request?.url ?? '').slice(0, 200);

    if (!config.localOnly) {
      let result;
      let primaryError = null;
      try {
        result = await original(request, signal);
      } catch (error) {
        primaryError = error;
      }

      if (primaryError) {
        // 取消 / 关闭降级开关：原样抛出，不偷偷换成另一次网络请求。
        if (!shouldFallback(undefined, primaryError, config)) throw primaryError;
        if (config.logFallback) log(`primary failed (${describePrimary(primaryError)}), falling back to local fetch for ${urlHint}`);
        try {
          return await localFetchImpl(request, signal, config);
        } catch (localError) {
          throw combinedError(primaryError, localError);
        }
      }

      // 主路成功：不可用结果（非 2xx / 空正文）才降级，否则原样返回。
      if (!shouldFallback(result, null, config)) return result;
      if (config.logFallback) log(`primary returned ${describePrimary(null, result)}, falling back to local fetch for ${urlHint}`);
      try {
        return await localFetchImpl(request, signal, config);
      } catch (localError) {
        throw combinedError(unusableResultError(result), localError);
      }
    }

    return localFetchImpl(request, signal, config);
  };

  web.fetch = wrapped;
  Object.defineProperty(web, MARK, {
    value: true, configurable: true, enumerable: false, writable: true,
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (web.fetch === wrapped) {
      if (hadOwn) web.fetch = ownFetch;
      else delete web.fetch;
    }
    if (web[MARK] === true) delete web[MARK];
  };

  return { ok: true, wrapped, dispose };
}

function makeLogger(ctx) {
  return message => {
    const line = `[${name}] ${message}`;
    try { ctx?.logger?.info?.(line); } catch { /* logger 不是必须 */ }
    try { console.log(line); } catch { /* 极端情况下 stdout 不可用也不崩 */ }
  };
}

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);
  const log = makeLogger(ctx);

  if (!cfg.enabled) {
    log('disabled by config; leaving official web_fetch behavior');
    return { name, enabled: false, reason: 'disabled' };
  }

  let wrapper;
  try {
    wrapper = createFetchWrapper({ web: ctx?.web, config: cfg, log });
  } catch (error) {
    log(`failed to wrap ctx.web.fetch, leaving official behavior: ${String(error?.message ?? error)}`);
    return { name, enabled: false, reason: String(error?.message ?? error) };
  }
  if (!wrapper.ok) {
    log(`skipped (${wrapper.reason}); leaving official behavior`);
    return { name, enabled: false, reason: wrapper.reason };
  }

  try { ctx?.on?.('dispose', wrapper.dispose); } catch { /* dispose 钩子不是必须 */ }
  log('wrapped ctx.web.fetch: primary provider first, local direct fetch on failure');
  return { name, enabled: true, dispose: wrapper.dispose };
}

export default { name, inject, apply };
