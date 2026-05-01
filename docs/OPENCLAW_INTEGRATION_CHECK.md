# OpenClaw Integration Check

Last checked: 2026-05-01 Europe/Zurich.

## Provider registration

`~/.openclaw/openclaw.json` contains provider `claude-proxy`:

- `baseUrl`: `http://127.0.0.1:3456`
- `api`: `openai-completions`
- advertised models:
  - `claude-opus-4-7`
  - `claude-opus-4-6`
  - `claude-sonnet-4-6`
  - `claude-haiku-4-5-20251001`

## Model picker allowlist

`agents.defaults.models` includes:

- `claude-proxy/claude-opus-4-7`
- `claude-proxy/claude-opus-4-6`
- `claude-proxy/claude-sonnet-4-6`
- `claude-proxy/claude-haiku-4-5-20251001`

If a new Claude model is added, update both the provider model list and this allowlist, then run the model-drift tests.

## Timeout posture

OpenClaw default LLM idle timeout is currently `300` seconds. Claude Proxy stream responses emit non-empty ZWSP content heartbeats so OpenClaw-compatible clients see countable activity during long Claude turns.

## Live checks

- `/health` on `127.0.0.1:3456` returned `status: ok`, runtime `stream-json`.
- Live trace SQLite status reported `enabled: true`, `pathConfigured: true`, `retentionMs: 604800000`.
- `npm run monitor:live` passed against the live proxy.

## Safety notes

- OpenClaw remains authoritative for caller-dispatched external OpenAI/OpenClaw tools.
- Inner Claude MCP injection is a separate mode and can bypass OpenClaw dispatcher/audit if Claude executes MCP tools internally; use the caller-dispatched bridge when auditability matters.
- Do not store Claude or n8n secret values in docs or traces.
