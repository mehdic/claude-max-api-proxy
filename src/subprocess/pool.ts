/**
 * Subprocess Warm Pool
 *
 * INTENT: Pre-spawn one idle `claude` per recently-used model so the next
 * request skips the ~1.5s claude bootstrap.
 *
 * STATUS: Disabled by default. claude in --print mode has a hard-coded 3s
 * stdin timeout — if no prompt arrives in 3s, it exits with
 * "Error: Input must be provided either through stdin or as a prompt
 * argument when using --print". Real warm-pool support needs
 * --input-format stream-json (persistent NDJSON mode), which is a deeper
 * refactor. The plumbing here is kept so that future work can flip
 * CLAUDE_PROXY_WARM_POOL=1 once stream-json is wired up.
 */

import { ClaudeSubprocess } from "./manager.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";

const MAX_IDLE_MS = 2500; // <3s claude --print stdin deadline
const ENABLED = process.env.CLAUDE_PROXY_WARM_POOL === "1";

interface PreparedSlot {
  subprocess: ClaudeSubprocess;
  preparedAt: number;
}

const warmSlots: Map<ClaudeModel, PreparedSlot> = new Map();
const refilling: Set<ClaudeModel> = new Set();

/**
 * Get a subprocess ready to receive a prompt for `model`. If a warm one is
 * available, pop it; otherwise spawn fresh. Either way, kick off a background
 * refill so the next request also gets a warm subprocess.
 */
export async function acquireSubprocess(model: ClaudeModel): Promise<ClaudeSubprocess> {
  if (!ENABLED) {
    const sub = new ClaudeSubprocess();
    await sub.prepare({ model });
    return sub;
  }

  const slot = warmSlots.get(model);
  warmSlots.delete(model);

  let result: ClaudeSubprocess;
  if (slot && slot.subprocess.isHealthy() && Date.now() - slot.preparedAt < MAX_IDLE_MS) {
    console.error(`[Pool] Warm hit for ${model} (age ${Date.now() - slot.preparedAt}ms)`);
    result = slot.subprocess;
  } else {
    if (slot) {
      const ageMs = Date.now() - slot.preparedAt;
      const healthDetails = slot.subprocess.healthDetails();
      console.error(
        `[Pool] Stale slot for ${model}: age=${ageMs}ms ${JSON.stringify(healthDetails)}`,
      );
      slot.subprocess.kill();
    }
    const sub = new ClaudeSubprocess();
    await sub.prepare({ model });
    result = sub;
  }

  // Refill in the background — don't await, the request shouldn't wait for it.
  refillSlot(model).catch((err) => {
    console.error(`[Pool] Refill failed for ${model}:`, err.message);
  });

  return result;
}

async function refillSlot(model: ClaudeModel): Promise<void> {
  if (refilling.has(model) || warmSlots.has(model)) return;
  refilling.add(model);
  try {
    const sub = new ClaudeSubprocess();
    await sub.prepare({ model });
    if (warmSlots.has(model)) {
      // Race: someone else filled it first. Discard ours.
      sub.kill();
      return;
    }
    warmSlots.set(model, { subprocess: sub, preparedAt: Date.now() });
    console.error(`[Pool] Refilled warm slot for ${model}`);
  } finally {
    refilling.delete(model);
  }
}

/** Drain pool on shutdown. */
export function drainPool(): void {
  for (const [model, slot] of warmSlots) {
    slot.subprocess.kill();
    console.error(`[Pool] Drained ${model}`);
  }
  warmSlots.clear();
}

process.on("SIGTERM", drainPool);
process.on("SIGINT", drainPool);
