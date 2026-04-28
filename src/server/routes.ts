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
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import type { ClaudeCliAssistant, ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";

const STREAM_JSON_ENABLED = process.env.CLAUDE_PROXY_STREAM_JSON === "1";

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

    if (STREAM_JSON_ENABLED) {
      const model = extractModel(body.model);
      await handleStreamJsonRequest(req, res, model, body, requestId, stream);
      return;
    }

    // Convert to CLI input format
    const cliInput = openaiToCli(body);

    // Acquire a (possibly warm) prepared subprocess. Cold path falls back to
    // spawning here; warm path skips the ~1.5s claude bootstrap.
    const subprocess = await acquireSubprocess(cliInput.model);

    if (stream) {
      await handleStreamingResponse(req, res, subprocess, cliInput, requestId);
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
  requestId: string
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

    subprocess.on("result", (_result: ClaudeCliResult) => {
      isComplete = true;
      if (!res.writableEnded) {
        // Send final done chunk with finish_reason
        const doneChunk = createDoneChunk(requestId, lastModel);
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

  const writeKeepaliveChunk = () => {
    if (res.writableEnded) return;
    const chunk = {
      id: `chatcmpl-${requestId}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: lastModel,
      choices: [{
        index: 0,
        delta: isFirst ? { role: "assistant", content: ZWSP } : { content: ZWSP },
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
          writeKeepaliveChunk();
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

    if (stream && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(createDoneChunk(requestId, lastModel))}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else if (!stream && !res.headersSent) {
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
    subprocess.off("content_delta", onContentDelta);
    subprocess.off("assistant", onAssistant);
    subprocess.off("message", onAnyClaudeEvent);
  }
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
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  });
}
