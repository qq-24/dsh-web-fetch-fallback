/**
 * 端到端验证（不需要重启 DSH）：
 *  1) 直接用本地抓取器抓目标 URL，证明本机网络能拿到正文；
 *  2) 用宿主真实的 DeepSeekFetchApiProvider 作为主路，套上本插件的包装，
 *     抓同一个 URL，证明「主路失败 → 不结束 → 本地直抓 → 成功结果交回工具」。
 *
 * 用法： node tools/verify-e2e.mjs
 * 环境变量：
 *   DSH_FETCH_E2E_HOST   宿主 dsh-web-deepseek-api/lib/index.js 的绝对路径
 *   DSH_FETCH_E2E_URL    要抓的 URL（默认就是用户报告失败的那个 raw 链接）
 *   DSH_FETCH_E2E_KEY    可选；不传则从 ~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY 读取
 * 脚本不会打印任何密钥。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFetchWrapper } from '../index.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { localFetch } from '../lib/local-fetch.mjs';

const DEFAULT_URL = 'https://raw.githubusercontent.com/google-ai-edge/LiteRT-LM/v0.18.0/runtime/engine/embedding_engine_settings.cc';
const DEFAULT_HOST = 'C:/Users/mingh/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-deepseek-api/lib/index.js';
const url = process.env.DSH_FETCH_E2E_URL ?? DEFAULT_URL;
const hostPath = process.env.DSH_FETCH_E2E_HOST ?? DEFAULT_HOST;
const cfg = normalizeConfig({ timeoutMs: 25_000, maxResponseBytes: 5_000_000, maxBodyChars: 200_000 });

function resolveKey() {
  if (process.env.DSH_FETCH_E2E_KEY) return process.env.DSH_FETCH_E2E_KEY;
  const cred = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', '.credentials.yaml');
  if (!fs.existsSync(cred)) throw new Error(`凭据文件不存在: ${cred}`);
  const match = /^\s*DEEPSEEK_API_KEY:\s*(\S+)/mu.exec(fs.readFileSync(cred, 'utf8'));
  if (!match) throw new Error('凭据文件里找不到 DEEPSEEK_API_KEY');
  return match[1].trim().replace(/^["']|["']$/gu, '');
}

function assertOk(result, label) {
  if (!result || result.statusCode !== 200) throw new Error(`${label}: 非 200 (${String(result?.statusCode)})`);
  const content = result?.body?.content ?? '';
  if (!content.includes('Copyright 2026 The ODML Authors')) {
    throw new Error(`${label}: 正文不含预期的 Apache 头（长度 ${content.length}）`);
  }
  console.log(`  ${label}: HTTP ${result.statusCode}, ${content.length} chars, truncated=${result.truncated}`);
}

async function main() {
  console.log(`URL: ${url}`);

  console.log('[1] 本地直抓（真实网络）');
  const direct = await localFetch({ url }, undefined, cfg);
  assertOk(direct, 'localFetch');

  console.log('[2] 宿主真实主路 + 插件包装');
  if (!fs.existsSync(hostPath)) throw new Error(`找不到宿主 provider: ${hostPath}`);
  const host = await import(pathToFileURL(hostPath).href);
  if (typeof host.DeepSeekFetchApiProvider !== 'function') {
    throw new Error('宿主模块没有导出 DeepSeekFetchApiProvider（版本不兼容）');
  }
  const key = resolveKey();
  const primary = new host.DeepSeekFetchApiProvider(() => ({
    apiKey: key,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseURL: 'https://api.deepseek.com/v1/tools',
  }));
  console.log(`  主路 provider id=${primary.id}, available=${primary.available()}`);

  const web = { fetch: (request, signal) => primary.fetch(request, signal) };
  let fallbackLogged = false;
  const wrapper = createFetchWrapper({
    web, config: cfg,
    log: message => { if (message.includes('falling back')) fallbackLogged = true; console.log(`  [log] ${message}`); },
  });
  if (!wrapper.ok) throw new Error(`包装失败: ${wrapper.reason}`);

  let primaryFailed = null;
  try {
    const probe = await primary.fetch({ url }, undefined);
    console.log(`  主路单独探测: 成功 (HTTP ${probe.statusCode}, ${String(probe.body?.content ?? '').length} chars)`);
  } catch (error) {
    primaryFailed = error;
    console.log(`  主路单独探测: 失败 (${error?.code ?? 'Error'}: ${String(error?.message ?? error).slice(0, 120)})`);
  }

  const result = await web.fetch({ url });
  assertOk(result, 'wrapped fetch');
  if (primaryFailed) console.log(`  fallback 触发: ${fallbackLogged ? '是' : '否（日志未捕获，但结果来自本地）'}`);
  else console.log('  主路本次成功，未触发 fallback（结果为主路原文）');

  wrapper.dispose();
  console.log('PASS: 整条链可用');
}

main().catch(error => {
  console.error(`FAIL: ${error?.message ?? error}`);
  process.exitCode = 1;
});
