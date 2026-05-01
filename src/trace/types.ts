/**
 * Trace record types for request/response debugging.
 *
 * Every Chat Completions and Responses request gets a stable trace_id.
 * Traces capture structured metadata (model, runtime, tools, errors)
 * without raw secrets, auth headers, or large prompt bodies.
 */

import type { ProtocolErrorClass } from "../errors.js";

export interface TraceToolCall {
  id: string;
  name: string;
  /** Redacted argument keys only, no values */
  argumentKeys: string[];
}

export interface TraceToolResult {
  toolCallId: string;
  name: string;
  /** Byte length of the result content */
  contentLength: number;
}

export interface TraceMcpDecision {
  server: string;
  action: "loaded" | "skipped" | "denied_by_policy" | "overlapping_tool_blocked" | "secret_resolved" | "secret_unresolved";
  reason?: string;
  tools?: string[];
  /** For secret resolution decisions: the env key (not the secret value) */
  envKey?: string;
}

export interface TraceRecord {
  traceId: string;
  requestId: string;
  createdAt: number;
  completedAt?: number;
  durationMs?: number;

  // Request metadata (redacted)
  model: string;
  requestedModel: string;
  runtime: "stream-json" | "print";
  stream: boolean;
  endpoint: "chat.completions" | "responses";
  messageCount: number;

  // Tool bridge
  bridgeTools: boolean;
  toolsOffered: string[];
  toolChoice?: string;
  toolCallsParsed: TraceToolCall[];
  toolCallParseSource?: "result_text" | "buffered_text";
  toolResultsInjected: TraceToolResult[];

  // Completion
  finishReason?: "stop" | "tool_calls" | "length" | "content_filter" | "error";
  responseTokens?: number;
  promptTokens?: number;
  cacheReadTokens?: number;

  // Error / fallback
  errorClass?: ProtocolErrorClass;
  errorMessage?: string;
  fallbackTriggered: boolean;
  fallbackReason?: string;

  // MCP governance
  mcpDecisions: TraceMcpDecision[];

  // Session pool
  sessionWarmHit?: boolean;
}

/**
 * Summary view for the trace list endpoint (excludes bulky arrays).
 */
export interface TraceListItem {
  traceId: string;
  createdAt: number;
  completedAt?: number;
  durationMs?: number;
  model: string;
  runtime: "stream-json" | "print";
  endpoint: "chat.completions" | "responses";
  stream: boolean;
  finishReason?: string;
  errorClass?: ProtocolErrorClass;
  toolCallCount: number;
  fallbackTriggered: boolean;
}
