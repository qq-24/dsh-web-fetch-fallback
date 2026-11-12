import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../lib/config.mjs';
import { shouldFallback, isCancellation, isUnusableResult } from '../lib/should-fallback.mjs';

const cfg = normalizeConfig();
const good = {
  url: 'https://example.com/a', statusCode: 200,
  body: { kind: 'text', content: 'real content' }, truncated: false,
};

test('主路成功且可用 → 不降级', () => {
  assert.equal(shouldFallback(good, null, cfg), false);
});

test('主路抛普通错误 → 降级', () => {
  assert.equal(shouldFallback(undefined, new Error('HTTP 404'), cfg), true);
});

test('主路取消（AbortError / WEB_ABORTED / ABORTED）→ 不降级', () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const webAbort = Object.assign(new Error('aborted'), { code: 'WEB_ABORTED' });
  const abortErr = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
  for (const error of [abort, webAbort, abortErr]) {
    assert.equal(isCancellation(error), true);
    assert.equal(shouldFallback(undefined, error, cfg), false, String(error.code ?? error.name));
  }
});

test('主路返回非 2xx → 降级', () => {
  assert.equal(isUnusableResult({ ...good, statusCode: 404 }, cfg), true);
  assert.equal(shouldFallback({ ...good, statusCode: 404 }, null, cfg), true);
});

test('主路返回空正文 → 降级', () => {
  const empty = { ...good, body: { kind: 'text', content: '   ' } };
  assert.equal(isUnusableResult(empty, cfg), true);
  assert.equal(shouldFallback(empty, null, cfg), true);
});

test('结果结构异常 → 降级', () => {
  for (const bad of [undefined, null, {}, { statusCode: 200 }]) {
    assert.equal(shouldFallback(bad, null, cfg), true);
  }
});

test('关闭对应开关后不再降级', () => {
  const off = normalizeConfig({ fallbackOnError: false, fallbackOnStatus: false, fallbackOnEmpty: false });
  assert.equal(shouldFallback(undefined, new Error('boom'), off), false);
  assert.equal(shouldFallback({ ...good, statusCode: 404 }, null, off), false);
  assert.equal(shouldFallback({ ...good, body: { kind: 'text', content: '' } }, null, off), false);
});
