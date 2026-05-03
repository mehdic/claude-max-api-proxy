import test from "node:test";
import assert from "node:assert/strict";
import { cliResultToOpenai, createDoneChunk, createToolCallChunks } from "../adapter/cli-to-openai.js";
import { messagesToPrompt, openaiToCli } from "../adapter/openai-to-cli.js";
import { assistantToolCallsToPrompt, externalNativeToolDisallowList, parseToolCalls, shouldBridgeExternalTools, toolDefsToPrompt } from "../adapter/tools.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import type { ClaudeCliResult } from "../types/claude-cli.js";

const tool = {
  type: "function" as const,
  function: {
    name: "n8n__n8n_list_workflows",
    description: "List n8n workflows",
    parameters: { type: "object", properties: { limit: { type: "number" } } },
  },
};

function req(overrides: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest {
  return {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "List workflows" }],
    tools: [tool],
    ...overrides,
  };
}

function result(text: string): ClaudeCliResult {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: text,
    session_id: "s",
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { "claude-sonnet-4-6": { inputTokens: 1, outputTokens: 1, costUSD: 0 } },
  };
}

test("tool instructions preserve Claude native capability composability", () => {
  const prompt = toolDefsToPrompt(req());
  assert.match(prompt, /in addition to your native Claude Code capabilities\/tools/);
  assert.match(prompt, /proxy will not execute them/);
  assert.match(prompt, /Do not treat this bridge as replacing or disabling Claude Code native tools\/capabilities/);
});

test("external bridge disallows overlapping native MCP tool names", () => {
  const disallowed = externalNativeToolDisallowList(req());
  assert.deepEqual(disallowed, ["mcp__n8n__n8n__n8n_list_workflows", "mcp__n8n__n8n_list_workflows", "n8n__n8n_list_workflows"]);
  assert.deepEqual(openaiToCli(req()).disallowedTools, disallowed);
});

test("tool_choice none disables external bridge", () => {
  assert.equal(shouldBridgeExternalTools(req({ tool_choice: "none" })), false);
  assert.equal(messagesToPrompt(req({ tool_choice: "none" }).messages, req({ tool_choice: "none" })).includes("claude_proxy_openai_tools"), false);
});

test("single schema-style synthetic tool is not treated as external operational bridge", () => {
  const schemaReq = req({ tools: [{ type: "function", function: { name: "Decision", parameters: { type: "object" } } }] });
  assert.equal(shouldBridgeExternalTools(schemaReq), false);
});

test("messagesToPrompt preserves tool results", () => {
  const prompt = messagesToPrompt([
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: tool.function.name, arguments: "{\"limit\":5}" } }] },
    { role: "tool", tool_call_id: "call_1", name: tool.function.name, content: "{\"count\":5}" },
  ], req());
  assert.match(prompt, /<tool_result name="n8n__n8n_list_workflows" tool_call_id="call_1">/);
  assert.match(prompt, /"count":5/);
});

test("parseToolCalls handles prose-prefixed JSON", () => {
  const parsed = parseToolCalls(`I will use the external tool.\n{"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{"limit":5}}}`, req());
  assert.equal(parsed.toolCalls[0].function.name, tool.function.name);
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).limit, 5);
  assert.doesNotMatch(parsed.textContent, /tool_call/);
});

test("parseToolCalls handles duplicate adjacent JSON objects", () => {
  const text = `{"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{"limit":5}}}{"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{"limit":6}}}`;
  const parsed = parseToolCalls(text, req());
  assert.equal(parsed.toolCalls.length, 2);
  assert.equal(JSON.parse(parsed.toolCalls[1].function.arguments).limit, 6);
});

test("parseToolCalls skips irrelevant JSON and fenced allowed call", () => {
  const parsed = parseToolCalls('{"note":"ignore"}\n\n```json\n{"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{"limit":7}}}\n```', req());
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).limit, 7);
});

test("parseToolCalls accepts Claude MCP-style name/parameters JSON and maps to OpenClaw tool name", () => {
  const parsed = parseToolCalls('```json\n{"name":"mcp__n8n__n8n_list_workflows","parameters":{"limit":3}}\n```', req());
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, "n8n__n8n_list_workflows");
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).limit, 3);
});

test("named tool_choice allows only the selected external tool", () => {
  const request = req({
    tool_choice: { type: "function", function: { name: "n8n__n8n_list_workflows" } },
    tools: [tool, { type: "function", function: { name: "web_search", parameters: { type: "object" } } }],
  });
  const parsed = parseToolCalls(`{"tool_call":{"name":"web_search","arguments":{}}}\n{"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{"limit":1}}}`, request);
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, "n8n__n8n_list_workflows");
});

test("cliResultToOpenai converts external tool request to OpenAI tool_calls", () => {
  const response = cliResultToOpenai(result(`{"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{"limit":5}}}`), "req1", req());
  const choice = response.choices[0];
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.content, null);
  assert.equal(choice.message.tool_calls?.[0].function.name, tool.function.name);
});

test("cliResultToOpenai leaves no-tool answer unchanged", () => {
  const response = cliResultToOpenai(result("Normal answer"), "req1", req());
  assert.equal(response.choices[0].finish_reason, "stop");
  assert.equal(response.choices[0].message.content, "Normal answer");
  assert.equal(response.choices[0].message.tool_calls, undefined);
});

test("streaming tool call helpers emit valid tool_calls delta and finish reason", () => {
  const response = cliResultToOpenai(result(`{"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{"limit":5}}}`), "req1", req());
  const chunks = createToolCallChunks("req1", "claude-sonnet-4-6", response.choices[0].message.tool_calls || []);
  assert.equal(chunks[0].choices[0].delta.tool_calls?.[0].function?.name, tool.function.name);
  assert.equal(createDoneChunk("req1", "claude-sonnet-4-6", null, "tool_calls").choices[0].finish_reason, "tool_calls");
});

test("parseToolCalls accepts top-level name and arguments shape", () => {
  const parsed = parseToolCalls('{"name":"n8n__n8n_list_workflows","arguments":{"limit":9}}', req());
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, tool.function.name);
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).limit, 9);
});

test("parseToolCalls ignores non-object arguments safely", () => {
  const parsed = parseToolCalls('{"tool_call":{"name":"n8n__n8n_list_workflows","arguments":["bad"]}}', req());
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.arguments, "{}");
});

test("parseToolCalls preserves caller supplied tool call id", () => {
  const parsed = parseToolCalls('{"tool_call":{"id":"call_fixed","name":"n8n__n8n_list_workflows","arguments":{}}}', req());
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].id, "call_fixed");
});

test("parseToolCalls generates OpenAI-style id when missing", () => {
  const parsed = parseToolCalls('{"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{}}}', req());
  assert.equal(parsed.toolCalls.length, 1);
  assert.match(parsed.toolCalls[0].id, /^call_/);
});

test("named tool_choice for unknown tool rejects all parsed calls", () => {
  const request = req({ tool_choice: { type: "function", function: { name: "missing_tool" } } });
  const parsed = parseToolCalls('{"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{}}}', request);
  assert.equal(parsed.toolCalls.length, 0);
  assert.equal(parsed.diagnostics.rejectedToolCalls, 1);
});

test("parseToolCalls reports malformed attempted bridge JSON", () => {
  const parsed = parseToolCalls('{"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{', req());
  assert.equal(parsed.toolCalls.length, 0);
  assert.equal(parsed.diagnostics.malformedJsonObjects, 1);
  assert.equal(parsed.diagnostics.attemptedToolCall, true);
});

test("parseToolCalls removes rejected tool JSON from text content", () => {
  const parsed = parseToolCalls('before {"tool_call":{"name":"not_allowed","arguments":{}}} after', req());
  assert.equal(parsed.toolCalls.length, 0);
  assert.equal(parsed.textContent, "before  after");
  assert.equal(parsed.diagnostics.rejectedToolCalls, 1);
});

test("messagesToPrompt escapes tool result attributes", () => {
  const prompt = messagesToPrompt([
    { role: "tool", tool_call_id: 'call_"<&', name: 'tool_"<&', content: "ok" },
  ], req());
  assert.match(prompt, /name="tool_&quot;&lt;&amp;"/);
  assert.match(prompt, /tool_call_id="call_&quot;&lt;&amp;"/);
});

test("assistantToolCallsToPrompt escapes JSON string fields", () => {
  const prompt = assistantToolCallsToPrompt({
    role: "assistant",
    content: null,
    tool_calls: [{ id: 'call_"x', type: "function", function: { name: 'tool_"y', arguments: "{}" } }],
  });
  assert.match(prompt, /\\"x/);
  assert.match(prompt, /\\"y/);
});
