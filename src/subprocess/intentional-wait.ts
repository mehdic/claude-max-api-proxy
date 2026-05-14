import type { ClaudeCliMessage, ClaudeCliResult } from "../types/claude-cli.js";

export type IntentionalWaitKind = "schedule_wakeup" | "background_task";
export type IntentionalWaitDetectedBy = "tool_use" | "result_text";

export interface IntentionalWaitState {
  kind: IntentionalWaitKind;
  reason: string;
  detectedBy: IntentionalWaitDetectedBy;
  toolName?: string;
  startedAt: number;
}

const WAIT_TOOL_NAMES = new Set(["ScheduleWakeup", "Monitor", "TaskOutput"]);
const SLEEPING_LOOP_RESULT_RE = /^Sleeping the loop\.\s+Will resume when\b[\s\S]*\.?$/i;

export function detectIntentionalWaitFromMessage(msg: unknown, now: number = Date.now()): IntentionalWaitState | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as {
    type?: string;
    event?: {
      type?: string;
      content_block?: { type?: string; name?: string };
    };
  };

  if (m.type !== "stream_event") return null;
  if (m.event?.type !== "content_block_start") return null;
  const block = m.event.content_block;
  if (block?.type !== "tool_use") return null;
  const toolName = block.name || "";
  if (!WAIT_TOOL_NAMES.has(toolName)) return null;

  if (toolName === "ScheduleWakeup") {
    return {
      kind: "schedule_wakeup",
      reason: "Claude scheduled a wakeup/background continuation",
      detectedBy: "tool_use",
      toolName,
      startedAt: now,
    };
  }

  return {
    kind: "background_task",
    reason: `Claude is waiting on ${toolName}`,
    detectedBy: "tool_use",
    toolName,
    startedAt: now,
  };
}

export function detectIntentionalWaitFromResult(result: ClaudeCliResult, now: number = Date.now()): IntentionalWaitState | null {
  if (result.subtype !== "success" || result.is_error) return null;
  const text = (result.result || "").trim();
  if (!text) return null;

  if (SLEEPING_LOOP_RESULT_RE.test(text)) {
    return {
      kind: "schedule_wakeup",
      reason: "Claude scheduled a wakeup/background continuation",
      detectedBy: "result_text",
      toolName: "ScheduleWakeup",
      startedAt: now,
    };
  }

  return null;
}

export function formatIntentionalWaitStatus(state: IntentionalWaitState, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - state.startedAt) / 1000));
  if (state.kind === "schedule_wakeup") return `waiting for Claude scheduled wakeup/background continuation · ${seconds}s`;
  return `waiting for Claude background task${state.toolName ? ` (${state.toolName})` : ""} · ${seconds}s`;
}
