/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */

import type { ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type { OpenAIChatResponse, OpenAIChatChunk } from "../types/openai.js";

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
export function createDoneChunk(requestId: string, model: string): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(model),
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
}

/**
 * Convert Claude CLI result to OpenAI non-streaming response
 */
export function cliResultToOpenai(
  result: ClaudeCliResult,
  requestId: string
): OpenAIChatResponse {
  // Get model from modelUsage or default
  const modelName = result.modelUsage
    ? Object.keys(result.modelUsage)[0]
    : "claude-sonnet-4";

  const inputTokens = result.usage?.input_tokens || 0;
  const outputTokens = result.usage?.output_tokens || 0;
  const cacheReadTokens = result.usage?.cache_read_input_tokens || 0;
  const cacheCreationTokens = result.usage?.cache_creation_input_tokens || 0;

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
          content: ensureString(result.result),
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: inputTokens + cacheReadTokens + cacheCreationTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens,
      prompt_tokens_details: { cached_tokens: cacheReadTokens },
      cache_creation_input_tokens: cacheCreationTokens,
    },
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
