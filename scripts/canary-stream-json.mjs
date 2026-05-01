#!/usr/bin/env node
/**
 * Stream-json transport canary.
 *
 * Run after Claude CLI updates to validate the reverse-engineered persistent
 * stream-json protocol before advertising the runtime as healthy.
 *
 * Checks per model:
 *   - initialize/control handshake succeeds
 *   - first content delta arrives for a trivial prompt
 *   - result event arrives with usage-ish fields
 *   - caller-dispatched tool-call JSON can be parsed into OpenAI tool_calls
 *   - worker exits gracefully after stdin close
 */

import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { StreamJsonSubprocess } from "../dist/subprocess/stream-json-manager.js";
import { parseToolCalls } from "../dist/adapter/tools.js";

const DEFAULT_MODELS = ["haiku", "sonnet", "opus"];
const models = (process.env.CLAUDE_PROXY_CANARY_MODELS || process.argv.slice(2).join(",") || DEFAULT_MODELS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const timeoutMs = Number(process.env.CLAUDE_PROXY_CANARY_TIMEOUT_MS || 120_000);

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => { throw new Error(`${label} timed out after ${timeoutMs}ms`); }),
  ]);
}

async function closeGracefully(subprocess) {
  subprocess.endInput();
  const [code] = await withTimeout(once(subprocess, "close"), "graceful close");
  if (code !== 0 && code !== null) throw new Error(`worker closed with non-zero code ${code}`);
}

async function terminate(subprocess) {
  try {
    await closeGracefully(subprocess);
  } catch {
    subprocess.kill?.();
  }
}

function assertUsage(result) {
  const usage = result?.usage || {};
  const hasAnyUsage = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
    .some((key) => Number.isFinite(usage[key]));
  if (!hasAnyUsage) throw new Error("result missing usage fields");
}

async function runModel(model) {
  const subprocess = new StreamJsonSubprocess();
  let sawFirstToken = false;
  subprocess.on("content_delta", (event) => {
    if (event?.event?.delta?.text) sawFirstToken = true;
  });

  try {
    await withTimeout(subprocess.start({ model }), `initialize ${model}`);
    const result = await withTimeout(subprocess.submitTurn("Reply with exactly: pong"), `first turn ${model}`);
    if (!sawFirstToken && !String(result?.result || "").includes("pong")) {
      throw new Error("no first token/content observed");
    }
    assertUsage(result);

    // Tool-call validation checks the same parser used by the live bridge with a
    // deterministic fixture. Relying on a live LLM to obey an exact JSON prompt
    // made the canary flaky and hid transport regressions behind model behavior.
    const parsed = parseToolCalls('{"tool_call":{"name":"canary_tool","arguments":{"ok":true}}}', {
      tools: [{ type: "function", function: { name: "canary_tool", parameters: { type: "object" } } }],
      tool_choice: "required",
    });
    if (parsed.toolCalls.length !== 1 || parsed.toolCalls[0].function.name !== "canary_tool") {
      throw new Error(`tool-call parse failed: ${JSON.stringify(parsed.diagnostics)}`);
    }

    await closeGracefully(subprocess);
  } catch (err) {
    await terminate(subprocess);
    throw err;
  }
}

for (const model of models) {
  process.stderr.write(`[canary] ${model} ... `);
  try {
    await runModel(model);
    process.stderr.write("ok\n");
  } catch (err) {
    process.stderr.write("failed\n");
    console.error(err instanceof Error ? err.stack || err.message : err);
    process.exitCode = 1;
    break;
  }
}
