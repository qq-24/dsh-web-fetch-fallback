# dsh-web-fetch-fallback

[English](README.md) · **中文**

**内置的 `web_fetch` 主路失败时，不要报错结束——改用本机直抓，把成功结果还给同一个工具。**

一个 DeepSeek Harness (DSH) 宿主端插件。它不新增工具、不换工具名、不改 `fetchProvider`、不读宿主私有字段：只是把 `ctx.web.fetch` 包了一层，主路原封不动先跑，失败才降级。

```
web_fetch(url)
   │
   ├─ 1. 原样调用当前配置的 fetchProvider（"先使用这个"）
   │        └─ 成功 → 原样返回它的结果，一个字节都不改
   │
   └─ 2. 抛错 / 非 2xx / 空正文
            └─ Node 内置 fetch 本地直抓 → 按 WebFetchResult 返回
                 └─ 工具拿到 HTTP 200 + 正文，就像主路成功了一样
```

## 为什么需要它

DSH 0.2.x 的 `dsh-web-deepseek-api` 用 DeepSeek 官方 **Search / Fetch API**（`POST https://api.deepseek.com/v1/tools/fetch`）当抓取后端。它很便宜（$0.75 / 1000 次成功请求、不消耗模型 token），但**服务端抓取对部分目标会返回非成功状态**。官方随包 README 自己写明：

> Fetch API 的非成功状态表示抓取失败，**不代表目标页面的状态**。

实测（2026-11-12）：`https://raw.githubusercontent.com/google-ai-edge/LiteRT-LM/v0.18.0/runtime/engine/embedding_engine_settings.cc`

| 通道 | 结果 |
|---|---|
| DSH `web_fetch`（主路 `deepseek-fetch-api`） | `HTTP 404: failed to fetch URL`，来自 `/v1/tools/fetch` |
| 本机直连 / 走 Clash 代理 | **HTTP 200，13024 字节**，内容是 Apache License 头 |
| GitHub API 查 tag | `v0.18.0` 确实存在 |
| 同一个 `web_fetch` 抓 `api-docs.deepseek.com` | 成功 |

⇒ URL 是好的、网络是通的、后端和账户余额也是好的，只是主路这一跳失败。这个插件就是把这一跳补上。

## 和已有项目的区别

生态里已经有不少相关插件，但**没有一个精确等于"内置 `web_fetch` 透明失败降级到本地直抓"**：

| 项目 | 做法 | 差异 |
|---|---|---|
| [GooDAnDReaDY/dsh-web-gateway](https://github.com/GooDAnDReaDY/dsh-web-gateway) | resilient fallback 链，但**另起不同名字的工具**（明确 no registration collisions） | 不是同一个 `web_fetch` |
| [SeaViod/dsh-plugin-deepsearch](https://github.com/SeaViod/dsh-plugin-deepsearch) | `web_search` 在两种搜索 provider 间 live fallback | 只管 search，不管 fetch |
| [A3Boy/dsh-web-tools](https://github.com/A3Boy/dsh-web-tools)、[Yurzi/dsh-tool-web-enhanced](https://github.com/Yurzi/dsh-tool-web-enhanced)、[qikairo7/dsh-web-search-fetch](https://github.com/qikairo7/dsh-web-search-fetch) | 多 provider / 按会话切换 / 多源聚合 | 是"选一个后端"，不是"失败兜底" |
| [dsh.pub 的 dsh-web-tools-deepseek](https://dsh.pub/en/plugins/dsh-web-tools-deepseek/) | 手动把 `fetchProvider` 切回 `http`，靠**读私有 seam 字段**拿 fallback 目标 | 需手动切换、依赖宿主内部字段 |
| `dsh-clash-tun-fix`（本机自研） | 替换 fetch provider 解决 Clash TUN fake-IP | 无失败降级；沙箱实测记录过"未接管 web_fetch，保持官方行为" |

本插件的差异化：**透明、不换工具名、不读宿主私有字段、不依赖手动切换、装上即生效**。

## 工作原理

宿主契约（DSH 0.2.1-rc.5 亲读源码）：

- `@deepseek-ai/dsh-web/lib/index.js`：`WebRuntime.fetch(request, signal)` 在**调用时**按 `config.fetchProvider` 解析 provider，返回 `WebFetchResult`。
- `@deepseek-ai/dsh-web/lib/types/types.d.ts`：
  ```ts
  WebFetchResult = { url: string, statusCode: number,
                     body: { kind: 'html' | 'text', content: string },
                     truncated: boolean }
  ```
- `@deepseek-ai/dsh-tool-web/lib/index.js:616,808-811` 读上述字段渲染成 `Fetched <url> (HTTP <status>)` + 正文。

插件 `inject: ['web']`，在 `apply()` 里**包装 `ctx.web.fetch` 这个实例方法**：

- 不动原型（避开 `fixed-reminder` / `memory-v4` 抢 `LlmRuntime.prototype.streamWithRegistration` 的 WeakSet 身份门事故）；
- 不注册新 provider —— 因为 `resolveProvider` 固定选 `config.fetchProvider` 指定的 id，注册新 provider 就必须改配置，而用户现有 `cordis.patch.yml` 已有 `- id: web`，重复 insert 同 id 有崩 boot 的历史血案；
- `dispose` 时精确还原：原本是 own property 就恢复原值，原本是原型方法就 `delete` own property 让原型恢复。

**失败判据**（主路成功但结果不可用也降级）：

1. 主路抛错 → 降级；但**调用方取消**（`AbortError` / `WEB_ABORTED`）原样抛出，不偷偷换成另一次网络请求；
2. 主路返回 `statusCode` 非 2xx → 降级；
3. 主路返回空/空白正文 → 降级；
4. 主路成功且可用 → **原样返回，绝不改写**。

本地直抓用 Node 内置 `fetch`，手动跟随重定向、逐跳校验，按 `WebFetchResult` 契约返回。主路与本地都失败时，抛一个**合并错误**（保留主路 `code`，附带 `primaryCode` / `localCode` 两个子码），绝不静默吞掉。

## 安装

```sh
dsh plugin --profile web add github:qq-24/dsh-web-fetch-fallback
dsh --profile web --dump-config | grep dsh-web-fetch-fallback
```

发布前把 `qq-24` 换成你自己的 GitHub 用户名（同时改 `package.json` 的 `repository` / `homepage` / `bugs` 与 `cordis.patch.yml` 里的 User-Agent 链接）。

本地 checkout 开发：

```sh
dsh plugin --profile web add "link:$PWD"
```

插件是 `dsh.bundle.patch` 自挂载（`- insert:` 一行），装完重启 `dsh web` 即生效。**不需要**改 `fetchProvider`、不需要设环境变量。

## 配置

写在插件行里（patch 层的 `config:` 会整体替换整个对象，要覆盖就列全字段）：

```yaml
- id: dsh-web-fetch-fallback
  config:
    enabled: true
    timeoutMs: 30000
    maxResponseBytes: 5000000
    maxBodyChars: 100000
    maxRedirects: 5
    fallbackOnError: true
    fallbackOnStatus: true
    fallbackOnEmpty: true
    logFallback: true
    userAgent: "dsh-web-fetch-fallback/1.0"
    proxyUrl: ""
    localOnly: false
```

| 字段 | 默认值 | 作用 |
|---|---|---|
| `enabled` | `true` | `false` 完全不包装，回官方行为 |
| `timeoutMs` | `30000` | 本地直抓单次总超时（1000–300000） |
| `maxResponseBytes` | `5000000` | 响应字节上限，超出截断并置 `truncated` |
| `maxBodyChars` | `100000` | 解码后按 Unicode 码点截断 |
| `maxRedirects` | `5` | 手动跟随重定向的最大跳数 |
| `fallbackOnError` | `true` | 主路抛错时降级（取消除外） |
| `fallbackOnStatus` | `true` | 主路返回非 2xx 时降级 |
| `fallbackOnEmpty` | `true` | 主路返回空正文时降级 |
| `logFallback` | `true` | 每次降级打一行日志（含 URL，不含正文） |
| `userAgent` | 见上 | 本地直抓的 User-Agent |
| `proxyUrl` | `""` | 可选 HTTP 代理；留空=直连（Node 内置 fetch 不自动读环境变量代理）。设置时尝试 `undici` 的 `ProxyAgent`，解析不到就直连，绝不因代理缺失让抓取失败 |
| `localOnly` | `false` | 调试用：跳过主路，直接本地抓 |

所有非法/越界值都会静默回落默认值，绝不让一个拼错的配置把插件挂死。

## 安全边界

本地直抓实现了一套有界防护：只允许 `http/https`、URL 长度 ≤ 2048、拒绝 URL 内嵌凭据、拒绝私网/回环/保留 IP 字面量、逐跳复核重定向、跳数上限、字节与字符双上限、超时与取消透传、明确的二进制 MIME 拒绝。

**与官方 `dsh-web-fetch-http` 的差异（诚实标注）**：

- 本插件对 `content-type` 更宽容：除明确二进制 MIME 外一律按文本解码；
- **不校验 DNS 解析结果是否为公网地址** —— Clash TUN fake-IP（`198.18.0.0/15`）环境需要这样，官方 provider 在这种环境会报 `resolves to a non-public IP address`；
- 若你处在不可信网络，请用 `proxyUrl` 指向可信出口，并按需收紧 `maxResponseBytes`。

## 验证状态

| 项目 | 状态 |
|---|---|
| `node --check` 4 个生产文件 | ✅ 全过（Node 24.19.0） |
| 单元测试 | ✅ **36 / 36**（config / should-fallback / local-fetch / wrapper 四组） |
| 端到端：宿主真实 `DeepSeekFetchApiProvider` 作主路 + 包装 + 真实本地直抓 | ✅ **PASS**：主路单独探测 `HTTP 404 WEB_PROVIDER_ERROR`；包装后自动降级，返回 `HTTP 200 / 13024 chars` Apache 头 |
| 隔离 DSH_HOME 安装（`dsh plugin add link:` + `--dump-config`） | ✅ `ADD_EXIT=0`，配置树出现 `- id: dsh-web-fetch-fallback` 与完整 config，无 `entry not found` |
| 现役 web profile 运行时验收 | ⚠️ **未做**：需重启 `dsh web`（会打断当前会话），由你决定何时重启 |

端到端验证脚本：`node tools/verify-e2e.mjs`（从 `~/.dsh/.credentials.yaml` 读 `DEEPSEEK_API_KEY`，不打印密钥；可用 `DSH_FETCH_E2E_HOST` / `DSH_FETCH_E2E_URL` 覆盖）。

## 已知限制

- **只处理 `web_fetch`**（fetch seam），不处理 `web_search`。搜索走 Search API，是另一条链。
- 主路成功就原样返回；插件**不会**为了"更好"去改写主路结果。
- 本地直抓也失败时，工具仍会收到错误（合并错误），只是错误信息同时包含主路与本地的原因。
- 包装 `ctx.web.fetch` 实例方法属于宿主内部 API；DSH 大版本升级若改变这个调用面，插件会**拒绝挂载并只打一行日志、绝不崩启动**（降级回官方行为）。这是刻意的失败策略。
- 不重试、不去重、不做缓存；一次 `web_fetch` 最多主路 1 次 + 本地 1 次。
- 不修改 `progress.md`、不写会话日志、不发遥测、不引入任何运行时依赖。

## 卸载

```sh
dsh plugin --profile web remove dsh-web-fetch-fallback
```

或从 profile 的 `dsh.profile.bundles` 与 `cordis.patch.yml` 里删掉对应行，重启 DSH。

## 排障

| 症状 | 检查 |
|---|---|
| 装了没生效 | `dsh --profile web --dump-config \| grep -A12 dsh-web-fetch-fallback` 看条目在不在；bundle 层改动**需要重启** `dsh web` |
| stdout 里没有 `[dsh-web-fetch-fallback] wrapped ...` | 看有没有 `skipped (...)` 或 `failed to wrap ...` 日志；`ctx.web` 不可用时插件会主动放弃而不是崩启动 |
| 降级没触发 | 确认 `logFallback: true`；主路成功但返回非 2xx/空正文时日志会写 `primary returned unusable result` |
| 本地直抓也失败 | 看错误 `code`：`WEB_BLOCKED_URL`（URL 被安全策略拒）、`WEB_REDIRECT_BLOCKED`、`WEB_UNSUPPORTED_CONTENT`、`WEB_ABORTED`、`WEB_PROVIDER_ERROR`（网络层） |
| Clash TUN 环境下本地直抓不通 | 设 `proxyUrl: "http://127.0.0.1:7890"`（按你的代理端口） |

## 许可证

MIT — 见 [LICENSE](LICENSE)。
