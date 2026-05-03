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

OpenClaw default LLM idle timeout is currently `300` seconds. Claude Proxy stream responses use transport-only SSE comment keepalives for generic silence so the proxy does not fabricate assistant `delta.content`. Truthful progress is emitted as visible assistant content when available, in priority order:

1. **n8n workflow progress** — real execution status from the n8n REST API (when `CLAUDE_PROXY_N8N_API_URL` + key are set and the detector sees a webhook call).
2. **Claude runtime phase (tool)** — derived from actual stream-json events, emitted as concise bracketed labels with a random clean status prefix: `[Thinking: using Bash…]` on tool_use start (reports the real tool name), `[Tinkering: waiting for Bash, 12s…]` after 8s silence with a tool in flight. Only the prefix varies; the body remains event-derived, and dedupe uses the semantic phase key rather than the rendered prefix. The raw `Agent` tool gets a deterministic funny subagent name with a visible `Subagent` suffix plus optional activity extracted from tool input: `[Thinking: using Sir Greps-a-Lot Subagent — inspect auth flow…]` / `[Tinkering: waiting for Sir Greps-a-Lot Subagent — inspect auth flow, 12s…]`. Names come from a small built-in whimsical list and are deterministic per tool-call id. Activity is extracted from fields like `description`, `subagent_type`, `prompt`, etc. and sanitized/truncated to a concise one-line display. Other tool names (Read, Bash, Write, etc.) are displayed unchanged. Deduplicated: the same semantic phase is never emitted twice.
3. **Claude runtime phase (thinking)** — inferred, conservative: when the main agent is silent with no tool active for ≥8s, emits a chunk such as `[Checking: thinking…]` once per silent period. Suppressed as soon as any tool or text activity appears. Lower priority than tool phases; does not override real activity.
4. **SSE comment** — transport-only `:keepalive` for generic idle periods with no meaningful phase change. Not parsed as assistant content by OpenAI-compatible clients.

## Live checks

- `/health` on `127.0.0.1:3456` returned `status: ok`, runtime `stream-json`.
- Live trace SQLite status reported `enabled: true`, `pathConfigured: true`, `retentionMs: 604800000`.
- `npm run monitor:live` passed against the live proxy.

## Safety notes

- OpenClaw remains authoritative for caller-dispatched external OpenAI/OpenClaw tools.
- Inner Claude MCP injection is a separate mode and can bypass OpenClaw dispatcher/audit if Claude executes MCP tools internally; use the caller-dispatched bridge when auditability matters.
- Do not store Claude or n8n secret values in docs or traces.
