# Setup guide

This guide takes a clean machine from zero to a running local `claude-proxy` server.

## 1. Requirements

- Node.js 20 or newer.
- npm.
- The official Claude Code CLI.
- An authenticated local Claude Code session.
- A client that can speak OpenAI-compatible HTTP, such as OpenClaw, an OpenAI SDK, Continue, Aider, Open WebUI, or a custom agent.

Install and authenticate Claude Code first:

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
claude --version
```

`claude-proxy` does not handle your Claude OAuth login itself. It launches the local `claude` CLI, so authentication must already work from the same user account that will run the proxy.

## 2. Install claude-proxy

Choose one of the two supported install paths.

### Option A: prebuilt release package

This is the easiest path for users who only want to run the proxy. The release package includes compiled `dist/` files, so it skips TypeScript and `npm run build`.

```bash
npm install -g https://github.com/mehdic/openclaw-claude-proxy/releases/download/v1.0.7/claude-proxy-1.0.7.tgz
```

Run it:

```bash
claude-proxy
```

If you download the file manually instead:

```bash
npm install -g ./claude-proxy-1.0.7.tgz
claude-proxy
```

### Option B: source checkout

Use this path if you want to develop, inspect, or modify the code.

```bash
git clone https://github.com/mehdic/openclaw-claude-proxy.git
cd openclaw-claude-proxy
npm install
npm run build
npm start
```

## 3. Run in the foreground

For the prebuilt global install:

```bash
claude-proxy
```

For a source checkout:

```bash
npm start
```

By default the server binds to `127.0.0.1:3456`.

Override the port with either an environment variable or a CLI argument:

```bash
CLAUDE_PROXY_PORT=3457 claude-proxy

# source checkout alternative
CLAUDE_PROXY_PORT=3457 npm start

# direct node alternative
node dist/server/standalone.js 3457
```

If a port CLI argument and `CLAUDE_PROXY_PORT` are both supplied, the CLI argument wins.

## 4. Smoke-test

In another terminal:

```bash
curl -s http://127.0.0.1:3456/health | jq .
curl -s http://127.0.0.1:3456/v1/models | jq .
```

Test a non-streaming Chat Completions request:

```bash
curl -s http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Reply exactly: OK"}],
    "stream": false
  }' | jq .
```

Test streaming:

```bash
curl -N http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Count from one to five."}],
    "stream": true
  }'
```

Run the deep health probe when you want to verify Claude itself can answer:

```bash
curl -s http://127.0.0.1:3456/healthz/deep | jq .
```

## 5. Run as a macOS LaunchAgent

A LaunchAgent is the recommended way to keep the proxy running for local tools on macOS.

Create `~/Library/LaunchAgents/ai.openclaw.claude-proxy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.openclaw.claude-proxy</string>

  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string><HOME>/openclaw-claude-proxy/dist/server/standalone.js</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string><HOME></string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>CLAUDE_PROXY_PORT</key><string>3456</string>
    <key>CLAUDE_PROXY_RUNTIME</key><string>stream-json</string>

    <!-- Headless service mode. Enable only for trusted local deployments. -->
    <key>CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS</key><string>true</string>
  </dict>

  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>

  <key>StandardOutPath</key><string><HOME>/Library/Logs/claude-proxy.stdout.log</string>
  <key>StandardErrorPath</key><string><HOME>/Library/Logs/claude-proxy.stderr.log</string>
</dict>
</plist>
```

Replace:

- `/path/to/node` with `which node` from the same Node installation you use to build.
- `<HOME>` with your home directory.
- `<HOME>/openclaw-claude-proxy` with the actual clone path.

Load and verify:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.claude-proxy.plist
sleep 3
curl -s http://127.0.0.1:3456/health | jq .
```

Restart after updates:

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.claude-proxy
```

Unload:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.claude-proxy.plist
```

## 6. Update an existing install

```bash
cd openclaw-claude-proxy
git pull --ff-only
npm install
npm run build
npm test
launchctl kickstart -k gui/$(id -u)/ai.openclaw.claude-proxy  # if using LaunchAgent
```

## 7. Local verification scripts

These scripts expect a proxy to already be running unless noted otherwise:

```bash
npm run soak:quick          # local smoke/fanout path
npm run canary:stream-json  # stream-json compatibility canary
npm run sdk:matrix          # raw HTTP + optional SDK compatibility
npm run failure:sim         # failure classification simulation
npm run monitor:live        # lightweight live monitor
```

The full live verification bundle is:

```bash
npm run verify:live
```

## 8. Troubleshooting

### `claude` is not found

Make sure the service `PATH` includes the directory containing the `claude` binary. LaunchAgents do not inherit your interactive shell environment.

### Auth errors

Run `claude auth login` as the same OS user that runs the proxy. A LaunchAgent launched as your user should see that user's Claude CLI auth state.

### Port already in use

Change `CLAUDE_PROXY_PORT`, stop the other process, or find the listener:

```bash
lsof -nP -iTCP:3456 -sTCP:LISTEN
```

### Stream-json regressions

Switch temporarily to print mode:

```bash
CLAUDE_PROXY_RUNTIME=print npm start
```

For services, set `CLAUDE_PROXY_RUNTIME=print` in the LaunchAgent and restart.

### n8n MCP binary not found

If using optional MCP injection with n8n, set `CLAUDE_PROXY_N8N_MCP_BIN` to the absolute path of `n8n-mcp`. See [Configuration](configuration.md#n8n-and-mcp-binary-paths).
