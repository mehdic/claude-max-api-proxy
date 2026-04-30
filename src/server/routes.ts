/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { acquireSubprocess } from "../subprocess/pool.js";
import { acquireSession, returnSession, discardSession } from "../subprocess/session-pool.js";
import { extractModel, openaiToCli } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
  extractTextContent,
  resultUsageToOpenAI,
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import type { ClaudeCliAssistant, ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";
import { attachN8nDetector } from "../n8n/detector.js";
import { n8nProgressEnabled, getRunningExecution, formatProgress } from "../n8n/progress.js";
import { resolveRuntime, defaultRuntime } from "../subprocess/runtime.js";
import { poolStats } from "../subprocess/session-pool.js";
import { recordRequest, recordSpawnFailure, recordTokenUsage } from "./metrics.js";
import { pricingSnapshot } from "./pricing.js";
import { annotateClaudeUsage, modelFromResult, usageFromClaudeResult } from "./usage.js";

const FALLBACK_ENABLED = process.env.CLAUDE_PROXY_FALLBACK_ON_STREAM_FAILURE === "1";

// Counters for /metrics. Keep cardinality fixed.
export const fallbackCounters = {
  total: 0,
  byReason: {} as Record<string, number>,
};

/**
 * Decide whether a thrown error looks like a stream-layer fault (worth
 * retrying via --print) vs a real model-layer error (rate limit, auth,
 * content policy — should surface to the client).
 *
 * Stream-layer faults bubble up as thrown exceptions from acquireSession,
 * StreamJsonSubprocess.start, or submitTurn. Model-layer errors come back
 * inside the `result` event with is_error=true and are surfaced through the
 * normal response shape — they do NOT throw, so they don't reach this guard.
 */
function isStreamLayerFault(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  // Allowlist of patterns we trust to be transport faults.
  return (
    msg.includes("subprocess closed before result")
    || msg.includes("init handshake timed out")
    || msg.includes("subprocess not initialized")
    || msg.includes("subprocess is dead")
    || msg.includes("stdin not writable")
    || msg.includes("claude cli not found")
    || msg.includes("turn timed out")
    || msg.includes("control error")
  );
}

/**
 * Reduce arbitrary client-provided model strings to one of a fixed set of
 * label values for /metrics. Bounded cardinality is critical — we never want
 * /metrics to grow unbounded labels from random model strings.
 */
const KNOWN_MODEL_LABELS = new Set([
  "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4",
  "claude-sonnet-4-6", "claude-sonnet-4",
  "claude-haiku-4-5-20251001", "claude-haiku-4-5", "claude-haiku-4",
]);
function canonicalizeModelLabel(model: string | undefined): string {
  if (!model) return "unknown";
  // Strip provider prefix (claude-proxy/ or claude-code-cli/).
  const stripped = model.replace(/^(claude-proxy|claude-code-cli)\//, "");
  return KNOWN_MODEL_LABELS.has(stripped) ? stripped : "other";
}

function classifyFallbackReason(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  const msg = err.message.toLowerCase();
  if (msg.includes("init handshake")) return "init_handshake_timeout";
  if (msg.includes("subprocess closed before result")) return "worker_died";
  if (msg.includes("turn timed out")) return "turn_timeout";
  if (msg.includes("claude cli not found")) return "spawn_enoent";
  if (msg.includes("stdin not writable")) return "stdin_closed";
  if (msg.includes("subprocess not initialized") || msg.includes("subprocess is dead")) return "worker_invalid";
  if (msg.includes("control error")) return "control_protocol";
  return "other_stream_fault";
}

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;
  const reqStart = Date.now();
  let usedRuntime: "stream-json" | "print" = "stream-json";
  // Attempt to record metrics on response close, regardless of branch taken.
  res.on("close", () => {
    const status: "ok" | "error" = res.statusCode >= 400 ? "error" : "ok";
    const canonModel = canonicalizeModelLabel(body.model);
    recordRequest({ runtime: usedRuntime, model: canonModel, status, durationMs: Date.now() - reqStart });
  });

  try {
    // Validate request
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    const runtime = resolveRuntime(req);
    usedRuntime = runtime;
    if (process.env.DEBUG) console.error(`[runtime] resolved=${runtime} req_id=${requestId}`);

    if (runtime === "stream-json") {
      const model = extractModel(body.model);
      try {
        await handleStreamJsonRequest(req, res, model, body, requestId, stream);
        return;
      } catch (err) {
        // Auto-fallback: only fires when CLAUDE_PROXY_FALLBACK_ON_STREAM_FAILURE=1,
        // the failure is a recognized stream-layer fault, AND no SSE bytes
        // have been committed to the client yet. Drops through to the --print
        // path below. One retry max — the print path doesn't auto-fall-back.
        if (
          FALLBACK_ENABLED
          && !res.headersSent
          && !res.writableEnded
          && isStreamLayerFault(err)
        ) {
          fallbackCounters.byReason[classifyFallbackReason(err)] =
            (fallbackCounters.byReason[classifyFallbackReason(err)] || 0) + 1;
          fallbackCounters.total++;
          console.warn(
            `[stream_fallback] reason=${classifyFallbackReason(err)} req_id=${requestId} err="${(err as Error).message}"`,
          );
          // fall through to --print path below
        } else {
          throw err;
        }
      }
    }

    // --print path (default fallback / runtime override / fallback retry)
    usedRuntime = "print";
    const cliInput = openaiToCli(body);
    let subprocess: ClaudeSubprocess;
    try {
      subprocess = await acquireSubprocess(cliInput.model);
    } catch (err) {
      recordSpawnFailure("print");
      throw err;
    }

    if (stream) {
      await handleStreamingResponse(req, res, subprocess, cliInput, requestId, body.stream_options?.include_usage === true);
    } else {
      await handleNonStreamingResponse(res, subprocess, cliInput, requestId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string,
  includeUsage: boolean,
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);

  // CRITICAL: Flush headers immediately to establish SSE connection
  // Without this, headers are buffered and client times out waiting
  res.flushHeaders();

  // Send initial comment to confirm connection is alive
  res.write(":ok\n\n");

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    let lastModel = "claude-sonnet-4";
    let isComplete = false;

    // Handle actual client disconnect (response stream closed)
    res.on("close", () => {
      if (!isComplete) {
        // Client disconnected before response completed - kill subprocess
        subprocess.kill();
      }
      resolve();
    });

    // Handle streaming content deltas
    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const text = event.event.delta?.text || "";
      if (text && !res.writableEnded) {
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              role: isFirst ? "assistant" : undefined,
              content: text,
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
      }
    });

    // Handle final assistant message (for model name)
    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      lastModel = message.message.model;
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      isComplete = true;
      if (!res.writableEnded) {
        annotateAndRecordUsage(result, cliInput.model);
        // Send final done chunk with finish_reason
        const doneChunk = createDoneChunk(requestId, lastModel, includeUsage ? resultUsageToOpenAI(result) : undefined);
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      // Subprocess exited - ensure response is closed
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          // Abnormal exit without result - send error
          res.write(`data: ${JSON.stringify({
            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
          })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    // Subprocess is already prepared by the pool; just write the prompt.
    try {
      subprocess.submit(cliInput.prompt);
    } catch (err) {
      console.error("[Streaming] Submit error:", err);
      reject(err);
    }
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      res.status(500).json({
        error: {
          message: error.message,
          type: "server_error",
          code: null,
        },
      });
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (finalResult) {
        annotateAndRecordUsage(finalResult, cliInput.model);
        setUsageHeaders(res, finalResult);
        res.json(cliResultToOpenai(finalResult, requestId));
      } else if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    // Subprocess is already prepared by the pool; just write the prompt.
    try {
      subprocess.submit(cliInput.prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({
        error: { message, type: "server_error", code: null },
      });
      resolve();
    }
  });
}

/**
 * Handle a chat completion via stream-json transport with conversation pooling.
 * Either reuses a live subprocess (warm: cache hits the prior turns) or spawns
 * a new one (cold: sends the conversation as one flat user message).
 */
async function handleStreamJsonRequest(
  _req: Request,
  res: Response,
  model: string,
  body: OpenAIChatRequest,
  requestId: string,
  stream: boolean,
): Promise<void> {
  const acquired = await acquireSession(model, body.messages);
  const subprocess = acquired.subprocess;

  // For warm path, send only the new user message; for cold, send the full
  // flattened conversation as one user message.
  const userText = acquired.isWarm ? acquired.lastUserText : (acquired.flattenedPrompt ?? acquired.lastUserText);

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Request-Id", requestId);
    res.flushHeaders();
    res.write(":ok\n\n");
  }

  let isFirst = true;
  let lastModel = "claude-sonnet-4";
  let assistantText = "";
  let done = false;
  let lastActivityAt = Date.now();

  // -------------------- Keepalive ---------------------
  //
  // openclaw aborts an LLM request when its stream iterator goes
  // `agents.defaults.llm.idleTimeoutSeconds` (default 120s) without yielding.
  // We have to keep that iterator yielding ANY chunk during long claude
  // turns (cold init, deep thinking, tool use, etc.).
  //
  // Three layers, defense-in-depth:
  //
  // 1. Eager handshake — emit a `delta: { role: "assistant" }` chunk the
  //    instant we open the SSE stream, before claude has done anything.
  //    openclaw's iterator yields immediately, idle timer starts already
  //    reset. Eliminates the cold-start race entirely.
  //
  // 2. Activity-bound tracker — `lastActivityAt` is bumped on EVERY claude
  //    event (system init, hooks, message_start, content_block_start,
  //    content_block_delta, message_delta, message_stop). claude is rarely
  //    truly silent — if it's running a tool or thinking, those events
  //    fire and count as activity even when no user-visible text is
  //    generated.
  //
  // 3. Periodic synthetic keepalive — every 5s we check if 10s have passed
  //    since the last activity. If yes, emit a `delta: { content: "​" }`
  //    chunk. Zero-width space: 1 character that openclaw definitely
  //    counts as content (so its client doesn't filter it as empty), but
  //    that no UI renders. Fires repeatedly for the entire request — works
  //    fine even for multi-minute claude turns.
  const KEEPALIVE_GAP_MS = 10_000;
  const KEEPALIVE_CHECK_MS = 5_000;
  const ZWSP = "​"; // zero-width space — counts as content, renders nothing

  // Optional n8n awareness: if a) the proxy is configured with n8n credentials
  // and b) we just observed claude invoke a tool that calls an n8n webhook,
  // the keepalive payload is enriched with a real progress line instead of
  // ZWSP. No-op when env vars unset.
  const n8nDetector = attachN8nDetector(subprocess);
  // Track when we last reported a particular execution so we don't repeat
  // the exact same line on every keepalive fire.
  let lastReportedExecution = "";

  const writeKeepaliveChunk = async () => {
    if (res.writableEnded) return;
    let content: string = ZWSP;
    if (n8nProgressEnabled() && n8nDetector.isInFlight()) {
      const snap = await getRunningExecution();
      if (snap) {
        const line = formatProgress(snap);
        // First report or a different execution → emit visibly.
        // Same execution again → emit ZWSP (still resets idle timer).
        if (snap.executionId !== lastReportedExecution) {
          content = line + " ";
          lastReportedExecution = snap.executionId;
        }
      }
    }
    const chunk = {
      id: `chatcmpl-${requestId}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: lastModel,
      choices: [{
        index: 0,
        delta: isFirst ? { role: "assistant", content } : { content },
        finish_reason: null,
      }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    isFirst = false;
    lastActivityAt = Date.now();
  };

  // Layer 1: eager handshake, fires before claude starts.
  if (stream && !res.writableEnded) {
    const handshake = {
      id: `chatcmpl-${requestId}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: lastModel,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(handshake)}\n\n`);
    isFirst = false;
    lastActivityAt = Date.now();
  }

  // Layer 2: bump activity on ANY claude event, not just content_delta.
  const onAnyClaudeEvent = () => {
    lastActivityAt = Date.now();
  };
  subprocess.on("message", onAnyClaudeEvent);

  // Layer 3: periodic safety-net keepalive.
  const keepaliveTimer = stream
    ? setInterval(() => {
        if (done || res.writableEnded) return;
        if (Date.now() - lastActivityAt >= KEEPALIVE_GAP_MS) {
          // Fire-and-forget — n8n fetch is short-timeout and best-effort.
          void writeKeepaliveChunk();
        }
      }, KEEPALIVE_CHECK_MS)
    : null;
  const stopKeepalive = () => {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
  };

  const onContentDelta = (event: ClaudeCliStreamEvent) => {
    const text = event.event.delta?.text || "";
    if (!text) return;
    assistantText += text;
    lastActivityAt = Date.now();
    if (stream && !res.writableEnded) {
      const chunk = {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: lastModel,
        choices: [{
          index: 0,
          delta: { role: isFirst ? "assistant" : undefined, content: text },
          finish_reason: null,
        }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      isFirst = false;
    }
  };

  const onAssistant = (m: ClaudeCliAssistant) => {
    lastModel = m.message.model;
    // Capture full text in case streaming deltas were missed.
    if (!assistantText) assistantText = extractTextContent(m);
  };

  subprocess.on("content_delta", onContentDelta);
  subprocess.on("assistant", onAssistant);

  res.on("close", () => {
    if (!done) {
      console.error("[StreamJson] client disconnected pre-completion, killing subprocess");
      discardSession(subprocess);
    }
  });

  try {
    const result = await subprocess.submitTurn(userText);
    done = true;
    annotateAndRecordUsage(result, model);

    if (stream && !res.writableEnded) {
      const usage = body.stream_options?.include_usage === true ? resultUsageToOpenAI(result) : undefined;
      res.write(`data: ${JSON.stringify(createDoneChunk(requestId, lastModel, usage))}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else if (!stream && !res.headersSent) {
      setUsageHeaders(res, result);
      res.json(cliResultToOpenai(result, requestId));
    }

    // Re-pool the subprocess for the next turn in this conversation.
    returnSession(subprocess, model, body.messages, assistantText);
  } catch (err) {
    done = true;
    discardSession(subprocess);
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[StreamJson] turn error:", message);
    if (stream && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: { message, type: "server_error", code: null } })}\n\n`);
      res.end();
    } else if (!stream && !res.headersSent) {
      res.status(500).json({ error: { message, type: "server_error", code: null } });
    }
  } finally {
    stopKeepalive();
    n8nDetector.detach();
    subprocess.off("content_delta", onContentDelta);
    subprocess.off("assistant", onAssistant);
    subprocess.off("message", onAnyClaudeEvent);
  }
}

function annotateAndRecordUsage(result: ClaudeCliResult, requestedModel: string): void {
  annotateClaudeUsage(result, requestedModel);
  recordTokenUsage(modelFromResult(result, requestedModel), usageFromClaudeResult(result), result.cost, Boolean(result.usageEstimated));
}

function setUsageHeaders(res: Response, result: ClaudeCliResult): void {
  if (!result.usage || res.headersSent) return;
  const usage = usageFromClaudeResult(result);
  res.setHeader("X-Claude-Proxy-Prompt-Tokens", String(usage.inputTokens + usage.cacheCreationInputTokens + usage.cachedInputTokens));
  res.setHeader("X-Claude-Proxy-Completion-Tokens", String(usage.outputTokens));
  res.setHeader("X-Claude-Proxy-Total-Tokens", String(usage.totalTokens));
  res.setHeader("X-Claude-Proxy-Usage-Estimated", result.usageEstimated ? "true" : "false");
  if (result.cost) res.setHeader("X-Claude-Proxy-Estimated-Cost-Usd", result.cost.total_cost_usd.toFixed(6));
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req: Request, res: Response): void {
  const created = Math.floor(Date.now() / 1000);
  const ids = [
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
    "claude-opus-4",
    "claude-sonnet-4",
    "claude-haiku-4",
  ];
  res.json({
    object: "list",
    data: ids.map((id) => ({
      id,
      object: "model",
      owned_by: "anthropic",
      created,
    })),
  });
}

/**
 * Handle GET /pricing and /v1/pricing
 *
 * Exposes the local public pricing book used for API-equivalent cost estimates.
 */
export function handlePricing(_req: Request, res: Response): void {
  res.json({ object: "pricing_book", ...pricingSnapshot() });
}

/**
 * Handle GET /health
 *
 * Cheap liveness probe — returns immediately. Confirms the process is up
 * and the HTTP listener is bound. No subprocess work. Use this for
 * load-balancer-style health checks.
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  });
}

// Module-level state for /healthz/deep — remembers the last successful
// deep-probe time so a failed probe can report when things last worked.
let lastDeepProbeSuccessAt: number = 0;

/**
 * Handle GET /healthz/deep
 *
 * Real probe — spawns a `claude --print` with a trivial prompt and a 5s
 * budget. Returns 200 with latency + pool stats on success, 503 with the
 * error and the last-success timestamp on failure. Use for the LaunchAgent
 * watchdog and openclaw probes — anything that needs to know whether the
 * proxy can actually serve a request, not just that the port is bound.
 */
export async function handleHealthDeep(_req: Request, res: Response): Promise<void> {
  const start = Date.now();
  try {
    const sub = new ClaudeSubprocess();
    // Plain --print path so /healthz/deep is independent of stream-json
    // health (intentional: a stream-json regression should not mask a
    // working --print fallback).
    const ok = await new Promise<boolean>((resolve, reject) => {
      const PROBE_TIMEOUT_MS = 15000;
      const timer = setTimeout(() => reject(new Error(`deep probe timed out (${PROBE_TIMEOUT_MS / 1000}s)`)), PROBE_TIMEOUT_MS);
      let gotResult = false;
      sub.on("result", () => { gotResult = true; });
      sub.on("close", () => {
        clearTimeout(timer);
        gotResult ? resolve(true) : reject(new Error("subprocess closed without result"));
      });
      sub.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      sub.start("Reply with: ok", { model: "haiku", timeout: PROBE_TIMEOUT_MS }).catch(reject);
    });

    const latencyMs = Date.now() - start;
    if (ok) lastDeepProbeSuccessAt = Date.now();

    res.json({
      ok: true,
      latency_ms: latencyMs,
      runtime: defaultRuntime(),
      pool: poolStats(),
      last_success_ts: lastDeepProbeSuccessAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(503).json({
      ok: false,
      error: message,
      latency_ms: Date.now() - start,
      runtime: defaultRuntime(),
      pool: poolStats(),
      last_success_ts: lastDeepProbeSuccessAt || null,
    });
  }
}
