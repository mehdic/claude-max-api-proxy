# PRD: Opt-In Sticky Claude CLI Sessions

**Status:** Ready for implementation planning  
**Date:** 2026-05-09  
**Owner:** Claude Proxy maintainers  
**Repository:** `/Users/mehdichaouachi/.openclaw/projects/claude-proxy`  
**Primary docs:** `docs/prd/sticky-sessions.md`, `docs/superpowers/plans/2026-05-09-sticky-claude-sessions.md`  
**Target transport:** `stream-json` only for sticky process reuse; `print` remains request-scoped.

---

## Problem

Claude Proxy currently exposes an OpenAI-compatible API over the local `claude` CLI and supports persistent `stream-json` workers through a message-hash-based session pool. That pool works for same-transcript continuation, but it is not deterministic for clients that want to explicitly bind future turns to a specific live Claude CLI session. Clients such as OpenClaw agents, LiveKit voice agents, or custom applications may create new HTTP requests or even fresh outer application sessions while still wanting the next request to resume the same live inner Claude CLI session. Today they cannot express that intent in the request protocol. The proxy decides reuse internally from message shape and pool hashes.

The desired behavior is an optional, generic, backward-compatible mode where the caller passes stable session metadata and the proxy routes each request to the same live Claude CLI subprocess for a configurable TTL, including long-lived sessions such as 24 hours. Normal OpenAI-compatible clients must continue to work unchanged.

---

## Goal

Add a generic, opt-in sticky-session extension to Claude Proxy so callers can request that a stable session key maps to the same live `stream-json` Claude CLI subprocess across turns, while preserving default OpenAI-compatible behavior for requests that do not opt in.

---

## Non-Goals

- Do not hard-code OpenClaw, Sevro, Cassius, Reaper, or any named agent into Claude Proxy behavior.
- Do not require OpenClaw-specific headers for the feature to work.
- Do not change default `/v1/chat/completions` semantics for standard OpenAI clients.
- Do not claim Anthropic server-side prompt cache stays hot for 24 hours. A 24h sticky CLI session preserves local Claude CLI continuity only; server-side prompt-cache TTL remains short-lived.
- Do not enable sticky behavior for `print` runtime. `print` can accept the request fields but must ignore or explicitly report that sticky persistence requires `stream-json`.
- Do not persist raw conversations to disk as part of sticky sessions.
- Do not rely on Claude CLI project JSONL session files; keep `--no-session-persistence` unless a separate future PRD explicitly changes that.
- Do not execute OpenAI/OpenClaw caller-dispatched tools inside the proxy. Existing tool-bridge safety boundaries remain.
- Do not expose user-controlled session keys as Prometheus labels or unredacted logs.
- Do not make the proxy a multi-tenant authorization service. It is still assumed to run as a trusted local service unless deployed behind external auth by the operator.

---

## Background

Claude Proxy has two runtime strategies:

1. **`print` runtime** — one `claude --print` subprocess per request. This is reliable and stateless, but cold per request.
2. **`stream-json` runtime** — persistent NDJSON subprocesses that can accept multiple turns.

Current `stream-json` reuse is implemented in `src/subprocess/session-pool.ts`:

- It maps `hash(model + prior OpenAI messages + disallowed tool policy)` to a live `StreamJsonSubprocess`.
- On a hit, the proxy sends only the latest user turn to the subprocess.
- On a miss, the proxy starts or acquires a pre-initialized process and sends a flattened full prompt.
- After a successful turn, it re-keys the process under the post-turn conversation hash.
- It already has TTL, LRU, warm-hit, cold-spawn, and fingerprint-mismatch counters.

This mechanism improves cache/warm behavior when the exact request history matches. It does not let the caller say: “Use this exact live CLI session for this stable identity for the next 24 hours.”

The new feature adds a caller-selected sticky session key and lifecycle policy while keeping the current hash pool as the default and fallback.

Relevant existing files:

- `src/server/routes.ts` — request handling, runtime resolution, `handleStreamJsonRequest`, trace setup, health endpoints.
- `src/subprocess/session-pool.ts` — current message-hash pool and subprocess lifecycle.
- `src/subprocess/stream-json-manager.ts` — live Claude CLI subprocess wrapper.
- `src/subprocess/init-pool.ts` — pre-initialized subprocess pool.
- `src/server/metrics.ts` — Prometheus metrics.
- `src/trace/builder.ts`, `src/trace/types.ts` — bounded trace metadata.
- `src/types/openai.ts` — request/response types.
- `docs/configuration.md` — environment variables.
- `docs/openclaw-integration.md` — OpenClaw-specific integration notes.

---

## User Stories

- As a normal OpenAI SDK user, I want Claude Proxy to ignore sticky-session behavior unless I explicitly opt in, so my existing code continues to work.
- As a custom app developer, I want to pass a stable session key so multiple HTTP requests are routed to the same live Claude CLI process.
- As an OpenClaw operator, I want each agent/conversation pair to reuse its own live Claude CLI session so short reconnects and follow-up turns preserve local CLI continuity.
- As a LiveKit voice agent developer, I want to set a 24h sticky TTL for long-lived voice personas while still resetting on command.
- As an operator, I want max-session and TTL limits so sticky sessions cannot exhaust RAM or leave zombie subprocesses forever.
- As an operator, I want metrics and health visibility for sticky sessions without leaking raw session keys or prompt content.
- As a security-conscious caller, I want sticky isolation to include model and tool policy, so one sticky key cannot accidentally reuse a subprocess with incompatible capabilities.
- As a test author, I want deterministic unit tests for key normalization, TTL parsing, reset behavior, per-session serialization, and fallback behavior.

---

## Functional Requirements

### FR1 — Default behavior remains OpenAI-compatible

Requests without sticky-session extension parameters must follow the existing behavior:

- Runtime resolution still uses existing env/request rules.
- `stream-json` uses the existing hash-based session pool.
- `print` uses the existing one-shot subprocess path.
- OpenAI request and response schemas remain compatible.
- No new required fields are introduced.

### FR2 — Sticky mode is opt-in per request

A request opts into sticky mode if either of these is true:

1. It includes a valid sticky session key header.
2. It includes a valid sticky session key inside an extension body object.

Supported headers:

| Header | Required? | Example | Meaning |
| --- | --- | --- | --- |
| `X-Claude-Proxy-Session-Key` | yes for header opt-in | `sevro:telegram:5216159759` | Caller-selected stable session key. |
| `X-Claude-Proxy-Session-Mode` | optional | `sticky` | `sticky`, `pool`, or `stateless`. Defaults to `sticky` when key exists. |
| `X-Claude-Proxy-Session-TTL-Seconds` | optional | `86400` | Requested idle TTL in seconds. Server clamps to configured min/max. |
| `X-Claude-Proxy-Session-Reset` | optional | `1` | If truthy, evict existing sticky session before serving this request. |
| `X-Claude-Proxy-Session-Policy` | optional | `strict` | Reserved initially; accepted values `strict`/`compatible`. Default `strict`. |

Supported body extension:

```json
{
  "model": "claude-sonnet-4-6",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": true,
  "claude_proxy": {
    "session_key": "sevro:telegram:5216159759",
    "session_mode": "sticky",
    "session_ttl_seconds": 86400,
    "session_reset": false,
    "session_policy": "strict"
  }
}
```

Body aliases accepted for ergonomics:

- `session`, `sessionKey`, `session_key`
- `mode`, `sessionMode`, `session_mode`
- `ttl_seconds`, `sessionTtlSeconds`, `session_ttl_seconds`
- `reset`, `sessionReset`, `session_reset`

Header precedence:

1. Explicit headers win over body extension fields.
2. Body extension fields win over environment defaults.
3. Environment defaults win over hard-coded defaults.

### FR3 — Sticky session modes

The effective mode must be one of:

- `pool` — existing hash-based pool behavior. This is the default when no sticky key is supplied.
- `sticky` — caller key maps to a live subprocess that survives between requests.
- `stateless` — bypass both sticky and hash session pools for the request. In `stream-json`, acquire a process for the single request and discard it afterward. In `print`, current behavior already matches this.

Rules:

- If a sticky key is supplied and no mode is supplied, effective mode is `sticky`.
- If mode is `sticky` but no valid key is supplied, return HTTP 400 with `invalid_session_key`.
- If mode is `pool`, ignore sticky key fields and use existing hash-based pool.
- If mode is `stateless`, ignore sticky key fields and do not return a subprocess to either sticky or hash pool.
- If runtime is `print` and mode is `sticky`, return HTTP 400 unless a compatibility env var explicitly downgrades to `pool`/`stateless`.

### FR4 — Session key normalization and safety

The caller-provided session key must be validated before use.

Validation rules:

- Type: string.
- Trim whitespace.
- Length after trim: 1 to `CLAUDE_PROXY_STICKY_KEY_MAX_LENGTH`, default 256.
- Reject control characters.
- Reject strings containing newline, carriage return, tab, null byte, or path separators that could confuse logs: `/`, `\\` are allowed only if stored hashed and never used as file paths; safer implementation may reject them.
- Accept common delimiters: `:`, `.`, `_`, `-`, `@`, `#`.
- Never use raw key as a metric label.
- Never print raw key by default. Logs and traces use a SHA-256 digest prefix.

Recommended normalized key type:

```ts
export interface StickySessionIdentity {
  rawKey: string;
  keyHash: string;
  displayKey: string; // first 12 chars of hash only, never raw input
}
```

### FR5 — Isolation fingerprint

Sticky sessions must not be keyed solely by the raw caller session key. The effective internal key must include compatibility dimensions so unsafe reuse cannot cross incompatible contexts.

Internal sticky fingerprint dimensions:

- normalized caller session key hash
- model id after `extractModel`
- runtime (`stream-json`)
- disallowed tools key / MCP governance policy that affects Claude spawn flags
- direct MCP injection state if it affects available tools
- optional workspace/cwd if the subprocess start context varies by request or deployment
- Claude CLI capability-affecting env flags such as dynamic system prompt exclusion when they change worker startup behavior

Minimum required implementation:

```ts
export interface StickySessionFingerprint {
  sessionKeyHash: string;
  model: ClaudeModel;
  runtime: "stream-json";
  disallowedToolsKey: string;
  mcpPolicyKey: string;
  cwd: string;
  dynamicPromptExclusion: boolean;
}
```

If an existing sticky slot has the same caller key but a different fingerprint, the proxy must not reuse it. It must either:

- create a separate sticky slot under the full fingerprint key, or
- evict the incompatible slot and cold-start a new one.

Preferred behavior: full fingerprint key permits concurrent incompatible variants while enforcing global max-session caps.

### FR6 — Sticky acquisition behavior

When effective mode is `sticky`:

1. Evict expired/unhealthy sticky slots.
2. If reset is requested, evict matching sticky slots for the caller key/fingerprint before acquiring.
3. If a matching healthy slot exists, serialize access through its per-slot lock and send the appropriate user prompt into that subprocess.
4. If no matching healthy slot exists, cold/acquire from init pool and create a sticky slot.
5. After successful turn, keep the subprocess in the same sticky slot and update `lastUsedAt`, `turnCount`, and `lastRequestId`.
6. After failure, watchdog kill, or client disconnect before completion, discard the subprocess and remove the sticky slot.

Prompt send behavior:

- For the first request in a sticky session, send the same cold prompt that existing `acquireSession` would send: the full flattened OpenAI messages prompt.
- For subsequent requests in the same sticky session, send only the last user turn if the previous turn completed successfully and the slot is marked `readyForIncrementalTurn`.
- If the incoming request includes messages that do not look like a direct continuation of the sticky state, the proxy should choose correctness over warmth. Initial implementation may require clients to send the full transcript but still use incremental last-turn sending after the first successful sticky turn.
- If the proxy cannot determine safe incremental behavior, it must evict and cold-start or use full prompt statelessly rather than silently corrupt context.

### FR7 — Per-session serialization

A single Claude CLI subprocess cannot safely handle two simultaneous turns. Sticky slots must enforce one active request at a time per slot.

Required behavior:

- If request B arrives for a sticky slot while request A is active, B waits in a FIFO queue up to `CLAUDE_PROXY_STICKY_QUEUE_TIMEOUT_MS`.
- Default queue timeout: 120000 ms.
- If the wait times out, return HTTP 409 or 429 with `sticky_session_busy`.
- On client disconnect while queued, remove it from the queue.
- Metrics must count queued, queue timeout, and busy rejections.
- Hash-pool behavior may remain unchanged initially; serialization is mandatory for sticky slots.

### FR8 — TTL and capacity

Sticky sessions must have configurable bounds.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_PROXY_STICKY_SESSIONS` | unset / off | If `1`, sticky mode is allowed. If unset, sticky requests return a clear 400/403 depending chosen policy. |
| `CLAUDE_PROXY_STICKY_DEFAULT_TTL_SECONDS` | `3600` | Default idle TTL when request does not specify one. |
| `CLAUDE_PROXY_STICKY_MIN_TTL_SECONDS` | `60` | Minimum idle TTL. |
| `CLAUDE_PROXY_STICKY_MAX_TTL_SECONDS` | `86400` | Maximum idle TTL. |
| `CLAUDE_PROXY_STICKY_ABSOLUTE_TTL_SECONDS` | `86400` | Max lifetime from creation, even if active. `0` disables absolute TTL. |
| `CLAUDE_PROXY_STICKY_MAX_SESSIONS` | `8` | Maximum live sticky slots. |
| `CLAUDE_PROXY_STICKY_QUEUE_TIMEOUT_MS` | `120000` | Max time a request waits for a busy sticky session. |
| `CLAUDE_PROXY_STICKY_ALLOW_BODY_OPTIONS` | `1` | Enables body extension parsing. Headers remain supported. |
| `CLAUDE_PROXY_STICKY_LOG_RAW_KEYS` | unset / off | Debug-only. If not `1`, raw keys never appear in logs/traces. |

TTL rules:

- Requested TTL is clamped to min/max.
- Idle TTL evicts sessions not used within the configured window.
- Absolute TTL evicts sessions older than configured max lifetime, even if repeatedly used.
- LRU eviction applies when max sticky sessions is reached.
- Sticky capacity is separate from existing hash-pool capacity. Operators must size total worker caps consciously.

### FR9 — Reset behavior

A caller must be able to reset a sticky session.

Reset triggers:

- Header `X-Claude-Proxy-Session-Reset: 1`, `true`, `yes`, or `on`.
- Body `claude_proxy.session_reset: true`.
- Future optional endpoint `DELETE /sessions/:hash` is out of scope for first release.

Reset behavior:

- If mode is sticky and reset is true, kill and remove the matching sticky slot before serving the request.
- If a matching request is active, reset request waits for the lock or returns `sticky_session_busy` depending policy. Initial implementation should return 409 to avoid killing an in-flight turn.
- Reset response should proceed with a fresh subprocess if the request also contains messages.
- Response should include header `X-Claude-Proxy-Sticky-Reset: 1` when reset occurred.

### FR10 — Response headers

Sticky requests should expose non-sensitive debugging headers.

Headers:

| Header | Example | Meaning |
| --- | --- | --- |
| `X-Claude-Proxy-Session-Mode` | `sticky` | Effective session mode. |
| `X-Claude-Proxy-Sticky-Hit` | `1` | `1` if reused existing sticky subprocess, `0` if cold-created. |
| `X-Claude-Proxy-Sticky-Key-Hash` | `a1b2c3d4e5f6` | Short hash prefix only. |
| `X-Claude-Proxy-Sticky-TTL-Seconds` | `86400` | Effective clamped idle TTL. |
| `X-Claude-Proxy-Sticky-Turn-Count` | `3` | Number of successful turns on this sticky slot after completion when known. |

Headers must be absent or set to `pool`/`stateless` for non-sticky modes without breaking clients.

### FR11 — Metrics

Add bounded-cardinality Prometheus metrics.

Required metrics:

```text
claude_proxy_sticky_sessions_size{state="live"} <n>
claude_proxy_sticky_sessions_size{state="max"} <n>
claude_proxy_sticky_hits_total <n>
claude_proxy_sticky_cold_starts_total <n>
claude_proxy_sticky_resets_total <n>
claude_proxy_sticky_ttl_evictions_total <n>
claude_proxy_sticky_absolute_ttl_evictions_total <n>
claude_proxy_sticky_lru_evictions_total <n>
claude_proxy_sticky_unhealthy_evictions_total <n>
claude_proxy_sticky_fingerprint_mismatches_total <n>
claude_proxy_sticky_busy_rejections_total <n>
claude_proxy_sticky_queue_timeouts_total <n>
claude_proxy_sticky_mode_requests_total{mode="sticky|pool|stateless",status="accepted|rejected"} <n>
```

Rules:

- Do not label by raw session key.
- Do not label by user-supplied arbitrary strings.
- If mode labels are used, they must be from a fixed enum.

### FR12 — Health and trace visibility

`/health` and `/healthz/deep` should include a sticky summary:

```json
{
  "stickySessions": {
    "enabled": true,
    "size": 2,
    "max": 8,
    "defaultTtlSeconds": 3600,
    "maxTtlSeconds": 86400,
    "absoluteTtlSeconds": 86400,
    "queueTimeoutMs": 120000
  }
}
```

Trace records should include non-sensitive sticky metadata:

```json
{
  "sessionMode": "sticky",
  "stickySessionHit": true,
  "stickySessionKeyHash": "a1b2c3d4e5f6",
  "stickyTtlSeconds": 86400,
  "stickyTurnCount": 3,
  "stickyEvictionReason": null
}
```

Trace redaction must guarantee the raw session key is not persisted unless `CLAUDE_PROXY_STICKY_LOG_RAW_KEYS=1`, and even then durable traces should still prefer redaction.

### FR13 — Compatibility with Responses API

The existing Responses API path translates to chat internally. Sticky options should eventually work for `/v1/responses`, but first release can scope support to Chat Completions if the PRD/plan states it explicitly.

Required first-release behavior:

- `/v1/chat/completions` supports sticky sessions.
- `/v1/responses` may either:
  - support the same headers; or
  - return/trace `sessionMode=pool` and ignore body extension until a follow-up task.

Preferred first-release behavior: support sticky headers on both Chat Completions and Responses because headers are transport-level and routes already pass through chat helpers.

### FR14 — Error responses

Error responses must be OpenAI-compatible where possible.

Examples:

Invalid key:

```json
{
  "error": {
    "message": "X-Claude-Proxy-Session-Key must be a non-empty string up to 256 characters",
    "type": "invalid_request_error",
    "code": "invalid_session_key"
  }
}
```

Sticky disabled:

```json
{
  "error": {
    "message": "Sticky sessions are disabled. Set CLAUDE_PROXY_STICKY_SESSIONS=1 to enable this opt-in extension.",
    "type": "invalid_request_error",
    "code": "sticky_sessions_disabled"
  }
}
```

Busy:

```json
{
  "error": {
    "message": "Sticky session is already processing another request",
    "type": "server_error",
    "code": "sticky_session_busy"
  }
}
```

### FR15 — Documentation

Update docs:

- `docs/configuration.md` — env vars and examples.
- `docs/openclaw-integration.md` — how OpenClaw can pass sticky headers or body fields, without hard-coding agents.
- `README.md` or `PROTOCOL.md` — public API extension summary.
- Infrastructure docs:
  - `/Users/mehdichaouachi/.openclaw/workspace/memory/infra/claude-proxy.md`
  - `/Users/mehdichaouachi/.openclaw/workspace/memory/infrastructure.md`

---

## Acceptance Criteria

### Backward compatibility

- [ ] Existing non-sticky Chat Completions requests still pass all current tests.
- [ ] Existing `print` runtime behavior is unchanged for normal requests.
- [ ] Existing `stream-json` hash pool behavior remains default when no sticky key/mode is supplied.
- [ ] Existing OpenAI SDK smoke/matrix remains green.

### Sticky API

- [ ] Header-based sticky session key creates a sticky subprocess on first request.
- [ ] Second request with same sticky key/model/tool policy reuses the same live subprocess.
- [ ] Body-extension sticky session key works when `CLAUDE_PROXY_STICKY_ALLOW_BODY_OPTIONS=1`.
- [ ] Headers override body fields.
- [ ] `session_mode=pool` forces existing hash-pool behavior even if body has sticky options.
- [ ] `session_mode=stateless` bypasses both sticky and hash pools.
- [ ] Invalid sticky key returns HTTP 400 with `invalid_session_key`.
- [ ] Sticky request while sticky feature disabled returns clear error.

### Safety

- [ ] Different model with same session key does not reuse the same subprocess.
- [ ] Different disallowed tool policy with same session key does not reuse the same subprocess.
- [ ] Client disconnect before completion discards sticky subprocess.
- [ ] Watchdog kill removes sticky subprocess.
- [ ] In-flight sticky session rejects or queues concurrent request according to implementation policy.
- [ ] Reset kills old subprocess and creates a new one.
- [ ] Raw sticky session keys do not appear in default logs, metrics, traces, or health output.

### Lifecycle

- [ ] Idle TTL eviction works and increments metrics.
- [ ] Absolute TTL eviction works and increments metrics.
- [ ] LRU eviction works and increments metrics.
- [ ] Max sticky sessions cap is enforced.
- [ ] Queue timeout works and increments metrics.

### Observability

- [ ] `/health` includes sticky configuration and live size.
- [ ] `/healthz/deep` includes sticky configuration and live size.
- [ ] `/metrics` includes sticky counters and gauges with bounded labels.
- [ ] Trace records include sticky mode, hit/miss, key hash prefix, TTL, and turn count.
- [ ] Response headers include effective sticky mode/hit/key hash/TTL for sticky requests.

### Validation commands

- [ ] `npm run build` passes.
- [ ] `npm test` passes.
- [ ] `npm run canary:stream-json` passes.
- [ ] `npm run soak:quick` passes.
- [ ] `npm run sdk:matrix` passes or skipped dependencies are explicitly reported.
- [ ] Manual sticky two-turn smoke proves the same session key hits the sticky path.
- [ ] Manual non-sticky smoke proves default mode remains unchanged.

---

## Technical Design

### Module: Sticky request options parser

**Create:** `src/server/sticky-options.ts`

Responsibility:

- Parse sticky headers and `body.claude_proxy` extension fields.
- Resolve precedence.
- Validate mode, key, TTL, reset flag, policy.
- Return normalized `SessionModeOptions` or an OpenAI-compatible error object.

Interface:

```ts
export type SessionMode = "pool" | "sticky" | "stateless";
export type StickySessionPolicy = "strict" | "compatible";

export interface StickySessionConfig {
  enabled: boolean;
  allowBodyOptions: boolean;
  keyMaxLength: number;
  defaultTtlSeconds: number;
  minTtlSeconds: number;
  maxTtlSeconds: number;
  absoluteTtlSeconds: number;
  maxSessions: number;
  queueTimeoutMs: number;
  logRawKeys: boolean;
}

export interface ResolvedSessionOptions {
  mode: SessionMode;
  sticky?: {
    rawKey: string;
    keyHash: string;
    keyHashShort: string;
    ttlSeconds: number;
    reset: boolean;
    policy: StickySessionPolicy;
  };
}

export interface SessionOptionsError {
  status: number;
  code: string;
  message: string;
}

export function stickySessionConfigFromEnv(env?: NodeJS.ProcessEnv): StickySessionConfig;
export function resolveSessionOptions(req: Pick<Request, "headers" | "body">, config?: StickySessionConfig): ResolvedSessionOptions | SessionOptionsError;
export function isSessionOptionsError(value: unknown): value is SessionOptionsError;
```

Tests:

- Header parse.
- Body parse.
- Header precedence.
- TTL clamp.
- Disabled behavior.
- Invalid key behavior.
- Boolean reset parse.
- Mode parse.

### Module: Sticky session pool

**Create:** `src/subprocess/sticky-session-pool.ts`

Responsibility:

- Maintain caller-keyed live `StreamJsonSubprocess` slots.
- Enforce TTL, absolute TTL, LRU cap, health eviction.
- Enforce per-slot serialization.
- Create workers through `acquirePreInit` or dedicated spawn when disallowed tools require spawn-time policy.
- Return acquisition metadata for routes.

Interface:

```ts
export interface StickyAcquireOptions {
  sessionKeyHash: string;
  sessionKeyHashShort: string;
  ttlSeconds: number;
  reset: boolean;
  model: ClaudeModel;
  messages: OpenAIChatMessage[];
  disallowedTools?: string[];
  mcpPolicyKey?: string;
  cwd?: string;
  dynamicPromptExclusion?: boolean;
}

export interface StickyAcquireResult {
  subprocess: StreamJsonSubprocess;
  isStickyHit: boolean;
  isWarm: boolean;
  userText: string;
  keyHashShort: string;
  ttlSeconds: number;
  turnCount: number;
  release: (result: StickyReleaseResult) => void;
}

export type StickyReleaseResult =
  | { status: "success"; assistantText: string }
  | { status: "discard"; reason: StickyEvictionReason };

export type StickyEvictionReason =
  | "reset"
  | "idle_ttl"
  | "absolute_ttl"
  | "lru"
  | "unhealthy"
  | "fingerprint_mismatch"
  | "client_disconnect"
  | "watchdog"
  | "turn_error";

export async function acquireStickySession(options: StickyAcquireOptions): Promise<StickyAcquireResult>;
export function stickyPoolStats(): StickyPoolStats;
export const stickyPoolCounters: StickyPoolCounters;
```

Tests:

- First request creates slot.
- Same key/fingerprint reuses slot.
- Same key/different model does not reuse same slot.
- Reset evicts.
- Idle TTL evicts.
- Absolute TTL evicts.
- LRU evicts.
- Unhealthy slot evicts.
- Concurrent acquire is serialized or rejected.

### Module: Route integration

**Modify:** `src/server/routes.ts`

Responsibility:

- Parse session options early after body validation.
- Choose path:
  - `pool` → existing `acquireSession`/`returnSession`.
  - `sticky` → new `acquireStickySession`/release API.
  - `stateless` → acquire process and discard after turn.
- Attach response headers.
- Trace sticky metadata.
- Ensure all error paths release/discard correctly.

### Module: Metrics

**Modify:** `src/server/metrics.ts`

Responsibility:

- Import sticky stats/counters.
- Render sticky metrics with bounded labels only.
- Reset sticky counters in test reset path if existing reset helper supports it.

### Module: Trace metadata

**Modify:** `src/trace/types.ts`, `src/trace/builder.ts`, `src/trace/redact.ts`

Responsibility:

- Add optional sticky fields to trace records.
- Ensure raw key is never recorded.
- Add builder methods for sticky mode/hit/TTL/turn count/eviction reason.

### Module: OpenAI request types

**Modify:** `src/types/openai.ts`

Responsibility:

- Add optional `claude_proxy` extension field to request types.
- Keep type optional and permissive enough for unknown fields.

### Module: Docs

**Modify/Create:**

- `docs/configuration.md`
- `docs/openclaw-integration.md`
- `PROTOCOL.md`
- `README.md`
- `/Users/mehdichaouachi/.openclaw/workspace/memory/infra/claude-proxy.md`
- `/Users/mehdichaouachi/.openclaw/workspace/memory/infrastructure.md`

---

## Data Model

### Request extension

```ts
export interface ClaudeProxyRequestExtension {
  session_key?: string;
  sessionKey?: string;
  session?: string;
  session_mode?: "pool" | "sticky" | "stateless";
  sessionMode?: "pool" | "sticky" | "stateless";
  mode?: "pool" | "sticky" | "stateless";
  session_ttl_seconds?: number | string;
  sessionTtlSeconds?: number | string;
  ttl_seconds?: number | string;
  session_reset?: boolean | string | number;
  sessionReset?: boolean | string | number;
  reset?: boolean | string | number;
  session_policy?: "strict" | "compatible";
  sessionPolicy?: "strict" | "compatible";
}
```

### Sticky slot

```ts
interface StickySlot {
  subprocess: StreamJsonSubprocess;
  internalKey: string;
  keyHashShort: string;
  createdAt: number;
  lastUsedAt: number;
  ttlMs: number;
  turnCount: number;
  active: boolean;
  queue: Array<QueuedAcquire>;
  fingerprint: StickySessionFingerprint;
  readyForIncrementalTurn: boolean;
}
```

### Internal key

```ts
internalKey = sha256(JSON.stringify({
  version: 1,
  sessionKeyHash,
  model,
  runtime: "stream-json",
  disallowedToolsKey,
  mcpPolicyKey,
  cwd,
  dynamicPromptExclusion,
}))
```

---

## Edge Cases

- **Client sends sticky key but feature disabled:** reject clearly; do not silently pool.
- **Client sends invalid TTL:** reject if non-numeric; clamp if numeric out of range.
- **Client sends same key with different model:** separate internal slot or evict; never reuse same process.
- **Client sends same key while active turn running:** queue or reject with bounded timeout.
- **Client disconnects during streaming:** discard sticky subprocess, because turn completion is unknown.
- **Claude CLI exits unexpectedly:** remove slot and increment unhealthy/crash metric.
- **Watchdog kills subprocess:** remove slot and record eviction reason.
- **Reset while active:** initial release should reject with 409 instead of killing active request.
- **Long TTL with memory pressure:** LRU max cap still evicts oldest idle sticky sessions.
- **Response API caller uses body extension:** only supported if implementation plumbs body through; headers are preferred and should work earlier.
- **Raw key includes PII:** proxy hashes and redacts; operators still should avoid embedding secrets in keys.

---

## Security and Privacy Requirements

- Raw session keys are treated as sensitive metadata.
- Raw prompts are not added to sticky metrics/logs.
- Sticky sessions do not change tool execution policy.
- Tool policy is part of the fingerprint.
- MCP injection state that changes available local tools is part of the fingerprint.
- No raw key in Prometheus labels.
- No raw key in durable traces by default.
- No disk persistence of session transcripts.
- Operators must opt in via `CLAUDE_PROXY_STICKY_SESSIONS=1`.

---

## Rollout Plan

1. Implement behind `CLAUDE_PROXY_STICKY_SESSIONS=1`.
2. Keep default disabled for public release if desired, or enabled only when explicitly requested by clients.
3. Ship docs showing normal OpenAI clients are unaffected.
4. Validate locally with unit tests and smoke tests.
5. Enable on Mehdi's LaunchAgent with conservative defaults first:
   - `CLAUDE_PROXY_STICKY_SESSIONS=1`
   - `CLAUDE_PROXY_STICKY_DEFAULT_TTL_SECONDS=3600`
   - `CLAUDE_PROXY_STICKY_MAX_TTL_SECONDS=86400`
   - `CLAUDE_PROXY_STICKY_MAX_SESSIONS=8`
6. Update OpenClaw/voice clients later to pass stable session headers.
7. Observe `/metrics`, `/health`, and traces for sticky hit/miss and evictions.
8. If stable, raise selected clients to 24h TTL by request header rather than hard-coding server-side agents.

---

## Open Questions

- Should first release support sticky body extension for `/v1/responses`, or headers only?
  - Recommendation: headers for both Chat and Responses; body extension for Chat first.
- Should `CLAUDE_PROXY_STICKY_SESSIONS` default to disabled or enabled but inert unless key is supplied?
  - Recommendation: disabled for first release, then consider enabled-by-default once tested.
- Should reset while active wait or reject?
  - Recommendation: reject with 409 for first release.
- Should `stateless` in `stream-json` reuse init-pool or always spawn dedicated?
  - Recommendation: use init-pool for speed but always discard after request.
- Should raw session key logging ever be allowed?
  - Recommendation: keep env var for local debugging, but never include raw keys in metrics or durable traces.

---

## Success Metrics

- Normal non-sticky request regression: 0 failures in existing unit/smoke/SDK matrix.
- Sticky two-turn smoke: second turn reports `X-Claude-Proxy-Sticky-Hit: 1` and lower latency than cold path in typical cases.
- Safety tests: no cross-model or cross-tool-policy reuse.
- Stability: no leaked live sticky subprocesses after TTL/absolute TTL/reset/failure simulations.
- Observability: sticky counters visible in `/metrics`; sticky summary visible in `/health`.

---

## Example Usage

### Normal OpenAI-compatible request — unchanged

```bash
curl -s http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Reply OK only."}]}'
```

### Sticky request with 24h TTL

```bash
curl -s http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Claude-Proxy-Session-Key: my-app:user-42:conversation-7' \
  -H 'X-Claude-Proxy-Session-Mode: sticky' \
  -H 'X-Claude-Proxy-Session-TTL-Seconds: 86400' \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Remember that my test word is orchid."}]}'
```

### Reset a sticky session

```bash
curl -s http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Claude-Proxy-Session-Key: my-app:user-42:conversation-7' \
  -H 'X-Claude-Proxy-Session-Mode: sticky' \
  -H 'X-Claude-Proxy-Session-Reset: 1' \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Start fresh. Reply OK."}]}'
```

### Body extension request

```bash
curl -s http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role":"user","content":"Continue my sticky session."}],
    "claude_proxy": {
      "session_key": "my-app:user-42:conversation-7",
      "session_mode": "sticky",
      "session_ttl_seconds": 86400
    }
  }'
```
