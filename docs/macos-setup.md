# macOS LaunchAgent reference

This is a focused LaunchAgent reference for running `claude-proxy` as a local user service on macOS. For the full install flow, see [Setup](setup.md). For environment variable details, see [Configuration](configuration.md).

## Before you start

Build the project and confirm it works in the foreground:

```bash
npm install
npm run build
npm start
curl -s http://127.0.0.1:3456/health
```

Find the paths you will need:

```bash
which node
which claude
echo "$HOME"
pwd
```

If you use optional binaries such as `n8n-mcp`, find those too:

```bash
which n8n-mcp
```

## Example plist

Save as `~/Library/LaunchAgents/ai.openclaw.claude-proxy.plist` and replace placeholders.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.openclaw.claude-proxy</string>

  <key>ProgramArguments</key>
  <array>
    <string><path-to-node></string>
    <string><path-to-repo>/dist/server/standalone.js</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string><HOME></string>
    <key>PATH</key><string><path-containing-claude>:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>

    <key>CLAUDE_PROXY_PORT</key><string>3456</string>
    <key>CLAUDE_PROXY_RUNTIME</key><string>stream-json</string>
    <key>CLAUDE_PROXY_FALLBACK_ON_STREAM_FAILURE</key><string>1</string>

    <!-- Trusted local service mode only. -->
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

Optional tracing:

```xml
<key>CLAUDE_PROXY_TRACE_SQLITE_PATH</key><string><HOME>/.claude-proxy/traces.sqlite</string>
<key>CLAUDE_PROXY_TRACE_SQLITE_RETENTION_DAYS</key><string>7</string>
```

Optional direct n8n MCP injection:

```xml
<key>CLAUDE_PROXY_TOOLS_TRANSLATION</key><string>1</string>
<key>CLAUDE_PROXY_MCP_ALLOW</key><string>n8n</string>
<key>CLAUDE_PROXY_N8N_API_URL</key><string>https://n8n.example.com/api/v1</string>
<key>CLAUDE_PROXY_N8N_API_KEY</key><string>&lt;n8n-api-key&gt;</string>
<key>CLAUDE_PROXY_N8N_MCP_BIN</key><string>&lt;path-to-n8n-mcp&gt;</string>
```

Do not commit a real plist containing secrets.

## Load and manage

Load:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.claude-proxy.plist
```

Verify:

```bash
launchctl list | grep ai.openclaw.claude-proxy
curl -s http://127.0.0.1:3456/health
```

Restart:

```bash
/Users/mehdichaouachi/.openclaw/scripts/claude-proxy-safe-restart.sh
```

Avoid bare `launchctl kickstart -k` after plist or environment changes: it can restart the stale loaded job definition. The safe wrapper reloads the plist from disk first and verifies the live env.

Unload:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.claude-proxy.plist
```

View logs:

```bash
tail -f ~/Library/Logs/claude-proxy.stdout.log
tail -f ~/Library/Logs/claude-proxy.stderr.log
```

## Common pitfalls

- LaunchAgents do not inherit your shell startup files. Put every required binary directory in `PATH`.
- `claude auth login` must have been run by the same macOS user.
- If `n8n-mcp` works in your terminal but not in the service, set `CLAUDE_PROXY_N8N_MCP_BIN` to its absolute path.
- If stream-json breaks after a Claude CLI update, temporarily set `CLAUDE_PROXY_RUNTIME=print` and restart.
