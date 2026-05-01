import type { TraceRecord } from "./types.js";

export type TraceExportFormat = "generic" | "openinference";

export interface TraceExportSpan {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  start_time_unix_ms: number;
  end_time_unix_ms?: number;
  attributes: Record<string, string | number | boolean>;
}

export interface TraceExportEvent {
  resource: {
    service_name: "claude-proxy";
    format: TraceExportFormat;
  };
  trace_id: string;
  spans: TraceExportSpan[];
}

const DEFAULT_EXPORT_TIMEOUT_MS = 1500;

export function traceExportEnabled(): boolean {
  return Boolean(process.env.CLAUDE_PROXY_TRACE_EXPORT_URL);
}

export function traceExportFormat(): TraceExportFormat {
  return process.env.CLAUDE_PROXY_TRACE_EXPORT_FORMAT === "openinference" ? "openinference" : "generic";
}

/**
 * Build a redacted, span-shaped event from a local TraceRecord. This is
 * deliberately small: no prompt bodies, no tool argument values, no env values,
 * no file paths beyond already-redacted trace metadata.
 */
export function buildTraceExportEvent(trace: TraceRecord, format: TraceExportFormat = traceExportFormat()): TraceExportEvent {
  const rootSpanId = stableSpanId(trace.traceId, "request");
  const end = trace.completedAt ?? trace.createdAt;
  const common = format === "openinference" ? openInferenceAttributes(trace) : genericAttributes(trace);
  const spans: TraceExportSpan[] = [
    {
      trace_id: trace.traceId,
      span_id: rootSpanId,
      name: "claude_proxy.request",
      start_time_unix_ms: trace.createdAt,
      end_time_unix_ms: end,
      attributes: common,
    },
    {
      trace_id: trace.traceId,
      span_id: stableSpanId(trace.traceId, "backend"),
      parent_span_id: rootSpanId,
      name: "claude_proxy.backend_turn",
      start_time_unix_ms: trace.createdAt,
      end_time_unix_ms: end,
      attributes: {
        "claude_proxy.runtime": trace.runtime,
        "claude_proxy.model": trace.model,
        "claude_proxy.session_warm_hit": trace.sessionWarmHit === true,
        "claude_proxy.fallback_triggered": trace.fallbackTriggered,
        ...(trace.fallbackReason ? { "claude_proxy.fallback_reason": trace.fallbackReason } : {}),
        ...(trace.errorClass ? { "claude_proxy.error_class": trace.errorClass } : {}),
      },
    },
  ];

  trace.toolCallsParsed.forEach((toolCall, index) => {
    spans.push({
      trace_id: trace.traceId,
      span_id: stableSpanId(trace.traceId, `tool:${index}:${toolCall.name}`),
      parent_span_id: rootSpanId,
      name: "claude_proxy.tool_call_emitted",
      start_time_unix_ms: trace.createdAt,
      end_time_unix_ms: end,
      attributes: {
        "tool.name": toolCall.name,
        "tool.call_id": toolCall.id,
        "tool.argument_keys": toolCall.argumentKeys.join(","),
      },
    });
  });

  trace.mcpDecisions.forEach((decision, index) => {
    spans.push({
      trace_id: trace.traceId,
      span_id: stableSpanId(trace.traceId, `mcp:${index}:${decision.server}:${decision.action}`),
      parent_span_id: rootSpanId,
      name: "claude_proxy.mcp_governance_decision",
      start_time_unix_ms: trace.createdAt,
      end_time_unix_ms: end,
      attributes: {
        "mcp.server": decision.server,
        "mcp.action": decision.action,
        ...(decision.reason ? { "mcp.reason": decision.reason } : {}),
        ...(decision.envKey ? { "mcp.env_key": decision.envKey } : {}),
        ...(decision.tools?.length ? { "mcp.tools": decision.tools.join(",") } : {}),
      },
    });
  });

  return {
    resource: { service_name: "claude-proxy", format },
    trace_id: trace.traceId,
    spans,
  };
}

export function exportTrace(trace: TraceRecord): void {
  const url = process.env.CLAUDE_PROXY_TRACE_EXPORT_URL;
  if (!url) return;
  const event = buildTraceExportEvent(trace);
  const timeoutMs = Math.max(100, parseInt(process.env.CLAUDE_PROXY_TRACE_EXPORT_TIMEOUT_MS || "", 10) || DEFAULT_EXPORT_TIMEOUT_MS);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.CLAUDE_PROXY_TRACE_EXPORT_HEADER) {
    const idx = process.env.CLAUDE_PROXY_TRACE_EXPORT_HEADER.indexOf(":");
    if (idx > 0) {
      headers[process.env.CLAUDE_PROXY_TRACE_EXPORT_HEADER.slice(0, idx).trim()] = process.env.CLAUDE_PROXY_TRACE_EXPORT_HEADER.slice(idx + 1).trim();
    }
  }

  const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
  void fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(event),
    signal,
  }).catch((err) => {
    if (process.env.CLAUDE_PROXY_TRACE_EXPORT_DEBUG === "1") {
      console.error("[trace-export] failed", err instanceof Error ? err.message : String(err));
    }
  });
}

function genericAttributes(trace: TraceRecord): Record<string, string | number | boolean> {
  return {
    "claude_proxy.endpoint": trace.endpoint,
    "claude_proxy.runtime": trace.runtime,
    "claude_proxy.model": trace.model,
    "claude_proxy.requested_model": trace.requestedModel,
    "claude_proxy.stream": trace.stream,
    "claude_proxy.message_count": trace.messageCount,
    "claude_proxy.bridge_tools": trace.bridgeTools,
    "claude_proxy.tools_offered_count": trace.toolsOffered.length,
    "claude_proxy.tool_calls_parsed": trace.toolCallsParsed.length,
    "claude_proxy.fallback_triggered": trace.fallbackTriggered,
    ...(trace.finishReason ? { "claude_proxy.finish_reason": trace.finishReason } : {}),
    ...(trace.errorClass ? { "claude_proxy.error_class": trace.errorClass } : {}),
    ...(trace.durationMs !== undefined ? { "claude_proxy.duration_ms": trace.durationMs } : {}),
    ...(trace.promptTokens !== undefined ? { "llm.usage.prompt_tokens": trace.promptTokens } : {}),
    ...(trace.responseTokens !== undefined ? { "llm.usage.completion_tokens": trace.responseTokens } : {}),
    ...(trace.cacheReadTokens !== undefined ? { "llm.usage.cache_read_tokens": trace.cacheReadTokens } : {}),
  };
}

function openInferenceAttributes(trace: TraceRecord): Record<string, string | number | boolean> {
  return {
    ...genericAttributes(trace),
    "openinference.span.kind": "LLM",
    "llm.system": "claude",
    "llm.model_name": trace.model,
    "llm.invocation_parameters": JSON.stringify({ stream: trace.stream, runtime: trace.runtime }),
    "input.value": "[redacted]",
    "output.value": trace.finishReason === "tool_calls" ? "[tool_calls]" : "[redacted]",
  };
}

function stableSpanId(...parts: string[]): string {
  let h = 0x811c9dc5;
  const input = parts.join("\0");
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hi = (h >>> 0).toString(16).padStart(8, "0");
  const lo = Math.imul(h ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return `${hi}${lo.toString(16).padStart(8, "0")}`;
}
