# Trace Security and Retention

Claude Proxy traces are designed for local debugging and postmortems, not broad telemetry.

## Access boundary

- `/traces` and `/traces/:id` are localhost-gated in the HTTP route layer.
- The live production service binds to `127.0.0.1:3456` by LaunchAgent.
- Do not expose trace endpoints through public nginx/Tailscale relays without adding explicit authentication.

## Redaction guarantees

Trace records store request/transport metadata, bounded error classes, MCP governance decisions, and tool-call shape information. They must not store raw secret values.

Current redaction posture:

- Tool argument values are redacted; only argument keys/shape metadata are kept.
- Environment values for secret-looking keys are redacted.
- Prompt/message bodies are not exported in trace export events.
- Health output reports whether a SQLite path is configured, not the raw path.

## Durable SQLite backend

Set `CLAUDE_PROXY_TRACE_SQLITE_PATH` to persist completed redacted traces locally. This also enables trace collection even if `CLAUDE_PROXY_TRACE_ENABLED` is not set.

Recommended production knobs:

```sh
CLAUDE_PROXY_TRACE_ENABLED=1
CLAUDE_PROXY_TRACE_SQLITE_PATH=$HOME/.claude-proxy/traces.sqlite
CLAUDE_PROXY_TRACE_SQLITE_RETENTION_DAYS=7
```

Retention can also be set with `CLAUDE_PROXY_TRACE_SQLITE_RETENTION_MS`. If neither retention env var is set, SQLite traces are retained until manually deleted.

## Operational checks

- Verify `/health` shows `trace.sqlite.enabled: true` and `pathConfigured: true`; the path itself should not be printed.
- Query counts locally with `sqlite3 ~/.claude-proxy/traces.sqlite 'select count(*) from traces;'`.
- Do not attach trace DBs to bug reports unless scrubbed again.
