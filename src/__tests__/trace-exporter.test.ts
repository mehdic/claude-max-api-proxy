import test from "node:test";
import assert from "node:assert/strict";
import { buildTraceExportEvent } from "../trace/exporter.js";
import type { TraceRecord } from "../trace/types.js";

function trace(): TraceRecord {
  return {
    traceId: "trace_abc",
    requestId: "req_abc",
    createdAt: 1000,
    completedAt: 1250,
    durationMs: 250,
    model: "claude-sonnet-4-6",
    requestedModel: "sonnet",
    runtime: "stream-json",
    stream: true,
    endpoint: "chat.completions",
    messageCount: 2,
    bridgeTools: true,
    toolsOffered: ["search"],
    toolChoice: "auto",
    toolCallsParsed: [{ id: "call_1", name: "search", argumentKeys: ["query"] }],
    toolResultsInjected: [],
    finishReason: "tool_calls",
    promptTokens: 11,
    responseTokens: 7,
    cacheReadTokens: 3,
    fallbackTriggered: false,
    mcpDecisions: [
      { server: "github", action: "secret_resolved", envKey: "GITHUB_TOKEN" },
      { server: "github", action: "overlapping_tool_blocked", tools: ["search"], reason: "caller tool wins" },
    ],
    sessionWarmHit: true,
  };
}

test("buildTraceExportEvent emits redacted generic spans", () => {
  const event = buildTraceExportEvent(trace(), "generic");
  assert.equal(event.trace_id, "trace_abc");
  assert.equal(event.resource.service_name, "claude-proxy");
  assert.equal(event.resource.format, "generic");
  assert.equal(event.spans[0].name, "claude_proxy.request");
  assert.equal(event.spans.some((s) => s.name === "claude_proxy.tool_call_emitted"), true);
  assert.equal(event.spans.filter((s) => s.name === "claude_proxy.mcp_governance_decision").length, 2);
  const serialized = JSON.stringify(event);
  assert.doesNotMatch(serialized, /secret-value|Bearer|sk-/i);
  assert.match(serialized, /GITHUB_TOKEN/);
});

test("buildTraceExportEvent supports OpenInference-style attributes without prompt bodies", () => {
  const event = buildTraceExportEvent(trace(), "openinference");
  assert.equal(event.resource.format, "openinference");
  assert.equal(event.spans[0].attributes["openinference.span.kind"], "LLM");
  assert.equal(event.spans[0].attributes["llm.model_name"], "claude-sonnet-4-6");
  assert.equal(event.spans[0].attributes["input.value"], "[redacted]");
});
