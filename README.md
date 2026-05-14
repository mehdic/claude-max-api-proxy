# openclaw-claude-proxy

`openclaw-claude-proxy` exposes the official Claude Code CLI as a local OpenAI-compatible HTTP server. It lets OpenAI-compatible clients talk to a local `claude` CLI session using familiar `/v1/chat/completions`, `/v1/responses`, `/v1/models`, streaming, usage, health, metrics, and tracing endpoints.

The installed executable remains `claude-proxy`. The proxy is designed for local developer and automation setups, especially [OpenClaw](https://github.com/openclaw/openclaw), but it also works with SDKs and tools that can point at an OpenAI-compatible base URL.

> **OAuth safety: `openclaw-claude-proxy` does not extract, read, copy, export, or store Claude Code OAuth tokens. It launches the official `claude` CLI in the background and lets Claude Code handle authentication the normal way. In other words, the proxy uses Claude Code as Anthropic expects it to be used, instead of scraping credentials or reimplementing Anthropic's login flow.**

## Highlights

- OpenAI-compatible Chat Completions and practical Responses API support.
- Persistent `stream-json` runtime by default, plus `print` fallback mode.
- SSE streaming and keepalives for long-running Claude Code turns.
- Intentional-wait handling for Claude Code `ScheduleWakeup` / background-task parks, with chat-completions and Responses streaming parity.
- Usage/cache metadata and estimated cost annotations.
- Caller-dispatched OpenAI tool call bridge.
- Optional direct MCP injection for advanced local setups.
- Optional n8n-aware progress keepalives.
- Optional synthetic liveness progress chunks for clients with provider-event idle timeouts.
- Optional in-memory, SQLite, and HTTP-exported traces with redaction boundaries.
- Optional sticky Claude CLI sessions for callers that pass deterministic session metadata.
- macOS LaunchAgent-friendly standalone server.

## Quick start

First install and authenticate Claude Code:

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

Then install the published npm package, or use one of the alternative paths below.

### Option A: install from npm

```bash
npm install -g openclaw-claude-proxy
claude-proxy
```

The executable command remains `claude-proxy`. The npm package includes the compiled `dist/` output, so users do not need TypeScript or `npm run build`.

GitHub release tarball alternative:

```bash
npm install -g https://github.com/mehdic/openclaw-claude-proxy/releases/download/v1.0.8/openclaw-claude-proxy-1.0.8.tgz
claude-proxy
```

### Option B: build from source

```bash
git clone https://github.com/mehdic/openclaw-claude-proxy.git
cd openclaw-claude-proxy
npm install
npm run build
npm start
```

In another terminal:

```bash
curl http://127.0.0.1:3456/health

curl http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}],
    "stream": false
  }'
```

No proxy API key is required by default. Authentication is whatever the local `claude` CLI has already established.

## Documentation

- [Setup guide](docs/setup.md) — install, run, smoke-test, macOS LaunchAgent, updates, and troubleshooting.
- [Configuration guide](docs/configuration.md) — runtime modes, environment variables, tracing, MCP, n8n, monitoring, and local secret handling.
- [OpenClaw integration guide](docs/openclaw-integration.md) — provider/model/agent configuration, sticky-session bridge setup, tool modes, and safety notes.
- [Trace security](docs/TRACE_SECURITY.md) — trace contents, redaction, access controls, and retention.
- [macOS LaunchAgent reference](docs/macos-setup.md) — focused plist example.

## API surface

Routes are mounted with and without `/v1` where relevant so both OpenAI SDKs and simpler clients can use the server.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Cheap liveness and runtime capability summary. |
| `/healthz/deep` | GET | Deep probe that asks Claude for a tiny response. |
| `/models`, `/v1/models` | GET | OpenAI-style model list. |
| `/chat/completions`, `/v1/chat/completions` | POST | Chat Completions, streaming and non-streaming. |
| `/responses`, `/v1/responses` | POST | Practical Responses API compatibility. |
| `/pricing`, `/v1/pricing` | GET | Pricing snapshot used for cost estimates. |
| `/metrics` | GET | Prometheus-style metrics. |
| `/traces`, `/traces/:id` | GET | Localhost-only trace endpoints when tracing is enabled. |

## Runtime model

Two Claude subprocess strategies are available:

- `stream-json` — default. Uses Claude Code's stream-json transport, init pool, and session pool for better latency and prompt-cache reuse.
- `print` — incident-response fallback. Spawns a fresh `claude --print` subprocess per request. Slower, but simpler and isolated.

In `stream-json`, Claude Code may intentionally park a turn with `ScheduleWakeup`, `Monitor`, or `TaskOutput` while background work finishes. The proxy treats the strict interim text `Sleeping the loop. Will resume when ...` as an intentional wait, keeps the worker busy/out of the pool, keeps the SSE stream alive, and finalizes only on a later real result/error or the absolute cap. `/v1/chat/completions` emits progress as chat delta chunks; `/v1/responses` emits proxy progress as `response.in_progress` lifecycle events so `response.output_text.delta` still matches the final `response.output_text.done` text.

See [Configuration](docs/configuration.md#runtime) and [Scheduled wakeup / background-task waits](docs/configuration.md#scheduled-wakeup--background-task-waits) for details.

## Sticky sessions

Sticky sessions are an opt-in extension on top of the normal OpenAI-compatible API. A request with no sticky metadata keeps the default pool behavior. A caller that wants stable live Claude CLI continuity sends deterministic session headers:

```text
X-Claude-Proxy-Session-Key: <caller-chosen-stable-id>
X-Claude-Proxy-Session-Mode: sticky
X-Claude-Proxy-Session-TTL-Seconds: 86400
X-Claude-Proxy-Session-Policy: compatible
```

Equivalent body options are also supported under `claude_proxy` when body options are enabled. The proxy hashes the raw key for logs/metrics; do not put secrets in the key.

Enable the server-side feature explicitly:

```bash
CLAUDE_PROXY_STICKY_SESSIONS=1
CLAUDE_PROXY_STICKY_MAX_SESSIONS=8
CLAUDE_PROXY_STICKY_DEFAULT_TTL_SECONDS=86400
```

For OpenClaw, use the local `claude-proxy-sticky` provider plugin plus the OpenAI-compatible Gateway patches described in [OpenClaw integration](docs/openclaw-integration.md#4-sticky-sessions-for-openclaw). Mehdi's installed-Gateway patch ledger lives at `/Users/mehdichaouachi/.openclaw/workspace/memory/infra/openclaw-gateway-patches.md`. OpenClaw remains the transcript source of truth; sticky sessions only keep the live Claude CLI worker warm/continuous for the chosen session key.

## Tool execution model

The safer default is caller-dispatched tools: the caller owns tool execution, approval, audit, and allowlists. The proxy can return OpenAI-style `tool_calls` so the caller can execute tools and send back tool results.

Optional MCP injection (`CLAUDE_PROXY_TOOLS_TRANSLATION=1`) registers selected MCP servers directly with the inner Claude CLI. This is useful for local automation but changes the security boundary: the inner Claude CLI executes those MCP tools directly, outside the caller's dispatcher. By default, native MCP tools that overlap caller-dispatched OpenClaw tools are disallowed so OpenClaw remains authoritative; trusted local overlaps can be explicitly allowed with `CLAUDE_PROXY_ALLOW_NATIVE_MCP_OVERLAPS`, for example `openbrain-local,serena`. See [OpenClaw tool modes](docs/openclaw-integration.md#tool-modes) before enabling it.

## Security notes

- **OAuth safety: this proxy does not extract or store Claude Code OAuth tokens. Authentication remains owned by the official `claude` CLI and its normal local auth state.**
- Keep the server bound to loopback unless you add your own authentication and network controls.
- Do not commit API keys, OAuth tokens, local paths, LaunchAgent plists containing secrets, or trace databases.
- Prefer environment variables, OS secret stores, or OpenClaw secret references for local secrets.
- Treat traces as sensitive diagnostic data even though the proxy redacts secret-looking fields.
- Use `CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=true` only for trusted headless/local service deployments where you accept the Claude CLI permission trade-off.

## Development

```bash
npm install
npm run build
npm test
```

Optional checks when a proxy is already running:

```bash
npm run soak:quick
npm run canary:stream-json
npm run sdk:matrix
npm run failure:sim
npm run monitor:live
```

## Fork lineage

This repository is based on `mnemon-dev/claude-max-api-proxy` and extends it with OpenClaw-oriented compatibility, persistent runtime hardening, tracing, monitoring, tool handling, and operational documentation.

## License

MIT
