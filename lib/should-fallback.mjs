/**
 * 失败判据：纯函数。决定一次主路调用的结果要不要触发本地直抓。
 *
 * 设计原则：主路成功就原样返回，绝不改写主路的结果（保持"先使用这个"的语义）；
 * 只有明确"没拿到可用内容"才降级。取消（WEB_ABORTED）不降级——用户/调用方
 * 主动中断不该被插件偷偷换成另一次网络请求。
 */

/** 主路抛出的错误是否属于"调用方取消"。 */
export function isCancellation(error) {
  if (!error) return false;
  if (error?.name === 'AbortError') return true;
  const code = typeof error?.code === 'string' ? error.code : '';
  return code === 'WEB_ABORTED' || code === 'ABORT_ERR' || code === 'ABORTED';
}

/** 主路返回的 WebFetchResult 是否是不可用内容（用于 fallbackOnEmpty / fallbackOnStatus）。 */
export function isUnusableResult(result, config) {
  if (!result || typeof result !== 'object') return true;
  if (config.fallbackOnStatus) {
    const status = result.statusCode;
    if (typeof status === 'number' && (status < 200 || status >= 300)) return true;
  }
  if (config.fallbackOnEmpty) {
    const content = result?.body?.content;
    if (typeof content !== 'string' || content.trim().length === 0) return true;
  }
  return false;
}

/**
 * @param result 主路成功时的返回值（主路抛错时为 undefined）
 * @param error  主路抛出的错误（成功时为 null）
 * @param config 归一化后的配置
 * @returns 是否应该降级
 */
export function shouldFallback(result, error, config) {
  if (error) {
    if (isCancellation(error)) return false;
    return config.fallbackOnError === true;
  }
  return isUnusableResult(result, config);
}
