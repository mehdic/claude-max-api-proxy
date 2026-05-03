/**
 * Phase Tracker
 *
 * Watches raw stream-json events from a Claude subprocess and derives
 * truthful progress descriptions for meaningful runtime phases:
 *
 *   - tool_use start  → "[Working: using Read…]" (real tool name from the event)
 *   - long tool wait   → "[Working: waiting for Read, 12s…]" (only after silence threshold)
 *   - Agent tool       → "[Working: using Sir Greps-a-Lot — inspect auth flow…]"
 *                        (deterministic funny name + extracted activity)
 *   - thinking         → "[Working: thinking…]" (inferred: no tool/text activity
 *                        for ≥8s — conservative, fires once per silent period)
 *   - n8n progress     → delegated to the existing n8n progress module
 *
 * Does NOT fabricate status. Only reports what the event stream proves
 * (tool/text phases) or conservatively infers from silence (thinking).
 * Deduplicates: consecutive calls with the same phase return null.
 */

import type { EventEmitter } from "events";

/** Minimum silence (ms) before we report "waiting for tool result". */
const TOOL_WAIT_THRESHOLD_MS = 8_000;

/**
 * Whimsical subagent names for Agent tool calls. The list is intentionally
 * small so names feel familiar/recurring rather than random noise.
 */
const AGENT_NAMES: readonly string[] = [
  "Sir Greps-a-Lot",
  "Captain Patchwork",
  "The Lint Whisperer",
  "Baron von Stacktrace",
  "Sergeant Refactor",
  "Professor Typecheck",
  "The Merge Marshal",
  "Deputy Debugger",
] as const;

/**
 * Pick a deterministic funny name from a tool-call identifier string.
 * Uses a simple hash → modulo so the same call always gets the same name.
 */
export function agentNameFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return AGENT_NAMES[Math.abs(hash) % AGENT_NAMES.length];
}

/** Max display length for extracted activity text. */
const ACTIVITY_MAX_LEN = 60;

/**
 * Fields we look for (in priority order) inside the Agent tool's JSON input
 * to derive a short activity description.
 */
const ACTIVITY_FIELDS = ["description", "subagent_type", "prompt", "task", "instructions"] as const;

/**
 * Try to extract a useful short activity from accumulated Agent tool JSON input.
 * Returns null if nothing usable is found.
 */
export function extractActivity(partialJson: string): string | null {
  // Try to parse accumulated JSON. If it's still partial, try extracting
  // field values via regex (the JSON may be incomplete mid-stream).
  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(partialJson);
  } catch {
    // Partial JSON — fall through to regex extraction.
  }

  if (obj && typeof obj === "object") {
    for (const field of ACTIVITY_FIELDS) {
      const val = obj[field];
      if (typeof val === "string" && val.trim()) {
        return sanitizeActivity(val);
      }
    }
    return null;
  }

  // Regex fallback for partial JSON: look for "field":"value" patterns.
  for (const field of ACTIVITY_FIELDS) {
    const re = new RegExp(`"${field}"\\s*:\\s*"([^"]{1,200})"`);
    const match = partialJson.match(re);
    if (match && match[1].trim()) {
      return sanitizeActivity(match[1]);
    }
  }
  return null;
}

/**
 * Sanitize an extracted activity string for display: single line, truncated,
 * no secrets or excessive content.
 */
export function sanitizeActivity(raw: string): string | null {
  // Collapse whitespace/newlines to single spaces.
  let clean = raw.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  // Strip anything that looks like a secret/token/path.
  clean = clean.replace(/(?:sk-|ghp_|gho_|Bearer )[^\s"]{6,}/g, "***");
  // Lowercase first char for flow (e.g. "— inspect auth flow…").
  if (clean.length > 0 && clean[0] === clean[0].toUpperCase() && clean[0] !== clean[0].toLowerCase()) {
    clean = clean[0].toLowerCase() + clean.slice(1);
  }
  if (clean.length > ACTIVITY_MAX_LEN) {
    clean = clean.slice(0, ACTIVITY_MAX_LEN - 1).trimEnd() + "\u2026";
  }
  return clean || null;
}

/**
 * Build the display label for an Agent tool call.
 */
function agentDisplayLabel(toolCallId: string, activity: string | null): string {
  const name = agentNameFor(toolCallId);
  if (activity) {
    return `${name} \u2014 ${activity}`;
  }
  return name;
}

/**
 * Map raw Claude tool names to user-friendly display labels.
 * Agent is handled specially via agentDisplayLabel(); this map is for
 * simple static renames only.
 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {};

function displayName(rawToolName: string): string {
  return TOOL_DISPLAY_NAMES[rawToolName] ?? rawToolName;
}

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
  let activeToolCallId: string = "";     // id from content_block_start for Agent naming
  let toolStartedAt: number = 0;
  let toolWaitReported: boolean = false;
  let lastContentDeltaAt: number = 0;

  // Thinking phase: inferred silence while the main agent has no tool/text
  // activity. Fires once per silent period after the silence threshold.
  let lastActivityAt: number = Date.now();
  let thinkingReported: boolean = false;

  // Accumulate JSON input for Agent tool calls to extract activity.
  let agentInputBuffer: string = "";
  let agentActivity: string | null = null;
  let agentActivityExtracted: boolean = false;

  const onMessage = (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as {
      type?: string;
      event?: {
        type?: string;
        content_block?: { type?: string; name?: string; id?: string };
        delta?: { type?: string; partial_json?: string };
      };
    };
    if (m.type !== "stream_event") return;
    const ev = m.event;
    if (!ev) return;

    if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      activeToolName = ev.content_block.name || "unknown";
      activeToolCallId = ev.content_block.id || "";
      toolStartedAt = Date.now();
      toolWaitReported = false;
      lastActivityAt = Date.now();
      thinkingReported = true; // tool is now active — suppress thinking
      // Reset Agent input accumulator.
      if (activeToolName === "Agent") {
        agentInputBuffer = "";
        agentActivity = null;
        agentActivityExtracted = false;
      } else {
        agentInputBuffer = "";
        agentActivity = null;
        agentActivityExtracted = true; // no extraction needed for non-Agent
      }
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
      // Accumulate Agent tool input to extract activity.
      if (activeToolName === "Agent" && !agentActivityExtracted) {
        const partial = ev.delta.partial_json || "";
        if (partial) {
          agentInputBuffer += partial;
          // Try to extract activity after we have some data (don't try on every tiny chunk).
          if (agentInputBuffer.length > 10) {
            const activity = extractActivity(agentInputBuffer);
            if (activity) {
              agentActivity = activity;
              agentActivityExtracted = true;
              // Clear buffer — we don't need more.
              agentInputBuffer = "";
            }
          }
        }
      }
    } else if (ev.type === "content_block_stop" && activeToolName) {
      // Tool input finished — claude is now executing/waiting for the tool result.
      // Last chance to extract activity from accumulated Agent input.
      if (activeToolName === "Agent" && !agentActivityExtracted && agentInputBuffer) {
        const activity = extractActivity(agentInputBuffer);
        if (activity) {
          agentActivity = activity;
        }
        agentActivityExtracted = true;
        agentInputBuffer = "";
      }
      // Keep activeToolName set so the wait phase can fire.
    } else if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
      // Claude started a new text block — tool execution is over.
      activeToolName = null;
      toolWaitReported = false;
      lastActivityAt = Date.now();
      thinkingReported = true; // text is flowing — suppress thinking
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      lastContentDeltaAt = Date.now();
      // Text flowing means no tool wait.
      activeToolName = null;
      toolWaitReported = false;
      lastActivityAt = Date.now();
      thinkingReported = true; // text is flowing — suppress thinking
    }
  };

  subprocess.on("message", onMessage);

  /**
   * Build the display label for the active tool. Agent tools get a funny name
   * plus optional activity; other tools use the static display name.
   */
  const getToolLabel = (): string => {
    if (activeToolName === "Agent") {
      return agentDisplayLabel(activeToolCallId, agentActivity);
    }
    return displayName(activeToolName!);
  };

  return {
    poll(): PhaseSnapshot | null {
      const now = Date.now();
      const label = activeToolName ? getToolLabel() : "";

      // Phase 1: tool_use start (or activity update for Agent).
      // The label is included in the key so that when activity is extracted
      // after the initial report, the phase naturally re-emits once.
      if (activeToolName && !toolWaitReported) {
        const key = `tool_use:${activeToolName}:${toolStartedAt}:${label}`;
        if (key !== currentPhase) {
          currentPhase = key;
          return { text: `[Working: using ${label}…]`, key };
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
            return { text: `[Working: waiting for ${label}, ${secs}s…]`, key };
          }
        }
      }

      // Phase 3: inferred thinking — main agent is silent with no tool active.
      // Conservative: fires once per silent period after the same 8s threshold.
      // Lower priority than tool phases; suppressed once text or tool activity appears.
      if (!activeToolName && !thinkingReported) {
        const silence = now - lastActivityAt;
        if (silence >= TOOL_WAIT_THRESHOLD_MS) {
          thinkingReported = true;
          const key = `thinking:${lastActivityAt}`;
          if (key !== currentPhase) {
            currentPhase = key;
            return { text: "[Working: thinking\u2026]", key };
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
