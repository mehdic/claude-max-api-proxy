# claude-proxy

**Use your Claude Pro / Max subscription with any OpenAI-compatible client.** No API keys, no per-token billing, no separate Anthropic account.

This proxy wraps the official `claude` CLI as a subprocess and exposes an OpenAI-compatible HTTP API on `127.0.0.1:3456`. Any tool that speaks the OpenAI `chat/completions` or minimal `responses` format — [openclaw](https://github.com/openclaw/openclaw), Continue.dev, Aider, OpenWebUI, custom agents, OpenAI SDK clients, anything — can point at it and route traffic through your existing Claude subscription's OAuth tokens.

Current release: **v1.0.4**. The production path is the persistent `stream-json` runtime with pre-initialized workers, session pooling, SSE keepalives, usage/cost reporting, caller-dispatched OpenAI/OpenClaw tool calls, optional MCP injection, minimal Responses compatibility, model-drift tests, and live soak coverage.

> **Tested with openclaw `2026.4.24`** as a drop-in `openai-completions` provider. Multi-turn cache hits, streaming, and the SSE keepalive have all been verified against live openclaw traffic on this version. See [openclaw integration](#openclaw) below for the exact provider config.

## Why this exists

| Approach | Cost | Limitation |
|----------|------|------------|
| Anthropic API directly | ~$15 / M input, ~$75 / M output | Pay per call |
| Claude Pro / Max | $20–200 / mo flat | OAuth tokens blocked from third-party API clients |
| **claude-proxy** | $0 extra (uses your subscription) | Routes through the local `claude` CLI |

Anthropic blocks OAuth tokens from being used directly with third-party API clients. The Claude Code CLI (`claude`) *can* use OAuth tokens. This proxy bridges the gap.

## How it works

```
Your tool (Continue.dev, Aider, your agent, …)
       │  HTTP, OpenAI chat/completions or responses format
       ▼
claude-proxy   (this project, listens on :3456)
       │  spawns subprocess
       ▼
claude --print …       (the official Claude Code CLI)
       │  OAuth from your Pro / Max subscription
       ▼
Anthropic API
       │  response
       ▼
       converted back to OpenAI format → your tool
```

The proxy itself does **not** store prompts, conversation history, OAuth tokens, or API keys. In `stream-json` mode it may keep a live Claude subprocess warm for a bounded session-pool window so follow-up turns can benefit from Claude's prompt cache; durable conversation history still belongs to the caller, which sends the OpenAI `messages` array each turn.

## Prerequisites

1. **Active Claude Pro or Max subscription** ([claude.ai](https://claude.ai))
2. **Claude Code CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```
3. **Node.js ≥ 20**

## Install & run

```bash
git clone https://github.com/mehdic/openclaw-claude-proxy.git
cd claude-proxy
npm install
npm run build
node dist/server/standalone.js
```

The server listens on `127.0.0.1:3456` by default. Override the port either way:

```bash
node dist/server/standalone.js 3458              # CLI arg
CLAUDE_PROXY_PORT=3458 node dist/server/standalone.js   # env var
```

CLI arg wins if both are set. Point your client at the chosen port:

```bash
curl -s http://127.0.0.1:3456/health
# {"status":"ok",...}

curl -s -X POST http://127.0.0.1:3456/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-opus-4-7","messages":[{"role":"user","content":"Reply OK only."}]}'
```

> Chat routes are mounted at both `/chat/completions` and `/v1/chat/completions`; Responses routes are mounted at both `/responses` and `/v1/responses` for compatibility with clients that prepend `/v1` themselves and ones that don't.

## Current implementation

Implemented in the current release:

- OpenAI-compatible Chat Completions with streaming/non-streaming support.
- Practical OpenAI Responses API compatibility on the same selected runtime as chat completions (`stream-json` by default, `print` fallback/override), with string/array input, `instructions`, usage/cost annotations, caller-dispatched `function_call` output items, and streaming lifecycle events.
- Persistent `stream-json` Claude runtime by default, plus `--print` fallback mode.
- Init-pool and session-pool for lower cold/warm latency and better prompt-cache behavior.
- Runtime override and fallback controls for debugging and incident response.
- SSE keepalives for OpenAI-compatible clients with strict idle timeouts.
- Claude usage/cache metadata mapped into OpenAI-ish usage fields and simulated Anthropic API-equivalent cost estimates.
- `/health`, `/healthz/deep`, `/metrics`, `/models`, `/pricing`, `/traces` and `/v1` aliases where relevant.
- Caller-dispatched OpenAI/OpenClaw tool bridge: the proxy emits OpenAI `tool_calls` and lets the caller execute tools under its own approval/audit/allowlist system.
- Optional inner Claude MCP injection via `CLAUDE_PROXY_TOOLS_TRANSLATION=1` with allow/deny governance policy (`CLAUDE_PROXY_MCP_ALLOW`, `CLAUDE_PROXY_MCP_DENY`).
- **Request tracing** — every request gets a stable `trace_id` returned in `X-Claude-Proxy-Trace-Id`. Optional bounded in-memory trace store (`CLAUDE_PROXY_TRACE_ENABLED=1`) with localhost-gated `GET /traces` and `GET /traces/:id` endpoints for debugging tool bridge, MCP governance decisions, error classification, and session pooling. Optional SQLite persistence supports retention via `CLAUDE_PROXY_TRACE_SQLITE_RETENTION_DAYS`; see [`docs/TRACE_SECURITY.md`](docs/TRACE_SECURITY.md).
- **Protocol error classification** — explicit bounded `ProtocolErrorClass` taxonomy replaces ad-hoc string matching. All errors map to one of ~15 fixed labels safe for Prometheus and trace records.
- Model drift tests, live soak scripts, SDK/client matrix, failure simulation, stream-json canary, and lightweight live monitor.

Planned work is tracked in [`docs/OCTO_FEATURE_PLAN.md`](docs/OCTO_FEATURE_PLAN.md).

## Available models

The proxy passes the model id straight through to `claude --model`:

| Model ID                          | What it is             |
|-----------------------------------|------------------------|
| `claude-opus-4-7`                 | Opus 4.7               |
| `claude-opus-4-6`                 | Opus 4.6               |
| `claude-sonnet-4-6`               | Sonnet 4.6             |
| `claude-haiku-4-5-20251001`       | Haiku 4.5              |
| `claude-opus-4`, `claude-sonnet-4`, `claude-haiku-4` | Aliases for prior generation |

`GET /models` (or `/v1/models`) returns the live list.

## Runtime modes

Two subprocess strategies. **`stream-json` is the production default;** `--print` is the incident-response escape hatch.

### `stream-json` mode (default)

Set `CLAUDE_PROXY_RUNTIME=stream-json` (or leave unset — it's the default). The proxy uses a persistent NDJSON transport (`claude --input-format stream-json`) and a session pool, so one subprocess survives across multiple turns of the same conversation:

- **Conversation history caches turn-to-turn.** Empirical: a 3-turn chat went from `cache_read=0` (turn 1) → `cache_read=70K` (turn 2) → `cache_read=70K` (turn 3) — ~99.9% of input tokens served from Anthropic's prompt cache.
- **Warm latency drops from ~5s to ~1.6s** because the next turn skips the spawn + handshake.
- **Cold turns are also faster** (~2.9s) because the proxy keeps a per-model pre-initialized "init pool" — the 5s init handshake happens once at startup, not per request.
- **3-layer keepalive/progress** (eager handshake → visible truthful progress → periodic SSE comment) keeps HTTP/SSE transports warm without fabricating invisible assistant text. When real progress is available, the proxy emits explicit bracketed visible chunks such as `[progress: using Bash…]`, `[progress: waiting for Bash, 12s…]`, or `[n8n: workflow · 9s elapsed · exec 73]`. Generic idle keepalives remain transport-only SSE comments.

### `--print` mode (fallback)

Set `CLAUDE_PROXY_RUNTIME=print`. Each request spawns a fresh `claude --print` subprocess. Higher latency (~5s/request, no warm pool), but **bulletproof**: zero session state, zero pool fingerprint drift, zero stream parser surface area. Flip here when stream-json regresses upstream — CLI flag rename, JSON shape change, transport bug.

The fallback path is also the target of the optional `CLAUDE_PROXY_FALLBACK_ON_STREAM_FAILURE=1` opt-in: when set, a request that hits a recognized stream-layer fault (worker died before first token, init handshake timeout, spawn ENOENT, etc.) before any SSE bytes have been committed retries on `--print` once. Real model errors (rate limit, auth, content policy) are NOT subject to fallback — they reach the client unchanged.

Active in both modes:
- Cache stats surfaced in `usage.prompt_tokens_details.cached_tokens` so you can see Anthropic's prompt cache fire.
- Optional `--exclude-dynamic-system-prompt-sections` support is capability-checked against `claude --help` before the proxy passes the flag, so CLI releases that remove/rename it do not break startup.

### Flipping modes

```bash
# default (stream-json)
node dist/server/standalone.js

# explicit print mode
CLAUDE_PROXY_RUNTIME=print node dist/server/standalone.js

# allow per-request override via header (off by default)
CLAUDE_PROXY_ALLOW_RUNTIME_OVERRIDE=1 node dist/server/standalone.js
# then:
curl -H 'X-Claude-Proxy-Runtime: print' …
```

### Environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `CLAUDE_PROXY_PORT` | `3456` | Port to listen on. CLI arg (`node standalone.js 3458`) takes precedence if also given. |
| `CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS` | unset | `true` to pass `--dangerously-skip-permissions` to `claude`. Required for headless / LaunchAgent operation since there's no TTY for permission prompts. |
| `CLAUDE_PROXY_RUNTIME` | `stream-json` | `stream-json` (default) or `print`. Picks the subprocess strategy. See "Runtime modes" above. |
| `CLAUDE_PROXY_STREAM_JSON` | unset | Legacy alias. `0` forces print mode for backward compatibility with older LaunchAgent envs. Prefer `CLAUDE_PROXY_RUNTIME`. |
| `CLAUDE_PROXY_ALLOW_RUNTIME_OVERRIDE` | unset | `1` to honor `X-Claude-Proxy-Runtime: print\|stream-json` request header for per-call debugging. Off by default. |
| `CLAUDE_PROXY_FALLBACK_ON_STREAM_FAILURE` | unset (off) | `1` to retry on `--print` once when stream-json hits a recognized stream-layer fault before any SSE bytes are committed. |
| `CLAUDE_PROXY_PREWARM_MODELS` | `claude-opus-4-7,claude-sonnet-4-6,claude-haiku-4-5-20251001` | Comma-separated model ids to pre-initialize at boot (stream-json mode only). |
| `CLAUDE_PROXY_INIT_POOL` | unset (on) | `0` to disable the per-model init pool (stream-json mode only). |
| `CLAUDE_PROXY_POOL_TTL_MS` | `600000` (10 min) | Idle TTL for session-pool workers. Floored at 360_000 (6 min) so we never evict mid-Anthropic-cache-window. |
| `CLAUDE_PROXY_POOL_MAX` | `4` | Max concurrent live workers in the session pool. LRU evicts oldest when adding past cap. |
| `CLAUDE_PROXY_N8N_API_URL` | unset | Optional. e.g. `http://n8n.example.com:5678/api/v1`. When this and the API key are both set, the proxy enriches keepalive chunks with real workflow progress from n8n during long Bash-curl-to-webhook calls (see "n8n-aware keepalive" below). |
| `CLAUDE_PROXY_N8N_API_KEY` | unset | Optional. n8n API key (Settings → n8n API in n8n UI). Required alongside `CLAUDE_PROXY_N8N_API_URL`. |
| `CLAUDE_PROXY_N8N_DETECTION_PATTERN` | `n8n.*\/webhook\/` | Optional regex (case-insensitive). Matched against claude's tool input to decide when an n8n call is in flight. Override if your webhook URLs don't contain "n8n". |
| `CLAUDE_PROXY_TOOLS_TRANSLATION` | unset (off) | `1` to register openclaw-known MCP servers with the inner claude CLI via `--mcp-config` injection. Currently registers `n8n` if `CLAUDE_PROXY_N8N_API_URL` + `CLAUDE_PROXY_N8N_API_KEY` are set. The inner claude exposes them as `mcp__n8n__<tool>`. **Trade-off:** claude executes these tools internally — openclaw's audit / approval / per-agent allowlist do NOT see the calls. See "Tools translation modes" below. |
| `CLAUDE_PROXY_N8N_MCP_BIN` | `n8n-mcp` | Override the path to the `n8n-mcp` binary if not at the default nvm location. |
| `CLAUDE_PROXY_TRACE_ENABLED` | unset (off) | `1` to enable the bounded in-memory trace store. Traces are accessible via `GET /traces` and `GET /traces/:id` (localhost-only). |
| `CLAUDE_PROXY_TRACE_CAPACITY` | `200` | Max traces kept in memory. LRU eviction when capacity is exceeded. |
| `CLAUDE_PROXY_TRACE_TTL_MS` | `3600000` (1 hour) | TTL per trace in milliseconds. Expired traces are evicted on access. Floor: 60,000 (1 min). |
| `CLAUDE_PROXY_TRACE_SQLITE_PATH` | unset (off) | Optional durable local SQLite trace log. Stores redacted trace metadata/JSON in a `traces` table. Setting this also enables trace collection. |
| `CLAUDE_PROXY_TRACE_SQLITE_RETENTION_DAYS` | unset (forever) | Optional durable trace retention window in days. Old rows are pruned after completed trace inserts. |
| `CLAUDE_PROXY_TRACE_SQLITE_RETENTION_MS` | unset (forever) | Optional retention override in milliseconds; used if days is unset. |
| `CLAUDE_PROXY_TRACE_SQLITE_DEBUG` | unset | `1` to log SQLite persistence failures. User requests never fail because durable trace persistence failed. |
| `CLAUDE_PROXY_EXCLUDE_DYNAMIC_SYSTEM_PROMPT_SECTIONS` | unset | `1` to request Claude CLI `--exclude-dynamic-system-prompt-sections`; the proxy first checks `claude --help` and skips the flag if unsupported. |
| `CLAUDE_PROXY_MCP_ALLOW` | unset (all) | Comma-separated list of MCP server names to allow for injection. If set, only listed servers are injected. |
| `CLAUDE_PROXY_MCP_DENY` | unset (none) | Comma-separated list of MCP server names to deny. Takes precedence over allow. |

#### Caveats

- The stream-json input protocol is **officially undocumented** — Anthropic [issue #24594](https://github.com/anthropics/claude-code/issues/24594) closed as not-planned. The implementation is reverse-engineered from the public Python Agent SDK. The shape may shift between `claude` CLI releases. That's why this mode is opt-in.
- The session-pool keys conversations by `hash(model, system + user messages)`. Assistant content is excluded from the hash because the live subprocess remembers what it actually said and incoming history may differ in punctuation. Idle subprocesses are evicted after 6 minutes (~1 min past Anthropic's 5-min cache TTL).

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Cheap liveness probe — process up + port bound, Claude CLI version/capability flags, pool, trace, and MCP governance summary. |
| `/healthz/deep` | GET | Real probe — spawns a `claude --print` with a trivial prompt + 5s budget. Returns `200 {ok, latency_ms, runtime, pool, last_success_ts}` on success, `503 {ok: false, error, …}` on failure. Use for watchdogs. |
| `/metrics` | GET | Prometheus exposition. See "Metrics" below. |
| `/models`, `/v1/models` | GET | List served model ids |
| `/chat/completions`, `/v1/chat/completions` | POST | OpenAI chat completion. Supports `stream: true` for SSE |
| `/responses`, `/v1/responses` | POST | Practical OpenAI Responses API compatibility. Uses the selected runtime (`stream-json` by default), supports string/array `input`, `instructions`, usage/cost annotations, caller-dispatched `function_call` output items, and streaming Responses SSE events |
| `/traces` | GET | List recent traces (summary). Localhost-only. Query: `?limit=50&offset=0`. Requires `CLAUDE_PROXY_TRACE_ENABLED=1`. |
| `/traces/:id` | GET | Get full trace record by trace ID. Localhost-only. Requires `CLAUDE_PROXY_TRACE_ENABLED=1`. |

## Live monitoring

`npm run monitor:live` performs a lightweight production check: `/health` plus one tiny Chat Completions request. It exits non-zero on failure. For operator alerting, set `CLAUDE_PROXY_MONITOR_ALERT_COMMAND`; the command receives the alert body on stdin and in `CLAUDE_PROXY_MONITOR_MESSAGE`. Example:

```bash
CLAUDE_PROXY_MONITOR_ALERT_COMMAND="/path/to/notify-operator.sh \"$CLAUDE_PROXY_MONITOR_MESSAGE\"" \
  npm run monitor:live
```

Other knobs: `CLAUDE_PROXY_MONITOR_BASE_URL`, `CLAUDE_PROXY_MONITOR_MODEL`, `CLAUDE_PROXY_MONITOR_TIMEOUT_MS`.


### Metrics

`/metrics` exposes (cardinality-bounded):

- `claude_proxy_requests_total{runtime,model,status}`
- `claude_proxy_request_duration_seconds{runtime,model,status}` — histogram, 100 ms → 2 min buckets
- `claude_proxy_stream_fallback_total{reason}`
- `claude_proxy_pool_size{state="live"|"max"}` — gauge
- `claude_proxy_pool_ttl_evictions_total`
- `claude_proxy_pool_lru_evictions_total`
- `claude_proxy_pool_fingerprint_mismatches_total`
- `claude_proxy_pool_warm_hits_total`, `_cold_spawns_total`
- `claude_proxy_subprocess_spawn_failures_total{runtime}`
- `claude_proxy_runtime_default{runtime}` — gauge, 0/1
- `claude_proxy_error_class_total{class}` — errors by protocol error class (bounded taxonomy)
- `claude_proxy_tool_call_parse_total{outcome}` — tool call parse success/failure/calls_emitted
- `claude_proxy_trace_store_size{state}` — trace store occupancy gauge
- `claude_proxy_trace_store_enabled` — 1 if tracing is on

The `model` label is canonicalized to a fixed set; unknown ids collapse to `other`. Error classes and fallback reasons come from fixed bounded allowlists. No per-request labels.

### Live soak / smoke

Bounded live checks are available but intentionally separate from unit tests:

```bash
npm run soak:quick   # concurrency=1 fast path
npm run soak         # default concurrency=2
```

The soak hits local `/health`, `/v1/models`, Chat Completions streaming/non-streaming, Responses streaming/non-streaming, early client abort handling, and bounded parallel fanout. Configure with `SOAK_BASE_URL`, `SOAK_MODEL`, `SOAK_CONCURRENCY`, and `SOAK_TIMEOUT_MS`.

## Wiring up clients

<a id="openclaw"></a>
### openclaw — full step-by-step

End-to-end recipe to get an OpenClaw agent running on your Claude Max subscription via this proxy. Tested on **OpenClaw `2026.4.24`**.

#### 1. Make sure the `claude` CLI is installed and signed in

```bash
npm install -g @anthropic-ai/claude-code
claude auth login          # OAuth flow with your Pro / Max account
claude --version           # sanity check
```

#### 2. Clone, install, and build the proxy

```bash
mkdir -p ~/.openclaw/projects
cd ~/.openclaw/projects
git clone https://github.com/mehdic/openclaw-claude-proxy.git
cd claude-proxy
npm install
npm run build
```

#### 3. Smoke-test the proxy in the foreground

```bash
CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=true node dist/server/standalone.js
# in another terminal:
curl -s http://127.0.0.1:3456/health
curl -s http://127.0.0.1:3456/models
```

If the chat probe below replies with text, the proxy half is working. Stop the foreground server (Ctrl+C) before continuing.

```bash
curl -s -X POST http://127.0.0.1:3456/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"Reply OK only"}]}'
```

#### 4. (Recommended) Run it as a macOS LaunchAgent

Save as `~/Library/LaunchAgents/ai.openclaw.claude-proxy.plist`, replace `<HOME>` with your home directory, then `launchctl bootstrap gui/$(id -u) <plist>`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.openclaw.claude-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string><HOME>/.openclaw/projects/claude-proxy/dist/server/standalone.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string><HOME></string>
    <key>CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS</key><string>true</string>
    <key>CLAUDE_PROXY_PORT</key><string>3456</string>
    <!-- Recommended: enable persistent transport for multi-turn cache reuse -->
    <key>CLAUDE_PROXY_STREAM_JSON</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/><key>NetworkState</key><true/></dict>
  <key>StandardOutPath</key><string><HOME>/.openclaw/logs/claude-proxy-stdout.log</string>
  <key>StandardErrorPath</key><string><HOME>/.openclaw/logs/claude-proxy-stderr.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.claude-proxy.plist
sleep 3
curl -s http://127.0.0.1:3456/health
```

#### 5. Register the proxy as an openclaw provider

Edit `~/.openclaw/openclaw.json`. Under `models.providers`, add:

```json
"claude-proxy": {
  "baseUrl": "http://127.0.0.1:3456",
  "apiKey": "claude-proxy-noop",
  "api": "openai-completions",
  "models": [
    { "id": "claude-opus-4-7",          "name": "Claude Opus 4.7 (via proxy)",   "api": "openai-completions", "input": ["text"], "contextWindow": 200000, "maxTokens": 8192 },
    { "id": "claude-sonnet-4-6",        "name": "Claude Sonnet 4.6 (via proxy)", "api": "openai-completions", "input": ["text"], "contextWindow": 200000, "maxTokens": 8192 },
    { "id": "claude-haiku-4-5-20251001","name": "Claude Haiku 4.5 (via proxy)",  "api": "openai-completions", "input": ["text"], "contextWindow": 200000, "maxTokens": 8192 }
  ]
}
```

> If you ran the proxy on a non-default port, change `baseUrl` to match.

#### 6. Add the models to the agent allowlist

Still in `openclaw.json`, append to `agents.defaults.models`:

```json
"claude-proxy/claude-opus-4-7",
"claude-proxy/claude-sonnet-4-6",
"claude-proxy/claude-haiku-4-5-20251001"
```

Without this step the provider is registered but the models won't appear in Telegram's `/model` picker.

#### 7. Restart the openclaw gateway

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
openclaw gateway probe       # expect "Reachable: yes"
```

#### 8. Point an agent at the proxy

Edit your agent's entry in `agents.list` (or use `openclaw agents edit <id>`):

```json
"model": {
  "primary": "claude-proxy/claude-opus-4-7",
  "fallbacks": ["openai-codex/gpt-5.5", "openai-codex/gpt-5.4-mini"]
}
```

Always keep at least one non-claude-proxy fallback so a proxy outage doesn't take the agent down.

#### 9. Verify

In Telegram:
- `/model` — confirm `claude-proxy` shows up with all three models.
- Send a message — the agent's reply should land.
- `tail -f ~/.openclaw/logs/claude-proxy-stderr.log` — you should see `[SessionPool]` / `[InitPool]` lines (in stream-json mode).

#### Version notes

- `2026.4.24` — known-good with this proxy, including stream-json mode.
- `2026.4.25` — broken at the bundled-channel install step (unrelated to this proxy). If you're stuck on it, roll back to `2026.4.24`.

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3456/v1",
    api_key="not-needed",  # any value
)

resp = client.chat.completions.create(
    model="claude-opus-4-7",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)
```

### Continue.dev

```json
{
  "models": [{
    "title": "Claude (via Max)",
    "provider": "openai",
    "model": "claude-opus-4-7",
    "apiBase": "http://127.0.0.1:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

### Aider

```bash
aider --openai-api-base http://127.0.0.1:3456/v1 \
      --openai-api-key not-needed \
      --model claude-opus-4-7
```

### Custom curl

```bash
curl -N -X POST http://127.0.0.1:3456/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-opus-4-7",
    "stream": true,
    "messages": [{"role":"user","content":"Hello"}]
  }'
```

## Run as a macOS LaunchAgent

Save as `~/Library/LaunchAgents/local.claude-proxy.plist`, edit `<HOME>` and the project path, then `launchctl bootstrap gui/$(id -u) <plist>`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>local.claude-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string><HOME>/path/to/claude-proxy/dist/server/standalone.js</string>
        <string>3456</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string><HOME></string>
        <key>CLAUDE_PROXY_STREAM_JSON</key>
        <string>1</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict><key>SuccessfulExit</key><false/></dict>
    <key>StandardOutPath</key>
    <string><HOME>/Library/Logs/claude-proxy.out.log</string>
    <key>StandardErrorPath</key>
    <string><HOME>/Library/Logs/claude-proxy.err.log</string>
</dict>
</plist>
```

## External OpenAI/OpenClaw tools bridge

When an OpenAI-compatible caller (for example openclaw) includes `tools[]` in a Chat Completions request, claude-proxy now supports a composable caller-dispatched bridge:

- The external OpenAI/OpenClaw tools are described to Claude **in addition to Claude Code native capabilities/tools**.
- Claude can request an external caller-dispatched tool by returning a JSON object shaped as `{"tool_call":{"name":"tool_name","arguments":{}}}`.
- The proxy parses that request and returns OpenAI-compatible `message.tool_calls` / streaming `delta.tool_calls` with `finish_reason: "tool_calls"`.
- The proxy does **not** execute those external tools. The caller dispatches them, preserving openclaw's audit, approval, and allowlist path.
- Follow-up OpenAI `role: "tool"` messages are preserved in the prompt as `<tool_result ...>` blocks so Claude consumes the result rather than repeating the same external call.

This bridge does not replace or disable Claude Code's native tools/capabilities. Native Claude Code capabilities remain available in the CLI context; the bridge only adds a way to ask the caller to run external OpenAI/OpenClaw tools. For a bridged request, the proxy also passes matching native MCP tool names through `--disallowedTools` so overlapping tools (for example `n8n__...` / `mcp__n8n__...`) cannot be executed inside Claude before the caller sees the OpenAI tool call.

### Tool modes and trade-offs

There are now two distinct tool paths:

1. **Caller-dispatched OpenAI/OpenClaw bridge (default for operational `tools[]`)** — safe for openclaw: the proxy emits `tool_calls`; openclaw executes tools externally.
2. **Inner Claude MCP injection (`CLAUDE_PROXY_TOOLS_TRANSLATION=1`)** — optional legacy/advanced mode that registers known MCP servers with the inner claude CLI via `--mcp-config`. Claude executes those tools locally inside the subprocess, so openclaw's dispatcher/audit/approval path does not see those calls.

Use the caller-dispatched bridge when you want openclaw to remain authoritative. Use MCP injection only when you deliberately accept the local-execution audit trade-off.

### MCP injection sources (optional advanced mode)

When `CLAUDE_PROXY_TOOLS_TRANSLATION=1` is enabled, the proxy collects MCP servers from two places, in priority order:

1. **`openclaw.json`'s `mcp.servers` section** (path defaults to `~/.openclaw/openclaw.json`, overridable via `CLAUDE_PROXY_OPENCLAW_CONFIG`). Secret references can be resolved through openclaw's keychain resolver.
2. **Direct env vars (legacy, n8n only):** `CLAUDE_PROXY_N8N_API_URL` + `CLAUDE_PROXY_N8N_API_KEY` register `n8n` if `openclaw.json` did not already.

Useful env vars for MCP injection:

| Variable | Purpose |
|---|---|
| `CLAUDE_PROXY_TOOLS_TRANSLATION=1` | Enable inner Claude MCP injection. Off by default. |
| `CLAUDE_PROXY_OPENCLAW_CONFIG` | Path to the JSON file with `mcp.servers`. Defaults to `~/.openclaw/openclaw.json`. |
| `CLAUDE_PROXY_N8N_MCP_BIN` | Override `n8n-mcp` binary path. |

## n8n-aware keepalive (optional)

When stream-json mode is on, the proxy emits transport-only SSE comment keepalives every ~10 s of claude silence so HTTP/SSE clients and intermediaries do not treat the connection as dead (see "stream-json mode" above). These generic keepalives are not OpenAI `delta.content` and are not assistant text. For one specific case — claude has invoked its `Bash` tool to `curl` an n8n webhook and is now sitting blocked waiting on the workflow — the keepalive can do something more useful: it can poll n8n's REST API and surface real workflow progress as visible assistant content.

How it works:

1. The proxy watches every `content_block_start` / `content_block_delta` event from claude. When a tool_use input matches `CLAUDE_PROXY_N8N_DETECTION_PATTERN` (default: `n8n.*\/webhook\/`), it flags the next ~30s as "n8n in flight".
2. While that window is open and `CLAUDE_PROXY_N8N_API_URL` + `CLAUDE_PROXY_N8N_API_KEY` are both set, each keepalive fire calls `GET /executions?status=running&limit=1` (3-second cache) to find the most recently started running execution.
3. If a new running execution is found, that keepalive is upgraded to a one-line visible status chunk (`[n8n: <workflow name> · <elapsed>s · exec <id>]`). It tells the user something useful is happening instead of sending fake/invisible assistant text.
4. The same execution id is only reported once per turn — subsequent keepalives fall back to SSE comments — so the response doesn't get spammed with duplicate status lines.

Best-effort by design: any HTTP error, timeout, duplicate execution, or no-running-execution result silently falls back to a generic SSE comment keepalive. The feature is **opt-in** via the env vars and a no-op when they're unset.

Sample flow (claude calling an n8n workflow that takes ~90 s):

```
T=0s    user message arrives
T=2s    claude emits Bash tool_use with curl https://n8n.../webhook/abc...
T=3s    detector flags "n8n in flight"
T=12s   keepalive fires → emits "[n8n: my-workflow · 9s elapsed · exec 73]\n"
T=22s   keepalive fires → SSE comment (same execution, already reported)
…
T=90s   curl returns, claude resumes generation
T=95s   final assistant text streamed normally
```

## Long-running tools — use MCP polling, not blocking calls

The 3-layer keepalive in stream-json mode protects the proxy's *active LLM stream* against client-side idle timeouts. It does **not** help when an agent invokes a tool that itself takes minutes to complete (a CI build, an n8n workflow, a long shell script). During tool execution the LLM stream is already closed — the keepalive has nothing to keep alive — and instead the consuming framework's tool-execution timeout governs how long it waits.

The right architectural pattern for those is **trigger + poll across multiple LLM rounds**, exposed by an MCP server:

```
LLM round 1: agent → mcp/tool.trigger(args)              → returns handle/run_id
              (LLM stream closes in seconds, no risk)

between:      consumer schedules the next round (cron / loop / user nudge)

LLM round 2: agent → mcp/tool.status(run_id)             → "running, step 2 of 5"
              agent decides to wait → another round in N seconds

…

LLM round N: agent → mcp/tool.status(run_id)             → "success, output: …"
              agent reports back to user
```

Each LLM call is short. The expensive wait happens *between* LLM calls, in regular cron/loop time, not inside a stream. There's no streaming idle pressure on this proxy, no inflated tool-execution timeout, and the user gets visible progress.

Concrete servers that follow this pattern:

| Long-running thing | MCP server |
|--------------------|------------|
| n8n workflows      | [`czlonkowski/n8n-mcp`](https://github.com/czlonkowski/n8n-mcp) — `n8n_test_workflow` triggers, `n8n_executions` lists/gets (works on running executions too) |
| GitHub Actions     | [`github/github-mcp-server`](https://github.com/github/github-mcp-server) — `list_workflow_runs`, `get_workflow_run` |
| K8s jobs           | community k8s MCP servers — pod status, log tail |
| Anything custom    | wrap your job-runner's status API in an MCP server |

If you find yourself bumping `agents.tools.exec.timeoutSec` to several minutes to accommodate a curl-the-webhook-and-block call, that's a signal to look for (or write) an MCP server for that workload instead.

## Architecture

```
src/
├── adapter/
│   ├── openai-to-cli.ts       # OpenAI request → claude CLI input
│   ├── cli-to-openai.ts       # claude output → OpenAI response (incl. cache stats)
│   ├── responses.ts           # Responses API translation (OpenAI Responses ↔ Chat Completions)
│   └── tools.ts               # caller-dispatched tool bridge + MCP injection config
├── subprocess/
│   ├── manager.ts             # --print mode subprocess
│   ├── pool.ts                # warm-pool scaffold (disabled — see code comment)
│   ├── stream-json-manager.ts # stream-json mode subprocess + control_request handshake
│   ├── init-pool.ts           # per-model pre-initialized stream-json pool
│   ├── session-pool.ts        # per-conversation pool keyed by hash(model, system+user)
│   └── runtime.ts             # runtime resolution (stream-json vs print)
├── server/
│   ├── index.ts               # Express setup
│   ├── routes.ts              # endpoint handlers (incl. SSE keepalive, tool parse/error recording)
│   ├── standalone.ts          # entry point + boot-time pre-warm + MCP injection warning
│   ├── metrics.ts             # Prometheus /metrics exposition (hand-rolled, no prom-client)
│   └── pricing.ts             # usage/cost estimation
├── trace/
│   ├── builder.ts             # per-request TraceBuilder (trace_id, tool calls, MCP decisions)
│   ├── store.ts               # bounded in-memory trace store with LRU + TTL eviction
│   ├── exporter.ts            # optional redacted trace export (generic/OpenInference-shaped)
│   ├── redact.ts              # secret/path redaction for trace records
│   └── types.ts               # TraceMcpDecision, TraceRecord types
├── mcp/
│   ├── governance.ts          # allow/deny policy, overlapping tool detection, startup warning
│   └── openclaw-config.ts     # openclaw.json MCP server loader + secret resolution
├── errors.ts                  # ProtocolErrorClass taxonomy (bounded, Prometheus-safe)
└── types/                     # OpenAI + Claude CLI type definitions
```

## Next features / plan

The complete project plan lives in [`docs/OCTO_FEATURE_PLAN.md`](docs/OCTO_FEATURE_PLAN.md).

**Completed (phases 1–5):**

1. **Transport hardening** — protocol error classes, `upstream_hard_dead` classification, Claude CLI version in `/health`, fixture parser tests, fallback metrics.
2. **Tool trace/replay** — stable `trace_id` per request, bounded in-memory trace store with LRU+TTL, redacted trace records, `GET /traces` and `/traces/:id` localhost-gated endpoints, semantic tool-parse metrics (`emitted`/`no_call`/`malformed`/`rejected`), and bounded protocol-error metrics wired into routes.
3. **MCP governance mode** — allow/deny policy (`CLAUDE_PROXY_MCP_ALLOW`/`DENY`), native Claude tool deny-list propagation for overlapping caller-dispatched tools, startup warning when MCP injection is enabled, secret resolution tracing (no secret values in traces), and structured audit decisions in trace records.
4. **Responses API parity** — Responses now uses the same selected runtime path as chat completions where feasible (`stream-json` by default), with text/function-call output items, streaming lifecycle, usage/cost annotations, tool call detection, and trace recording.
5. **Thin observability export** — optional redacted span-shaped trace export (`generic` or OpenInference-style attributes), disabled by default and fire-and-forget so exporter failures never affect requests.
6. **Live client matrix** — `npm run sdk:matrix` validates fetch wire-compatibility, Python stdlib compatibility, and OpenAI Node/Python + LangChain clients when installed. Use `npm run setup:sdk-matrix` once, then run with `SDK_MATRIX_PYTHON=.venv-sdk-matrix/bin/python`.
7. **Failure simulation** — `npm run failure:sim` exercises invalid requests, streaming aborts, trace headers, and tool-bridge resilience against live proxy behavior; unit tests cover unsupported CLI flags, corrupt stream-json events, malformed tool JSON, and MCP-style rejected tool calls.
8. **Durable local traces** — optional SQLite trace persistence via `CLAUDE_PROXY_TRACE_SQLITE_PATH`, storing redacted records for postmortems beyond process memory; retention is controlled by `CLAUDE_PROXY_TRACE_SQLITE_RETENTION_DAYS` / `_MS`.
9. **Claude CLI capability detection** — optional/version-sensitive flags are checked against `claude --help` before being passed; unsupported flags no longer break worker startup.

**Remaining work:**

10. **Later, only if useful** — context compression on session eviction, artifact/file output endpoints, semantic cache, or cross-provider routing.

Deprioritized: building a full router, workflow engine, or generic MCP platform inside this repo. That is how a proxy becomes a haunted appliance with a changelog.

## Limits and known issues

- **`claude --print` has a hardcoded 3s stdin timeout.** If a client connects but takes longer than 3s to send the prompt, `claude` exits with `Error: Input must be provided either through stdin or as a prompt argument when using --print`. This is why `--print` mode can't keep warm subprocesses around.
- **Stream-json's protocol is reverse-engineered.** Pin a `claude` CLI version you trust if you depend on this in production.
- **Tool bridge is text-protocol based.** Operational OpenAI/OpenClaw `tools[]` are exposed as caller-dispatched external tools and converted to OpenAI `tool_calls`; the proxy still does not intercept native Claude CLI `tool_use` before local execution.
- **Single host.** This is a local proxy. Don't expose `:3456` to the network — it has no auth (the only "auth" is Claude CLI's local keychain).

## Security

- Subprocesses are spawned with Node's `spawn()` — no shell interpretation.
- Prompts are written to `claude`'s stdin, never to argv, so they can't trip command-line length limits or be observed via `ps`.
- The proxy holds no secrets. Authentication is whatever `claude auth login` set up locally.

## Fork lineage

This is a fork of [`mnemon-dev/claude-max-api-proxy`](https://github.com/mnemon-dev/claude-max-api-proxy) (Atal Ashutosh, MIT, originally named `claude-max-api-proxy`) with:

- An openclaw-compat fix that mounts routes both at `/chat/completions` and `/v1/chat/completions` (for clients that don't prepend `/v1`).
- Support for Claude Opus 4.7 / Sonnet 4.6 / Haiku 4.5 model ids.
- Surfaced cache stats in the OpenAI usage object.
- `--exclude-dynamic-system-prompt-sections` flag for cross-host cache reuse.
- `stream-json` persistent transport with init-pool and session-pool for multi-turn cache hits and ~3× latency drop on warm turns.

## License

MIT.

## Contributing

PRs welcome — see the issue tracker first for active threads. The architecture section above maps the moving pieces.
