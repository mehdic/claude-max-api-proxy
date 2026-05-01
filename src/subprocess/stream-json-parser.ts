import type { ClaudeCliMessage } from "../types/claude-cli.js";

export interface ClaudeControlResponse {
  type: "control_response";
  response: { request_id: string; subtype: string; error?: string };
}

export type StreamJsonParsedLine =
  | { kind: "empty" }
  | { kind: "control_response"; value: ClaudeControlResponse }
  | { kind: "message"; value: ClaudeCliMessage }
  | { kind: "malformed"; raw: string; error: string };

/**
 * Parse one complete NDJSON line from Claude CLI's stream-json output.
 * This deliberately does not throw: callers can keep the worker alive for
 * unexpected/malformed side-channel lines while tests exercise protocol drift
 * fixtures without spawning a real Claude process.
 */
export function parseStreamJsonLine(line: string): StreamJsonParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "empty" };

  try {
    const parsed = JSON.parse(trimmed) as ClaudeCliMessage | ClaudeControlResponse;
    if ((parsed as { type?: string }).type === "control_response") {
      return { kind: "control_response", value: parsed as ClaudeControlResponse };
    }
    return { kind: "message", value: parsed as ClaudeCliMessage };
  } catch (err) {
    return {
      kind: "malformed",
      raw: trimmed,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
