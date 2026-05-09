/**
 * Types for OpenAI-compatible API
 * Used for Clawdbot integration
 */

export interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: string;
  };
}

export type OpenAIMessageContent = string | OpenAIContentPart[] | null;

export interface OpenAIFunctionDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface OpenAITool {
  type: "function";
  function: OpenAIFunctionDef;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-encoded
  };
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "developer" | "tool";
  content: OpenAIMessageContent;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string; // present when role === "tool"
  name?: string; // tool name for role === "tool"
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  user?: string; // Used for session mapping
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  stream_options?: {
    include_usage?: boolean;
  };
  claude_proxy?: ClaudeProxyRequestExtension;
}

export interface OpenAIChatResponseChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  cache_creation_input_tokens?: number;
  estimated?: boolean;
  estimate_method?: string;
  cost?: UsageCostEstimate;
  cost_usd?: number;
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatResponseChoice[];
  usage: OpenAIUsage;
}

export interface OpenAIToolCallChunkFunction {
  name?: string;
  arguments?: string;
}

export interface OpenAIToolCallChunk {
  index: number;
  id?: string;
  type?: "function";
  function?: OpenAIToolCallChunkFunction;
}

export interface OpenAIChatChunkDelta {
  role?: "assistant";
  content?: string | null;
  tool_calls?: OpenAIToolCallChunk[];
}

export interface OpenAIChatChunkChoice {
  index: number;
  delta: OpenAIChatChunkDelta;
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

export interface OpenAIChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChatChunkChoice[];
  usage?: OpenAIUsage | null;
}

export interface UsageCostEstimate {
  currency: "USD";
  total_cost_usd: number;
  input_cost_usd: number;
  cache_creation_input_cost_usd: number;
  cached_input_cost_usd: number;
  output_cost_usd: number;
  model: string;
  pricing: {
    input_per_1m: number;
    cache_creation_input_per_1m: number;
    cached_input_per_1m: number;
    output_per_1m: number;
    source: string;
    updated_at: string;
    note?: string;
  };
}

export interface OpenAIModel {
  id: string;
  object: "model";
  owned_by: string;
  created?: number;
}

export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}

export interface OpenAIError {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}

export type ClaudeProxySessionMode = "pool" | "sticky" | "stateless";
export type ClaudeProxySessionPolicy = "strict" | "compatible";

export interface ClaudeProxyRequestExtension {
  session_key?: string;
  sessionKey?: string;
  session?: string;
  session_mode?: ClaudeProxySessionMode;
  sessionMode?: ClaudeProxySessionMode;
  mode?: ClaudeProxySessionMode;
  session_ttl_seconds?: number | string;
  sessionTtlSeconds?: number | string;
  ttl_seconds?: number | string;
  session_reset?: boolean | string | number;
  sessionReset?: boolean | string | number;
  reset?: boolean | string | number;
  session_policy?: ClaudeProxySessionPolicy;
  sessionPolicy?: ClaudeProxySessionPolicy;
  policy?: ClaudeProxySessionPolicy;
}

// ── OpenAI Responses API types ──────────────────────────────────────

export interface ResponsesInputTextPart {
  type: "input_text";
  text: string;
}

export interface ResponsesOutputTextPart {
  type: "output_text";
  text: string;
}

export type ResponsesContentPart = ResponsesInputTextPart | ResponsesOutputTextPart;

export interface ResponsesMessageItem {
  role: "user" | "assistant" | "system" | "developer";
  content: string | ResponsesContentPart[];
}

export type ResponsesInput = string | ResponsesMessageItem[];

export interface ResponsesRequest {
  model: string;
  input: ResponsesInput;
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  instructions?: string;
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  claude_proxy?: ClaudeProxyRequestExtension;
}

export interface ResponsesOutputMessageContent {
  type: "output_text";
  text: string;
  annotations?: unknown[];
}

export interface ResponsesFunctionCallOutput {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string; // JSON-encoded
  status: "completed";
}

export interface ResponsesOutputMessage {
  type: "message";
  id: string;
  role: "assistant";
  status: "completed";
  content: ResponsesOutputMessageContent[];
}

export type ResponsesOutputItem = ResponsesOutputMessage | ResponsesFunctionCallOutput;

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
  cost?: UsageCostEstimate;
  cost_usd?: number;
}

export interface ResponsesResponse {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  output: ResponsesOutputItem[];
  output_text: string;
  status: "completed" | "failed" | "incomplete";
  usage: ResponsesUsage;
}
