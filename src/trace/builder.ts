/**
 * Trace builder — accumulates trace data during request handling and
 * commits the final TraceRecord to the store.
 *
 * Usage:
 *   const tb = createTraceBuilder({ traceId, requestId, ... });
 *   tb.setRuntime("stream-json");
 *   tb.addToolCall({ id, name, argumentKeys: [] });
 *   tb.commit();  // writes to traceStore
 */

import type { TraceRecord, TraceToolCall, TraceToolResult, TraceMcpDecision } from "./types.js";
import type { ProtocolErrorClass } from "../errors.js";
import { traceStore } from "./store.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import { extractArgumentKeys, redactToolChoice } from "./redact.js";
import type { OpenAIToolCall } from "../types/openai.js";

export interface TraceBuilderInit {
  traceId: string;
  requestId: string;
  model: string;
  requestedModel: string;
  stream: boolean;
  endpoint: "chat.completions" | "responses";
}

export interface TraceBuilder {
  readonly traceId: string;
  setRuntime(runtime: "stream-json" | "print"): void;
  setMessageCount(count: number): void;
  setBridgeTools(bridge: boolean, req: Pick<OpenAIChatRequest, "tools" | "tool_choice">): void;
  addToolCall(tc: OpenAIToolCall): void;
  addToolResult(result: TraceToolResult): void;
  addMcpDecision(decision: TraceMcpDecision): void;
  setFinishReason(reason: TraceRecord["finishReason"]): void;
  setUsage(opts: { promptTokens?: number; responseTokens?: number; cacheReadTokens?: number }): void;
  setError(cls: ProtocolErrorClass, message?: string): void;
  setFallback(reason: string): void;
  setSessionWarmHit(warm: boolean): void;
  setToolCallParseSource(source: "result_text" | "buffered_text"): void;
  commit(): void;
}

export function createTraceBuilder(init: TraceBuilderInit): TraceBuilder {
  const record: TraceRecord = {
    traceId: init.traceId,
    requestId: init.requestId,
    createdAt: Date.now(),
    model: init.model,
    requestedModel: init.requestedModel,
    runtime: "stream-json",
    stream: init.stream,
    endpoint: init.endpoint,
    messageCount: 0,
    bridgeTools: false,
    toolsOffered: [],
    toolCallsParsed: [],
    toolResultsInjected: [],
    finishReason: undefined,
    fallbackTriggered: false,
    mcpDecisions: [],
  };

  return {
    get traceId() { return record.traceId; },

    setRuntime(runtime) { record.runtime = runtime; },
    setMessageCount(count) { record.messageCount = count; },

    setBridgeTools(bridge, req) {
      record.bridgeTools = bridge;
      record.toolsOffered = (req.tools || [])
        .filter((t) => t.type === "function")
        .map((t) => t.function.name);
      record.toolChoice = redactToolChoice(req.tool_choice);

      // Record tool results from the request messages
      if ("messages" in req) {
        const messages = (req as OpenAIChatRequest).messages || [];
        for (const msg of messages) {
          if (msg.role === "tool" && msg.tool_call_id) {
            record.toolResultsInjected.push({
              toolCallId: msg.tool_call_id,
              name: msg.name || "unknown",
              contentLength: typeof msg.content === "string" ? msg.content.length : JSON.stringify(msg.content ?? "").length,
            });
          }
        }
      }
    },

    addToolCall(tc) {
      const traced: TraceToolCall = {
        id: tc.id,
        name: tc.function.name,
        argumentKeys: extractArgumentKeys(tc.function.arguments),
      };
      record.toolCallsParsed.push(traced);
    },

    addToolResult(result) {
      record.toolResultsInjected.push(result);
    },

    addMcpDecision(decision) {
      record.mcpDecisions.push(decision);
    },

    setFinishReason(reason) { record.finishReason = reason; },

    setUsage(opts) {
      if (opts.promptTokens !== undefined) record.promptTokens = opts.promptTokens;
      if (opts.responseTokens !== undefined) record.responseTokens = opts.responseTokens;
      if (opts.cacheReadTokens !== undefined) record.cacheReadTokens = opts.cacheReadTokens;
    },

    setError(cls, message) {
      record.errorClass = cls;
      record.errorMessage = message ? message.slice(0, 200) : undefined;
    },

    setFallback(reason) {
      record.fallbackTriggered = true;
      record.fallbackReason = reason;
    },

    setSessionWarmHit(warm) { record.sessionWarmHit = warm; },
    setToolCallParseSource(source) { record.toolCallParseSource = source; },

    commit() {
      record.completedAt = Date.now();
      record.durationMs = record.completedAt - record.createdAt;
      traceStore.set(record);
    },
  };
}
