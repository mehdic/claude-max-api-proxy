/**
 * Phase Tracker
 *
 * Watches raw stream-json events from a Claude subprocess and derives
 * truthful progress descriptions for meaningful runtime phases:
 *
 *   - tool_use start  → "[progress: using Read…]" (real tool name from the event)
 *   - long tool wait   → "[progress: waiting for Read, 12s…]" (only after silence threshold)
 *   - n8n progress     → delegated to the existing n8n progress module
 *
 * Does NOT fabricate status. Only reports what the event stream proves.
 * Deduplicates: consecutive calls with the same phase return null.
 */

import type { EventEmitter } from "events";

/** Minimum silence (ms) before we report "waiting for tool result". */
const TOOL_WAIT_THRESHOLD_MS = 8_000;

export interface PhaseSnapshot {
  /** Human-readable description of the current phase, or null if nothing new. */
  text: string;
  /** Monotonic phase key for dedup (same key ⇒ don't re-emit). */
  key: string;
}

export interface PhaseTracker {
  /**
   * Return a new progress snapshot if the phase has changed since the last
   * call. Returns null if nothing new to report (dedup).
   */
  poll(): PhaseSnapshot | null;
  detach(): void;
}

export function attachPhaseTracker(subprocess: EventEmitter): PhaseTracker {
  let currentPhase: string = "";        // key of the last reported phase
  let activeToolName: string | null = null;
  let toolStartedAt: number = 0;
  let toolWaitReported: boolean = false;
  let lastContentDeltaAt: number = 0;

  const onMessage = (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as {
      type?: string;
      event?: {
        type?: string;
        content_block?: { type?: string; name?: string };
        delta?: { type?: string };
      };
    };
    if (m.type !== "stream_event") return;
    const ev = m.event;
    if (!ev) return;

    if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      activeToolName = ev.content_block.name || "unknown";
      toolStartedAt = Date.now();
      toolWaitReported = false;
    } else if (ev.type === "content_block_stop" && activeToolName) {
      // Tool input finished — claude is now executing/waiting for the tool result.
      // Keep activeToolName set so the wait phase can fire.
    } else if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
      // Claude started a new text block — tool execution is over.
      activeToolName = null;
      toolWaitReported = false;
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      lastContentDeltaAt = Date.now();
      // Text flowing means no tool wait.
      activeToolName = null;
      toolWaitReported = false;
    }
  };

  subprocess.on("message", onMessage);

  return {
    poll(): PhaseSnapshot | null {
      const now = Date.now();

      // Phase 1: tool_use just started — report the tool name once.
      if (activeToolName && !toolWaitReported) {
        const key = `tool_use:${activeToolName}:${toolStartedAt}`;
        if (key !== currentPhase) {
          currentPhase = key;
          return { text: `[progress: using ${activeToolName}…]`, key };
        }
      }

      // Phase 2: tool wait exceeded threshold — report once.
      if (activeToolName && toolStartedAt > 0 && !toolWaitReported) {
        const elapsed = now - toolStartedAt;
        if (elapsed >= TOOL_WAIT_THRESHOLD_MS) {
          toolWaitReported = true;
          const key = `tool_wait:${activeToolName}:${toolStartedAt}`;
          if (key !== currentPhase) {
            currentPhase = key;
            const secs = Math.round(elapsed / 1000);
            return { text: `[progress: waiting for ${activeToolName}, ${secs}s…]`, key };
          }
        }
      }

      return null;
    },

    detach() {
      subprocess.off("message", onMessage);
    },
  };
}
