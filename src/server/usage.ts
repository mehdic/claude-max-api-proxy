import type { ClaudeCliResult } from "../types/claude-cli.js";
import { estimateCost, normalizeModel, type ClaudeTokenUsageBreakdown } from "./pricing.js";

export function annotateClaudeUsage(result: ClaudeCliResult, requestedModel: string): ClaudeCliResult {
  const usage = usageFromClaudeResult(result);
  const model = modelFromResult(result, requestedModel);
  result.usageEstimated = false;
  result.usageEstimateMethod = "claude_cli_usage";
  result.cost = estimateCost(model, usage);
  return result;
}

export function usageFromClaudeResult(result: ClaudeCliResult): ClaudeTokenUsageBreakdown {
  const inputTokens = Math.max(0, result.usage?.input_tokens || 0);
  const cacheCreationInputTokens = Math.max(0, result.usage?.cache_creation_input_tokens || 0);
  const cachedInputTokens = Math.max(0, result.usage?.cache_read_input_tokens || 0);
  const outputTokens = Math.max(0, result.usage?.output_tokens || 0);
  return {
    inputTokens,
    cacheCreationInputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + cacheCreationInputTokens + cachedInputTokens + outputTokens,
  };
}

export function modelFromResult(result: ClaudeCliResult, requestedModel: string): string {
  const modelUsageModel = result.modelUsage ? Object.keys(result.modelUsage)[0] : "";
  return normalizeModel(modelUsageModel || requestedModel);
}
