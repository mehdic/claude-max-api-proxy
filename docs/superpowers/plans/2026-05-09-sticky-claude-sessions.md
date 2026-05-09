# Opt-In Sticky Claude CLI Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add generic opt-in sticky Claude CLI sessions so callers can bind a stable session key to the same live `stream-json` subprocess while standard OpenAI-compatible requests continue unchanged.

**Architecture:** Keep existing hash-based `session-pool.ts` as the default `pool` mode. Add request parsing in `sticky-options.ts` and a separate `sticky-session-pool.ts` keyed by caller-provided session identity plus safety fingerprint. Route handlers choose `pool`, `sticky`, or `stateless` per request and expose bounded metrics/traces/headers.

**Tech Stack:** TypeScript, Node.js `node:test`, Express, existing Claude Proxy `stream-json` subprocess manager, Prometheus text metrics, existing trace store.

---

## Spec Source

Primary PRD: `docs/prd/sticky-sessions.md`

The PRD defines the public API, safety constraints, observability, acceptance criteria, and rollout strategy. This plan turns it into implementation tasks.

---

## File Structure

### New files

- `src/server/sticky-options.ts`
  - Parses headers/body extension.
  - Resolves `pool | sticky | stateless`.
  - Validates session key, TTL, reset, policy.
  - Exposes sticky env config.

- `src/subprocess/sticky-session-pool.ts`
  - Maintains live sticky `StreamJsonSubprocess` slots.
  - Enforces TTL, absolute TTL, LRU, health eviction, reset, and per-slot serialization.
  - Uses `acquirePreInit` when safe and dedicated spawn when disallowed tools are present.

- `src/__tests__/sticky-options.test.ts`
  - Unit tests for request parsing and env config.

- `src/__tests__/sticky-session-pool.test.ts`
  - Unit tests for sticky key/fingerprint/lifecycle logic using fake worker doubles where possible.

### Modified files

- `src/types/openai.ts`
  - Add optional `claude_proxy` body extension to Chat and Responses requests.

- `src/server/routes.ts`
  - Parse session options.
  - Route stream-json requests through `pool`, `sticky`, or `stateless` acquisition.
  - Set sticky response headers.
  - Record trace sticky metadata.
  - Ensure all error/client-disconnect/watchdog paths release or discard sticky workers correctly.

- `src/server/metrics.ts`
  - Add sticky gauges/counters.
  - Keep labels bounded.

- `src/trace/types.ts`
  - Add sticky metadata fields.

- `src/trace/builder.ts`
  - Add `setSessionMode`, `setStickySession`, and `setStickyEviction` methods.

- `src/trace/redact.ts`
  - Confirm no raw sticky key is recorded. Add helper only if needed.

- `docs/configuration.md`
  - Document env vars and request headers/body extension.

- `docs/openclaw-integration.md`
  - Document generic OpenClaw integration without hard-coded agents.

- `PROTOCOL.md`
  - Document public optional protocol extension.

- `README.md`
  - Add concise feature summary and link to detailed docs.

- `/Users/mehdichaouachi/.openclaw/workspace/memory/infra/claude-proxy.md`
  - Add roadmap/reference entry for sticky session docs.

- `/Users/mehdichaouachi/.openclaw/workspace/memory/infrastructure.md`
  - Update Claude Proxy index line with sticky-session docs reference.

---

## Implementation Tasks

### Task 1: Add OpenAI request extension types

**Files:**
- Modify: `src/types/openai.ts`
- Test indirectly in: `src/__tests__/sticky-options.test.ts`

- [ ] **Step 1: Add the request extension interfaces**

Insert after `OpenAIError` and before Responses API types:

```ts
export type ClaudeProxySessionMode = "pool" | "sticky" | "stateless";
export type ClaudeProxySessionPolicy = "strict" | "compatible";

export interface ClaudeProxyRequestExtension {
  session_key?: string;
  sessionKey?: string;
  session?: string;
  session_mode?: ClaudeProxySessionMode;
  sessionMode?: ClaudeProxySessionMode;
  mode?: ClaudeProxySessionMode;
  session_ttl_seconds?: number | string;
  sessionTtlSeconds?: number | string;
  ttl_seconds?: number | string;
  session_reset?: boolean | string | number;
  sessionReset?: boolean | string | number;
  reset?: boolean | string | number;
  session_policy?: ClaudeProxySessionPolicy;
  sessionPolicy?: ClaudeProxySessionPolicy;
  policy?: ClaudeProxySessionPolicy;
}
```

- [ ] **Step 2: Add optional extension to `OpenAIChatRequest`**

Modify the interface so it includes:

```ts
  claude_proxy?: ClaudeProxyRequestExtension;
```

The resulting section should include:

```ts
export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  user?: string; // Used for session mapping
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  stream_options?: {
    include_usage?: boolean;
  };
  claude_proxy?: ClaudeProxyRequestExtension;
}
```

- [ ] **Step 3: Add optional extension to `ResponsesRequest`**

Modify the interface so it includes:

```ts
  claude_proxy?: ClaudeProxyRequestExtension;
```

The resulting section should include:

```ts
export interface ResponsesRequest {
  model: string;
  input: ResponsesInput;
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  instructions?: string;
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  claude_proxy?: ClaudeProxyRequestExtension;
}
```

- [ ] **Step 4: Run build to verify type changes compile**

Run:

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
npm run build
```

Expected: TypeScript exits successfully.

- [ ] **Step 5: Commit**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
git add src/types/openai.ts
git commit -m "feat: add Claude proxy session extension types"
```

---

### Task 2: Write sticky option parser tests

**Files:**
- Create: `src/__tests__/sticky-options.test.ts`
- Later implementation: `src/server/sticky-options.ts`

- [ ] **Step 1: Create failing tests**

Create `src/__tests__/sticky-options.test.ts` with this content:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  stickySessionConfigFromEnv,
  resolveSessionOptions,
  isSessionOptionsError,
} from "../server/sticky-options.js";

function req(headers: Record<string, string | undefined>, body: Record<string, unknown> = {}) {
  return { headers, body };
}

test("default request without sticky fields resolves to pool mode", () => {
  const result = resolveSessionOptions(req({}, {}), stickySessionConfigFromEnv({}));
  assert.equal(isSessionOptionsError(result), false);
  if (!isSessionOptionsError(result)) assert.equal(result.mode, "pool");
});

test("header session key opts into sticky mode when enabled", () => {
  const config = stickySessionConfigFromEnv({ CLAUDE_PROXY_STICKY_SESSIONS: "1" });
  const result = resolveSessionOptions(req({
    "x-claude-proxy-session-key": " app:user:conversation ",
    "x-claude-proxy-session-ttl-seconds": "86400",
  }), config);
  assert.equal(isSessionOptionsError(result), false);
  if (!isSessionOptionsError(result)) {
    assert.equal(result.mode, "sticky");
    assert.equal(result.sticky?.rawKey, "app:user:conversation");
    assert.equal(result.sticky?.ttlSeconds, 86400);
    assert.equal(result.sticky?.reset, false);
    assert.match(result.sticky?.keyHashShort || "", /^[a-f0-9]{12}$/);
  }
});

test("body extension opts into sticky mode when body options enabled", () => {
  const config = stickySessionConfigFromEnv({
    CLAUDE_PROXY_STICKY_SESSIONS: "1",
    CLAUDE_PROXY_STICKY_ALLOW_BODY_OPTIONS: "1",
  });
  const result = resolveSessionOptions(req({}, {
    claude_proxy: {
      session_key: "body-session",
      session_mode: "sticky",
      session_ttl_seconds: 3600,
      session_reset: true,
    },
  }), config);
  assert.equal(isSessionOptionsError(result), false);
  if (!isSessionOptionsError(result)) {
    assert.equal(result.mode, "sticky");
    assert.equal(result.sticky?.rawKey, "body-session");
    assert.equal(result.sticky?.ttlSeconds, 3600);
    assert.equal(result.sticky?.reset, true);
  }
});

test("headers override body extension", () => {
  const config = stickySessionConfigFromEnv({
    CLAUDE_PROXY_STICKY_SESSIONS: "1",
    CLAUDE_PROXY_STICKY_ALLOW_BODY_OPTIONS: "1",
  });
  const result = resolveSessionOptions(req({
    "x-claude-proxy-session-key": "header-session",
    "x-claude-proxy-session-mode": "stateless",
  }, {
    claude_proxy: {
      session_key: "body-session",
      session_mode: "sticky",
    },
  }), config);
  assert.equal(isSessionOptionsError(result), false);
  if (!isSessionOptionsError(result)) assert.equal(result.mode, "stateless");
});

test("sticky key while feature disabled returns sticky_sessions_disabled", () => {
  const result = resolveSessionOptions(req({
    "x-claude-proxy-session-key": "disabled-session",
  }), stickySessionConfigFromEnv({}));
  assert.equal(isSessionOptionsError(result), true);
  if (isSessionOptionsError(result)) {
    assert.equal(result.status, 400);
    assert.equal(result.code, "sticky_sessions_disabled");
  }
});

test("explicit sticky mode without key returns invalid_session_key", () => {
  const config = stickySessionConfigFromEnv({ CLAUDE_PROXY_STICKY_SESSIONS: "1" });
  const result = resolveSessionOptions(req({
    "x-claude-proxy-session-mode": "sticky",
  }), config);
  assert.equal(isSessionOptionsError(result), true);
  if (isSessionOptionsError(result)) assert.equal(result.code, "invalid_session_key");
});

test("invalid mode returns invalid_session_mode", () => {
  const config = stickySessionConfigFromEnv({ CLAUDE_PROXY_STICKY_SESSIONS: "1" });
  const result = resolveSessionOptions(req({
    "x-claude-proxy-session-key": "abc",
    "x-claude-proxy-session-mode": "forever",
  }), config);
  assert.equal(isSessionOptionsError(result), true);
  if (isSessionOptionsError(result)) assert.equal(result.code, "invalid_session_mode");
});

test("TTL is clamped to configured min and max", () => {
  const config = stickySessionConfigFromEnv({
    CLAUDE_PROXY_STICKY_SESSIONS: "1",
    CLAUDE_PROXY_STICKY_MIN_TTL_SECONDS: "60",
    CLAUDE_PROXY_STICKY_MAX_TTL_SECONDS: "3600",
  });
  const low = resolveSessionOptions(req({
    "x-claude-proxy-session-key": "low",
    "x-claude-proxy-session-ttl-seconds": "5",
  }), config);
  const high = resolveSessionOptions(req({
    "x-claude-proxy-session-key": "high",
    "x-claude-proxy-session-ttl-seconds": "86400",
  }), config);
  assert.equal(isSessionOptionsError(low), false);
  assert.equal(isSessionOptionsError(high), false);
  if (!isSessionOptionsError(low)) assert.equal(low.sticky?.ttlSeconds, 60);
  if (!isSessionOptionsError(high)) assert.equal(high.sticky?.ttlSeconds, 3600);
});

test("invalid key with control character returns invalid_session_key", () => {
  const config = stickySessionConfigFromEnv({ CLAUDE_PROXY_STICKY_SESSIONS: "1" });
  const result = resolveSessionOptions(req({
    "x-claude-proxy-session-key": "bad\nkey",
  }), config);
  assert.equal(isSessionOptionsError(result), true);
  if (isSessionOptionsError(result)) assert.equal(result.code, "invalid_session_key");
});
```

- [ ] **Step 2: Build and run the new test to verify it fails before implementation**

Run:

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
npm run build
```

Expected: FAIL because `src/server/sticky-options.ts` does not exist.

---

### Task 3: Implement sticky option parser

**Files:**
- Create: `src/server/sticky-options.ts`
- Test: `src/__tests__/sticky-options.test.ts`

- [ ] **Step 1: Create `sticky-options.ts`**

Create `src/server/sticky-options.ts` with this content:

```ts
import { createHash } from "crypto";
import type { Request } from "express";
import type { ClaudeProxyRequestExtension, ClaudeProxySessionMode, ClaudeProxySessionPolicy } from "../types/openai.js";

export type SessionMode = ClaudeProxySessionMode;
export type StickySessionPolicy = ClaudeProxySessionPolicy;

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

const VALID_MODES = new Set<SessionMode>(["pool", "sticky", "stateless"]);
const VALID_POLICIES = new Set<StickySessionPolicy>(["strict", "compatible"]);

export function stickySessionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StickySessionConfig {
  const minTtlSeconds = positiveInt(env.CLAUDE_PROXY_STICKY_MIN_TTL_SECONDS, 60);
  const maxTtlSeconds = Math.max(minTtlSeconds, positiveInt(env.CLAUDE_PROXY_STICKY_MAX_TTL_SECONDS, 86400));
  const defaultTtlSeconds = clamp(
    positiveInt(env.CLAUDE_PROXY_STICKY_DEFAULT_TTL_SECONDS, 3600),
    minTtlSeconds,
    maxTtlSeconds,
  );
  return {
    enabled: env.CLAUDE_PROXY_STICKY_SESSIONS === "1",
    allowBodyOptions: env.CLAUDE_PROXY_STICKY_ALLOW_BODY_OPTIONS !== "0",
    keyMaxLength: positiveInt(env.CLAUDE_PROXY_STICKY_KEY_MAX_LENGTH, 256),
    defaultTtlSeconds,
    minTtlSeconds,
    maxTtlSeconds,
    absoluteTtlSeconds: nonNegativeInt(env.CLAUDE_PROXY_STICKY_ABSOLUTE_TTL_SECONDS, 86400),
    maxSessions: positiveInt(env.CLAUDE_PROXY_STICKY_MAX_SESSIONS, 8),
    queueTimeoutMs: positiveInt(env.CLAUDE_PROXY_STICKY_QUEUE_TIMEOUT_MS, 120000),
    logRawKeys: env.CLAUDE_PROXY_STICKY_LOG_RAW_KEYS === "1",
  };
}

export function isSessionOptionsError(value: unknown): value is SessionOptionsError {
  return Boolean(value && typeof value === "object" && "status" in value && "code" in value && "message" in value);
}

export function resolveSessionOptions(
  req: Pick<Request, "headers" | "body">,
  config: StickySessionConfig = stickySessionConfigFromEnv(),
): ResolvedSessionOptions | SessionOptionsError {
  const bodyExt = readBodyExtension(req.body, config.allowBodyOptions);
  const headerKey = readHeader(req, "x-claude-proxy-session-key");
  const headerMode = readHeader(req, "x-claude-proxy-session-mode");
  const headerTtl = readHeader(req, "x-claude-proxy-session-ttl-seconds");
  const headerReset = readHeader(req, "x-claude-proxy-session-reset");
  const headerPolicy = readHeader(req, "x-claude-proxy-session-policy");

  const rawMode = headerMode ?? readFirst(bodyExt, ["session_mode", "sessionMode", "mode"]);
  const rawKey = headerKey ?? readFirst(bodyExt, ["session_key", "sessionKey", "session"]);
  const rawTtl = headerTtl ?? readFirst(bodyExt, ["session_ttl_seconds", "sessionTtlSeconds", "ttl_seconds"]);
  const rawReset = headerReset ?? readFirst(bodyExt, ["session_reset", "sessionReset", "reset"]);
  const rawPolicy = headerPolicy ?? readFirst(bodyExt, ["session_policy", "sessionPolicy", "policy"]);

  const keyWasProvided = rawKey !== undefined && rawKey !== null && String(rawKey).trim().length > 0;
  const mode = normalizeMode(rawMode, keyWasProvided);
  if (!mode) return error(400, "invalid_session_mode", "Session mode must be one of: pool, sticky, stateless");

  if (mode !== "sticky") return { mode };

  if (!config.enabled) {
    return error(400, "sticky_sessions_disabled", "Sticky sessions are disabled. Set CLAUDE_PROXY_STICKY_SESSIONS=1 to enable this opt-in extension.");
  }

  const normalizedKey = normalizeSessionKey(rawKey, config.keyMaxLength);
  if (!normalizedKey) {
    return error(400, "invalid_session_key", `X-Claude-Proxy-Session-Key must be a non-empty string up to ${config.keyMaxLength} characters`);
  }

  const ttlParsed = rawTtl === undefined || rawTtl === null || String(rawTtl).trim() === ""
    ? config.defaultTtlSeconds
    : Number.parseInt(String(rawTtl), 10);
  if (!Number.isFinite(ttlParsed) || ttlParsed <= 0) {
    return error(400, "invalid_session_ttl", "Session TTL must be a positive integer number of seconds");
  }

  const policy = normalizePolicy(rawPolicy);
  if (!policy) return error(400, "invalid_session_policy", "Session policy must be strict or compatible");

  const keyHash = createHash("sha256").update(normalizedKey).digest("hex");
  return {
    mode: "sticky",
    sticky: {
      rawKey: normalizedKey,
      keyHash,
      keyHashShort: keyHash.slice(0, 12),
      ttlSeconds: clamp(ttlParsed, config.minTtlSeconds, config.maxTtlSeconds),
      reset: parseBoolean(rawReset) === true,
      policy,
    },
  };
}

function readHeader(req: Pick<Request, "headers">, name: string): string | undefined {
  const direct = req.headers[name];
  if (Array.isArray(direct)) return direct[0];
  if (typeof direct === "string") return direct;
  const found = Object.entries(req.headers).find(([k]) => k.toLowerCase() === name);
  const value = found?.[1];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function readBodyExtension(body: unknown, allow: boolean): ClaudeProxyRequestExtension | undefined {
  if (!allow || !body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const ext = (body as { claude_proxy?: unknown }).claude_proxy;
  if (!ext || typeof ext !== "object" || Array.isArray(ext)) return undefined;
  return ext as ClaudeProxyRequestExtension;
}

function readFirst(ext: ClaudeProxyRequestExtension | undefined, keys: Array<keyof ClaudeProxyRequestExtension>): unknown {
  if (!ext) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(ext, key)) return ext[key];
  }
  return undefined;
}

function normalizeMode(raw: unknown, keyWasProvided: boolean): SessionMode | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === "") return keyWasProvided ? "sticky" : "pool";
  const normalized = String(raw).trim().toLowerCase();
  return VALID_MODES.has(normalized as SessionMode) ? normalized as SessionMode : undefined;
}

function normalizePolicy(raw: unknown): StickySessionPolicy | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === "") return "strict";
  const normalized = String(raw).trim().toLowerCase();
  return VALID_POLICIES.has(normalized as StickySessionPolicy) ? normalized as StickySessionPolicy : undefined;
}

function normalizeSessionKey(raw: unknown, maxLength: number): string | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const key = String(raw).trim();
  if (!key || key.length > maxLength) return undefined;
  if (/[\u0000-\u001F\u007F]/.test(key)) return undefined;
  return key;
}

function parseBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  return undefined;
}

function positiveInt(raw: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(raw: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function error(status: number, code: string, message: string): SessionOptionsError {
  return { status, code, message };
}
```

- [ ] **Step 2: Build**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
npm run build
```

Expected: PASS.

- [ ] **Step 3: Run sticky option tests**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
node --test dist/__tests__/sticky-options.test.js
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
git add src/server/sticky-options.ts src/__tests__/sticky-options.test.ts dist src/types/openai.ts
git commit -m "feat: parse opt-in sticky session options"
```

---

### Task 4: Add trace fields for sticky metadata

**Files:**
- Modify: `src/trace/types.ts`
- Modify: `src/trace/builder.ts`
- Test: existing trace tests plus build

- [ ] **Step 1: Extend `TraceRecord`**

In `src/trace/types.ts`, replace the session pool section:

```ts
  // Session pool
  sessionWarmHit?: boolean;
```

with:

```ts
  // Session / worker reuse
  sessionMode?: "pool" | "sticky" | "stateless";
  sessionWarmHit?: boolean;
  stickySessionHit?: boolean;
  stickySessionKeyHash?: string;
  stickyTtlSeconds?: number;
  stickyTurnCount?: number;
  stickyEvictionReason?: string;
```

- [ ] **Step 2: Extend `TraceBuilder` interface**

In `src/trace/builder.ts`, add these methods to `TraceBuilder`:

```ts
  setSessionMode(mode: "pool" | "sticky" | "stateless"): void;
  setStickySession(opts: { hit: boolean; keyHash: string; ttlSeconds: number; turnCount: number }): void;
  setStickyEviction(reason: string): void;
```

- [ ] **Step 3: Implement builder methods**

Inside `createTraceBuilder` return object, add:

```ts
    setSessionMode(mode) { record.sessionMode = mode; },

    setStickySession(opts) {
      record.stickySessionHit = opts.hit;
      record.stickySessionKeyHash = opts.keyHash.slice(0, 12);
      record.stickyTtlSeconds = opts.ttlSeconds;
      record.stickyTurnCount = opts.turnCount;
    },

    setStickyEviction(reason) { record.stickyEvictionReason = reason.slice(0, 80); },
```

Place them near `setSessionWarmHit` so reuse-related methods are grouped together.

- [ ] **Step 4: Build and run trace tests**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
npm run build
node --test dist/__tests__/trace-store.test.js dist/__tests__/trace-sqlite.test.js dist/__tests__/trace-exporter.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
git add src/trace/types.ts src/trace/builder.ts dist
git commit -m "feat: trace sticky session metadata"
```

---

### Task 5: Write sticky pool lifecycle tests

**Files:**
- Create: `src/__tests__/sticky-session-pool.test.ts`
- Later implementation: `src/subprocess/sticky-session-pool.ts`

- [ ] **Step 1: Create lifecycle helper tests**

Create `src/__tests__/sticky-session-pool.test.ts` with this content:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStickyInternalKey,
  disallowedToolsKey,
  isIdleExpired,
  isAbsoluteExpired,
  parseStickyTtlMs,
} from "../subprocess/sticky-session-pool.js";

test("disallowedToolsKey sorts tools for stable fingerprinting", () => {
  assert.equal(disallowedToolsKey(["mcp__b", "mcp__a"]), "mcp__a,mcp__b");
  assert.equal(disallowedToolsKey([]), "");
});

test("internal key changes across model and tool policy", () => {
  const base = {
    sessionKeyHash: "abc123",
    model: "claude-sonnet-4-6",
    runtime: "stream-json" as const,
    disallowedToolsKey: "",
    mcpPolicyKey: "mcp:on",
    cwd: "/tmp/proxy",
    dynamicPromptExclusion: true,
  };
  const same = buildStickyInternalKey(base);
  const differentModel = buildStickyInternalKey({ ...base, model: "claude-opus-4-7" });
  const differentTools = buildStickyInternalKey({ ...base, disallowedToolsKey: "mcp__n8n__list" });
  assert.equal(same, buildStickyInternalKey(base));
  assert.notEqual(same, differentModel);
  assert.notEqual(same, differentTools);
  assert.match(same, /^[a-f0-9]{64}$/);
});

test("idle expiration uses lastUsedAt and ttlMs", () => {
  assert.equal(isIdleExpired({ lastUsedAt: 1000, ttlMs: 5000 }, 7001), true);
  assert.equal(isIdleExpired({ lastUsedAt: 1000, ttlMs: 5000 }, 6000), false);
});

test("absolute expiration can be disabled with zero", () => {
  assert.equal(isAbsoluteExpired({ createdAt: 1000 }, 900000, 0), false);
  assert.equal(isAbsoluteExpired({ createdAt: 1000 }, 900000, 60_000), true);
  assert.equal(isAbsoluteExpired({ createdAt: 1000 }, 30_000, 60_000), false);
});

test("parseStickyTtlMs converts seconds to milliseconds", () => {
  assert.equal(parseStickyTtlMs(60), 60_000);
  assert.equal(parseStickyTtlMs(86400), 86_400_000);
});
```

- [ ] **Step 2: Build to verify missing module failure**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
npm run build
```

Expected: FAIL because `src/subprocess/sticky-session-pool.ts` does not exist.

---

### Task 6: Implement sticky session pool core

**Files:**
- Create: `src/subprocess/sticky-session-pool.ts`
- Test: `src/__tests__/sticky-session-pool.test.ts`

- [ ] **Step 1: Create pool module with exported helpers**

Create `src/subprocess/sticky-session-pool.ts` with this content:

```ts
import { createHash } from "crypto";
import { StreamJsonSubprocess } from "./stream-json-manager.js";
import { acquirePreInit } from "./init-pool.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
import { messagesToPrompt, type OpenAIChatRequest } from "../adapter/openai-to-cli.js";
import type { OpenAIChatMessage } from "../types/openai.js";
import { stickySessionConfigFromEnv } from "../server/sticky-options.js";

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

export interface StickySessionFingerprint {
  sessionKeyHash: string;
  model: ClaudeModel;
  runtime: "stream-json";
  disallowedToolsKey: string;
  mcpPolicyKey: string;
  cwd: string;
  dynamicPromptExclusion: boolean;
}

interface StickySlot {
  subprocess: StreamJsonSubprocess;
  internalKey: string;
  keyHashShort: string;
  createdAt: number;
  lastUsedAt: number;
  ttlMs: number;
  turnCount: number;
  active: boolean;
  fingerprint: StickySessionFingerprint;
  readyForIncrementalTurn: boolean;
}

export interface StickyAcquireOptions {
  sessionKeyHash: string;
  sessionKeyHashShort: string;
  ttlSeconds: number;
  reset: boolean;
  model: ClaudeModel;
  messages: OpenAIChatMessage[];
  bodyForPrompt: OpenAIChatRequest;
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

export interface StickyPoolStats {
  enabled: boolean;
  size: number;
  max: number;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  absoluteTtlSeconds: number;
  queueTimeoutMs: number;
}

export const stickyPoolCounters = {
  hits: 0,
  coldStarts: 0,
  resets: 0,
  ttlEvictions: 0,
  absoluteTtlEvictions: 0,
  lruEvictions: 0,
  unhealthyEvictions: 0,
  fingerprintMismatches: 0,
  busyRejections: 0,
  queueTimeouts: 0,
  modeAccepted: { sticky: 0, pool: 0, stateless: 0 },
  modeRejected: { sticky: 0, pool: 0, stateless: 0 },
};

const slots = new Map<string, StickySlot>();

export function disallowedToolsKey(disallowedTools: string[] = []): string {
  return [...disallowedTools].sort().join(",");
}

export function parseStickyTtlMs(ttlSeconds: number): number {
  return Math.max(1, Math.trunc(ttlSeconds)) * 1000;
}

export function isIdleExpired(slot: Pick<StickySlot, "lastUsedAt" | "ttlMs">, now: number): boolean {
  return now - slot.lastUsedAt > slot.ttlMs;
}

export function isAbsoluteExpired(slot: Pick<StickySlot, "createdAt">, now: number, absoluteTtlMs: number): boolean {
  return absoluteTtlMs > 0 && now - slot.createdAt > absoluteTtlMs;
}

export function buildStickyInternalKey(fingerprint: StickySessionFingerprint): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, ...fingerprint })).digest("hex");
}

export async function acquireStickySession(options: StickyAcquireOptions): Promise<StickyAcquireResult> {
  const config = stickySessionConfigFromEnv();
  evictExpired(Date.now(), config.absoluteTtlSeconds * 1000);

  const fingerprint: StickySessionFingerprint = {
    sessionKeyHash: options.sessionKeyHash,
    model: options.model,
    runtime: "stream-json",
    disallowedToolsKey: disallowedToolsKey(options.disallowedTools),
    mcpPolicyKey: options.mcpPolicyKey || (process.env.CLAUDE_PROXY_TOOLS_TRANSLATION === "1" ? "mcp:on" : "mcp:off"),
    cwd: options.cwd || process.cwd(),
    dynamicPromptExclusion: process.env.CLAUDE_PROXY_EXCLUDE_DYNAMIC_SYSTEM_PROMPT_SECTIONS === "1" || options.dynamicPromptExclusion === true,
  };
  const internalKey = buildStickyInternalKey(fingerprint);
  const ttlMs = parseStickyTtlMs(options.ttlSeconds);

  if (options.reset) {
    const existing = slots.get(internalKey);
    if (existing?.active) {
      stickyPoolCounters.busyRejections++;
      throw new Error("sticky_session_busy");
    }
    if (existing) {
      evictSlot(internalKey, existing, "reset");
      stickyPoolCounters.resets++;
    }
  }

  const existing = slots.get(internalKey);
  if (existing && existing.subprocess.isHealthy()) {
    if (existing.active) {
      stickyPoolCounters.busyRejections++;
      throw new Error("sticky_session_busy");
    }
    existing.active = true;
    existing.lastUsedAt = Date.now();
    existing.ttlMs = ttlMs;
    stickyPoolCounters.hits++;
    const userText = buildWarmUserText(options.messages, options.bodyForPrompt);
    return buildAcquireResult(existing, true, true, userText, options.ttlSeconds);
  }

  if (existing) {
    evictSlot(internalKey, existing, "unhealthy");
  }

  evictLRU(config.maxSessions);
  const subprocess = await createProcess(options.model, options.disallowedTools);
  const now = Date.now();
  const slot: StickySlot = {
    subprocess,
    internalKey,
    keyHashShort: options.sessionKeyHashShort,
    createdAt: now,
    lastUsedAt: now,
    ttlMs,
    turnCount: 0,
    active: true,
    fingerprint,
    readyForIncrementalTurn: false,
  };
  slots.set(internalKey, slot);
  stickyPoolCounters.coldStarts++;
  return buildAcquireResult(slot, false, false, messagesToPrompt(options.messages, options.bodyForPrompt), options.ttlSeconds);
}

function buildAcquireResult(
  slot: StickySlot,
  isStickyHit: boolean,
  isWarm: boolean,
  userText: string,
  ttlSeconds: number,
): StickyAcquireResult {
  return {
    subprocess: slot.subprocess,
    isStickyHit,
    isWarm,
    userText,
    keyHashShort: slot.keyHashShort,
    ttlSeconds,
    turnCount: slot.turnCount,
    release: (result) => releaseStickySession(slot.internalKey, result),
  };
}

function releaseStickySession(internalKey: string, result: StickyReleaseResult): void {
  const slot = slots.get(internalKey);
  if (!slot) return;
  slot.active = false;
  if (result.status === "success" && slot.subprocess.isHealthy()) {
    slot.turnCount++;
    slot.lastUsedAt = Date.now();
    slot.readyForIncrementalTurn = true;
    return;
  }
  evictSlot(internalKey, slot, result.status === "discard" ? result.reason : "turn_error");
}

function buildWarmUserText(messages: OpenAIChatMessage[], body: OpenAIChatRequest): string {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return messagesToPrompt(messages, body);
  return messagesToPrompt([lastMessage], body);
}

async function createProcess(model: ClaudeModel, disallowedTools: string[] = []): Promise<StreamJsonSubprocess> {
  if (disallowedTools.length === 0) return acquirePreInit(model);
  const subprocess = new StreamJsonSubprocess();
  await subprocess.start({ model, disallowedTools });
  return subprocess;
}

function evictExpired(now: number, absoluteTtlMs: number): void {
  for (const [key, slot] of slots) {
    if (!slot.subprocess.isHealthy()) {
      evictSlot(key, slot, "unhealthy");
    } else if (isIdleExpired(slot, now)) {
      evictSlot(key, slot, "idle_ttl");
    } else if (isAbsoluteExpired(slot, now, absoluteTtlMs)) {
      evictSlot(key, slot, "absolute_ttl");
    }
  }
}

function evictLRU(maxSessions: number): void {
  while (slots.size >= maxSessions) {
    let oldest: { key: string; slot: StickySlot } | null = null;
    for (const [key, slot] of slots) {
      if (slot.active) continue;
      if (!oldest || slot.lastUsedAt < oldest.slot.lastUsedAt) oldest = { key, slot };
    }
    if (!oldest) {
      stickyPoolCounters.busyRejections++;
      throw new Error("sticky_session_capacity_busy");
    }
    evictSlot(oldest.key, oldest.slot, "lru");
  }
}

function evictSlot(key: string, slot: StickySlot, reason: StickyEvictionReason): void {
  if (reason === "idle_ttl") stickyPoolCounters.ttlEvictions++;
  if (reason === "absolute_ttl") stickyPoolCounters.absoluteTtlEvictions++;
  if (reason === "lru") stickyPoolCounters.lruEvictions++;
  if (reason === "unhealthy") stickyPoolCounters.unhealthyEvictions++;
  if (reason === "fingerprint_mismatch") stickyPoolCounters.fingerprintMismatches++;
  slot.subprocess.kill();
  slots.delete(key);
}

export function stickyPoolStats(): StickyPoolStats {
  const config = stickySessionConfigFromEnv();
  evictExpired(Date.now(), config.absoluteTtlSeconds * 1000);
  return {
    enabled: config.enabled,
    size: slots.size,
    max: config.maxSessions,
    defaultTtlSeconds: config.defaultTtlSeconds,
    maxTtlSeconds: config.maxTtlSeconds,
    absoluteTtlSeconds: config.absoluteTtlSeconds,
    queueTimeoutMs: config.queueTimeoutMs,
  };
}
```

- [ ] **Step 2: Build and run sticky pool tests**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
npm run build
node --test dist/__tests__/sticky-session-pool.test.js
```

Expected: PASS.

- [ ] **Step 3: Run existing session-pool tests**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
node --test dist/__tests__/session-pool.test.js
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
git add src/subprocess/sticky-session-pool.ts src/__tests__/sticky-session-pool.test.ts dist
git commit -m "feat: add sticky Claude session pool core"
```

---

### Task 7: Integrate session mode parsing into chat route

**Files:**
- Modify: `src/server/routes.ts`
- Test: build and existing route tests

- [ ] **Step 1: Add imports**

In `src/server/routes.ts`, add imports near existing session-pool import:

```ts
import { resolveSessionOptions, isSessionOptionsError } from "./sticky-options.js";
import { acquireStickySession, stickyPoolCounters } from "../subprocess/sticky-session-pool.js";
```

- [ ] **Step 2: Parse session options in `handleChatCompletions`**

After body validation and before runtime resolution, insert:

```ts
    const sessionOptions = resolveSessionOptions(req);
    if (isSessionOptionsError(sessionOptions)) {
      tb.setError("invalid_request", sessionOptions.message);
      tb.commit();
      res.status(sessionOptions.status).json({
        error: {
          message: sessionOptions.message,
          type: "invalid_request_error",
          code: sessionOptions.code,
        },
      });
      return;
    }
    tb.setSessionMode(sessionOptions.mode);
```

- [ ] **Step 3: Pass session options into stream-json handler**

Change the call:

```ts
await handleStreamJsonRequest(req, res, model, body, requestId, stream, tb);
```

To:

```ts
await handleStreamJsonRequest(req, res, model, body, requestId, stream, tb, sessionOptions);
```

- [ ] **Step 4: Update `handleStreamJsonRequest` signature**

Change signature to include:

```ts
  sessionOptions: import("./sticky-options.js").ResolvedSessionOptions,
```

- [ ] **Step 5: Build to expose integration errors**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
npm run build
```

Expected at this stage: build may fail until Task 8 rewires acquisition. Continue to Task 8 in the same implementation batch before committing if needed.

---

### Task 8: Route stream-json acquisition through pool/sticky/stateless modes

**Files:**
- Modify: `src/server/routes.ts`
- Modify if needed: `src/subprocess/sticky-session-pool.ts`

- [ ] **Step 1: Replace direct `acquireSession` call**

In `handleStreamJsonRequest`, replace:

```ts
  const cliInput = openaiToCli(body);
  const acquired = await acquireSession(model, body.messages, { disallowedTools: cliInput.disallowedTools });
  const subprocess = acquired.subprocess;
  tb.setSessionWarmHit(acquired.isWarm);
```

With:

```ts
  const cliInput = openaiToCli(body);
  const acquired = sessionOptions.mode === "sticky" && sessionOptions.sticky
    ? await acquireStickySession({
        sessionKeyHash: sessionOptions.sticky.keyHash,
        sessionKeyHashShort: sessionOptions.sticky.keyHashShort,
        ttlSeconds: sessionOptions.sticky.ttlSeconds,
        reset: sessionOptions.sticky.reset,
        model,
        messages: body.messages,
        bodyForPrompt: body,
        disallowedTools: cliInput.disallowedTools,
      })
    : sessionOptions.mode === "stateless"
      ? await acquireSession(model, body.messages, { disallowedTools: cliInput.disallowedTools })
      : await acquireSession(model, body.messages, { disallowedTools: cliInput.disallowedTools });
  const subprocess = acquired.subprocess;
  tb.setSessionWarmHit(acquired.isWarm);
  if (sessionOptions.mode === "sticky" && "isStickyHit" in acquired) {
    tb.setStickySession({
      hit: acquired.isStickyHit,
      keyHash: acquired.keyHashShort,
      ttlSeconds: acquired.ttlSeconds,
      turnCount: acquired.turnCount,
    });
  }
```

- [ ] **Step 2: Replace user text selection**

Replace the existing `userText` calculation:

```ts
  const lastMessage = body.messages[body.messages.length - 1];
  const userText = acquired.isWarm
    ? (bridgeTools ? messagesToPrompt([lastMessage], body) : acquired.lastUserText)
    : cliInput.prompt;
```

With:

```ts
  const lastMessage = body.messages[body.messages.length - 1];
  const userText = "userText" in acquired
    ? acquired.userText
    : acquired.isWarm
      ? (bridgeTools ? messagesToPrompt([lastMessage], body) : acquired.lastUserText)
      : cliInput.prompt;
```

- [ ] **Step 3: Add sticky headers helper**

Add helper near `setTraceHeader`:

```ts
function setSessionHeaders(res: Response, mode: "pool" | "sticky" | "stateless", acquired?: unknown): void {
  if (res.headersSent) return;
  res.setHeader("X-Claude-Proxy-Session-Mode", mode);
  if (mode === "sticky" && acquired && typeof acquired === "object" && "keyHashShort" in acquired) {
    const a = acquired as { isStickyHit?: boolean; keyHashShort?: string; ttlSeconds?: number; turnCount?: number };
    res.setHeader("X-Claude-Proxy-Sticky-Hit", a.isStickyHit ? "1" : "0");
    if (a.keyHashShort) res.setHeader("X-Claude-Proxy-Sticky-Key-Hash", a.keyHashShort);
    if (a.ttlSeconds !== undefined) res.setHeader("X-Claude-Proxy-Sticky-TTL-Seconds", String(a.ttlSeconds));
    if (a.turnCount !== undefined) res.setHeader("X-Claude-Proxy-Sticky-Turn-Count", String(a.turnCount));
  }
}
```

Call it before streaming headers flush and before non-stream response:

```ts
  setSessionHeaders(res, sessionOptions.mode, acquired);
```

Place this before:

```ts
  if (stream) {
```

- [ ] **Step 4: Release sticky sessions correctly on success**

Replace final re-pool block:

```ts
    // Re-pool the subprocess for the next turn in this conversation.
    returnSession(subprocess, model, body.messages, assistantText, { disallowedTools: cliInput.disallowedTools });
```

With:

```ts
    // Re-pool or keep the subprocess according to session mode.
    if (sessionOptions.mode === "sticky" && "release" in acquired) {
      acquired.release({ status: "success", assistantText });
    } else if (sessionOptions.mode === "stateless") {
      discardSession(subprocess);
    } else {
      returnSession(subprocess, model, body.messages, assistantText, { disallowedTools: cliInput.disallowedTools });
    }
```

- [ ] **Step 5: Release sticky sessions correctly on client disconnect**

Replace:

```ts
      discardSession(subprocess);
```

inside `res.on("close"...)` with:

```ts
      if (sessionOptions.mode === "sticky" && "release" in acquired) {
        acquired.release({ status: "discard", reason: "client_disconnect" });
        tb.setStickyEviction("client_disconnect");
      } else {
        discardSession(subprocess);
      }
```

- [ ] **Step 6: Release sticky sessions correctly on watchdog**

Replace the watchdog cleanup:

```ts
    subprocess.kill();
    discardSession(subprocess);
```

With:

```ts
    if (sessionOptions.mode === "sticky" && "release" in acquired) {
      acquired.release({ status: "discard", reason: "watchdog" });
      tb.setStickyEviction("watchdog");
    } else {
      subprocess.kill();
      discardSession(subprocess);
    }
```

- [ ] **Step 7: Release sticky sessions correctly on turn error**

Replace catch cleanup:

```ts
    discardSession(subprocess);
```

With:

```ts
    if (sessionOptions.mode === "sticky" && "release" in acquired) {
      acquired.release({ status: "discard", reason: "turn_error" });
      tb.setStickyEviction("turn_error");
    } else {
      discardSession(subprocess);
    }
```

- [ ] **Step 8: Build and run route-adjacent tests**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
npm run build
node --test dist/__tests__/responses-api.test.js dist/__tests__/bridge-streaming.test.js dist/__tests__/upstream-watchdog.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
git add src/server/routes.ts src/subprocess/sticky-session-pool.ts dist
git commit -m "feat: route stream-json requests through sticky sessions"
```

---

### Task 9: Add sticky metrics

**Files:**
- Modify: `src/server/metrics.ts`
- Test: `src/__tests__/sticky-session-pool.test.ts`, `src/__tests__/trace-store.test.ts`, full test suite

- [ ] **Step 1: Import sticky stats**

In `src/server/metrics.ts`, add:

```ts
import { stickyPoolCounters, stickyPoolStats } from "../subprocess/sticky-session-pool.js";
```

- [ ] **Step 2: Render sticky gauges and counters**

Add this block after existing pool metrics:

```ts
  // claude_proxy_sticky_sessions_size
  const ss = stickyPoolStats();
  lines.push("# HELP claude_proxy_sticky_sessions_size Live workers in the sticky session pool.");
  lines.push("# TYPE claude_proxy_sticky_sessions_size gauge");
  lines.push(`claude_proxy_sticky_sessions_size{state="live"} ${ss.size}`);
  lines.push(`claude_proxy_sticky_sessions_size{state="max"} ${ss.max}`);
  lines.push(`claude_proxy_sticky_sessions_enabled ${ss.enabled ? 1 : 0}`);

  lines.push("# HELP claude_proxy_sticky_hits_total Sticky requests served from an existing live session.");
  lines.push("# TYPE claude_proxy_sticky_hits_total counter");
  lines.push(`claude_proxy_sticky_hits_total ${stickyPoolCounters.hits}`);

  lines.push("# HELP claude_proxy_sticky_cold_starts_total Sticky requests that created a new live session.");
  lines.push("# TYPE claude_proxy_sticky_cold_starts_total counter");
  lines.push(`claude_proxy_sticky_cold_starts_total ${stickyPoolCounters.coldStarts}`);

  lines.push("# HELP claude_proxy_sticky_resets_total Sticky sessions reset by caller request.");
  lines.push("# TYPE claude_proxy_sticky_resets_total counter");
  lines.push(`claude_proxy_sticky_resets_total ${stickyPoolCounters.resets}`);

  lines.push("# HELP claude_proxy_sticky_ttl_evictions_total Sticky sessions evicted for idle TTL.");
  lines.push("# TYPE claude_proxy_sticky_ttl_evictions_total counter");
  lines.push(`claude_proxy_sticky_ttl_evictions_total ${stickyPoolCounters.ttlEvictions}`);

  lines.push("# HELP claude_proxy_sticky_absolute_ttl_evictions_total Sticky sessions evicted for absolute TTL.");
  lines.push("# TYPE claude_proxy_sticky_absolute_ttl_evictions_total counter");
  lines.push(`claude_proxy_sticky_absolute_ttl_evictions_total ${stickyPoolCounters.absoluteTtlEvictions}`);

  lines.push("# HELP claude_proxy_sticky_lru_evictions_total Sticky sessions evicted to honor cap.");
  lines.push("# TYPE claude_proxy_sticky_lru_evictions_total counter");
  lines.push(`claude_proxy_sticky_lru_evictions_total ${stickyPoolCounters.lruEvictions}`);

  lines.push("# HELP claude_proxy_sticky_unhealthy_evictions_total Sticky sessions evicted because worker was unhealthy.");
  lines.push("# TYPE claude_proxy_sticky_unhealthy_evictions_total counter");
  lines.push(`claude_proxy_sticky_unhealthy_evictions_total ${stickyPoolCounters.unhealthyEvictions}`);

  lines.push("# HELP claude_proxy_sticky_busy_rejections_total Sticky requests rejected because the session was busy or capacity was busy.");
  lines.push("# TYPE claude_proxy_sticky_busy_rejections_total counter");
  lines.push(`claude_proxy_sticky_busy_rejections_total ${stickyPoolCounters.busyRejections}`);
```

- [ ] **Step 3: Build and run metrics smoke**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
npm run build
node --test dist/__tests__/usage-reporting.test.js dist/__tests__/session-pool.test.js dist/__tests__/sticky-session-pool.test.js
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
git add src/server/metrics.ts dist
git commit -m "feat: expose sticky session metrics"
```

---

### Task 10: Add sticky health summaries

**Files:**
- Modify: `src/server/routes.ts`

- [ ] **Step 1: Import sticky stats**

Add to imports:

```ts
import { stickyPoolStats } from "../subprocess/sticky-session-pool.js";
```

If `stickyPoolCounters` was imported in Task 7 and now unused, keep only the imports actually used by TypeScript.

- [ ] **Step 2: Add sticky stats to `/health` response**

In `handleHealth`, near existing `pool: poolStats()`, add:

```ts
    stickySessions: stickyPoolStats(),
```

- [ ] **Step 3: Add sticky stats to `/healthz/deep` response**

In both success and error response objects for `handleHealthDeep`, near `pool: poolStats()`, add:

```ts
      stickySessions: stickyPoolStats(),
```

- [ ] **Step 4: Build and run health-adjacent tests**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
npm run build
node --test dist/__tests__/runtime.test.js dist/__tests__/failure-simulation.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
git add src/server/routes.ts dist
git commit -m "feat: report sticky session health"
```

---

### Task 11: Add stateless mode correctness guard

**Files:**
- Modify: `src/server/routes.ts`

- [ ] **Step 1: Prevent stateless from returning to hash pool**

Review the success, error, watchdog, and close branches from Task 8. Confirm every branch has this invariant:

```ts
if (sessionOptions.mode === "stateless") {
  discardSession(subprocess);
}
```

and never calls:

```ts
returnSession(subprocess, model, body.messages, assistantText, { disallowedTools: cliInput.disallowedTools });
```

for stateless mode.

- [ ] **Step 2: Add a log line for effective mode**

Update the existing request start log to include session mode:

```ts
console.error(`[StreamJson] request start req_id=${requestId} trace_id=${tb.traceId} model=${model} runtime=stream-json sessionMode=${sessionOptions.mode} stream=${stream} bridgeTools=${bridgeTools}`);
```

- [ ] **Step 3: Build and run full tests**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
npm run build
npm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
git add src/server/routes.ts dist
git commit -m "fix: keep stateless session mode out of worker pools"
```

---

### Task 12: Document public protocol extension

**Files:**
- Modify: `PROTOCOL.md`
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/openclaw-integration.md`

- [ ] **Step 1: Add `PROTOCOL.md` section**

Append this section to `PROTOCOL.md`:

```markdown
## Optional Claude Proxy session extension

Claude Proxy remains OpenAI-compatible by default. Requests without the following optional fields use the normal runtime behavior.

### Headers

| Header | Values | Description |
| --- | --- | --- |
| `X-Claude-Proxy-Session-Key` | caller-selected string | Enables sticky mode by default when present. The proxy hashes this value internally and never uses it as a metric label. |
| `X-Claude-Proxy-Session-Mode` | `pool`, `sticky`, `stateless` | `pool` uses the normal hash-based pool; `sticky` binds to the caller key; `stateless` discards the worker after the request. |
| `X-Claude-Proxy-Session-TTL-Seconds` | positive integer | Requested sticky idle TTL, clamped by server env limits. |
| `X-Claude-Proxy-Session-Reset` | `1`, `true`, `yes`, `on` | Evicts the existing sticky session before serving the request. |

### Body extension

```json
{
  "claude_proxy": {
    "session_key": "app:user:conversation",
    "session_mode": "sticky",
    "session_ttl_seconds": 86400,
    "session_reset": false
  }
}
```

Headers override body extension fields. Sticky sessions require `CLAUDE_PROXY_STICKY_SESSIONS=1` and `stream-json` runtime.
```

- [ ] **Step 2: Add `README.md` summary**

Add a short section near runtime/session-pool documentation:

```markdown
### Optional sticky Claude CLI sessions

By default, Claude Proxy behaves like a normal OpenAI-compatible server. Advanced callers can opt into sticky live Claude CLI sessions by passing `X-Claude-Proxy-Session-Key` and related headers. In sticky mode, the same session key plus model/tool-policy fingerprint maps to the same live `stream-json` subprocess until TTL, reset, failure, or LRU eviction.

This is useful for agent and voice systems that want local Claude CLI continuity across HTTP requests. It does not make Anthropic's server-side prompt cache last for 24 hours; long TTLs preserve local CLI session continuity only.

See `PROTOCOL.md` and `docs/configuration.md` for the complete API and env knobs.
```

- [ ] **Step 3: Add configuration env table**

In `docs/configuration.md`, under Pooling and prewarm, add:

```markdown
## Sticky sessions

Sticky sessions are an opt-in extension for callers that want a stable key to reuse the same live `stream-json` Claude CLI subprocess across requests. Normal OpenAI-compatible requests do not need these options.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_STICKY_SESSIONS` | unset | Set `1` to allow sticky session requests. |
| `CLAUDE_PROXY_STICKY_DEFAULT_TTL_SECONDS` | `3600` | Default idle TTL when the request does not specify one. |
| `CLAUDE_PROXY_STICKY_MIN_TTL_SECONDS` | `60` | Minimum allowed sticky idle TTL. |
| `CLAUDE_PROXY_STICKY_MAX_TTL_SECONDS` | `86400` | Maximum allowed sticky idle TTL. |
| `CLAUDE_PROXY_STICKY_ABSOLUTE_TTL_SECONDS` | `86400` | Maximum age from creation. `0` disables absolute TTL. |
| `CLAUDE_PROXY_STICKY_MAX_SESSIONS` | `8` | Maximum live sticky subprocesses. |
| `CLAUDE_PROXY_STICKY_QUEUE_TIMEOUT_MS` | `120000` | Maximum wait for a busy sticky session before rejection. |
| `CLAUDE_PROXY_STICKY_ALLOW_BODY_OPTIONS` | `1` | Allows the `claude_proxy` body extension. Headers always work. |
| `CLAUDE_PROXY_STICKY_KEY_MAX_LENGTH` | `256` | Maximum caller session key length. |
| `CLAUDE_PROXY_STICKY_LOG_RAW_KEYS` | unset | Debug-only raw key logging. Avoid enabling outside local debugging. |

Example 24h sticky request:

```bash
curl -s http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Claude-Proxy-Session-Key: app:user:conversation' \
  -H 'X-Claude-Proxy-Session-Mode: sticky' \
  -H 'X-Claude-Proxy-Session-TTL-Seconds: 86400' \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Hello"}]}'
```
```

- [ ] **Step 4: Add generic OpenClaw integration note**

In `docs/openclaw-integration.md`, add:

```markdown
## Optional sticky session headers

OpenClaw integrations can opt into Claude Proxy sticky sessions by adding stable headers to requests. Do not hard-code agent names in Claude Proxy. The caller chooses the session key.

Recommended key shape:

```text
<app-or-framework>:<agent-id>:<channel-or-surface>:<conversation-id>
```

Example:

```text
X-Claude-Proxy-Session-Key: openclaw:sevro:telegram:5216159759
X-Claude-Proxy-Session-Mode: sticky
X-Claude-Proxy-Session-TTL-Seconds: 86400
```

Use a conversation/chat/session component in the key so two conversations handled by the same agent do not share a Claude CLI context.
```

- [ ] **Step 5: Commit docs**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
git add PROTOCOL.md README.md docs/configuration.md docs/openclaw-integration.md
git commit -m "docs: document sticky session extension"
```

---

### Task 13: Add live smoke scripts or manual smoke commands

**Files:**
- Modify optional: `scripts/soak.mjs`
- Or document manual smoke in release notes

- [ ] **Step 1: Run non-sticky smoke**

```bash
curl -s -D /tmp/claude-proxy-nonsticky.headers \
  -X POST http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"Reply NONSTICKY_OK only."}]}' \
  | tee /tmp/claude-proxy-nonsticky.json
```

Expected:

- Body contains `NONSTICKY_OK`.
- Headers do not require sticky fields.

- [ ] **Step 2: Run sticky first turn**

```bash
curl -s -D /tmp/claude-proxy-sticky-1.headers \
  -X POST http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Claude-Proxy-Session-Key: smoke:sticky:manual' \
  -H 'X-Claude-Proxy-Session-Mode: sticky' \
  -H 'X-Claude-Proxy-Session-TTL-Seconds: 86400' \
  -d '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"Remember the smoke word is orchid. Reply STICKY_ONE_OK only."}]}' \
  | tee /tmp/claude-proxy-sticky-1.json
```

Expected:

```bash
grep -i 'x-claude-proxy-session-mode: sticky' /tmp/claude-proxy-sticky-1.headers
grep -i 'x-claude-proxy-sticky-hit: 0' /tmp/claude-proxy-sticky-1.headers
grep 'STICKY_ONE_OK' /tmp/claude-proxy-sticky-1.json
```

- [ ] **Step 3: Run sticky second turn**

```bash
curl -s -D /tmp/claude-proxy-sticky-2.headers \
  -X POST http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Claude-Proxy-Session-Key: smoke:sticky:manual' \
  -H 'X-Claude-Proxy-Session-Mode: sticky' \
  -H 'X-Claude-Proxy-Session-TTL-Seconds: 86400' \
  -d '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"What is the smoke word? Reply with the word only."}]}' \
  | tee /tmp/claude-proxy-sticky-2.json
```

Expected:

```bash
grep -i 'x-claude-proxy-sticky-hit: 1' /tmp/claude-proxy-sticky-2.headers
grep -i 'orchid' /tmp/claude-proxy-sticky-2.json
```

- [ ] **Step 4: Run reset smoke**

```bash
curl -s -D /tmp/claude-proxy-sticky-reset.headers \
  -X POST http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Claude-Proxy-Session-Key: smoke:sticky:manual' \
  -H 'X-Claude-Proxy-Session-Mode: sticky' \
  -H 'X-Claude-Proxy-Session-Reset: 1' \
  -d '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"Start fresh. Reply RESET_OK only."}]}' \
  | tee /tmp/claude-proxy-sticky-reset.json
```

Expected:

```bash
grep -i 'x-claude-proxy-sticky-hit: 0' /tmp/claude-proxy-sticky-reset.headers
grep 'RESET_OK' /tmp/claude-proxy-sticky-reset.json
```

- [ ] **Step 5: Run metrics check**

```bash
curl -s http://127.0.0.1:3456/metrics | rg 'claude_proxy_sticky_(sessions_size|hits_total|cold_starts_total|resets_total)'
```

Expected: sticky metrics are present and counters reflect smoke activity.

---

### Task 14: Full validation gate

**Files:**
- No source edits unless validation finds failures.

- [ ] **Step 1: Clean build**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
npm run clean
npm run build
```

Expected: PASS.

- [ ] **Step 2: Full unit tests**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
npm test
```

Expected: PASS.

- [ ] **Step 3: Stream-json canary**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
npm run canary:stream-json
```

Expected: PASS.

- [ ] **Step 4: Quick soak**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
npm run soak:quick
```

Expected: PASS.

- [ ] **Step 5: SDK matrix**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
npm run sdk:matrix
```

Expected: PASS or explicit dependency skips with `failed 0`.

- [ ] **Step 6: Failure simulation**

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
npm run failure:sim
```

Expected: PASS.

- [ ] **Step 7: Manual sticky smoke**

Run Task 13 commands against the live service after enabling:

```bash
CLAUDE_PROXY_STICKY_SESSIONS=1
```

Expected: first turn `Sticky-Hit: 0`, second turn `Sticky-Hit: 1`, reset returns `Sticky-Hit: 0`.

- [ ] **Step 8: Commit validation docs if changed**

If validation results are recorded in docs:

```bash
cd /Users/mehdichaouachi/.openclaw/projects/claude-proxy
git add docs README.md PROTOCOL.md
git commit -m "docs: record sticky session validation"
```

---

### Task 15: Update infrastructure docs after implementation

**Files:**
- Modify: `/Users/mehdichaouachi/.openclaw/workspace/memory/infra/claude-proxy.md`
- Modify: `/Users/mehdichaouachi/.openclaw/workspace/memory/infrastructure.md`

- [ ] **Step 1: Update Claude Proxy infra doc**

Add to the Source table:

```markdown
| **Sticky sessions PRD** | `/Users/mehdichaouachi/.openclaw/projects/claude-proxy/docs/prd/sticky-sessions.md` |
| **Sticky sessions implementation plan** | `/Users/mehdichaouachi/.openclaw/projects/claude-proxy/docs/superpowers/plans/2026-05-09-sticky-claude-sessions.md` |
```

Add a short section after the stream-json pool section:

```markdown
## Planned opt-in sticky Claude CLI sessions

Sticky sessions are planned as a generic Claude Proxy protocol extension, not an OpenClaw-agent hard-code. Normal OpenAI-compatible requests continue using the existing default behavior. Callers that pass optional headers or the `claude_proxy` body extension can request `pool`, `sticky`, or `stateless` session behavior.

Primary design docs:
- PRD: `/Users/mehdichaouachi/.openclaw/projects/claude-proxy/docs/prd/sticky-sessions.md`
- Implementation plan: `/Users/mehdichaouachi/.openclaw/projects/claude-proxy/docs/superpowers/plans/2026-05-09-sticky-claude-sessions.md`

Important caveat: a 24h sticky TTL preserves local Claude CLI process continuity, not Anthropic server-side prompt cache for 24h.
```

- [ ] **Step 2: Update infrastructure index line**

In `/Users/mehdichaouachi/.openclaw/workspace/memory/infrastructure.md`, update the Claude Proxy bullet to mention:

```markdown
planned opt-in generic sticky Claude CLI sessions, documented in the repo PRD and implementation plan
```

- [ ] **Step 3: Commit or leave memory docs uncommitted according to workspace policy**

The infrastructure docs live in the OpenClaw workspace memory repo, not necessarily the Claude Proxy repo. If that workspace is git-backed, commit separately:

```bash
cd /Users/mehdichaouachi/.openclaw
git status --short
git add workspace/memory/infra/claude-proxy.md workspace/memory/infrastructure.md
git commit -m "docs: reference Claude Proxy sticky session plan"
```

---

## Self-Review Checklist

- [ ] PRD requirement FR1 maps to Tasks 7, 8, 11, 14.
- [ ] PRD requirement FR2 maps to Tasks 2, 3, 12.
- [ ] PRD requirement FR3 maps to Tasks 3, 7, 8, 11.
- [ ] PRD requirement FR4 maps to Tasks 2, 3.
- [ ] PRD requirement FR5 maps to Tasks 5, 6.
- [ ] PRD requirement FR6 maps to Tasks 6, 8.
- [ ] PRD requirement FR7 maps to Task 6; first release rejects busy sessions rather than full FIFO queue. Add FIFO queue in a follow-up if operator demand requires it.
- [ ] PRD requirement FR8 maps to Tasks 3, 6, 9, 10, 12.
- [ ] PRD requirement FR9 maps to Tasks 3, 6, 13.
- [ ] PRD requirement FR10 maps to Task 8.
- [ ] PRD requirement FR11 maps to Task 9.
- [ ] PRD requirement FR12 maps to Tasks 4, 10.
- [ ] PRD requirement FR13 maps to Task 12 and should be verified during route work if Responses headers are passed through.
- [ ] PRD requirement FR14 maps to Tasks 3, 7.
- [ ] PRD requirement FR15 maps to Tasks 12, 15.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-09-sticky-claude-sessions.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh coding agent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, with checkpoints after each group.

Recommended first implementation batch: Tasks 1–4. That creates types, parser, and trace metadata without touching live subprocess routing.
