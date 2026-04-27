# claude-max-api-proxy

**Use your Claude Pro / Max subscription with any OpenAI-compatible client.** No API keys, no per-token billing, no separate Anthropic account.

This proxy wraps the official `claude` CLI as a subprocess and exposes an OpenAI-compatible HTTP API on `127.0.0.1:3456`. Any tool that speaks the OpenAI `chat/completions` format — Continue.dev, Aider, OpenWebUI, custom agents, OpenAI SDK clients, anything — can point at it and route traffic through your existing Claude subscription's OAuth tokens.

## Why this exists

| Approach | Cost | Limitation |
|----------|------|------------|
| Anthropic API directly | ~$15 / M input, ~$75 / M output | Pay per call |
| Claude Pro / Max | $20–200 / mo flat | OAuth tokens blocked from third-party API clients |
| **claude-max-api-proxy** | $0 extra (uses your subscription) | Routes through the local `claude` CLI |

Anthropic blocks OAuth tokens from being used directly with third-party API clients. The Claude Code CLI (`claude`) *can* use OAuth tokens. This proxy bridges the gap.

## How it works

```
Your tool (Continue.dev, Aider, your agent, …)
       │  HTTP, OpenAI chat/completions format
       ▼
claude-max-api-proxy   (this project, listens on :3456)
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
git clone https://github.com/mehdic/claude-max-api-proxy.git
cd claude-max-api-proxy
npm install
npm run build
node dist/server/standalone.js
```

The server listens on `127.0.0.1:3456`. Point your client at it:

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

#### stream-json env vars

| Variable | Default | Effect |
|----------|---------|--------|
| `CLAUDE_PROXY_STREAM_JSON` | unset (off) | `1` to switch to persistent NDJSON transport |
| `CLAUDE_PROXY_PREWARM_MODELS` | `claude-opus-4-7,claude-sonnet-4-6,claude-haiku-4-5-20251001` | Comma-separated model ids to pre-initialize at boot |
| `CLAUDE_PROXY_INIT_POOL` | unset (on) | `0` to disable the per-model init pool |

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

Save as `~/Library/LaunchAgents/local.claude-max-api-proxy.plist`, edit `<HOME>` and the project path, then `launchctl bootstrap gui/$(id -u) <plist>`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>local.claude-max-api-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string><HOME>/path/to/claude-max-api-proxy/dist/server/standalone.js</string>
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
    <string><HOME>/Library/Logs/claude-max-api-proxy.out.log</string>
    <key>StandardErrorPath</key>
    <string><HOME>/Library/Logs/claude-max-api-proxy.err.log</string>
</dict>
</plist>
```

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

This is a fork of [`mnemon-dev/claude-max-api-proxy`](https://github.com/mnemon-dev/claude-max-api-proxy) (Atal Ashutosh, MIT) with:

- An openclaw-compat fix that mounts routes both at `/chat/completions` and `/v1/chat/completions` (for clients that don't prepend `/v1`).
- Support for Claude Opus 4.7 / Sonnet 4.6 / Haiku 4.5 model ids.
- Surfaced cache stats in the OpenAI usage object.
- `--exclude-dynamic-system-prompt-sections` flag for cross-host cache reuse.
- `stream-json` persistent transport with init-pool and session-pool for multi-turn cache hits and ~3× latency drop on warm turns.

## License

MIT.

## Contributing

PRs welcome — see the issue tracker first for active threads. The architecture section above maps the moving pieces.
