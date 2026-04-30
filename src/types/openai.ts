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

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "developer";
  content: OpenAIMessageContent;
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
  stream_options?: {
    include_usage?: boolean;
  };
}

export interface OpenAIChatResponseChoice {
  index: number;
  message: {
    role: "assistant";
    content: string;
  };
  finish_reason: "stop" | "length" | "content_filter" | null;
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

export interface OpenAIChatChunkDelta {
  role?: "assistant";
  content?: string;
}

export interface OpenAIChatChunkChoice {
  index: number;
  delta: OpenAIChatChunkDelta;
  finish_reason: "stop" | "length" | "content_filter" | null;
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
