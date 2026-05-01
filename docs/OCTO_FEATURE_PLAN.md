# claude-proxy — Octo Feature Plan

Date: 2026-05-01

## Positioning

`claude-proxy` should be the fast Claude subscription bridge: optimized for Claude Pro/Max traffic, low latency through the persistent `stream-json` runtime, safe caller-dispatched tool calls, and explicit governance around optional MCP execution.

Do not try to turn it into a full router, workflow engine, or generic MCP platform. That way lies another infrastructure swamp. We already own enough swamps.

## Octo debate synthesis

### Balanced analyst

The strongest value in `claude-proxy` is the warm Claude CLI runtime. Preserve that advantage, but harden it because `stream-json` is reverse-engineered and therefore operationally fragile. Tool support should stay caller-dispatched by default so OpenClaw keeps approvals, allowlists, and audit control.

### Innovative advocate

Use Claude’s ecosystem strengths. Add a safer MCP governance layer, richer developer traces, artifact-like output handling, and context compression around session eviction. Make the proxy feel like a premium local Claude runtime, not just a format converter.

### Pragmatic engineer

Do not expand before stabilizing the transport. Add parser fixtures, fallback metrics, trace/replay, and practical Responses compatibility. Treat direct MCP injection as privileged/debug-only until there is a strong policy boundary.

## Phase 0 — documentation and release hygiene

- Keep README, `MODEL_DRIFT.md`, and infra docs aligned with the current default runtime: `stream-json` with `print` fallback.
- Document that `/v1/responses` currently has minimal compatibility and should not be advertised as full OpenAI Responses parity.
- Keep model aliases synchronized across adapter maps, advertised `/models`, metrics label allowlist, OpenClaw provider config, and agent model allowlists.

## Phase 1 — transport hardening

Goal: make `stream-json` boring. Boring is the dream.

Deliverables:

- ✅ Fixture-based parser tests for partial, malformed, interleaved, and unexpected Claude CLI stream events.
- ✅ Explicit protocol-error classes with bounded Prometheus labels (`ProtocolErrorClass` taxonomy in `errors.ts`, including `upstream_hard_dead`).
- ✅ Canary script that runs after a Claude CLI update and validates handshake, first token, usage fields, tool calls, and graceful shutdown (`npm run canary:stream-json`).
- ✅ Stronger stream-json to print fallback classification before bytes are committed (`classifyFallbackReason` in `routes.ts`).
- ✅ More visible health output: Claude CLI version, selected runtime, init-pool state, session-pool state, and last protocol error class (`/health` endpoint enhanced in `routes.ts`).

Acceptance checks:

- ✅ `npm run build`
- ✅ `npm test` (181 tests pass)
- `npm run soak:quick`
- local stream-json canary against all advertised models (`npm run canary:stream-json`; requires live Claude CLI auth)

## Phase 2 — tool trace and replay

Goal: make prompt-based tool bridging debuggable instead of mystical.

Deliverables:

- ✅ Generate a stable `trace_id` per request and return it in `X-Claude-Proxy-Trace-Id` (`trace/builder.ts`).
- ✅ Record recent in-memory traces with redaction: model, runtime, tools offered, tool choice, parsed JSON source, emitted `tool_calls`, tool results reinjected, finish reason, fallback path, error class (`trace/store.ts`, `trace/redact.ts`).
- ✅ Add optional `GET /traces/:id` for local debugging, gated to localhost and disabled unless explicitly enabled (`CLAUDE_PROXY_TRACE_ENABLED=1`).
- ✅ Add tests for trace records: tool call data, secret redaction, MCP decisions, error classification, governance policy (`trace-store.test.ts`).

Acceptance checks:

- ✅ Tool bridge tests prove trace data is present without leaking raw secrets.
- ✅ Metrics include bounded counters for semantic parse outcomes (`emitted`, `no_call`, `malformed`, `rejected`) and emitted tool calls (`recordToolCallParse` and `recordErrorClass` wired in `routes.ts`).

## Phase 3 — MCP governance mode

Goal: keep the useful MCP path without pretending it is governed when it is not.

Deliverables:

- ✅ Make caller-dispatched OpenAI/OpenClaw tool bridge the documented safe default (README documents this).
- ✅ Add a clear runtime warning when `CLAUDE_PROXY_TOOLS_TRANSLATION=1` enables inner MCP injection (`emitMcpInjectionWarning()` in `governance.ts`, called at boot from `standalone.ts`).
- ✅ Add allow/deny policy for injected MCP servers and overlapping tool names (`applyMcpPolicy`, `applyMcpPolicyWithEnv`, `detectOverlappingTools` in `governance.ts`; `CLAUDE_PROXY_MCP_ALLOW` / `CLAUDE_PROXY_MCP_DENY` env vars).
- ✅ Trace every MCP injection decision: server loaded, server skipped, secret reference resolved/not resolved, overlapping tool disallowed (`SecretResolutionDecision` in `openclaw-config.ts`, `secretDecisionsToTrace` in `governance.ts`, `TraceMcpDecision` extended with secret actions).
- ✅ Document privileged/debug mode semantics in README.

Acceptance checks:

- ✅ OpenClaw tool smoke still emits `tool_calls` rather than executing overlapping MCP tools locally.
- ✅ MCP injection smoke documents the audit trade-off and never logs secret values (tests verify no raw secrets in trace records).

## Phase 4 — Responses API practical parity

Goal: support the clients we actually use, not cosplay the entire OpenAI platform.

Deliverables:

- ✅ Move Responses handling onto the warm `stream-json` runtime where feasible (`handleResponsesStreamJson` in `routes.ts`; `print` remains available via runtime override/fallback).
- ✅ Add practical Responses output items for text and function calls (`responses.ts` adapter).
- ✅ Add streaming lifecycle events for function calls and completion aliases expected by common SDKs (`responses.ts` streaming path).
- ✅ Preserve usage/cost annotations in both streaming and non-streaming Responses.
- ✅ Fix non-streaming Responses trace: proper tool call detection, correct `finishReason`, tool call recording in trace (`routes.ts` Responses non-streaming handler).
- ✅ Add adapter/event fixture tests plus live client matrix harness (`npm run sdk:matrix`) covering fetch wire compatibility, Python stdlib, and OpenAI Node/Python + LangChain clients when installed (`npm run setup:sdk-matrix` prepares local optional deps).

Acceptance checks:

- Chat and Responses both pass streaming/non-streaming unit/adapter tests; live soak and SDK matrix are operator-run because they require Claude CLI auth and a running proxy.
- ✅ Responses tool-call smoke returns function-call output items without native MCP execution leaks.

## Phase 5 — thin observability export

Goal: export useful traces without building an observability product inside the proxy. Revolutionary restraint.

Deliverables:

- ✅ Optional span-shaped export for request, backend turn, fallback/error metadata, tool-call emission, and MCP governance decisions (`CLAUDE_PROXY_TRACE_EXPORT_URL`).
- ✅ Durable local SQLite trace persistence via `CLAUDE_PROXY_TRACE_SQLITE_PATH` for postmortems that survive process restarts, with optional retention pruning via `CLAUDE_PROXY_TRACE_SQLITE_RETENTION_DAYS` / `_MS`.
- ✅ Redaction controls by design: prompts/tool argument values/env values are not exported or persisted; only metadata and argument keys leave volatile memory.
- ✅ Optional OpenInference-style attributes via `CLAUDE_PROXY_TRACE_EXPORT_FORMAT=openinference`; generic JSON is the default.

Acceptance checks:

- ✅ Disabled by default.
- ✅ Enabled mode produces trace IDs that line up with response headers and local trace records.

## Phase 6 — optional later features

Only do these after the earlier phases are stable:

- Context compression or summary-on-eviction for long-running stream-json sessions.
- Artifact/file output endpoint if real UI clients need it.
- Semantic caching for deterministic low-temperature requests.
- Routing/fallback across Claude/Codex/direct API providers. Prefer doing this above the proxies unless a concrete client needs it here.

## Non-goals

- Do not store Claude OAuth tokens.
- Do not expose the proxy beyond localhost without a separate auth/security review.
- Do not make direct MCP execution the default path for OpenClaw tools.
- Do not build a full agent orchestrator inside this project.


## Operational follow-ups added after v1.0.5

- Trace endpoint/security posture is documented in [`TRACE_SECURITY.md`](TRACE_SECURITY.md).
- Lightweight production monitoring is available via `npm run monitor:live`; production alerting is configured with `CLAUDE_PROXY_MONITOR_ALERT_COMMAND`.
