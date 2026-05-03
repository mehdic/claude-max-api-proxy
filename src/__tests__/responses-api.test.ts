import test from "node:test";
import assert from "node:assert/strict";
import {
  responsesToChatRequest,
  chatResponseToResponses,
  chatUsageToResponsesUsage,
  toolCallsToFunctionCallOutputs,
  buildResponsesStreamEvents,
  buildTextDeltaEvent,
  buildStreamDoneEvents,
  buildFunctionCallStreamEvents,
} from "../adapter/responses.js";
import type {
  OpenAIChatResponse,
  OpenAIUsage,
  OpenAIToolCall,
  ResponsesRequest,
} from "../types/openai.js";

// ── Request translation ──────────────────────────────────────────

test("responsesToChatRequest: string input becomes single user message", () => {
  const req: ResponsesRequest = { model: "claude-sonnet-4-6", input: "Hello" };
  const chat = responsesToChatRequest(req);
  assert.equal(chat.model, "claude-sonnet-4-6");
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.messages[0].role, "user");
  assert.equal(chat.messages[0].content, "Hello");
});

test("responsesToChatRequest: instructions become system message", () => {
  const req: ResponsesRequest = {
    model: "claude-sonnet-4-6",
    input: "Hi",
    instructions: "You are a pirate.",
  };
  const chat = responsesToChatRequest(req);
  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[0].content, "You are a pirate.");
  assert.equal(chat.messages[1].role, "user");
  assert.equal(chat.messages[1].content, "Hi");
});

test("responsesToChatRequest: array of message items maps roles correctly", () => {
  const req: ResponsesRequest = {
    model: "claude-opus-4-7",
    input: [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Question" },
      { role: "assistant", content: "Answer" },
      { role: "user", content: "Follow-up" },
    ],
  };
  const chat = responsesToChatRequest(req);
  assert.equal(chat.messages.length, 4);
  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[1].role, "user");
  assert.equal(chat.messages[2].role, "assistant");
  assert.equal(chat.messages[3].role, "user");
});

test("responsesToChatRequest: content parts with input_text are extracted", () => {
  const req: ResponsesRequest = {
    model: "claude-sonnet-4-6",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Part 1" },
          { type: "input_text", text: "Part 2" },
        ],
      },
    ],
  };
  const chat = responsesToChatRequest(req);
  assert.equal(chat.messages[0].content, "Part 1\nPart 2");
});

test("responsesToChatRequest: tools and tool_choice pass through", () => {
  const tool = { type: "function" as const, function: { name: "search", parameters: { type: "object" } } };
  const req: ResponsesRequest = {
    model: "claude-sonnet-4-6",
    input: "Search something",
    tools: [tool],
    tool_choice: "auto",
  };
  const chat = responsesToChatRequest(req);
  assert.equal(chat.tools?.length, 1);
  assert.equal(chat.tools?.[0].function.name, "search");
  assert.equal(chat.tool_choice, "auto");
});

test("responsesToChatRequest: max_output_tokens maps to max_tokens", () => {
  const req: ResponsesRequest = { model: "claude-sonnet-4-6", input: "Hi", max_output_tokens: 500 };
  const chat = responsesToChatRequest(req);
  assert.equal(chat.max_tokens, 500);
});

test("responsesToChatRequest: stream flag passes through", () => {
  const req: ResponsesRequest = { model: "claude-sonnet-4-6", input: "Hi", stream: true };
  const chat = responsesToChatRequest(req);
  assert.equal(chat.stream, true);
});

test("responsesToChatRequest: developer role preserved", () => {
  const req: ResponsesRequest = {
    model: "claude-sonnet-4-6",
    input: [
      { role: "developer", content: "Dev instructions" },
      { role: "user", content: "Hi" },
    ],
  };
  const chat = responsesToChatRequest(req);
  assert.equal(chat.messages[0].role, "developer");
});

test("responsesToChatRequest: instructions-only request adds empty user message", () => {
  const req: ResponsesRequest = {
    model: "claude-sonnet-4-6",
    input: [],
    instructions: "Stay concise.",
  };
  const chat = responsesToChatRequest(req);
  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[1].role, "user");
  assert.equal(chat.messages[1].content, "");
});

test("responsesToChatRequest: unknown input item role falls back to user", () => {
  const req: ResponsesRequest = JSON.parse(JSON.stringify({
    model: "claude-sonnet-4-6",
    input: [{ role: "operator", content: "Fallback text" }],
  }));
  const chat = responsesToChatRequest(req);
  assert.equal(chat.messages[0].role, "user");
  assert.equal(chat.messages[0].content, "Fallback text");
});

test("responsesToChatRequest: output_text content parts are preserved", () => {
  const req: ResponsesRequest = {
    model: "claude-sonnet-4-6",
    input: [{ role: "assistant", content: [{ type: "output_text", text: "Prior answer" }] }],
  };
  const chat = responsesToChatRequest(req);
  assert.equal(chat.messages[0].role, "assistant");
  assert.equal(chat.messages[0].content, "Prior answer");
});

test("responsesToChatRequest: non-text content parts are ignored", () => {
  const req: ResponsesRequest = JSON.parse(JSON.stringify({
    model: "claude-sonnet-4-6",
    input: [{ role: "user", content: [{ type: "input_image", image_url: "data:" }] }],
  }));
  const chat = responsesToChatRequest(req);
  assert.equal(chat.messages[0].role, "user");
  assert.equal(chat.messages[0].content, "");
});

test("responsesToChatRequest: temperature zero is preserved", () => {
  const req: ResponsesRequest = { model: "claude-sonnet-4-6", input: "Hi", temperature: 0 };
  const chat = responsesToChatRequest(req);
  assert.equal(chat.temperature, 0);
});

test("responsesToChatRequest: required tool_choice passes through", () => {
  const req: ResponsesRequest = {
    model: "claude-sonnet-4-6",
    input: "Use a tool",
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    tool_choice: "required",
  };
  const chat = responsesToChatRequest(req);
  assert.equal(chat.tool_choice, "required");
});

// ── Response translation ──────────────────────────────────────────

function chatResponse(text: string, usage?: Partial<OpenAIUsage>): OpenAIChatResponse {
  return {
    id: "chatcmpl-abc123",
    object: "chat.completion",
    created: 1700000000,
    model: "claude-sonnet-4",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      ...usage,
    },
  };
}

test("chatResponseToResponses: produces valid response envelope", () => {
  const resp = chatResponseToResponses(chatResponse("Hello world"), "req123");
  assert.equal(resp.object, "response");
  assert.equal(resp.id, "resp_req123");
  assert.equal(resp.status, "completed");
  assert.equal(resp.output_text, "Hello world");
  assert.equal(resp.output.length, 1);
  const msg = resp.output[0] as { type: string; role: string; status: string; content: Array<{ type: string; text: string }> };
  assert.equal(msg.type, "message");
  assert.equal(msg.role, "assistant");
  assert.equal(msg.status, "completed");
  assert.equal(msg.content[0].type, "output_text");
  assert.equal(msg.content[0].text, "Hello world");
});

test("chatResponseToResponses: maps usage correctly", () => {
  const resp = chatResponseToResponses(chatResponse("Hi", {
    prompt_tokens: 200,
    completion_tokens: 80,
    total_tokens: 280,
    prompt_tokens_details: { cached_tokens: 50 },
  }), "req456");
  assert.equal(resp.usage.input_tokens, 200);
  assert.equal(resp.usage.output_tokens, 80);
  assert.equal(resp.usage.total_tokens, 280);
  assert.equal(resp.usage.input_tokens_details?.cached_tokens, 50);
});

test("chatResponseToResponses: empty content handled", () => {
  const chat = chatResponse("");
  chat.choices[0].message.content = null;
  const resp = chatResponseToResponses(chat, "req789");
  assert.equal(resp.output_text, "");
  const msg = resp.output[0] as { type: "message"; content: Array<{ text: string }> };
  assert.equal(msg.content[0].text, "");
});

// ── Usage translation ─────────────────────────────────────────────

test("chatUsageToResponsesUsage: preserves cost annotations", () => {
  const cost = {
    currency: "USD" as const,
    total_cost_usd: 0.0015,
    input_cost_usd: 0.001,
    cache_creation_input_cost_usd: 0,
    cached_input_cost_usd: 0,
    output_cost_usd: 0.0005,
    model: "claude-sonnet-4-6",
    pricing: {
      input_per_1m: 3,
      cache_creation_input_per_1m: 3.75,
      cached_input_per_1m: 0.3,
      output_per_1m: 15,
      source: "fallback-table",
      updated_at: "2026-04-30",
    },
  };
  const usage: OpenAIUsage = {
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    cost,
    cost_usd: 0.0015,
  };
  const responsesUsage = chatUsageToResponsesUsage(usage);
  assert.equal(responsesUsage.cost?.total_cost_usd, 0.0015);
  assert.equal(responsesUsage.cost_usd, 0.0015);
  assert.equal(responsesUsage.input_tokens, 100);
  assert.equal(responsesUsage.output_tokens, 50);
});

// ── Streaming event builders ──────────────────────────────────────

test("buildResponsesStreamEvents: emits valid created, itemAdded, partAdded JSON", () => {
  const events = buildResponsesStreamEvents("resp_abc", "msg_xyz", "claude-sonnet-4-6");
  const created = JSON.parse(events.created);
  assert.equal(created.type, "response.created");
  assert.equal(created.response.id, "resp_abc");
  assert.equal(created.response.status, "in_progress");

  const itemAdded = JSON.parse(events.itemAdded);
  assert.equal(itemAdded.type, "response.output_item.added");
  assert.equal(itemAdded.item.id, "msg_xyz");

  const partAdded = JSON.parse(events.partAdded);
  assert.equal(partAdded.type, "response.content_part.added");
  assert.equal(partAdded.part.type, "output_text");
});

test("buildTextDeltaEvent: produces valid delta event", () => {
  const evt = JSON.parse(buildTextDeltaEvent("chunk of text"));
  assert.equal(evt.type, "response.output_text.delta");
  assert.equal(evt.delta, "chunk of text");
  assert.equal(evt.output_index, 0);
  assert.equal(evt.content_index, 0);
});

test("buildTextDeltaEvent: preserves multiline delta text", () => {
  const evt = JSON.parse(buildTextDeltaEvent("line one\nline two"));
  assert.equal(evt.delta, "line one\nline two");
});

test("buildStreamDoneEvents: emits text.done, part.done, item.done, response.completed", () => {
  const usage = { input_tokens: 100, output_tokens: 50, total_tokens: 150 };
  const events = buildStreamDoneEvents("resp_abc", "msg_xyz", "claude-sonnet-4-6", "Full text", usage);
  assert.equal(events.length, 4);

  const types = events.map((e) => JSON.parse(e).type);
  assert.deepEqual(types, [
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ]);

  const textDone = JSON.parse(events[0]);
  assert.equal(textDone.text, "Full text");

  const completed = JSON.parse(events[3]);
  assert.equal(completed.response.status, "completed");
  assert.equal(completed.response.output_text, "Full text");
  assert.equal(completed.response.usage.input_tokens, 100);
});

// ── Tool-call → function_call mapping ─────────────────────────────

function chatResponseWithToolCalls(): OpenAIChatResponse {
  return {
    id: "chatcmpl-tc123",
    object: "chat.completion",
    created: 1700000000,
    model: "claude-sonnet-4",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: { name: "search_web", arguments: '{"query":"test"}' },
            },
            {
              id: "call_def",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

test("chatResponseToResponses: tool_calls produce function_call output items", () => {
  const resp = chatResponseToResponses(chatResponseWithToolCalls(), "tc_req");
  // First output is the message
  assert.equal(resp.output[0].type, "message");
  // Next are function_call items
  assert.equal(resp.output.length, 3);
  assert.equal(resp.output[1].type, "function_call");
  assert.equal(resp.output[2].type, "function_call");

  const fc1 = resp.output[1] as { type: "function_call"; call_id: string; name: string; arguments: string; status: string };
  assert.equal(fc1.call_id, "call_abc");
  assert.equal(fc1.name, "search_web");
  assert.equal(fc1.arguments, '{"query":"test"}');
  assert.equal(fc1.status, "completed");

  const fc2 = resp.output[2] as { type: "function_call"; call_id: string; name: string };
  assert.equal(fc2.call_id, "call_def");
  assert.equal(fc2.name, "get_weather");
});

test("chatResponseToResponses: no tool_calls produces only message output", () => {
  const resp = chatResponseToResponses(chatResponse("Just text"), "notc_req");
  assert.equal(resp.output.length, 1);
  assert.equal(resp.output[0].type, "message");
});

test("toolCallsToFunctionCallOutputs: maps call ids and arguments", () => {
  const tcs: OpenAIToolCall[] = [
    { id: "call_1", type: "function", function: { name: "foo", arguments: '{"x":1}' } },
  ];
  const fcs = toolCallsToFunctionCallOutputs(tcs);
  assert.equal(fcs.length, 1);
  assert.equal(fcs[0].type, "function_call");
  assert.equal(fcs[0].call_id, "call_1");
  assert.equal(fcs[0].id, "fc_call_1");
  assert.equal(fcs[0].name, "foo");
  assert.equal(fcs[0].arguments, '{"x":1}');
  assert.equal(fcs[0].status, "completed");
});

test("toolCallsToFunctionCallOutputs: empty input returns empty output", () => {
  assert.deepEqual(toolCallsToFunctionCallOutputs([]), []);
});

test("buildFunctionCallStreamEvents: emits added, arguments.done, item.done per tool call", () => {
  const tcs: OpenAIToolCall[] = [
    { id: "call_s1", type: "function", function: { name: "search", arguments: '{"q":"hi"}' } },
  ];
  const events = buildFunctionCallStreamEvents(tcs, 1);
  // 3 events per tool call: added, arguments.done, item.done
  assert.equal(events.length, 3);
  const types = events.map((e) => JSON.parse(e).type);
  assert.deepEqual(types, [
    "response.output_item.added",
    "response.function_call_arguments.done",
    "response.output_item.done",
  ]);

  const added = JSON.parse(events[0]);
  assert.equal(added.output_index, 1);
  assert.equal(added.item.type, "function_call");
  assert.equal(added.item.name, "search");

  const argsDone = JSON.parse(events[1]);
  assert.equal(argsDone.call_id, "call_s1");
  assert.equal(argsDone.arguments, '{"q":"hi"}');
});

test("buildFunctionCallStreamEvents: multiple tool calls get incrementing output_index", () => {
  const tcs: OpenAIToolCall[] = [
    { id: "call_a", type: "function", function: { name: "a", arguments: "{}" } },
    { id: "call_b", type: "function", function: { name: "b", arguments: "{}" } },
  ];
  const events = buildFunctionCallStreamEvents(tcs, 1);
  assert.equal(events.length, 6); // 3 per call
  // First call at output_index 1, second at 2
  assert.equal(JSON.parse(events[0]).output_index, 1);
  assert.equal(JSON.parse(events[3]).output_index, 2);
});

test("buildFunctionCallStreamEvents: empty calls emit no events", () => {
  assert.deepEqual(buildFunctionCallStreamEvents([], 1), []);
});

test("buildStreamDoneEvents: function calls are included before response.completed", () => {
  const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
  const tcs: OpenAIToolCall[] = [
    { id: "call_done", type: "function", function: { name: "lookup", arguments: "{\"id\":1}" } },
  ];
  const events = buildStreamDoneEvents("resp_fc", "msg_fc", "claude-sonnet-4-6", "", usage, tcs);
  const types = events.map((e) => JSON.parse(e).type);
  assert.deepEqual(types.slice(-4), [
    "response.output_item.added",
    "response.function_call_arguments.done",
    "response.output_item.done",
    "response.completed",
  ]);
  const completed = JSON.parse(events.at(-1) || "{}");
  assert.equal(completed.response.output[1].type, "function_call");
  assert.equal(completed.response.output[1].call_id, "call_done");
});

// ── No regression: existing chat types still work ─────────────────

test("responsesToChatRequest output is valid OpenAIChatRequest shape", () => {
  const req: ResponsesRequest = { model: "claude-sonnet-4-6", input: "Hello" };
  const chat = responsesToChatRequest(req);
  // Must have messages array (Chat Completions requires it)
  assert.ok(Array.isArray(chat.messages));
  assert.ok(chat.messages.length > 0);
  assert.ok(chat.model);
});
