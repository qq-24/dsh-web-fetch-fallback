# dsh-web-fetch-fallback

[English](README.en.md)

**内置的 `web_fetch` 主路失败时，不报错结束——改用本机直抓，把成功结果还给同一个工具。**

一个 DeepSeek Harness (DSH) 宿主端插件。它不新增工具、不换工具名、不改 `fetchProvider`、不读宿主私有字段：只是把 `ctx.web.fetch` 包了一层，主路原封不动先跑，失败才降级。

```
web_fetch(url)
   │
   ├─ 1. 原样调用当前配置的 fetchProvider
   │        └─ 成功 → 原样返回它的结果，一个字节都不改
   │
   └─ 2. 抛错 / 非 2xx / 空正文
            └─ Node 内置 fetch 本机直抓 → 按 WebFetchResult 返回
                 └─ 工具拿到 HTTP 200 + 正文，就像主路成功了一样
```

## 它解决什么

DSH 0.2.x 可以用 DeepSeek 官方 Search / Fetch API 作为抓取后端。这类服务端抓取有一个特点：官方随包文档明确写「Fetch API 的非成功状态表示抓取失败，不代表目标页面的状态」。也就是说，目标 URL 本身完全正常、网络也通，主路这一跳仍可能返回失败状态，内置 `web_fetch` 就直接结束了。

这个插件在主路失败时补一次本机直抓，把成功结果交回同一个工具。它不替换主路：主路成功时结果原样返回。

## 工作原理

宿主接口（`dsh-web` / `dsh-tool-web`）：

- `WebRuntime.fetch(request, signal)` 在调用时按 `config.fetchProvider` 解析后端，返回 `WebFetchResult`；
- `WebFetchResult = { url, statusCode, body: { kind: 'html' | 'text', content }, truncated }`；
- `dsh-tool-web` 按这些字段渲染成 `Fetched <url> (HTTP <status>)` + 正文。

插件声明 `inject: ['web']`，在 `apply()` 里**包装 `ctx.web.fetch` 实例方法**：

- 不动原型；
- 不注册新 provider —— `resolveProvider` 固定选 `config.fetchProvider` 指定的 id，注册新 provider 就必须改配置；
- `dispose` 时精确还原（原本是原型方法就删掉 own property 让原型恢复）；
- 主路成功且可用 → **原样返回，绝不改写**。

**失败判据**：

1. 主路抛错 → 降级；但调用方取消（`AbortError` / `WEB_ABORTED`）原样抛出，不偷偷换成另一次网络请求；
2. 主路返回非 2xx → 降级；
3. 主路返回空/空白正文 → 降级。

本地直抓用 Node 内置 `fetch`，手动跟随重定向、逐跳校验，按同一契约返回。两条路都失败时抛一个**合并错误**（保留主路 `code`，附带 `primaryCode` / `localCode`），绝不静默吞掉。

## 安装

```sh
dsh plugin --profile web add github:qq-24/dsh-web-fetch-fallback
dsh --profile web --dump-config | grep dsh-web-fetch-fallback
```

本地 checkout 开发：

```sh
dsh plugin --profile web add "link:$PWD"
```

插件通过 `dsh.bundle.patch` 自挂载（`- insert:` 一行），安装后重启 DSH 生效。**不需要**改 `fetchProvider`，不需要设环境变量。

## 配置

写在插件行里。patch 层的 `config:` 会整体替换整个对象，要覆盖就列全字段：

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
| `proxyUrl` | `""` | 可选 HTTP 代理；留空=直连。Node 内置 fetch 不自动读环境变量代理；设置时尝试 `undici` 的 `ProxyAgent`，解析不到就直连，绝不因代理缺失让抓取失败 |
| `localOnly` | `false` | 调试用：跳过主路，直接本地抓 |

所有非法/越界值都会静默回落默认值，绝不让一个拼错的配置把插件挂死。

## 安全边界

本地直抓实现了一套有界防护：只允许 `http/https`、URL 长度 ≤ 2048、拒绝 URL 内嵌凭据、拒绝私网/回环/保留 IP 字面量、逐跳复核重定向、跳数上限、字节与字符双上限、超时与取消透传、明确的二进制 MIME 拒绝。

**与官方 `dsh-web-fetch-http` 的差异**：

- 对 `content-type` 更宽容：除明确二进制 MIME 外一律按文本解码；
- 不校验 DNS 解析结果是否为公网地址 —— Clash TUN fake-IP（`198.18.0.0/15`）环境需要这样，官方 provider 在这种环境会报 `resolves to a non-public IP address`；
- 在不可信网络中，请用 `proxyUrl` 指向可信出口，并按需收紧 `maxResponseBytes`。

## 已知限制

- **只处理 `web_fetch`**，不处理 `web_search`（另一条 seam 操作）。
- 主路成功就原样返回；插件不会为了"更好"去改写主路结果。
- 本地直抓也失败时，工具仍会收到错误（合并错误，同时包含主路与本地的原因）。
- 包装 `ctx.web.fetch` 实例方法属于宿主内部接口；DSH 大版本升级若改变这个调用面，插件会**拒绝挂载、只打一行日志、绝不崩启动**（降级回官方行为）。
- 不重试、不去重、不做缓存：一次 `web_fetch` 最多主路 1 次 + 本地 1 次。
- 不写会话日志、不发遥测、零运行时依赖。

## 卸载

```sh
dsh plugin --profile web remove dsh-web-fetch-fallback
```

或从 profile 的 `dsh.profile.bundles` 与 `cordis.patch.yml` 里删掉对应行，重启 DSH。

## 排障

| 症状 | 检查 |
|---|---|
| 装了没生效 | `dsh --profile web --dump-config \| grep -A12 dsh-web-fetch-fallback` 看条目在不在；bundle 层改动需要重启 DSH |
| 没有 `[dsh-web-fetch-fallback] wrapped ...` 日志 | 看有没有 `skipped (...)` 或 `failed to wrap ...`；`ctx.web` 不可用时插件会主动放弃而不是崩启动 |
| 降级没触发 | 确认 `logFallback: true`；主路成功但返回非 2xx/空正文时日志会写 `primary returned unusable result` |
| 本地直抓也失败 | 看错误 `code`：`WEB_BLOCKED_URL`、`WEB_REDIRECT_BLOCKED`、`WEB_UNSUPPORTED_CONTENT`、`WEB_ABORTED`、`WEB_PROVIDER_ERROR` |
| Clash TUN 环境下直抓不通 | 设 `proxyUrl: "http://127.0.0.1:7890"`（按你的代理端口） |

## 许可证

MIT — 见 [LICENSE](LICENSE)。
