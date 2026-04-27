/**
 * Pre-initialized stream-json subprocess pool.
 *
 * Cold start of a stream-json subprocess takes ~5s: spawn (1s) + claude
 * session-init hooks (2-3s) + initialize control_request handshake (1s).
 * Clients (openclaw) often disconnect before that gap closes when the
 * conversation is "cold" — no warm session-pool entry to reuse.
 *
 * This pool keeps one already-initialized subprocess waiting per model.
 * acquirePreInit() pops the warm one, kicks off a background refill, and
 * returns a subprocess that's ready to receive submitTurn() immediately —
 * shaving ~5s off every conversation-cold turn.
 */

import { StreamJsonSubprocess } from "./stream-json-manager.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";

const ENABLED = process.env.CLAUDE_PROXY_INIT_POOL !== "0"; // default on
const slots: Map<ClaudeModel, StreamJsonSubprocess> = new Map();
const refilling: Set<ClaudeModel> = new Set();

export async function acquirePreInit(model: ClaudeModel): Promise<StreamJsonSubprocess> {
  if (!ENABLED) {
    const sub = new StreamJsonSubprocess();
    await sub.start({ model });
    return sub;
  }

  const cached = slots.get(model);
  slots.delete(model);

  let result: StreamJsonSubprocess;
  if (cached && cached.isHealthy()) {
    console.error(`[InitPool] Pre-init hit for ${model} (age ${cached.getAge()}ms)`);
    result = cached;
  } else {
    if (cached) {
      console.error(`[InitPool] Stale pre-init for ${model}, killing`);
      cached.kill();
    }
    console.error(`[InitPool] No pre-init for ${model}, spawning fresh`);
    result = new StreamJsonSubprocess();
    await result.start({ model });
  }

  // Refill in background — don't await, the request shouldn't wait for it.
  refillSlot(model).catch((err) => {
    console.error(`[InitPool] Refill failed for ${model}:`, err.message);
  });

  return result;
}

async function refillSlot(model: ClaudeModel): Promise<void> {
  if (refilling.has(model) || slots.has(model)) return;
  refilling.add(model);
  try {
    const sub = new StreamJsonSubprocess();
    await sub.start({ model });
    if (slots.has(model)) {
      sub.kill(); // raced
      return;
    }
    slots.set(model, sub);
    console.error(`[InitPool] Refilled pre-init for ${model}`);
  } finally {
    refilling.delete(model);
  }
}

/**
 * Eagerly fill the pool for the given models on startup so the very first
 * request of each model doesn't pay the cold cost.
 */
export function preWarm(models: ClaudeModel[]): void {
  if (!ENABLED) return;
  for (const m of models) {
    refillSlot(m).catch((err) => {
      console.error(`[InitPool] Pre-warm failed for ${m}:`, err.message);
    });
  }
}

export function drainInitPool(): void {
  for (const [m, s] of slots) {
    s.kill();
    console.error(`[InitPool] Drained ${m}`);
  }
  slots.clear();
}

process.on("SIGTERM", drainInitPool);
process.on("SIGINT", drainInitPool);
