/**
 * Conversation Session Pool for stream-json mode
 *
 * Maps `(model, hash(prior conversation prefix))` → live `StreamJsonSubprocess`.
 * On a hit, we just send the new last user message and the in-process claude
 * picks up where it left off — turn 2 reads turn 1's prefix from Anthropic's
 * prompt cache.
 *
 * On a miss, we kill any orphan subprocess for stale keys and either:
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

const IDLE_TTL_MS = 6 * 60 * 1000; // ~1min past Anthropic's 5min cache TTL — enough buffer that we don't evict mid-window from clock skew or in-flight handoff, but not so long we hold dead subprocesses for cache-miss-anyway gaps
const MAX_SESSIONS = 8;

interface Slot {
  subprocess: StreamJsonSubprocess;
  key: string;
  lastUsedAt: number;
}

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
): Promise<AcquireResult> {
  evictExpired();

  if (messages.length === 0) throw new Error("messages required");
  const lastMsg = messages[messages.length - 1];
  if (lastMsg.role !== "user") {
    // Last message must be user; if not, fall back to flattening everything.
    return cold(model, messages);
  }

  const lastUserText = extractText(lastMsg.content);
  const priorKey = hashConversation(model, messages.slice(0, -1));
  const postTurnKey = hashConversation(model, messages); // before assistant response — see note below

  const slot = slots.get(priorKey);
  if (slot && slot.subprocess.isHealthy() && slot.subprocess.getModel() === model) {
    console.error(`[SessionPool] WARM HIT model=${model} key=${priorKey.slice(0, 8)}`);
    slots.delete(priorKey);
    return {
      subprocess: slot.subprocess,
      isWarm: true,
      flattenedPrompt: null,
      lastUserText,
      postTurnKey,
    };
  }

  if (slot) {
    console.error(`[SessionPool] Stale slot for ${priorKey.slice(0, 8)}, killing`);
    slot.subprocess.kill();
    slots.delete(priorKey);
  }

  return cold(model, messages, postTurnKey);
}

async function cold(
  model: ClaudeModel,
  messages: OpenAIChatMessage[],
  postTurnKey?: string,
): Promise<AcquireResult> {
  console.error(`[SessionPool] COLD model=${model} (will use init-pool)`);
  // Pull from the init-pool — most of the time this is a pre-spawned,
  // already-initialized subprocess so cold turns skip the 5s handshake.
  const sub = await acquirePreInit(model);

  return {
    subprocess: sub,
    isWarm: false,
    flattenedPrompt: messagesToFlatPrompt(messages),
    lastUserText: extractText(messages[messages.length - 1].content),
    postTurnKey: postTurnKey ?? hashConversation(model, messages),
  };
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
  const postKey = hashConversation(model, fullMessages);
  slots.set(postKey, { subprocess, key: postKey, lastUsedAt: Date.now() });
  console.error(`[SessionPool] Returned subprocess under key ${postKey.slice(0, 8)} (size=${slots.size})`);
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
      console.error(`[SessionPool] Evicting expired ${k.slice(0, 8)} (age=${now - s.lastUsedAt}ms)`);
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
    console.error(`[SessionPool] LRU evict ${oldest.key.slice(0, 8)}`);
    slots.get(oldest.key)?.subprocess.kill();
    slots.delete(oldest.key);
  }
}

function hashConversation(model: ClaudeModel, messages: OpenAIChatMessage[]): string {
  // Ignore assistant content: the live subprocess already remembers what *it*
  // said. The incoming OpenAI history may differ in whitespace/punctuation
  // (e.g. trailing period stripped by clients) and we don't want that to bust
  // the cache key. Role presence still matters so we hash that.
  const h = createHash("sha256");
  h.update(model);
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
