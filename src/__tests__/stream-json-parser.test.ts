import test from "node:test";
import assert from "node:assert/strict";
import { parseStreamJsonLine } from "../subprocess/stream-json-parser.js";
import { parseToolCalls } from "../adapter/tools.js";
import { recordToolCallParse, renderMetrics, resetMetrics } from "../server/metrics.js";

test("parseStreamJsonLine: parses control responses", () => {
  const parsed = parseStreamJsonLine('{"type":"control_response","response":{"request_id":"req_1","subtype":"success"}}');
  assert.equal(parsed.kind, "control_response");
  if (parsed.kind === "control_response") {
    assert.equal(parsed.value.response.request_id, "req_1");
  }
});

test("parseStreamJsonLine: parses assistant/result stream events", () => {
  const assistant = parseStreamJsonLine('{"type":"assistant","message":{"model":"claude-sonnet-4","content":[{"type":"text","text":"hi"}]}}');
  assert.equal(assistant.kind, "message");
  const result = parseStreamJsonLine('{"type":"result","subtype":"success","result":"hi","usage":{"input_tokens":1,"output_tokens":1}}');
  assert.equal(result.kind, "message");
});

test("parseStreamJsonLine: reports malformed and empty lines without throwing", () => {
  assert.equal(parseStreamJsonLine("   ").kind, "empty");
  const malformed = parseStreamJsonLine('{"type":"assistant"');
  assert.equal(malformed.kind, "malformed");
  if (malformed.kind === "malformed") assert.match(malformed.error, /JSON|Unexpected|Expected/i);
});

test("parseToolCalls diagnostics distinguish no-call, malformed, rejected, emitted", () => {
  const req = {
    tools: [{ type: "function" as const, function: { name: "get_data", parameters: { type: "object" } } }],
    tool_choice: "auto" as const,
  };

  const noCall = parseToolCalls("plain answer", req);
  assert.equal(noCall.toolCalls.length, 0);
  assert.equal(noCall.diagnostics.attemptedToolCall, false);

  const malformed = parseToolCalls('{"tool_call":{"name":"get_data","arguments":', req);
  assert.equal(malformed.toolCalls.length, 0);
  assert.equal(malformed.diagnostics.malformedJsonObjects > 0, true);

  const rejected = parseToolCalls('{"tool_call":{"name":"other_tool","arguments":{}}}', req);
  assert.equal(rejected.toolCalls.length, 0);
  assert.equal(rejected.diagnostics.rejectedToolCalls, 1);

  const emitted = parseToolCalls('{"tool_call":{"name":"get_data","arguments":{"x":1}}}', req);
  assert.equal(emitted.toolCalls.length, 1);
  assert.equal(emitted.diagnostics.jsonObjects >= 1, true);
});

test("tool parse metrics expose semantic outcomes, not no-call-as-failure", () => {
  resetMetrics();
  recordToolCallParse("emitted", 2);
  recordToolCallParse("no_call", 0);
  recordToolCallParse("malformed", 0);
  recordToolCallParse("rejected", 0);
  const metrics = renderMetrics();
  assert.match(metrics, /claude_proxy_tool_call_parse_total\{outcome="emitted"\} 1/);
  assert.match(metrics, /claude_proxy_tool_call_parse_total\{outcome="no_call"\} 1/);
  assert.match(metrics, /claude_proxy_tool_call_parse_total\{outcome="malformed"\} 1/);
  assert.match(metrics, /claude_proxy_tool_call_parse_total\{outcome="rejected"\} 1/);
  assert.match(metrics, /claude_proxy_tool_call_parse_total\{outcome="calls_emitted"\} 2/);
});
