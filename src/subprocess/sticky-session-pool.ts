import { createHash } from "crypto";
import { StreamJsonSubprocess } from "./stream-json-manager.js";
import { acquirePreInit } from "./init-pool.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
import { messagesToPrompt } from "../adapter/openai-to-cli.js";
import type { OpenAIChatMessage, OpenAIChatRequest } from "../types/openai.js";
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
  sessionPolicy?: string;
}

interface QueuedWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
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
  waiters: QueuedWaiter[];
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
  bodyForPrompt: Pick<OpenAIChatRequest, "tools" | "tool_choice">;
  disallowedTools?: string[];
  mcpPolicyKey?: string;
  cwd?: string;
  dynamicPromptExclusion?: boolean;
  sessionPolicy?: string;
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
  queued: 0,
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
  const absoluteTtlMs = config.absoluteTtlSeconds * 1000;
  evictExpired(Date.now(), absoluteTtlMs);

  const fingerprint: StickySessionFingerprint = {
    sessionKeyHash: options.sessionKeyHash,
    model: options.model,
    runtime: "stream-json",
    disallowedToolsKey: disallowedToolsKey(options.disallowedTools),
    mcpPolicyKey: options.mcpPolicyKey || defaultMcpPolicyKey(),
    cwd: options.cwd || process.cwd(),
    dynamicPromptExclusion: process.env.CLAUDE_PROXY_EXCLUDE_DYNAMIC_SYSTEM_PROMPT_SECTIONS === "1" || options.dynamicPromptExclusion === true,
    sessionPolicy: options.sessionPolicy || "strict",
  };
  const internalKey = buildStickyInternalKey(fingerprint);
  const ttlMs = parseStickyTtlMs(options.ttlSeconds);

  if (options.reset) {
    const matching = [...slots.entries()].filter(([, slot]) => slot.fingerprint.sessionKeyHash === options.sessionKeyHash);
    if (matching.some(([, slot]) => slot.active)) {
      stickyPoolCounters.busyRejections++;
      throw new Error("sticky_session_busy");
    }
    for (const [key, slot] of matching) {
      evictSlot(key, slot, "reset");
      stickyPoolCounters.resets++;
    }
  }

  // Retry loop handles a queued request waking up after the active turn releases.
  for (;;) {
    const existing = slots.get(internalKey);
    if (existing) {
      if (!existing.subprocess.isHealthy()) {
        evictSlot(internalKey, existing, "unhealthy");
      } else if (existing.active) {
        await waitForSlot(existing, config.queueTimeoutMs);
      } else {
        existing.active = true;
        existing.lastUsedAt = Date.now();
        existing.ttlMs = ttlMs;
        stickyPoolCounters.hits++;
        const userText = existing.readyForIncrementalTurn
          ? buildWarmUserText(options.messages, options.bodyForPrompt)
          : messagesToPrompt(options.messages, options.bodyForPrompt);
        return buildAcquireResult(existing, true, existing.readyForIncrementalTurn, userText, options.ttlSeconds);
      }
      continue;
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
      waiters: [],
      fingerprint,
      readyForIncrementalTurn: false,
    };
    slots.set(internalKey, slot);
    stickyPoolCounters.coldStarts++;
    return buildAcquireResult(slot, false, false, messagesToPrompt(options.messages, options.bodyForPrompt), options.ttlSeconds);
  }
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
    wakeNext(slot);
    return;
  }
  evictSlot(internalKey, slot, result.status === "discard" ? result.reason : "turn_error");
}

function defaultMcpPolicyKey(): string {
  return JSON.stringify({
    translation: process.env.CLAUDE_PROXY_TOOLS_TRANSLATION === "1" ? "on" : "off",
    allow: process.env.CLAUDE_PROXY_MCP_ALLOW || "",
    deny: process.env.CLAUDE_PROXY_MCP_DENY || "",
    config: process.env.CLAUDE_PROXY_OPENCLAW_CONFIG || "",
  });
}

function buildWarmUserText(messages: OpenAIChatMessage[], body: Pick<OpenAIChatRequest, "tools" | "tool_choice">): string {
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

function waitForSlot(slot: StickySlot, timeoutMs: number): Promise<void> {
  stickyPoolCounters.queued++;
  return new Promise((resolve, reject) => {
    const waiter: QueuedWaiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const idx = slot.waiters.indexOf(waiter);
        if (idx >= 0) slot.waiters.splice(idx, 1);
        stickyPoolCounters.queueTimeouts++;
        reject(new Error("sticky_session_busy"));
      }, Math.max(1, timeoutMs)),
    };
    slot.waiters.push(waiter);
  });
}

function wakeNext(slot: StickySlot): void {
  const waiter = slot.waiters.shift();
  if (!waiter) return;
  clearTimeout(waiter.timer);
  waiter.resolve();
}

function rejectWaiters(slot: StickySlot, reason: StickyEvictionReason): void {
  for (const waiter of slot.waiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(`sticky_session_evicted:${reason}`));
  }
}

function evictExpired(now: number, absoluteTtlMs: number): void {
  for (const [key, slot] of slots) {
    if (slot.active) continue;
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
  rejectWaiters(slot, reason);
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

export function resetStickyPoolForTests(): void {
  for (const [key, slot] of slots) evictSlot(key, slot, "reset");
  slots.clear();
  stickyPoolCounters.hits = 0;
  stickyPoolCounters.coldStarts = 0;
  stickyPoolCounters.resets = 0;
  stickyPoolCounters.ttlEvictions = 0;
  stickyPoolCounters.absoluteTtlEvictions = 0;
  stickyPoolCounters.lruEvictions = 0;
  stickyPoolCounters.unhealthyEvictions = 0;
  stickyPoolCounters.fingerprintMismatches = 0;
  stickyPoolCounters.busyRejections = 0;
  stickyPoolCounters.queueTimeouts = 0;
  stickyPoolCounters.queued = 0;
  stickyPoolCounters.modeAccepted.sticky = 0;
  stickyPoolCounters.modeAccepted.pool = 0;
  stickyPoolCounters.modeAccepted.stateless = 0;
  stickyPoolCounters.modeRejected.sticky = 0;
  stickyPoolCounters.modeRejected.pool = 0;
  stickyPoolCounters.modeRejected.stateless = 0;
}
