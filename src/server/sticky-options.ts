import { createHash } from "crypto";
import type { Request } from "express";
import type {
  ClaudeProxyRequestExtension,
  ClaudeProxySessionMode,
  ClaudeProxySessionPolicy,
} from "../types/openai.js";

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
  const maxTtlSeconds = Math.max(minTtlSeconds, positiveInt(env.CLAUDE_PROXY_STICKY_MAX_TTL_SECONDS, 86_400));
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
    absoluteTtlSeconds: nonNegativeInt(env.CLAUDE_PROXY_STICKY_ABSOLUTE_TTL_SECONDS, 86_400),
    maxSessions: positiveInt(env.CLAUDE_PROXY_STICKY_MAX_SESSIONS, 8),
    queueTimeoutMs: positiveInt(env.CLAUDE_PROXY_STICKY_QUEUE_TIMEOUT_MS, 120_000),
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
