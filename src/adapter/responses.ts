/**
 * OpenAI Responses API ↔ Chat Completions translation layer
 *
 * Converts Responses API requests into Chat Completions requests, reusing the
 * existing Claude CLI transport. Converts Chat Completions results back into
 * Responses API shapes.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  ResponsesRequest,
  ResponsesResponse,
  ResponsesUsage,
  ResponsesMessageItem,
  ResponsesContentPart,
  ResponsesOutputItem,
  ResponsesFunctionCallOutput,
  OpenAIChatRequest,
  OpenAIChatMessage,
  OpenAIChatResponse,
  OpenAIUsage,
  OpenAIToolCall,
} from "../types/openai.js";

/**
 * Extract text from a Responses API content field (string or content parts array).
 */
function extractResponsesText(content: string | ResponsesContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p) => (p.type === "input_text" || p.type === "output_text") && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

/**
 * Convert a Responses API request into a Chat Completions request.
 * This allows the existing handleChatCompletions machinery to do all the work.
 */
export function responsesToChatRequest(req: ResponsesRequest): OpenAIChatRequest {
  const messages: OpenAIChatMessage[] = [];

  // instructions → system message
  if (req.instructions) {
    messages.push({ role: "system", content: req.instructions });
  }

  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
  } else if (Array.isArray(req.input)) {
    for (const item of req.input) {
      const text = extractResponsesText(item.content);
      const role = item.role === "developer" ? "developer"
        : item.role === "system" ? "system"
        : item.role === "assistant" ? "assistant"
        : "user";
      messages.push({ role, content: text });
    }
  }

  // Ensure at least one user message exists (Chat Completions requires it).
  if (!messages.some((m) => m.role === "user")) {
    messages.push({ role: "user", content: "" });
  }

  return {
    model: req.model,
    messages,
    stream: req.stream,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.max_output_tokens !== undefined ? { max_tokens: req.max_output_tokens } : {}),
    ...(req.tools ? { tools: req.tools } : {}),
    ...(req.tool_choice ? { tool_choice: req.tool_choice } : {}),
  };
}

/**
 * Convert Chat Completions tool_calls to Responses API function_call output items.
 */
export function toolCallsToFunctionCallOutputs(
  toolCalls: OpenAIToolCall[],
): ResponsesFunctionCallOutput[] {
  return toolCalls.map((tc) => ({
    type: "function_call" as const,
    id: `fc_${tc.id}`,
    call_id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
    status: "completed" as const,
  }));
}

/**
 * Convert a Chat Completions response into a Responses API response.
 *
 * When the Chat Completions response contains tool_calls (from the external
 * tool bridge), they are mapped to Responses API function_call output items.
 * The proxy does NOT execute these tools — they are exposed so the caller
 * can dispatch them under its own audit/approval controls.
 */
export function chatResponseToResponses(
  chat: OpenAIChatResponse,
  requestId: string,
): ResponsesResponse {
  const choice = chat.choices[0];
  const text = choice?.message?.content ?? "";
  const toolCalls = choice?.message?.tool_calls;
  const msgId = `msg_${uuidv4().replace(/-/g, "").slice(0, 24)}`;

  const output: ResponsesOutputItem[] = [
    {
      type: "message",
      id: msgId,
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text,
          annotations: [],
        },
      ],
    },
  ];

  // Append function_call items for each tool_call.
  if (toolCalls && toolCalls.length > 0) {
    output.push(...toolCallsToFunctionCallOutputs(toolCalls));
  }

  return {
    id: `resp_${requestId}`,
    object: "response",
    created_at: chat.created,
    model: chat.model,
    output,
    output_text: text,
    status: "completed",
    usage: chatUsageToResponsesUsage(chat.usage),
  };
}

/**
 * Map Chat Completions usage to Responses API usage shape.
 */
export function chatUsageToResponsesUsage(usage: OpenAIUsage): ResponsesUsage {
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.prompt_tokens_details?.cached_tokens !== undefined
      ? { input_tokens_details: { cached_tokens: usage.prompt_tokens_details.cached_tokens } }
      : {}),
    output_tokens_details: { reasoning_tokens: 0 },
    ...(usage.cost ? { cost: usage.cost, cost_usd: usage.cost_usd } : {}),
  };
}

/**
 * Build Responses API SSE streaming events from text + usage.
 */
export function buildResponsesStreamEvents(
  responseId: string,
  msgId: string,
  model: string,
): { created: string; itemAdded: string; partAdded: string } {
  const createdAt = Math.floor(Date.now() / 1000);

  const responseCreated = {
    type: "response.created",
    response: {
      id: responseId,
      object: "response",
      created_at: createdAt,
      model,
      output: [],
      output_text: "",
      status: "in_progress",
    },
  };

  const itemAdded = {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      type: "message",
      id: msgId,
      role: "assistant",
      status: "in_progress",
      content: [],
    },
  };

  const partAdded = {
    type: "response.content_part.added",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  };

  return {
    created: JSON.stringify(responseCreated),
    itemAdded: JSON.stringify(itemAdded),
    partAdded: JSON.stringify(partAdded),
  };
}

export function buildTextDeltaEvent(text: string): string {
  return JSON.stringify({
    type: "response.output_text.delta",
    output_index: 0,
    content_index: 0,
    delta: text,
  });
}

export function buildStreamDoneEvents(
  responseId: string,
  msgId: string,
  model: string,
  fullText: string,
  usage: ResponsesUsage,
  toolCalls: OpenAIToolCall[] = [],
): string[] {
  const createdAt = Math.floor(Date.now() / 1000);
  const events: string[] = [];

  events.push(JSON.stringify({
    type: "response.output_text.done",
    output_index: 0,
    content_index: 0,
    text: fullText,
  }));

  events.push(JSON.stringify({
    type: "response.content_part.done",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: fullText, annotations: [] },
  }));

  events.push(JSON.stringify({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "message",
      id: msgId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: fullText, annotations: [] }],
    },
  }));

  const functionCallOutputs = toolCallsToFunctionCallOutputs(toolCalls);
  if (functionCallOutputs.length > 0) {
    events.push(...buildFunctionCallStreamEvents(toolCalls, 1));
  }

  events.push(JSON.stringify({
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      created_at: createdAt,
      model,
      output: [{
        type: "message",
        id: msgId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: fullText, annotations: [] }],
      }, ...functionCallOutputs],
      output_text: fullText,
      status: "completed",
      usage,
    },
  }));

  return events;
}

/**
 * Build Responses API SSE events for function_call output items.
 * These are appended after the message events when tool_calls are detected.
 */
export function buildFunctionCallStreamEvents(
  toolCalls: OpenAIToolCall[],
  startOutputIndex: number,
): string[] {
  const events: string[] = [];
  const fcOutputs = toolCallsToFunctionCallOutputs(toolCalls);

  for (let i = 0; i < fcOutputs.length; i++) {
    const fc = fcOutputs[i];
    const outputIndex = startOutputIndex + i;

    events.push(JSON.stringify({
      type: "response.output_item.added",
      output_index: outputIndex,
      item: fc,
    }));

    events.push(JSON.stringify({
      type: "response.function_call_arguments.done",
      output_index: outputIndex,
      item_id: fc.id,
      call_id: fc.call_id,
      name: fc.name,
      arguments: fc.arguments,
    }));

    events.push(JSON.stringify({
      type: "response.output_item.done",
      output_index: outputIndex,
      item: fc,
    }));
  }

  return events;
}
