/**
 * Runtime mode resolver.
 *
 * The proxy supports two subprocess strategies:
 *   - "stream-json" (DEFAULT): long-lived `claude --output-format stream-json`
 *     workers driven by stream-json-manager + session-pool + init-pool. Lower
 *     per-request latency, supports prewarm, supports incremental streaming.
 *   - "print" (FALLBACK): one-shot `claude --print` per request via the
 *     classic ClaudeSubprocess. Higher latency, no warm pool, but bulletproof:
 *     zero session state, zero pool fingerprint drift, zero stream parser
 *     surface area. Flip here when stream-json regresses upstream.
 *
 * Resolution order (highest priority first):
 *   1. Per-request header `X-Claude-Proxy-Runtime` — only honored when
 *      `CLAUDE_PROXY_ALLOW_RUNTIME_OVERRIDE=1`. Off by default.
 *   2. `CLAUDE_PROXY_RUNTIME` env var (`stream-json` | `print`).
 *   3. Legacy `CLAUDE_PROXY_STREAM_JSON=1` → maps to `stream-json` for
 *      backward compatibility with the original feature flag.
 *   4. Default: `stream-json`.
 */

import type { Request } from "express";

export type RuntimeMode = "stream-json" | "print";

const ENV_RUNTIME = process.env.CLAUDE_PROXY_RUNTIME;
const ENV_LEGACY_STREAM_JSON = process.env.CLAUDE_PROXY_STREAM_JSON;
const ALLOW_OVERRIDE = process.env.CLAUDE_PROXY_ALLOW_RUNTIME_OVERRIDE === "1";

function isValidMode(s: unknown): s is RuntimeMode {
  return s === "stream-json" || s === "print";
}

function resolveDefaultMode(): RuntimeMode {
  if (isValidMode(ENV_RUNTIME)) return ENV_RUNTIME;
  // Legacy: CLAUDE_PROXY_STREAM_JSON=1 used to opt-in to stream-json when
  // print was the default. Now stream-json is the default, but we still
  // honor the legacy flag so existing LaunchAgent envs keep working.
  if (ENV_LEGACY_STREAM_JSON === "0") return "print";
  return "stream-json";
}

const DEFAULT_MODE = resolveDefaultMode();

/**
 * Resolve the runtime mode for a given request.
 * Optional `req` is consulted only when override is allowed.
 */
export function resolveRuntime(req?: Pick<Request, "header">): RuntimeMode {
  if (ALLOW_OVERRIDE && req) {
    const header = req.header("x-claude-proxy-runtime");
    if (isValidMode(header)) return header;
  }
  return DEFAULT_MODE;
}

/** Default runtime, ignoring per-request overrides. Used by boot-time code paths. */
export function defaultRuntime(): RuntimeMode {
  return DEFAULT_MODE;
}

export function runtimeOverrideAllowed(): boolean {
  return ALLOW_OVERRIDE;
}
