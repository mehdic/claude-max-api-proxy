import test from "node:test";
import assert from "node:assert/strict";
import {
  responsesToChatRequest,
  chatResponseToResponses,
  chatUsageToResponsesUsage,
  buildResponsesStreamEvents,
  buildTextDeltaEvent,
  buildStreamDoneEvents,
} from "../adapter/responses.js";
import type {
  OpenAIChatResponse,
  OpenAIUsage,
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
  assert.equal(resp.output[0].type, "message");
  assert.equal(resp.output[0].role, "assistant");
  assert.equal(resp.output[0].status, "completed");
  assert.equal(resp.output[0].content[0].type, "output_text");
  assert.equal(resp.output[0].content[0].text, "Hello world");
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
  assert.equal(resp.output[0].content[0].text, "");
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

// ── No regression: existing chat types still work ─────────────────

test("responsesToChatRequest output is valid OpenAIChatRequest shape", () => {
  const req: ResponsesRequest = { model: "claude-sonnet-4-6", input: "Hello" };
  const chat = responsesToChatRequest(req);
  // Must have messages array (Chat Completions requires it)
  assert.ok(Array.isArray(chat.messages));
  assert.ok(chat.messages.length > 0);
  assert.ok(chat.model);
});
