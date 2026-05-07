# Configuration guide

`claude-proxy` is configured with environment variables. Keep machine-specific values in your shell profile, process manager, LaunchAgent, container runtime, or secret store — not in the repository.

## Minimal configuration

For a foreground local run, no environment variables are required:

```bash
npm start
```

The default server is:

```text
http://127.0.0.1:3456
```

For headless service mode, the practical minimum is usually:

```bash
CLAUDE_PROXY_PORT=3456
CLAUDE_PROXY_RUNTIME=stream-json
CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=true
```

Only use `CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=true` on a trusted local machine where you accept the Claude Code CLI permission trade-off.

## Runtime

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_PORT` | `3456` | Port for the HTTP server. A CLI arg to `standalone.js` overrides this. |
| `CLAUDE_PROXY_RUNTIME` | `stream-json` | `stream-json` or `print`. `stream-json` is the default persistent runtime. `print` spawns a fresh subprocess per request. |
| `CLAUDE_PROXY_STREAM_JSON` | unset | Legacy compatibility flag. `0` forces print mode if `CLAUDE_PROXY_RUNTIME` is unset. Prefer `CLAUDE_PROXY_RUNTIME`. |
| `CLAUDE_PROXY_ALLOW_RUNTIME_OVERRIDE` | unset | Set `1` to allow per-request `X-Claude-Proxy-Runtime: print` or `stream-json`. Off by default. |
| `CLAUDE_PROXY_FALLBACK_ON_STREAM_FAILURE` | unset | Set `1` to retry once with `print` when a recognized stream-layer failure happens before response bytes are committed. |
| `CLAUDE_PROXY_EXCLUDE_DYNAMIC_SYSTEM_PROMPT_SECTIONS` | unset | Set `1` to request Claude CLI dynamic-system-prompt exclusion when the installed CLI supports the flag. |
| `CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS` | unset | Set `true` to pass Claude CLI's permission-skipping flag. Useful for trusted headless services; risky on untrusted hosts. |

### Choosing a runtime

Use `stream-json` for normal operation:

```bash
CLAUDE_PROXY_RUNTIME=stream-json npm start
```

Use `print` when debugging upstream CLI protocol changes or when you want one subprocess per request:

```bash
CLAUDE_PROXY_RUNTIME=print npm start
```

## Pooling and prewarm

These variables affect the persistent `stream-json` runtime.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_PREWARM_MODELS` | `claude-opus-4-7,claude-sonnet-4-6,claude-haiku-4-5-20251001` | Comma-separated models to pre-initialize at startup. |
| `CLAUDE_PROXY_INIT_POOL` | enabled | Set `0` to disable the per-model init pool. |
| `CLAUDE_PROXY_POOL_TTL_MS` | `600000` | Idle TTL for session-pool workers. Floored internally to avoid evicting during the prompt-cache window. |
| `CLAUDE_PROXY_POOL_MAX` | `4` | Maximum live workers in the session pool. |
| `CLAUDE_PROXY_WARM_POOL` | unset | Legacy warm-pool toggle used by older code paths. Prefer the default stream-json init/session pool. |
| `CLAUDE_PROXY_UPSTREAM_SOFT_DEAD_MS` | code default | Soft-dead threshold for upstream silence detection. Usually leave unset. |
| `CLAUDE_PROXY_DESCENDANT_GRACE_MS` | code default | Grace window for descendant/tool process handling. Usually leave unset. |

## Models

The proxy exposes current Claude model ids through `/models` and `/v1/models`. Common ids include:

```text
claude-opus-4-7
claude-opus-4-6
claude-sonnet-4-6
claude-haiku-4-5-20251001
```

Provider-prefixed ids such as `claude-proxy/claude-sonnet-4-6` are accepted by the model normalizer for OpenClaw-style clients.

## Tracing

Tracing is optional and intended for local debugging.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_TRACE_ENABLED` | unset | Set `1` to enable the bounded in-memory trace store. |
| `CLAUDE_PROXY_TRACE_CAPACITY` | `200` | Maximum in-memory traces. |
| `CLAUDE_PROXY_TRACE_TTL_MS` | `3600000` | In-memory trace TTL in milliseconds. Minimum one minute. |
| `CLAUDE_PROXY_TRACE_SQLITE_PATH` | unset | Enables durable SQLite trace persistence at the given local path. |
| `CLAUDE_PROXY_TRACE_SQLITE_RETENTION_DAYS` | unset | Retention window for SQLite traces, in days. |
| `CLAUDE_PROXY_TRACE_SQLITE_RETENTION_MS` | unset | Retention override in milliseconds. Used when days is unset. |
| `CLAUDE_PROXY_TRACE_SQLITE_DEBUG` | unset | Set `1` to log SQLite persistence errors. |

Example:

```bash
CLAUDE_PROXY_TRACE_ENABLED=1 \
CLAUDE_PROXY_TRACE_SQLITE_PATH="$HOME/.claude-proxy/traces.sqlite" \
CLAUDE_PROXY_TRACE_SQLITE_RETENTION_DAYS=7 \
npm start
```

Trace endpoints are localhost-gated:

```bash
curl http://127.0.0.1:3456/traces
curl http://127.0.0.1:3456/traces/<trace-id>
```

See [Trace security](TRACE_SECURITY.md) before enabling durable traces.

## Trace export

The proxy can export redacted trace events to an HTTP collector.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_TRACE_EXPORT_URL` | unset | Destination URL. Export is disabled when unset. |
| `CLAUDE_PROXY_TRACE_EXPORT_FORMAT` | `generic` | `generic` or `openinference`. |
| `CLAUDE_PROXY_TRACE_EXPORT_HEADER` | unset | Optional single HTTP header in `Name: value` format. Avoid putting long-lived secrets in shell history. |
| `CLAUDE_PROXY_TRACE_EXPORT_TIMEOUT_MS` | code default | Export request timeout. |
| `CLAUDE_PROXY_TRACE_EXPORT_DEBUG` | unset | Set `1` to log export failures. |

## Pricing snapshot

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_PRICING_FILE` | `$HOME/.claude-proxy/pricing.json` | Local pricing snapshot path used by the pricing updater and cost estimator. |

Update pricing:

```bash
npm run update-pricing
```

## MCP and tool modes

There are two distinct tool paths.

### Caller-dispatched tools — recommended default

The caller sends OpenAI-style tools, the proxy returns OpenAI-style `tool_calls`, and the caller executes tools under its own approval/audit/allowlist system. This is the safest mode for OpenClaw.

No MCP injection env vars are required for this mode.

### Direct MCP injection — advanced local mode

When enabled, the proxy registers selected MCP servers directly with the inner Claude CLI. Claude Code then executes those MCP tools inside the subprocess.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_TOOLS_TRANSLATION` | unset | Set `1` to enable direct MCP injection. |
| `CLAUDE_PROXY_OPENCLAW_CONFIG` | `$HOME/.openclaw/openclaw.json` | Optional path to an OpenClaw config file whose `mcp.servers` can be imported. |
| `CLAUDE_PROXY_MCP_ALLOW` | unset | Comma-separated allowlist of MCP server names. If set, only these servers are injected. |
| `CLAUDE_PROXY_MCP_DENY` | unset | Comma-separated denylist of MCP server names. Deny wins over allow. |

Example:

```bash
CLAUDE_PROXY_TOOLS_TRANSLATION=1 \
CLAUDE_PROXY_MCP_ALLOW=n8n,github \
npm start
```

Security trade-off: direct MCP injection bypasses the caller's dispatcher. For OpenClaw, that means OpenClaw may not see those tool calls in its normal approval/audit path.

## n8n and MCP binary paths

`claude-proxy` has two optional n8n-related features:

1. n8n-aware keepalive progress, using the n8n REST API.
2. Direct n8n MCP injection, using the `n8n-mcp` stdio binary.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_N8N_API_URL` | unset | n8n API base URL, for example `https://n8n.example.com/api/v1`. |
| `CLAUDE_PROXY_N8N_API_KEY` | unset | n8n API key. Required with `CLAUDE_PROXY_N8N_API_URL` for n8n progress and legacy n8n MCP registration. |
| `CLAUDE_PROXY_N8N_DETECTION_PATTERN` | `n8n.*\/webhook\/` | Regex used to detect in-flight n8n webhook calls in Claude tool input. |
| `CLAUDE_PROXY_N8N_MCP_BIN` | `n8n-mcp` | Command or absolute path to the `n8n-mcp` stdio binary. |

If `n8n-mcp` is not on the service `PATH`, set `CLAUDE_PROXY_N8N_MCP_BIN` explicitly:

```bash
CLAUDE_PROXY_TOOLS_TRANSLATION=1 \
CLAUDE_PROXY_N8N_API_URL="https://n8n.example.com/api/v1" \
CLAUDE_PROXY_N8N_API_KEY="<n8n-api-key>" \
CLAUDE_PROXY_N8N_MCP_BIN="<path-to-n8n-mcp>" \
npm start
```

This matters for macOS LaunchAgents because they often run with a minimal `PATH`. A binary that works in your interactive shell may not be visible to the service.

Recommended private LaunchAgent pattern:

```xml
<key>CLAUDE_PROXY_N8N_MCP_BIN</key><string><path-to-n8n-mcp></string>
```

Do not commit real n8n API keys or private n8n URLs to the repository.

## Live monitor

`npm run monitor:live` checks `/health` and one tiny chat request.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_MONITOR_BASE_URL` | `http://127.0.0.1:3456` | Proxy URL to monitor. |
| `CLAUDE_PROXY_MONITOR_MODEL` | `claude-haiku-4-5-20251001` | Model used for the tiny monitor request. |
| `CLAUDE_PROXY_MONITOR_TIMEOUT_MS` | `60000` | Monitor timeout. |
| `CLAUDE_PROXY_MONITOR_ALERT_COMMAND` | unset | Optional command run on failure. Receives the alert body on stdin and in `CLAUDE_PROXY_MONITOR_MESSAGE`. |

Example:

```bash
CLAUDE_PROXY_MONITOR_ALERT_COMMAND="/path/to/notify-operator.sh" \
npm run monitor:live
```

## Verification script variables

These are used by local scripts, not the server.

| Variable | Script | Description |
| --- | --- | --- |
| `SOAK_BASE_URL` | `npm run soak` | Proxy base URL. |
| `SOAK_CONCURRENCY` | `npm run soak` | Soak concurrency. |
| `SOAK_TIMEOUT_MS` | `npm run soak` | Soak timeout. |
| `SOAK_MODEL` | `npm run soak` | Model used for soak requests. |
| `CLAUDE_PROXY_CANARY_MODELS` | `npm run canary:stream-json` | Comma-separated canary model list. |
| `CLAUDE_PROXY_CANARY_TIMEOUT_MS` | `npm run canary:stream-json` | Canary timeout. |
| `SDK_MATRIX_BASE_URL` | `npm run sdk:matrix` | Proxy base URL. |
| `SDK_MATRIX_MODEL` | `npm run sdk:matrix` | Model used by SDK matrix checks. |
| `SDK_MATRIX_TIMEOUT_MS` | `npm run sdk:matrix` | SDK matrix timeout. |
| `SDK_MATRIX_REQUIRE_OPTIONAL` | `npm run sdk:matrix` | Set `1` to fail if optional SDK clients are missing. |
| `SDK_MATRIX_PYTHON` | `npm run sdk:matrix` | Python executable for Python SDK checks. |
| `FAILURE_SIM_BASE_URL` | `npm run failure:sim` | Proxy base URL. |
| `FAILURE_SIM_MODEL` | `npm run failure:sim` | Model used by failure simulation. |
| `FAILURE_SIM_TIMEOUT_MS` | `npm run failure:sim` | Failure simulation timeout. |

## Keeping local config private

Recommended patterns:

- Keep LaunchAgent plists with real secrets outside the repo.
- Use placeholders in checked-in examples: `<HOME>`, `<path-to-n8n-mcp>`, `<n8n-api-key>`.
- Prefer OS keychains or your automation platform's secret resolver for long-lived API keys.
- Add local config files and trace databases to `.gitignore` before experimenting.
