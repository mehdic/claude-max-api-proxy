/**
 * Conversation Session Pool for stream-json mode
 *
 * Maps `(model, hash(prior conversation prefix))` → live `StreamJsonSubprocess`.
 * On a hit, we just send the new last user message and the in-process claude
 * picks up where it left off — turn 2 reads turn 1's prefix from Anthropic's
 * prompt cache.
 *
 * On a miss, we kill orphan subprocesses for stale keys and either:
 *   - send the entire conversation as a single flattened user message (cold)
 *   - or replay each prior turn (not implemented; would re-bill assistant turns)
 *
 * After a successful turn, we re-key the subprocess under
 * `hash(messages-after-this-turn)` so the next request finds it.
 *
 * Lifecycle:
 *   - Idle subprocesses are evicted after IDLE_TTL_MS (under Anthropic's 5min
 *     prompt-cache TTL — keeping them longer wastes resources without a
 *     cache benefit).
 *   - Max MAX_SESSIONS concurrent live subprocesses; LRU evict.
 *   - On crash/exit, the subprocess is removed from the map automatically.
 */

import { createHash } from "crypto";
import { StreamJsonSubprocess } from "./stream-json-manager.js";
import { acquirePreInit } from "./init-pool.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
import type { OpenAIChatMessage, OpenAIMessageContent } from "../types/openai.js";

// Pool TTL is the longer of CLAUDE_PROXY_POOL_TTL_MS (default 600_000 = 10
// min, per the operator's preference) and our internal floor of 6 min (~1 min
// past Anthropic's 5-min prompt-cache TTL — anything tighter risks evicting
// mid-cache-window from clock skew). The 10-min default stretches over
// natural pause windows in chat without holding dead processes through
// cache-miss-anyway gaps.
const FLOOR_TTL_MS = 6 * 60 * 1000;
const IDLE_TTL_MS = Math.max(
  FLOOR_TTL_MS,
  parseInt(process.env.CLAUDE_PROXY_POOL_TTL_MS || "600000", 10) || 600_000,
);
// Cap concurrent live workers. Operator override via CLAUDE_PROXY_POOL_MAX.
// When the cap is hit, new conversations cold-spawn instead of joining the
// pool — overflow is graceful, not a failure.
const MAX_SESSIONS = (() => {
  const raw = parseInt(process.env.CLAUDE_PROXY_POOL_MAX || "4", 10);
  return raw > 0 ? raw : 4;
})();

interface Slot {
  subprocess: StreamJsonSubprocess;
  key: string;
  lastUsedAt: number;
  // Fingerprint snapshot taken at insertion time. We compare against this
  // when checking out a worker; drift (model rename, env change between
  // request and re-use) routes the request to a cold spawn instead of
  // reusing a worker whose init context no longer matches.
  fingerprint: SlotFingerprint;
}

interface SlotFingerprint {
  model: ClaudeModel;
  disallowedToolsKey: string;
}

interface AcquireOptions {
  disallowedTools?: string[];
}

function disallowedToolsKey(disallowedTools: string[] = []): string {
  return [...disallowedTools].sort().join(",");
}

// Bounded counters for /metrics. Module-scoped; the metrics endpoint reads
// them. Keep cardinality fixed (no per-request labels here).
export const poolCounters = {
  ttlEvictions: 0,
  lruEvictions: 0,
  fingerprintMismatches: 0,
  warmHits: 0,
  coldSpawns: 0,
};

const slots: Map<string, Slot> = new Map();

export interface AcquireResult {
  subprocess: StreamJsonSubprocess;
  isWarm: boolean; // true => prior history already in subprocess; just send last user msg
  flattenedPrompt: string | null; // for cold path: send this as the single user message
  lastUserText: string; // for warm path: send only this
  postTurnKey: string; // re-key under this after the turn finishes
}

/**
 * Find a live subprocess matching this conversation's prior turns, or create
 * a new one if none. Returns instructions for the caller on what to send.
 */
export async function acquireSession(
  model: ClaudeModel,
  messages: OpenAIChatMessage[],
  options: AcquireOptions = {},
): Promise<AcquireResult> {
  evictExpired();

  if (messages.length === 0) throw new Error("messages required");
  const lastMsg = messages[messages.length - 1];
  if (lastMsg.role !== "user") {
    // Last message must be user; if not, fall back to flattening everything.
    return cold(model, messages, undefined, options);
  }

  const lastUserText = extractText(lastMsg.content);
  const disallowedKey = disallowedToolsKey(options.disallowedTools);
  const priorKey = hashConversation(model, messages.slice(0, -1), disallowedKey);
  const postTurnKey = hashConversation(model, messages, disallowedKey); // before assistant response — see note below

  const slot = slots.get(priorKey);
  if (slot) {
    // Healthy + fingerprint match → warm hit. Anything else → fall back cold.
    const fingerprintOk = slot.fingerprint.model === model
      && slot.fingerprint.disallowedToolsKey === disallowedKey
      && slot.subprocess.getModel() === model;
    if (slot.subprocess.isHealthy() && fingerprintOk) {
      console.error(`[SessionPool] WARM HIT model=${model} key=${priorKey.slice(0, 8)}`);
      poolCounters.warmHits++;
      slots.delete(priorKey);
      return {
        subprocess: slot.subprocess,
        isWarm: true,
        flattenedPrompt: null,
        lastUserText,
        postTurnKey,
      };
    }
    if (!fingerprintOk) {
      console.error(`[SessionPool] FINGERPRINT MISMATCH key=${priorKey.slice(0, 8)} stored.model=${slot.fingerprint.model} requested.model=${model} — routing to cold`);
      poolCounters.fingerprintMismatches++;
    } else {
      console.error(`[SessionPool] Stale slot for ${priorKey.slice(0, 8)}, killing`);
    }
    slot.subprocess.kill();
    slots.delete(priorKey);
  }

  poolCounters.coldSpawns++;
  return cold(model, messages, postTurnKey, options);
}

async function cold(
  model: ClaudeModel,
  messages: OpenAIChatMessage[],
  postTurnKey?: string,
  options: AcquireOptions = {},
): Promise<AcquireResult> {
  console.error(`[SessionPool] COLD model=${model} (will use init-pool)`);
  // Pull from the init-pool when the process can use the default Claude tool
  // policy. Per-request disallowedTools must be present at spawn time, so those
  // requests get a dedicated process rather than a pre-initialized generic one.
  const sub = options.disallowedTools && options.disallowedTools.length > 0
    ? await createDedicatedProcess(model, options.disallowedTools)
    : await acquirePreInit(model);

  return {
    subprocess: sub,
    isWarm: false,
    flattenedPrompt: messagesToFlatPrompt(messages),
    lastUserText: extractText(messages[messages.length - 1].content),
    postTurnKey: postTurnKey ?? hashConversation(model, messages, disallowedToolsKey(options.disallowedTools)),
  };
}

async function createDedicatedProcess(model: ClaudeModel, disallowedTools: string[]): Promise<StreamJsonSubprocess> {
  const sub = new StreamJsonSubprocess();
  await sub.start({ model, disallowedTools });
  return sub;
}

/**
 * Re-key the subprocess after a successful turn so the next request can find it.
 * The caller passes the actual assistant content so we can hash the post-turn
 * conversation accurately.
 */
export function returnSession(
  subprocess: StreamJsonSubprocess,
  model: ClaudeModel,
  messages: OpenAIChatMessage[],
  assistantContent: string,
  options: AcquireOptions = {},
): void {
  evictLRU();

  if (!subprocess.isHealthy()) {
    console.error(`[SessionPool] Not returning unhealthy subprocess`);
    subprocess.kill();
    return;
  }

  const fullMessages: OpenAIChatMessage[] = [
    ...messages,
    { role: "assistant", content: assistantContent },
  ];
  const disallowedKey = disallowedToolsKey(options.disallowedTools);
  const postKey = hashConversation(model, fullMessages, disallowedKey);
  slots.set(postKey, {
    subprocess,
    key: postKey,
    lastUsedAt: Date.now(),
    fingerprint: { model, disallowedToolsKey: disallowedKey },
  });
  console.error(`[SessionPool] Returned subprocess under key ${postKey.slice(0, 8)} (size=${slots.size}/${MAX_SESSIONS})`);
}

/** Snapshot the pool state for /metrics and /healthz/deep. */
export function poolStats(): { size: number; max: number; ttlMs: number } {
  return { size: slots.size, max: MAX_SESSIONS, ttlMs: IDLE_TTL_MS };
}

/** Discard a subprocess (e.g., after error) without re-pooling. */
export function discardSession(subprocess: StreamJsonSubprocess): void {
  subprocess.endInput();
  subprocess.kill();
}

function evictExpired(): void {
  const now = Date.now();
  for (const [k, s] of slots) {
    if (now - s.lastUsedAt > IDLE_TTL_MS || !s.subprocess.isHealthy()) {
      console.error(`[SessionPool] TTL evict ${k.slice(0, 8)} (age=${now - s.lastUsedAt}ms, ttl=${IDLE_TTL_MS}ms)`);
      poolCounters.ttlEvictions++;
      s.subprocess.kill();
      slots.delete(k);
    }
  }
}

function evictLRU(): void {
  while (slots.size >= MAX_SESSIONS) {
    let oldest: { key: string; t: number } | null = null;
    for (const [k, s] of slots) {
      if (!oldest || s.lastUsedAt < oldest.t) oldest = { key: k, t: s.lastUsedAt };
    }
    if (!oldest) return;
    console.error(`[SessionPool] LRU evict ${oldest.key.slice(0, 8)} (cap=${MAX_SESSIONS})`);
    poolCounters.lruEvictions++;
    slots.get(oldest.key)?.subprocess.kill();
    slots.delete(oldest.key);
  }
}

function hashConversation(model: ClaudeModel, messages: OpenAIChatMessage[], disallowedKey: string = ""): string {
  // Ignore assistant content: the live subprocess already remembers what *it*
  // said. The incoming OpenAI history may differ in whitespace/punctuation
  // (e.g. trailing period stripped by clients) and we don't want that to bust
  // the cache key. Role presence still matters so we hash that.
  const h = createHash("sha256");
  h.update(model);
  h.update("\0tools\0");
  h.update(disallowedKey);
  for (const m of messages) {
    h.update("\0");
    h.update(m.role);
    h.update("\0");
    if (m.role === "assistant") continue;
    h.update(extractText(m.content));
  }
  return h.digest("hex");
}

function extractText(content: OpenAIMessageContent): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    return content
      .filter((p): p is typeof p & { text: string } => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return String(content);
}

/**
 * Render the entire OpenAI messages array as a single user-message string.
 * Used for the cold path where we have no live subprocess to feed turn-by-turn.
 * Mirrors the existing messagesToPrompt approach in adapter/openai-to-cli.ts.
 */
function messagesToFlatPrompt(messages: OpenAIChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const text = extractText(m.content);
    if (!text) continue;
    if (m.role === "system" || m.role === "developer") {
      parts.push(`<system>\n${text}\n</system>\n`);
    } else if (m.role === "user") {
      parts.push(text);
    } else if (m.role === "assistant") {
      parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
    }
  }
  return parts.join("\n").trim();
}

export function poolSize(): number {
  return slots.size;
}

export function drainPool(): void {
  for (const [k, s] of slots) {
    s.subprocess.kill();
    console.error(`[SessionPool] Drained ${k.slice(0, 8)}`);
  }
  slots.clear();
}

process.on("SIGTERM", drainPool);
process.on("SIGINT", drainPool);
