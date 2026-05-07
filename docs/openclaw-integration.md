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

## 4. Restart or reload OpenClaw

Use the normal OpenClaw config reload/restart path for your installation. Then verify:

```bash
curl -s http://127.0.0.1:3456/health | jq .
```

In OpenClaw, confirm the `claude-proxy/...` models appear in the model picker or status output for the relevant agent.

## 5. Send a test request through OpenClaw

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
