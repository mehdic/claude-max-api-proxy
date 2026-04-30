/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */

import type { ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type { OpenAIChatRequest, OpenAIChatResponse, OpenAIChatChunk, OpenAIUsage, OpenAIToolCall } from "../types/openai.js";
import { parseToolCalls, shouldBridgeExternalTools } from "./tools.js";

/**
 * Extract text content from Claude CLI assistant message
 */
export function extractTextContent(message: ClaudeCliAssistant): string {
  return message.message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export function cliToOpenaiChunk(
  message: ClaudeCliAssistant,
  requestId: string,
  isFirst: boolean = false
): OpenAIChatChunk {
  const text = extractTextContent(message);

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(message.message.model),
    choices: [
      {
        index: 0,
        delta: {
          role: isFirst ? "assistant" : undefined,
          content: text,
        },
        finish_reason: message.message.stop_reason ? "stop" : null,
      },
    ],
  };
}

/**
 * Create a final "done" chunk for streaming
 */
export function createDoneChunk(
  requestId: string,
  model: string,
  usage?: OpenAIUsage | null,
  finishReason: "stop" | "tool_calls" = "stop",
): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(model),
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
    ...(usage !== undefined ? { usage } : {}),
  };
}

/**
 * Create streaming chunks for tool_calls detected in accumulated text.
 * Returns an array of SSE-ready chunk objects — one per tool call with the
 * full function name + arguments in a single chunk (non-incremental).
 */
export function createToolCallChunks(
  requestId: string,
  model: string,
  toolCalls: OpenAIToolCall[],
): OpenAIChatChunk[] {
  return toolCalls.map((tc, idx) => ({
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk" as const,
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(model),
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: idx,
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  }));
}

/**
 * Convert Claude CLI result to OpenAI non-streaming response.
 *
 * When `hasTools` is true, scans the result text for tool_call JSON blocks
 * and converts them to OpenAI-format tool_calls. The remaining text (if any)
 * becomes the content field; if the entire response is tool calls, content
 * is set to null.
 */
export function cliResultToOpenai(
  result: ClaudeCliResult,
  requestId: string,
  toolRequest?: Pick<OpenAIChatRequest, "tools" | "tool_choice">,
): OpenAIChatResponse {
  // Get model from modelUsage or default
  const modelName = result.modelUsage
    ? Object.keys(result.modelUsage)[0]
    : "claude-sonnet-4";

  const usage = resultUsageToOpenAI(result);
  const rawText = ensureString(result.result);

  let content: string | null = rawText;
  let toolCalls: OpenAIToolCall[] | undefined;
  let finishReason: "stop" | "tool_calls" = "stop";

  if (toolRequest && shouldBridgeExternalTools(toolRequest)) {
    const parsed = parseToolCalls(rawText, toolRequest);
    if (parsed.toolCalls.length > 0) {
      toolCalls = parsed.toolCalls;
      // OpenAI tool-call assistant messages should not carry prose content.
      // Drop any model preamble around the JSON tool request.
      content = null;
      finishReason = "tool_calls";
    }
  }

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(modelName),
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}

export function resultUsageToOpenAI(result: ClaudeCliResult): OpenAIUsage {
  const inputTokens = result.usage?.input_tokens || 0;
  const outputTokens = result.usage?.output_tokens || 0;
  const cacheReadTokens = result.usage?.cache_read_input_tokens || 0;
  const cacheCreationTokens = result.usage?.cache_creation_input_tokens || 0;
  const totalTokens = inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens;
  return {
    prompt_tokens: inputTokens + cacheReadTokens + cacheCreationTokens,
    completion_tokens: outputTokens,
    total_tokens: totalTokens,
    prompt_tokens_details: { cached_tokens: cacheReadTokens },
    cache_creation_input_tokens: cacheCreationTokens,
    estimated: Boolean(result.usageEstimated),
    estimate_method: result.usageEstimateMethod,
    ...(result.cost ? { cost: result.cost, cost_usd: result.cost.total_cost_usd } : {}),
  };
}

/**
 * Normalize Claude model names to a consistent format
 * e.g., "claude-sonnet-4-5-20250929" -> "claude-sonnet-4"
 */
/**
 * Defensively convert any value to string to prevent [object Object] in responses
 */
function ensureString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function normalizeModelName(model: string | undefined): string {
  if (!model) return "claude-sonnet-4";
  if (model.includes("opus")) return "claude-opus-4";
  if (model.includes("sonnet")) return "claude-sonnet-4";
  if (model.includes("haiku")) return "claude-haiku-4";
  return model;
}
