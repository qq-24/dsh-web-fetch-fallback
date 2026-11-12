# dsh-web-fetch-fallback

**English** · [中文](README.zh.md)

**When the built-in `web_fetch` primary provider fails, don't end on an error — fetch the URL directly and return a successful result to the same tool.**

A host-side plugin for DeepSeek Harness (DSH). It adds no tool, changes no tool name, does not touch `fetchProvider`, and reads no private host fields. It wraps `ctx.web.fetch` once: the configured primary provider runs first, unchanged; only a failure triggers a local direct fetch.

```
web_fetch(url)
   │
   ├─ 1. call the currently configured fetchProvider (unchanged)
   │        └─ success → return its result byte-for-byte
   │
   └─ 2. throw / non-2xx / empty body
            └─ Node built-in fetch, directly → WebFetchResult
                 └─ the tool sees HTTP 200 + body, as if the primary succeeded
```

## Why

DSH 0.2.x ships `dsh-web-deepseek-api`, which uses DeepSeek's standalone **Search / Fetch API** (`POST https://api.deepseek.com/v1/tools/fetch`). It is cheap ($0.75 per 1,000 successful requests, no model round trip), but the service-side fetch returns a non-success status for some targets. Its own README states:

> A non-success status from the Fetch API indicates a fetch failure and **does not represent the target page's status**.

Measured on 2026-11-12 with `https://raw.githubusercontent.com/google-ai-edge/LiteRT-LM/v0.18.0/runtime/engine/embedding_engine_settings.cc`:

| Channel | Result |
|---|---|
| DSH `web_fetch` (primary `deepseek-fetch-api`) | `HTTP 404: failed to fetch URL`, from `/v1/tools/fetch` |
| Direct local request / via Clash proxy | **HTTP 200, 13,024 bytes**, Apache license header |
| GitHub API tags | `v0.18.0` exists |
| Same `web_fetch` against `api-docs.deepseek.com` | Success |

The URL, the network, the backend and the account balance were all fine — only the primary hop failed. This plugin closes that hop.

## How it differs from existing plugins

Several plugins address adjacent problems, but **none implements transparent failure fallback into the same built-in `web_fetch`**:

| Project | Approach | Difference |
|---|---|---|
| [GooDAnDReaDY/dsh-web-gateway](https://github.com/GooDAnDReaDY/dsh-web-gateway) | Resilient fallback chain with **separate tool names** (no registration collisions) | Not the same `web_fetch` |
| [SeaViod/dsh-plugin-deepsearch](https://github.com/SeaViod/dsh-plugin-deepsearch) | Live fallback for `web_search` between two search providers | Search only |
| [A3Boy/dsh-web-tools](https://github.com/A3Boy/dsh-web-tools), [Yurzi/dsh-tool-web-enhanced](https://github.com/Yurzi/dsh-tool-web-enhanced), [qikairo7/dsh-web-search-fetch](https://github.com/qikairo7/dsh-web-search-fetch) | Multiple providers / per-session switching / aggregation | "Pick a backend", not "fall back on failure" |
| [dsh.pub dsh-web-tools-deepseek](https://dsh.pub/en/plugins/dsh-web-tools-deepseek/) | Manually switch `fetchProvider` back to `http`, reads a **private seam field** for the fallback target | Manual switch, depends on host internals |
| `dsh-clash-tun-fix` | Replaces the fetch provider for Clash TUN fake-IP | No failure fallback |

This plugin: **transparent, same tool name, no private fields, no manual switching, works as soon as it is mounted.**

## How it works

Host contract (read from DSH 0.2.1-rc.5 sources):

- `@deepseek-ai/dsh-web/lib/index.js`: `WebRuntime.fetch(request, signal)` resolves the provider at call time from `config.fetchProvider` and returns a `WebFetchResult`.
- `@deepseek-ai/dsh-web/lib/types/types.d.ts`:
  ```ts
  WebFetchResult = { url: string, statusCode: number,
                     body: { kind: 'html' | 'text', content: string },
                     truncated: boolean }
  ```
- `@deepseek-ai/dsh-tool-web/lib/index.js:616,808-811` renders those fields.

The plugin declares `inject: ['web']` and **wraps the `ctx.web.fetch` instance method** in `apply()`:

- It does not patch the prototype (avoiding the `WeakSet` identity-gate incident between `fixed-reminder` and `memory-v4` over `LlmRuntime.prototype.streamWithRegistration`).
- It does not register a new provider: `resolveProvider` always selects the id named by `config.fetchProvider`, so a new provider would require changing that config — and an existing `- id: web` row makes a duplicate insert a known boot failure.
- On `dispose` it restores precisely: an own property is restored to its old value; a prototype method is restored by deleting the own property.

**Failure criteria:**

1. Primary throws → fall back, **except caller cancellation** (`AbortError` / `WEB_ABORTED`), which is rethrown unchanged.
2. Primary returns a non-2xx status → fall back.
3. Primary returns an empty/blank body → fall back.
4. Primary succeeds with usable content → **return it unchanged**.

The local fetch uses Node's built-in `fetch`, follows redirects manually with per-hop validation, and returns a valid `WebFetchResult`. If both paths fail, a **combined error** is thrown (primary `code` preserved, plus `primaryCode` / `localCode`), never silently swallowed.

## Install

```sh
dsh plugin --profile web add github:qq-24/dsh-web-fetch-fallback
dsh --profile web --dump-config | grep dsh-web-fetch-fallback
```

Before publishing, replace `qq-24` with your GitHub username in `package.json` (`repository` / `homepage` / `bugs`) and in the User-Agent URL inside `cordis.patch.yml`.

For local checkout development:

```sh
dsh plugin --profile web add "link:$PWD"
```

The package self-mounts through `dsh.bundle.patch` (an `- insert:` row). Restart `dsh web` after installing. **No** `fetchProvider` change and **no** environment variable needed.

## Configuration

All fields are normalized defensively; illegal or out-of-range values fall back to defaults instead of breaking startup.

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

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` leaves official behavior untouched |
| `timeoutMs` | `30000` | Total timeout for one local fetch (1000–300000) |
| `maxResponseBytes` | `5000000` | Response byte cap; overflow truncates and sets `truncated` |
| `maxBodyChars` | `100000` | Cap on decoded Unicode code points |
| `maxRedirects` | `5` | Maximum manually followed redirects |
| `fallbackOnError` | `true` | Fall back when the primary throws (cancellation excluded) |
| `fallbackOnStatus` | `true` | Fall back on non-2xx results |
| `fallbackOnEmpty` | `true` | Fall back on an empty body |
| `logFallback` | `true` | One log line per fallback (URL included, body excluded) |
| `userAgent` | see above | User-Agent for the local request |
| `proxyUrl` | `""` | Optional HTTP proxy. Empty = direct. Node's built-in fetch does not read proxy env vars; when set, the plugin tries `undici`'s `ProxyAgent` and silently falls back to direct if unavailable |
| `localOnly` | `false` | Debug: skip the primary entirely |

## Security boundary

The local fetch enforces: `http/https` only, URL length ≤ 2048, no credentials in URLs, blocked private/loopback/reserved IP literals, per-hop redirect validation, redirect cap, byte and character caps, timeout and cancellation forwarding, and rejection of explicit binary MIME types.

**Deliberate differences from the official `dsh-web-fetch-http`:**

- More permissive `content-type` handling: anything not explicitly binary is decoded as text.
- **It does not validate that DNS answers are public addresses** — Clash TUN fake-IP (`198.18.0.0/15`) environments require this; the official provider rejects them with `resolves to a non-public IP address`.
- On an untrusted network, set `proxyUrl` to a trusted egress and tighten `maxResponseBytes`.

## Verification status

| Item | Status |
|---|---|
| `node --check` on 4 production files | ✅ Pass (Node 24.19.0) |
| Unit tests | ✅ **36 / 36** (config, should-fallback, local-fetch, wrapper) |
| End-to-end: real host `DeepSeekFetchApiProvider` as primary + wrapper + real local fetch | ✅ **PASS**: primary alone → `HTTP 404 WEB_PROVIDER_ERROR`; wrapped call → `HTTP 200 / 13,024 chars` Apache header |
| Isolated DSH_HOME install (`dsh plugin add link:` + `--dump-config`) | ✅ `ADD_EXIT=0`, config tree contains `- id: dsh-web-fetch-fallback` with full config, no `entry not found` |
| Runtime acceptance in the live web profile | ⚠️ **Not done**: requires restarting `dsh web` (interrupts the session) |

Run the E2E check with `node tools/verify-e2e.mjs` (reads `DEEPSEEK_API_KEY` from `~/.dsh/.credentials.yaml`, never prints it; override with `DSH_FETCH_E2E_HOST` / `DSH_FETCH_E2E_URL`).

## Known limitations

- Handles **`web_fetch` only**, not `web_search` (a different seam operation).
- A successful primary result is returned unchanged; the plugin never "improves" it.
- If the local fetch also fails, the tool still receives an error — a combined one carrying both causes.
- Wrapping `ctx.web.fetch` is a host-internal API. If a future DSH changes that surface, the plugin **refuses to mount, logs one line, and never crashes startup** (falling back to official behavior). This is intentional.
- No retries, deduplication or caching: at most one primary attempt plus one local attempt per call.
- No progress files, no session-log writes, no telemetry, no runtime dependencies.

## Uninstall

```sh
dsh plugin --profile web remove dsh-web-fetch-fallback
```

Or remove the row from `dsh.profile.bundles` / `cordis.patch.yml` and restart DSH.

## Troubleshooting

| Symptom | Check |
|---|---|
| No effect after install | `dsh --profile web --dump-config \| grep -A12 dsh-web-fetch-fallback`; bundle changes need a `dsh web` restart |
| No `[dsh-web-fetch-fallback] wrapped ...` log | Look for `skipped (...)` / `failed to wrap ...`; the plugin gives up cleanly when `ctx.web` is unavailable |
| Fallback did not trigger | Keep `logFallback: true`; a non-2xx/empty primary result logs `primary returned unusable result` |
| Local fetch fails too | Inspect `code`: `WEB_BLOCKED_URL`, `WEB_REDIRECT_BLOCKED`, `WEB_UNSUPPORTED_CONTENT`, `WEB_ABORTED`, `WEB_PROVIDER_ERROR` |
| Clash TUN direct fetch unreachable | Set `proxyUrl: "http://127.0.0.1:7890"` (your proxy port) |

## License

MIT — see [LICENSE](LICENSE).
