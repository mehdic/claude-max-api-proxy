#!/usr/bin/env node
/**
 * Lightweight live monitor for claude-proxy.
 *
 * Checks /health plus one tiny Chat Completions request. On failure it exits
 * non-zero and can invoke an operator-provided alert command with the alert
 * body on stdin. The default is intentionally local/no-op friendly; production
 * alerting is configured by LaunchAgent env, not hard-coded into the repo.
 */

import { spawn } from "node:child_process";

const BASE_URL = process.env.CLAUDE_PROXY_MONITOR_BASE_URL || "http://127.0.0.1:3456";
// Keep the monitor on the current stable Sonnet 4.6 alias. Haiku aliases can
// initialize successfully but intermittently hang this tiny non-streaming smoke request.
const MODEL = process.env.CLAUDE_PROXY_MONITOR_MODEL || "claude-sonnet-4-6";
const TIMEOUT_MS = Number(process.env.CLAUDE_PROXY_MONITOR_TIMEOUT_MS || 60_000);
const ALERT_COMMAND = process.env.CLAUDE_PROXY_MONITOR_ALERT_COMMAND || "";

function timeoutSignal() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

async function fetchJson(path, options = {}) {
  const timer = timeoutSignal();
  try {
    const res = await fetch(`${BASE_URL}${path}`, { ...options, signal: timer.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  } finally {
    timer.clear();
  }
}

async function alert(message) {
  if (!ALERT_COMMAND) return;
  await new Promise((resolve) => {
    const child = spawn(ALERT_COMMAND, { shell: true, stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, CLAUDE_PROXY_MONITOR_MESSAGE: message } });
    child.stdin.end(message);
    child.on("close", resolve);
    child.on("error", resolve);
  });
}

async function main() {
  const health = await fetchJson("/health");
  if (health.status !== "ok") throw new Error(`/health status=${health.status}`);

  const chat = await fetchJson("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer local-monitor" },
    body: JSON.stringify({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "Reply with one short word." }] }),
  });
  const content = chat.choices?.[0]?.message?.content;
  if (!content) throw new Error("smoke chat returned no content");

  console.log(JSON.stringify({ ok: true, baseUrl: BASE_URL, runtime: health.runtime, model: MODEL, responseModel: chat.model || null, trace: chat.trace_id || null }));
}

try {
  await main();
} catch (err) {
  const msg = `⚠️ Claude Proxy monitor failed on ${BASE_URL} using ${MODEL}: ${err instanceof Error ? err.message : String(err)}`;
  console.error(msg);
  await alert(msg);
  process.exitCode = 1;
}
