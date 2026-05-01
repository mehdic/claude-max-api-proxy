import test from "node:test";
import assert from "node:assert/strict";
import { classifyError, isStreamLayerFault } from "../errors.js";
import { parseStreamJsonLine } from "../subprocess/stream-json-parser.js";
import { parseToolCalls } from "../adapter/tools.js";

test("failure simulation: unsupported Claude CLI flag is classified as fallback-eligible stream fault", () => {
  const err = new Error("error: unknown option '--exclude-dynamic-system-prompt-sections'");
  assert.equal(classifyError(err), "unsupported_cli_flag");
  assert.equal(isStreamLayerFault(err), true);
});

test("failure simulation: corrupt interleaved stream-json line is isolated without poisoning next valid event", () => {
  const bad = parseStreamJsonLine('{"type":"assistant","message":');
  assert.equal(bad.kind, "malformed");
  const good = parseStreamJsonLine('{"type":"result","subtype":"success","result":"ok","usage":{"input_tokens":1,"output_tokens":1}}');
  assert.equal(good.kind, "message");
});

test("failure simulation: malformed tool JSON is measured as malformed rather than rejected/no-call", () => {
  const parsed = parseToolCalls('{"tool_call":{"name":"lookup_city","arguments":{"city":', {
    tools: [{ type: "function", function: { name: "lookup_city", parameters: { type: "object" } } }],
    tool_choice: { type: "function", function: { name: "lookup_city" } },
  });
  assert.equal(parsed.toolCalls.length, 0);
  assert.equal(parsed.diagnostics.malformedJsonObjects > 0, true);
  assert.equal(parsed.diagnostics.attemptedToolCall, true);
});

test("failure simulation: denied native MCP-style tool call is rejected instead of emitted", () => {
  const parsed = parseToolCalls('{"tool_call":{"name":"mcp__github__delete_repo","arguments":{"repo":"x"}}}', {
    tools: [{ type: "function", function: { name: "lookup_city", parameters: { type: "object" } } }],
    tool_choice: "required",
  });
  assert.equal(parsed.toolCalls.length, 0);
  assert.equal(parsed.diagnostics.rejectedToolCalls, 1);
});
