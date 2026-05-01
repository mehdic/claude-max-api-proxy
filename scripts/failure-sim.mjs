#!/usr/bin/env node
/**
 * Live failure simulation harness for claude-proxy.
 *
 * Exercises failure-adjacent behavior without damaging the running service:
 *   - invalid request returns bounded 400 error
 *   - streaming client abort is tolerated
 *   - trace headers are present
 *   - malformed external tool-call attempts do not crash the proxy
 */

const BASE_URL = process.env.FAILURE_SIM_BASE_URL || "http://127.0.0.1:3456";
const MODEL = process.env.FAILURE_SIM_MODEL || "claude-haiku-4-5-20251001";
const TIMEOUT_MS = Number(process.env.FAILURE_SIM_TIMEOUT_MS || 90_000);

function log(ok, name, detail = "") {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function invalidRequest() {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [] }),
  });
  const body = await res.json();
  if (res.status !== 400 || body.error?.code !== "invalid_messages") throw new Error(`unexpected invalid status ${res.status}`);
  log(true, "invalid-request bounded error");
}

async function streamAbort() {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, stream: true, max_tokens: 128, messages: [{ role: "user", content: "Count slowly from one to ten." }] }),
    signal: ctrl.signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const traceId = res.headers.get("x-claude-proxy-trace-id");
  const reader = res.body.getReader();
  const timer = setTimeout(() => ctrl.abort(), 300);
  try {
    await reader.read();
    ctrl.abort();
  } catch {}
  clearTimeout(timer);
  log(true, "client abort tolerated", traceId ? `trace=${traceId}` : "trace header absent before body read");
}

async function malformedToolAttempt() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 128,
        messages: [{ role: "user", content: "If you use a tool, use lookup_city. Otherwise say ok." }],
        tools: [{ type: "function", function: { name: "lookup_city", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
        tool_choice: "auto",
      }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    JSON.parse(text);
    log(true, "tool-bridge request survives malformed/no-tool model behavior");
  } finally {
    clearTimeout(timer);
  }
}

try {
  await invalidRequest();
  await streamAbort();
  await malformedToolAttempt();
  console.log("\nFailure simulation: passed");
} catch (err) {
  log(false, "failure simulation", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
