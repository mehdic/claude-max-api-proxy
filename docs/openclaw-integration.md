# OpenClaw integration guide

This guide registers `claude-proxy` as an OpenAI-compatible provider in OpenClaw.

The examples use placeholders. Do not paste real secrets into checked-in documentation.

## 1. Start claude-proxy

Follow [Setup](setup.md) first and verify:

```bash
curl -s http://127.0.0.1:3456/health | jq .
curl -s http://127.0.0.1:3456/v1/models | jq .
```

For a local OpenClaw installation on the same machine, the provider base URL is usually:

```text
http://127.0.0.1:3456
```

If OpenClaw runs in a container or on another host, expose the proxy deliberately and add your own network access controls. Do not casually bind a Claude-authenticated local proxy to a public interface.

## 2. Register the provider

Add a provider entry to OpenClaw's config under `models.providers`.

Example:

```json
{
  "models": {
    "providers": {
      "claude-proxy": {
        "baseUrl": "http://127.0.0.1:3456",
        "apiKey": "local-placeholder",
        "api": "openai-completions",
        "models": [
          {
            "id": "claude-opus-4-7",
            "name": "Claude Opus 4.7 (via claude-proxy)",
            "api": "openai-completions",
            "input": ["text"],
            "contextWindow": 200000,
            "maxTokens": 8192
          },
          {
            "id": "claude-opus-4-6",
            "name": "Claude Opus 4.6 (via claude-proxy)",
            "api": "openai-completions",
            "input": ["text"],
            "contextWindow": 200000,
            "maxTokens": 8192
          },
          {
            "id": "claude-sonnet-4-6",
            "name": "Claude Sonnet 4.6 (via claude-proxy)",
            "api": "openai-completions",
            "input": ["text"],
            "contextWindow": 200000,
            "maxTokens": 8192
          },
          {
            "id": "claude-haiku-4-5-20251001",
            "name": "Claude Haiku 4.5 (via claude-proxy)",
            "api": "openai-completions",
            "input": ["text"],
            "contextWindow": 200000,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}
```

The `apiKey` value is a placeholder for OpenAI-compatible clients that expect one. `claude-proxy` does not validate it by default.

## 3. Allow the models for agents

Make the models available to agents. Exact config shape can vary by OpenClaw version, but the model ids generally look like this:

```json
{
  "agents": {
    "defaults": {
      "models": [
        "claude-proxy/claude-opus-4-7",
        "claude-proxy/claude-opus-4-6",
        "claude-proxy/claude-sonnet-4-6",
        "claude-proxy/claude-haiku-4-5-20251001"
      ]
    }
  }
}
```

For a specific agent, set the primary model and keep at least one non-proxy fallback:

```json
{
  "id": "agent-id",
  "model": {
    "primary": "claude-proxy/claude-sonnet-4-6",
    "fallbacks": [
      "openai-codex/gpt-5.5",
      "openai-codex/gpt-5.4-mini"
    ]
  }
}
```

Keeping a fallback prevents a proxy outage, Claude CLI auth issue, or local service restart from taking the agent completely offline.

## 4. Sticky sessions for OpenClaw

This step is optional but recommended for OpenClaw agent traffic. It gives each OpenClaw session a deterministic sticky Claude CLI worker while preserving normal OpenAI-compatible behavior for clients that do not send sticky metadata.

### 4.1 Enable sticky sessions in claude-proxy

Set these in the service environment or LaunchAgent plist:

```bash
CLAUDE_PROXY_STICKY_SESSIONS=1
CLAUDE_PROXY_STICKY_MAX_SESSIONS=8
CLAUDE_PROXY_STICKY_DEFAULT_TTL_SECONDS=86400
```

Restart `claude-proxy` after changing its service environment, then verify:

```bash
curl -s http://127.0.0.1:3456/health | jq '.sticky_pool'
curl -s http://127.0.0.1:3456/metrics | grep claude_proxy_sticky_pool_enabled
```

Expected metric when enabled:

```text
claude_proxy_sticky_pool_enabled 1
```

### 4.2 Add the OpenClaw provider hook plugin

Create a local OpenClaw plugin such as:

```text
~/.openclaw/plugins/claude-proxy-sticky/
  openclaw.plugin.json
  package.json
  index.js
```

The plugin should register provider id `claude-proxy` and implement `resolveTransportTurnState(ctx)`. The hook returns headers like:

```text
X-Claude-Proxy-Session-Key: openclaw:claude-proxy:<model-id>:<openclaw-session-id>
X-Claude-Proxy-Session-Mode: sticky
X-Claude-Proxy-Session-TTL-Seconds: 86400
X-Claude-Proxy-Session-Policy: compatible
X-OpenClaw-Session-Id: <openclaw-session-id>
X-OpenClaw-Turn-Id: <turn-id>
X-OpenClaw-Turn-Attempt: <attempt>
```

Recommended key shape:

```text
openclaw:<provider>:<model>:<session-id>
```

Keep the key deterministic, non-secret, and under the proxy key length limit. If a session id is missing, use a harmless fallback such as `default`; do not use random values or every request will create a new sticky slot.

Enable the plugin in OpenClaw config:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/Users/mehdichaouachi/.openclaw/plugins/claude-proxy-sticky"
      ]
    },
    "allow": [
      "claude-proxy-sticky"
    ],
    "entries": {
      "claude-proxy-sticky": {
        "enabled": true,
        "config": {
          "ttlSeconds": 86400,
          "policy": "compatible",
          "keyPrefix": "openclaw"
        }
      }
    }
  }
}
```

If your install uses the persisted plugin registry, ensure `~/.openclaw/plugins/installs.json` contains the local `claude-proxy-sticky` entry. In Mehdi's deployment this was refreshed directly in the registry file.

### 4.3 Ensure OpenClaw's OpenAI-compatible transport forwards turn headers

OpenClaw provider hooks only help if the active transport attaches `ProviderTransportTurnState.headers` to the HTTP request. In OpenClaw 2026.5.6, the Responses transport already did this, but the Chat Completions / `openai-completions` transport did not.

For `claude-proxy` configured as `api: "openai-completions"`, patch or upgrade OpenClaw so its OpenAI completions client path:

1. calls provider `resolveTransportTurnState` with `options.sessionId`, a stable turn id, attempt number, and `transport: "stream"`;
2. passes `turnState.headers` into the OpenAI client default headers;
3. does **not** add sticky metadata to the JSON payload unless you intentionally choose the body extension.

Mehdi's local Gateway patch ledger, including Cassius's OpenAI Completions turn-header patch and Reaper's later boundary-aware stream-selection patch for `streamStrategy: session-custom`, is documented at:

```text
/Users/mehdichaouachi/.openclaw/workspace/memory/infra/openclaw-gateway-patches.md
```

Without both Gateway behaviors, the plugin can calculate sticky headers but live OpenClaw traffic may still reach `claude-proxy` as ordinary pooled OpenAI-compatible calls.

## 5. Restart or reload OpenClaw

Use the normal OpenClaw config reload/restart path for your installation. Then verify:

```bash
curl -s http://127.0.0.1:3456/health | jq .
```

In OpenClaw, confirm the `claude-proxy/...` models appear in the model picker or status output for the relevant agent.

## 6. Send a test request through OpenClaw

A good first test is a short, non-tool prompt:

```text
Reply with exactly: proxy-ok
```

Then test a longer prompt to confirm streaming and keepalives work across your channel.

## Tool modes

OpenClaw users should understand the two tool paths before enabling advanced MCP features.

### Mode A — caller-dispatched OpenAI tools, recommended

Flow:

1. OpenClaw sends OpenAI-style `tools[]` schemas to `claude-proxy`.
2. The model asks for a tool call.
3. `claude-proxy` returns an OpenAI-style `tool_calls` response.
4. OpenClaw executes the tool using its own dispatcher.
5. OpenClaw sends the tool result back in the next request.

This keeps OpenClaw's approval, audit, and allowlist machinery authoritative.

Use this mode by default. No direct MCP injection variables are required.

### Mode B — direct MCP injection, advanced/local only

When `CLAUDE_PROXY_TOOLS_TRANSLATION=1`, the proxy can register MCP servers directly with the inner Claude CLI. The inner Claude CLI can then execute those MCP tools itself.

Example:

```bash
CLAUDE_PROXY_TOOLS_TRANSLATION=1 \
CLAUDE_PROXY_OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json" \
CLAUDE_PROXY_MCP_ALLOW=n8n \
npm start
```

Trade-off: OpenClaw may not see those tool calls in its normal dispatcher, so OpenClaw approvals, audits, and per-agent allowlists may not apply to those direct MCP calls. Only enable this on trusted local deployments where you accept that boundary.

## n8n integration notes

If you want n8n-aware keepalive progress or direct n8n MCP injection, configure the proxy service environment.

```bash
CLAUDE_PROXY_N8N_API_URL="https://n8n.example.com/api/v1"
CLAUDE_PROXY_N8N_API_KEY="<n8n-api-key>"
CLAUDE_PROXY_N8N_DETECTION_PATTERN="n8n.*\\/webhook\\/"
```

If `n8n-mcp` is not on the proxy service `PATH`, also set:

```bash
CLAUDE_PROXY_N8N_MCP_BIN="<path-to-n8n-mcp>"
```

This is especially important for macOS LaunchAgents because their `PATH` is usually smaller than your interactive shell's `PATH`.

## Recommended LaunchAgent additions for OpenClaw

For an OpenClaw-focused local service, start with:

```xml
<key>CLAUDE_PROXY_PORT</key><string>3456</string>
<key>CLAUDE_PROXY_RUNTIME</key><string>stream-json</string>
<key>CLAUDE_PROXY_FALLBACK_ON_STREAM_FAILURE</key><string>1</string>
<key>CLAUDE_PROXY_TRACE_SQLITE_PATH</key><string><HOME>/.claude-proxy/traces.sqlite</string>
<key>CLAUDE_PROXY_TRACE_SQLITE_RETENTION_DAYS</key><string>7</string>
```

Only add direct MCP injection if you accept the tool execution trade-off:

```xml
<key>CLAUDE_PROXY_TOOLS_TRANSLATION</key><string>1</string>
<key>CLAUDE_PROXY_MCP_ALLOW</key><string>n8n</string>
<key>CLAUDE_PROXY_N8N_MCP_BIN</key><string><path-to-n8n-mcp></string>
```

Do not commit a real LaunchAgent containing API keys.

## Debugging OpenClaw requests

Useful proxy endpoints:

```bash
curl -s http://127.0.0.1:3456/health | jq .
curl -s http://127.0.0.1:3456/metrics
curl -s http://127.0.0.1:3456/traces | jq .
```

Useful local checks:

```bash
npm run monitor:live
npm run soak:quick
npm run failure:sim
```

If an agent cannot use the proxy:

1. Confirm `claude` works directly for the same OS user.
2. Confirm `curl http://127.0.0.1:3456/health` works from the OpenClaw host.
3. Confirm the OpenClaw provider `baseUrl` matches the proxy URL.
4. Confirm the model id is both registered under the provider and allowed for the agent.
5. Check proxy stderr/stdout logs.
6. Temporarily set `CLAUDE_PROXY_RUNTIME=print` if stream-json protocol drift is suspected.

## Safety checklist

Before using the proxy in a real OpenClaw agent:

- [ ] Proxy binds only to a trusted interface.
- [ ] Claude CLI is authenticated for the service user.
- [ ] OpenClaw has at least one non-proxy fallback model.
- [ ] Secrets are not stored in checked-in files.
- [ ] Direct MCP injection is disabled unless explicitly needed.
- [ ] If direct MCP injection is enabled, `CLAUDE_PROXY_MCP_ALLOW` or `CLAUDE_PROXY_MCP_DENY` is configured.
- [ ] Trace retention is bounded if durable traces are enabled.
