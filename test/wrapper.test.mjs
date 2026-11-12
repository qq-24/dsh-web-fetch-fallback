import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../lib/config.mjs';
import { createFetchWrapper, apply, name, inject } from '../index.mjs';

const cfg = normalizeConfig();
const LOCAL = {
  url: 'https://example.com/a', statusCode: 200,
  body: { kind: 'text', content: 'local body' }, truncated: false,
};
const PRIMARY = {
  url: 'https://example.com/a', statusCode: 200,
  body: { kind: 'text', content: 'primary body' }, truncated: false,
};

function makeWeb(primaryImpl) {
  return { fetch: primaryImpl };
}

test('插件元数据：name 与 inject web', () => {
  assert.equal(name, 'dsh-web-fetch-fallback');
  assert.deepEqual(inject, ['web']);
});

test('主路成功 → 不调本地，原样返回主路结果', async () => {
  let localCalls = 0;
  const web = makeWeb(async () => PRIMARY);
  const w = createFetchWrapper({ web, config: cfg, localFetchImpl: async () => { localCalls += 1; return LOCAL; } });
  assert.equal(w.ok, true);
  const result = await web.fetch({ url: 'https://example.com/a' });
  assert.deepEqual(result, PRIMARY);
  assert.equal(localCalls, 0);
  w.dispose();
});

test('主路抛错 → 降级本地，返回本地成功结果', async () => {
  let localCalls = 0;
  const web = makeWeb(async () => { throw Object.assign(new Error('HTTP 404'), { code: 'WEB_PROVIDER_ERROR' }); });
  const w = createFetchWrapper({ web, config: cfg, localFetchImpl: async () => { localCalls += 1; return LOCAL; } });
  const result = await web.fetch({ url: 'https://example.com/a' });
  assert.deepEqual(result, LOCAL);
  assert.equal(localCalls, 1);
  w.dispose();
});

test('主路返回非 2xx 结果 → 降级本地', async () => {
  const web = makeWeb(async () => ({ ...PRIMARY, statusCode: 404 }));
  const w = createFetchWrapper({ web, config: cfg, localFetchImpl: async () => LOCAL });
  assert.deepEqual(await web.fetch({ url: 'https://example.com/a' }), LOCAL);
  w.dispose();
});

test('主路返回空正文 → 降级本地', async () => {
  const web = makeWeb(async () => ({ ...PRIMARY, body: { kind: 'text', content: '  ' } }));
  const w = createFetchWrapper({ web, config: cfg, localFetchImpl: async () => LOCAL });
  assert.deepEqual(await web.fetch({ url: 'https://example.com/a' }), LOCAL);
  w.dispose();
});

test('主路取消 → 原样抛，不发本地请求', async () => {
  let localCalls = 0;
  const abort = Object.assign(new Error('aborted'), { code: 'WEB_ABORTED' });
  const web = makeWeb(async () => { throw abort; });
  const w = createFetchWrapper({ web, config: cfg, localFetchImpl: async () => { localCalls += 1; return LOCAL; } });
  await assert.rejects(() => web.fetch({ url: 'https://example.com/a' }), e => e === abort);
  assert.equal(localCalls, 0);
  w.dispose();
});

test('主路与本地都失败 → 抛合并错误，保留主路 code 且带两个子码', async () => {
  const primary = Object.assign(new Error('primary down'), { code: 'WEB_PROVIDER_ERROR' });
  const local = Object.assign(new Error('local down'), { code: 'WEB_PROVIDER_ERROR' });
  const web = makeWeb(async () => { throw primary; });
  const w = createFetchWrapper({ web, config: cfg, localFetchImpl: async () => { throw local; } });
  await assert.rejects(
    () => web.fetch({ url: 'https://example.com/a' }),
    e => e.code === 'WEB_PROVIDER_ERROR' && e.primaryCode === 'WEB_PROVIDER_ERROR'
      && e.localCode === 'WEB_PROVIDER_ERROR' && /primary down/.test(e.message) && /local down/.test(e.message),
  );
  w.dispose();
});

test('主路成功但本地失败时（不可用结果）→ 仍抛合并错误而非静默吞', async () => {
  const web = makeWeb(async () => ({ ...PRIMARY, statusCode: 500 }));
  const w = createFetchWrapper({ web, config: cfg, localFetchImpl: async () => { throw new Error('local down'); } });
  await assert.rejects(
    () => web.fetch({ url: 'https://example.com/a' }),
    e => /primary failed and local fallback also failed/.test(e.message),
  );
  w.dispose();
});

test('localOnly → 跳过主路直接本地抓', async () => {
  let primaryCalls = 0;
  const web = makeWeb(async () => { primaryCalls += 1; return PRIMARY; });
  const w = createFetchWrapper({
    web, config: normalizeConfig({ localOnly: true }), localFetchImpl: async () => LOCAL,
  });
  assert.deepEqual(await web.fetch({ url: 'https://example.com/a' }), LOCAL);
  assert.equal(primaryCalls, 0);
  w.dispose();
});

test('signal 原样透传给主路和本地', async () => {
  const controller = new AbortController();
  let seenPrimary = null;
  let seenLocal = null;
  const web = makeWeb(async (_r, s) => { seenPrimary = s; throw new Error('boom'); });
  const w = createFetchWrapper({
    web, config: cfg,
    localFetchImpl: async (_r, s) => { seenLocal = s; return LOCAL; },
  });
  await web.fetch({ url: 'https://example.com/a' }, controller.signal);
  assert.equal(seenPrimary, controller.signal);
  assert.equal(seenLocal, controller.signal);
  w.dispose();
});

test('dispose 精确还原：own property 恢复原值；原型方法恢复可见', async () => {
  const proto = { async fetch() { return 'proto-result'; } };
  const web = Object.create(proto);
  const originalOwn = undefined;
  assert.equal(Object.prototype.hasOwnProperty.call(web, 'fetch'), false);

  const w = createFetchWrapper({ web, config: cfg, localFetchImpl: async () => LOCAL });
  assert.equal(w.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(web, 'fetch'), true);
  w.dispose();
  assert.equal(Object.prototype.hasOwnProperty.call(web, 'fetch'), false);
  assert.equal(await web.fetch({ url: 'x' }), 'proto-result');

  // 已有 own fetch 的情况：dispose 后恢复那个函数本身
  const own = async () => 'own-result';
  const web2 = { fetch: own };
  const w2 = createFetchWrapper({ web2, config: cfg, localFetchImpl: async () => LOCAL });
  w2.dispose();
  assert.equal(web2.fetch, own);
  assert.equal(await web2.fetch(), 'own-result');
  void originalOwn;
});

test('重复包装幂等，不叠加', () => {
  const web = makeWeb(async () => PRIMARY);
  const first = createFetchWrapper({ web, config: cfg, localFetchImpl: async () => LOCAL });
  const second = createFetchWrapper({ web, config: cfg, localFetchImpl: async () => LOCAL });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.match(second.reason, /already wrapped/);
  first.dispose();
});

test('ctx.web 不可用 / enabled=false → apply 不崩且明确返回 disabled', () => {
  const ctx = { on() {}, logger: { info() {} } };
  const missing = apply(ctx, {});
  assert.equal(missing.enabled, false);
  const off = apply({ ...ctx, web: makeWeb(async () => PRIMARY) }, { enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.reason, 'disabled');
});

test('apply 成功包装并注册 dispose 回调', async () => {
  let disposer = null;
  const web = makeWeb(async () => PRIMARY);
  const ctx = { web, on(event, fn) { if (event === 'dispose') disposer = fn; }, logger: { info() {} } };
  const result = apply(ctx, {});
  assert.equal(result.enabled, true);
  assert.equal(typeof disposer, 'function');
  disposer();
  assert.equal(Object.prototype.hasOwnProperty.call(web, 'fetch'), true); // own 原本就有，恢复成原函数
  assert.equal(await web.fetch({ url: 'x' }), PRIMARY);
});
