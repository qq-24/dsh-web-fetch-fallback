import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../lib/config.mjs';
import { localFetch, validateFetchUrl, classifyBody, isBlockedIpLiteral } from '../lib/local-fetch.mjs';

const cfg = normalizeConfig({ maxResponseBytes: 5000, maxBodyChars: 1000, timeoutMs: 5000, maxRedirects: 2 });
const textResponse = (body, status = 200, contentType = 'text/plain; charset=utf-8') =>
  new Response(body, { status, headers: { 'content-type': contentType } });
const impl = handler => async (url, options) => handler(url, options);

test('URL 校验：协议 / 长度 / 凭据 / 私网 IP 字面量', () => {
  assert.equal(validateFetchUrl('https://example.com/a').hostname, 'example.com');
  assert.throws(() => validateFetchUrl('file:///etc/passwd'), e => e.code === 'WEB_INVALID_URL');
  assert.throws(() => validateFetchUrl('javascript:alert(1)'), e => e.code === 'WEB_INVALID_URL');
  assert.throws(() => validateFetchUrl('https://u:p@example.com'), e => e.code === 'WEB_BLOCKED_URL');
  assert.throws(() => validateFetchUrl('http://127.0.0.1:8080'), e => e.code === 'WEB_BLOCKED_URL');
  assert.throws(() => validateFetchUrl('http://192.168.1.1'), e => e.code === 'WEB_BLOCKED_URL');
  assert.equal(isBlockedIpLiteral('198.18.0.1'), false, 'Clash fake-IP 是 DNS 结果，不是这里拦的对象');
  assert.equal(classifyBody('text/html; charset=utf-8'), 'html');
  assert.equal(classifyBody('text/plain'), 'text');
  assert.equal(classifyBody('application/json'), 'text');
});

test('200 文本 → 完整 WebFetchResult 契约', async () => {
  const result = await localFetch({ url: 'https://example.com/a.cc' }, undefined, cfg,
    impl(async () => textResponse('// Copyright 2026 The ODML Authors.\nint main(){}')));
  assert.equal(result.url, 'https://example.com/a.cc');
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.kind, 'text');
  assert.match(result.body.content, /Copyright 2026/);
  assert.equal(result.truncated, false);
});

test('text/html → kind=html', async () => {
  const result = await localFetch({ url: 'https://example.com/' }, undefined, cfg,
    impl(async () => textResponse('<html><body>hi</body></html>', 200, 'text/html')));
  assert.equal(result.body.kind, 'html');
  assert.match(result.body.content, /<html>/);
});

test('非 2xx 作为结果返回（不抛）', async () => {
  const result = await localFetch({ url: 'https://example.com/nope' }, undefined, cfg,
    impl(async () => textResponse('Page Not Found', 404)));
  assert.equal(result.statusCode, 404);
  assert.equal(result.body.content, 'Page Not Found');
});

test('逐跳跟随重定向并返回最终 URL', async () => {
  let calls = 0;
  const result = await localFetch({ url: 'https://example.com/start' }, undefined, cfg, impl(async url => {
    calls += 1;
    if (calls === 1) return new Response(null, { status: 302, headers: { location: 'https://example.com/final' } });
    return textResponse('final');
  }));
  assert.equal(calls, 2);
  assert.equal(result.url, 'https://example.com/final');
  assert.equal(result.body.content, 'final');
});

test('重定向跳数超限抛 WEB_REDIRECT_BLOCKED', async () => {
  await assert.rejects(
    () => localFetch({ url: 'https://example.com/loop' }, undefined, cfg,
      impl(async () => new Response(null, { status: 302, headers: { location: 'https://example.com/loop2' } }))),
    e => e.code === 'WEB_REDIRECT_BLOCKED',
  );
});

test('二进制 content-type 拒绝', async () => {
  await assert.rejects(
    () => localFetch({ url: 'https://example.com/a.png' }, undefined, cfg,
      impl(async () => textResponse('PNGDATA', 200, 'image/png'))),
    e => e.code === 'WEB_UNSUPPORTED_CONTENT',
  );
});

test('字节上限截断（truncated=true）', async () => {
  const small = normalizeConfig({ maxResponseBytes: 1000, maxBodyChars: 5000 });
  const result = await localFetch({ url: 'https://example.com/big' }, undefined, small,
    impl(async () => textResponse('x'.repeat(2000))));
  assert.equal(result.body.content.length, 1000);
  assert.equal(result.truncated, true);
});

test('字符上限按码点截断', async () => {
  const small = normalizeConfig({ maxResponseBytes: 5000, maxBodyChars: 100 });
  const result = await localFetch({ url: 'https://example.com/big' }, undefined, small,
    impl(async () => textResponse('中'.repeat(200))));
  assert.equal(Array.from(result.body.content).length, 100);
  assert.equal(result.truncated, true);
});

test('调用方取消 → WEB_ABORTED，且不会发起请求', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    () => localFetch({ url: 'https://example.com/' }, controller.signal, cfg, impl(async () => { called = true; return textResponse('x'); })),
    e => e.code === 'WEB_ABORTED',
  );
  assert.equal(called, false);
});

test('网络层错误 → WEB_PROVIDER_ERROR', async () => {
  await assert.rejects(
    () => localFetch({ url: 'https://example.com/' }, undefined, cfg,
      impl(async () => { throw new Error('ECONNRESET'); })),
    e => e.code === 'WEB_PROVIDER_ERROR',
  );
});
