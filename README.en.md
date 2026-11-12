# dsh-web-fetch-fallback

**English** · [中文](README.md)

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

## What it solves

DSH 0.2.x can use DeepSeek's standalone Search / Fetch API as its fetch backend. Service-side fetching has one property that its own bundled README states explicitly: a non-success status from the Fetch API indicates a fetch failure and **does not represent the target page's status**. In other words, the target URL can be perfectly valid and the network perfectly healthy, yet the primary hop still returns a failure and the built-in `web_fetch` simply ends on it.

This plugin adds one local direct fetch when that happens and hands the successful result back to the same tool. It does not replace the primary: a successful primary result is returned unchanged.

## How it works

Host interfaces (`dsh-web` / `dsh-tool-web`):

- `WebRuntime.fetch(request, signal)` resolves the backend from `config.fetchProvider` at call time and returns a `WebFetchResult`;
- `WebFetchResult = { url, statusCode, body: { kind: 'html' | 'text', content }, truncated }`;
- `dsh-tool-web` renders those fields as `Fetched <url> (HTTP <status>)` plus the body.

The plugin declares `inject: ['web']` and **wraps the `ctx.web.fetch` instance method** in `apply()`:

- It does not patch the prototype.
- It does not register a new provider — `resolveProvider` always selects the id named by `config.fetchProvider`, so a new provider would require changing that config.
- On `dispose` it restores precisely (a prototype method is restored by deleting the own property).
- A successful, usable primary result is **returned unchanged**.

**Failure criteria:**

1. Primary throws → fall back, **except caller cancellation** (`AbortError` / `WEB_ABORTED`), which is rethrown unchanged.
2. Primary returns a non-2xx status → fall back.
3. Primary returns an empty/blank body → fall back.

The local fetch uses Node's built-in `fetch`, follows redirects manually with per-hop validation, and returns the same contract. If both paths fail, a **combined error** is thrown (primary `code` preserved, plus `primaryCode` / `localCode`), never silently swallowed.

## Install

```sh
dsh plugin --profile web add github:qq-24/dsh-web-fetch-fallback
dsh --profile web --dump-config | grep dsh-web-fetch-fallback
```

For local checkout development:

```sh
dsh plugin --profile web add "link:$PWD"
```

The package self-mounts through `dsh.bundle.patch` (an `- insert:` row). Restart DSH after installing. **No** `fetchProvider` change and **no** environment variable needed.

## Configuration

All fields are normalized defensively; illegal or out-of-range values fall back to defaults instead of breaking startup. The patch layer replaces the whole `config:` object, so list every field when overriding.

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
- It does not validate that DNS answers are public addresses — Clash TUN fake-IP (`198.18.0.0/15`) environments require this; the official provider rejects them with `resolves to a non-public IP address`.
- On an untrusted network, set `proxyUrl` to a trusted egress and tighten `maxResponseBytes`.

## Known limitations

- Handles **`web_fetch` only**, not `web_search` (a different seam operation).
- A successful primary result is returned unchanged; the plugin never "improves" it.
- If the local fetch also fails, the tool still receives an error — a combined one carrying both causes.
- Wrapping `ctx.web.fetch` is a host-internal interface. If a future DSH changes that surface, the plugin **refuses to mount, logs one line, and never crashes startup** (falling back to official behavior).
- No retries, deduplication or caching: at most one primary attempt plus one local attempt per call.
- No session-log writes, no telemetry, no runtime dependencies.

## Uninstall

```sh
dsh plugin --profile web remove dsh-web-fetch-fallback
```

Or remove the row from `dsh.profile.bundles` / `cordis.patch.yml` and restart DSH.

## Troubleshooting

| Symptom | Check |
|---|---|
| No effect after install | `dsh --profile web --dump-config \| grep -A12 dsh-web-fetch-fallback`; bundle changes need a DSH restart |
| No `[dsh-web-fetch-fallback] wrapped ...` log | Look for `skipped (...)` / `failed to wrap ...`; the plugin gives up cleanly when `ctx.web` is unavailable |
| Fallback did not trigger | Keep `logFallback: true`; a non-2xx/empty primary result logs `primary returned unusable result` |
| Local fetch fails too | Inspect `code`: `WEB_BLOCKED_URL`, `WEB_REDIRECT_BLOCKED`, `WEB_UNSUPPORTED_CONTENT`, `WEB_ABORTED`, `WEB_PROVIDER_ERROR` |
| Clash TUN direct fetch unreachable | Set `proxyUrl: "http://127.0.0.1:7890"` (your proxy port) |

## License

MIT — see [LICENSE](LICENSE).
