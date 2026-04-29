/**
 * Watches a StreamJsonSubprocess's outgoing events for evidence that claude
 * has invoked a tool that calls an n8n webhook (typically `Bash` running
 * `curl https://n8n.../webhook/...`). When detected, the proxy uses the
 * n8n progress fetcher to enrich keepalive chunks with real workflow status.
 *
 * Signal source: every stream-json `content_block_start` and
 * `content_block_delta` event is observable. Bash tool input arrives as
 * `input_json_delta` chunks that we accumulate per tool_use id.
 *
 * Detection is purely textual — match a configurable regex against the
 * accumulated tool input. Default pattern catches `n8n.../webhook/...` URLs.
 */

import type { EventEmitter } from "events";

const DEFAULT_PATTERN = /n8n[^"\s]*\/webhook\//i;
const PATTERN = process.env.CLAUDE_PROXY_N8N_DETECTION_PATTERN
  ? new RegExp(process.env.CLAUDE_PROXY_N8N_DETECTION_PATTERN, "i")
  : DEFAULT_PATTERN;

const HOLD_AFTER_DETECTION_MS = 30_000; // window during which keepalive enriches

export interface N8nDetector {
  /** True if a recent claude tool call appears to target n8n. */
  isInFlight(): boolean;
  detach(): void;
}

export function attachN8nDetector(subprocess: EventEmitter): N8nDetector {
  // Per tool_use id, accumulate partial JSON input as it streams in.
  const buffers = new Map<string, string>();
  let lastDetectedAt = 0;

  const onMessage = (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type?: string; event?: { type?: string; index?: number; content_block?: { type?: string; id?: string; name?: string }; delta?: { type?: string; partial_json?: string } } };
    if (m.type !== "stream_event") return;
    const ev = m.event;
    if (!ev) return;

    if (ev.type === "content_block_start") {
      const cb = ev.content_block;
      if (cb?.type === "tool_use" && cb.id) {
        // Start a fresh buffer for this tool_use.
        buffers.set(cb.id, "");
      }
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
      // claude doesn't include id on deltas; map by index. For robustness we
      // append to ALL active buffers and check each — the partial_json text
      // is short and the regex match cost is trivial.
      const partial = ev.delta.partial_json || "";
      if (!partial) return;
      for (const [id, buf] of buffers) {
        const next = buf + partial;
        buffers.set(id, next);
        if (PATTERN.test(next)) {
          lastDetectedAt = Date.now();
        }
      }
    } else if (ev.type === "content_block_stop") {
      // Don't clear yet — claude waits for the tool result before continuing,
      // and during that wait we want isInFlight() to keep returning true.
      // Sliding window via lastDetectedAt does the cleanup naturally.
    }
  };

  subprocess.on("message", onMessage);

  return {
    isInFlight() {
      return lastDetectedAt > 0 && Date.now() - lastDetectedAt < HOLD_AFTER_DETECTION_MS;
    },
    detach() {
      subprocess.off("message", onMessage);
      buffers.clear();
    },
  };
}
