import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig } from '../lib/config.mjs';

test('默认值覆盖全部字段且不可变', () => {
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
  const cfg = normalizeConfig();
  for (const key of Object.keys(DEFAULT_CONFIG)) assert.equal(cfg[key], DEFAULT_CONFIG[key], key);
});

test('非法值一律回落默认值，不抛异常', () => {
  const cfg = normalizeConfig({
    timeoutMs: -1, maxResponseBytes: 'abc', maxBodyChars: 0, maxRedirects: 999,
    enabled: 'yes', fallbackOnError: 1, userAgent: '', proxyUrl: 'ftp://x',
  });
  assert.equal(cfg.timeoutMs, DEFAULT_CONFIG.timeoutMs);
  assert.equal(cfg.maxResponseBytes, DEFAULT_CONFIG.maxResponseBytes);
  assert.equal(cfg.maxBodyChars, DEFAULT_CONFIG.maxBodyChars);
  assert.equal(cfg.maxRedirects, DEFAULT_CONFIG.maxRedirects);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.fallbackOnError, true);
  assert.equal(cfg.userAgent, DEFAULT_CONFIG.userAgent);
  assert.equal(cfg.proxyUrl, '');
});

test('合法自定义值被保留；proxyUrl 只接受 http(s)', () => {
  const cfg = normalizeConfig({
    timeoutMs: 8000, maxResponseBytes: 2048, maxBodyChars: 500, maxRedirects: 0,
    fallbackOnEmpty: false, logFallback: false, localOnly: true,
    userAgent: 'probe/1', proxyUrl: 'http://127.0.0.1:7890',
  });
  assert.equal(cfg.timeoutMs, 8000);
  assert.equal(cfg.maxRedirects, 0);
  assert.equal(cfg.fallbackOnEmpty, false);
  assert.equal(cfg.logFallback, false);
  assert.equal(cfg.localOnly, true);
  assert.equal(cfg.proxyUrl, 'http://127.0.0.1:7890');
  assert.equal(normalizeConfig({ proxyUrl: 'socks5://x' }).proxyUrl, '');
  // 下限必须允许小预算（截断逻辑的测试与调试依赖它），不能被悄悄回落成默认值
  const small = normalizeConfig({ maxResponseBytes: 1000, maxBodyChars: 100 });
  assert.equal(small.maxResponseBytes, 1000);
  assert.equal(small.maxBodyChars, 100);
});

test('非对象输入（null / 字符串 / 数组）不炸', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    const cfg = normalizeConfig(bad);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.timeoutMs, DEFAULT_CONFIG.timeoutMs);
  }
});
