# claude-proxy

**Use your Claude Pro / Max subscription with any OpenAI-compatible client.** No API keys, no per-token billing, no separate Anthropic account.

This proxy wraps the official `claude` CLI as a subprocess and exposes an OpenAI-compatible HTTP API on `127.0.0.1:3456`. Any tool that speaks the OpenAI `chat/completions` format — [openclaw](https://github.com/openclaw/openclaw), Continue.dev, Aider, OpenWebUI, custom agents, OpenAI SDK clients, anything — can point at it and route traffic through your existing Claude subscription's OAuth tokens.

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
       │  HTTP, OpenAI chat/completions format
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

The proxy itself is **stateless**: it does not store prompts, conversation history, or API keys. All state lives either in the calling client (which sends the full message array each turn) or in the live `claude` subprocess.

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
git clone https://github.com/mehdic/claude-proxy.git
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

> Routes are mounted at both `/chat/completions` and `/v1/chat/completions` for compatibility with clients that prepend `/v1` themselves and ones that don't.

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

## Two transport modes

The proxy ships with two ways of talking to `claude`. Pick based on whether you care about multi-turn caching for chat workloads.

### `--print` mode (default — works out of the box)

Each request spawns a fresh `claude --print` subprocess. Reliable, simple, no surprises.

Active optimizations:
- Cache stats are surfaced in `usage.prompt_tokens_details.cached_tokens` so you can see Anthropic's prompt cache fire (~88% hit on system prompt + tools after the first call).
- `--exclude-dynamic-system-prompt-sections` is passed to `claude` automatically, which moves per-machine bits (cwd, env info, git status) out of the cached system prompt so the cache hash matches across hosts and runs.

Trade-off: each request pays a ~5s subprocess cold start. Fine for chat, not great if you need sub-second latency.

### `stream-json` mode (opt-in, recommended for chat)

Set `CLAUDE_PROXY_STREAM_JSON=1` and the proxy switches to a persistent NDJSON transport (`claude --input-format stream-json`). One subprocess survives across multiple turns of the same conversation, so:

- **Conversation history caches turn-to-turn.** Empirical: a 3-turn chat went from `cache_read=0` (turn 1) → `cache_read=70K` (turn 2) → `cache_read=70K` (turn 3) — 99.9% of input tokens served from Anthropic's prompt cache.
- **Warm latency drops from ~5s to ~1.6s** because the next turn skips the spawn + handshake.
- **Cold turns are also faster** (~2.9s) because the proxy keeps a per-model pre-initialized "init pool" — the 5s init handshake happens once at startup, not per request.
- **SSE keepalives** (`:keepalive\n\n`) are emitted every 1s during the cold gap so OpenAI clients with short idle timeouts don't disconnect.

Enable:
```bash
CLAUDE_PROXY_STREAM_JSON=1 node dist/server/standalone.js
```

### Environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `CLAUDE_PROXY_PORT` | `3456` | Port to listen on. CLI arg (`node standalone.js 3458`) takes precedence if also given. |
| `CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS` | unset | `true` to pass `--dangerously-skip-permissions` to `claude`. Required for headless / LaunchAgent operation since there's no TTY for permission prompts. |
| `CLAUDE_PROXY_STREAM_JSON` | unset (off) | `1` to switch to persistent NDJSON transport with multi-turn cache reuse. |
| `CLAUDE_PROXY_PREWARM_MODELS` | `claude-opus-4-7,claude-sonnet-4-6,claude-haiku-4-5-20251001` | Comma-separated model ids to pre-initialize at boot (stream-json mode only). |
| `CLAUDE_PROXY_INIT_POOL` | unset (on) | `0` to disable the per-model init pool (stream-json mode only). |

#### Caveats

- The stream-json input protocol is **officially undocumented** — Anthropic [issue #24594](https://github.com/anthropics/claude-code/issues/24594) closed as not-planned. The implementation is reverse-engineered from the public Python Agent SDK. The shape may shift between `claude` CLI releases. That's why this mode is opt-in.
- The session-pool keys conversations by `hash(model, system + user messages)`. Assistant content is excluded from the hash because the live subprocess remembers what it actually said and incoming history may differ in punctuation. Idle subprocesses are evicted after 6 minutes (~1 min past Anthropic's 5-min cache TTL).

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Liveness probe |
| `/models`, `/v1/models` | GET | List served model ids |
| `/chat/completions`, `/v1/chat/completions` | POST | OpenAI chat completion. Supports `stream: true` for SSE |

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
git clone https://github.com/mehdic/claude-proxy.git
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
│   └── cli-to-openai.ts       # claude output → OpenAI response (incl. cache stats)
├── subprocess/
│   ├── manager.ts             # --print mode subprocess
│   ├── pool.ts                # warm-pool scaffold (disabled — see code comment)
│   ├── stream-json-manager.ts # stream-json mode subprocess + control_request handshake
│   ├── init-pool.ts           # per-model pre-initialized stream-json pool
│   └── session-pool.ts        # per-conversation pool keyed by hash(model, system+user)
├── server/
│   ├── index.ts               # Express setup
│   ├── routes.ts              # endpoint handlers (incl. SSE keepalive in stream-json path)
│   └── standalone.ts          # entry point + boot-time pre-warm
└── types/                     # OpenAI + Claude CLI type definitions
```

## Limits and known issues

- **`claude --print` has a hardcoded 3s stdin timeout.** If a client connects but takes longer than 3s to send the prompt, `claude` exits with `Error: Input must be provided either through stdin or as a prompt argument when using --print`. This is why `--print` mode can't keep warm subprocesses around.
- **Stream-json's protocol is reverse-engineered.** Pin a `claude` CLI version you trust if you depend on this in production.
- **No tool-use translation.** OpenAI tool-calling format is not converted to/from Claude tool calls. The proxy passes through text; tools are claude's built-in tools (Bash, Edit, Read, etc.) running in the subprocess's cwd.
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
