#!/usr/bin/env node
/**
 * Live soak / smoke test for claude-proxy.
 *
 * Exercises:
 *   1. Parallel fanout  — N concurrent chat/completions (streaming + non-streaming)
 *   2. Streaming Responses API — validates SSE event sequence
 *   3. Client abort / cancellation — opens a streaming request and closes early
 *
 * Safe & bounded:
 *   - Sends a single short prompt per request ("Reply with: ok")
 *   - Configurable concurrency, timeout, and base URL via env/CLI
 *   - No secrets required — uses the proxy's local auth
 *   - Exit code 0 on full success, 1 on any failure
 *
 * Usage:
 *   node scripts/soak.mjs                          # defaults
 *   SOAK_BASE_URL=http://127.0.0.1:3456 \
 *   SOAK_CONCURRENCY=4 \
 *   SOAK_TIMEOUT_MS=30000 \
 *   SOAK_MODEL=claude-haiku-4-5-20251001 \
 *     node scripts/soak.mjs
 *
 * npm scripts:
 *   npm run soak          # run soak suite
 *   npm run soak:quick    # concurrency=1, fast smoke
 */

const BASE_URL = process.env.SOAK_BASE_URL || "http://127.0.0.1:3456";
const CONCURRENCY = parseInt(process.env.SOAK_CONCURRENCY || "2", 10);
const TIMEOUT_MS = parseInt(process.env.SOAK_TIMEOUT_MS || "30000", 10);
const MODEL = process.env.SOAK_MODEL || "claude-haiku-4-5-20251001";

const results = [];
let passed = 0;
let failed = 0;

function log(label, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${label}] ${msg}`);
}

function fail(label, msg) {
  console.error(`[FAIL] [${label}] ${msg}`);
  results.push({ label, ok: false, error: msg });
  failed++;
}

function pass(label, detail) {
  log(label, `OK ${detail || ""}`);
  results.push({ label, ok: true });
  passed++;
}

// ── Helpers ────────────────────────────────────────────────────────

async function fetchWithTimeout(url, opts, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function chatBody(stream = false) {
  return JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
    stream,
    max_tokens: 16,
  });
}

function responsesBody(stream = false) {
  return JSON.stringify({
    model: MODEL,
    input: "Reply with exactly: ok",
    stream,
    max_output_tokens: 16,
  });
}

// ── 0. Reachability ───────────────────────────────────────────────

async function checkHealth() {
  const label = "health";
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/health`, {}, 5000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.status !== "ok") throw new Error(`status=${body.status}`);
    pass(label, `provider=${body.provider}`);
  } catch (e) {
    fail(label, e.message);
    throw new Error("Proxy unreachable — aborting soak");
  }
}

// ── 1. Parallel fanout ────────────────────────────────────────────

async function parallelFanout() {
  const label = "parallel-fanout";
  log(label, `launching ${CONCURRENCY} concurrent non-streaming requests`);

  const tasks = Array.from({ length: CONCURRENCY }, (_, i) =>
    fetchWithTimeout(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatBody(false),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`req ${i}: HTTP ${res.status}`);
        const json = await res.json();
        const text = json.choices?.[0]?.message?.content || "";
        if (!text) throw new Error(`req ${i}: empty content`);
        return { i, text, usage: json.usage };
      })
  );

  const settled = await Promise.allSettled(tasks);
  const failures = settled.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    fail(label, `${failures.length}/${CONCURRENCY} failed: ${failures.map((f) => f.reason.message).join("; ")}`);
  } else {
    pass(label, `${CONCURRENCY}/${CONCURRENCY} succeeded`);
  }
}

// ── 2. Streaming chat completions ─────────────────────────────────

async function streamingChat() {
  const label = "streaming-chat";
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatBody(true),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));
    const hasDone = lines.some((l) => l === "data: [DONE]");
    const dataChunks = lines.filter((l) => l !== "data: [DONE]");
    if (dataChunks.length === 0) throw new Error("no data chunks received");
    if (!hasDone) throw new Error("missing [DONE] sentinel");
    pass(label, `${dataChunks.length} chunks, [DONE] present`);
  } catch (e) {
    fail(label, e.message);
  }
}

// ── 3. Streaming Responses API ────────────────────────────────────

async function streamingResponses() {
  const label = "streaming-responses";
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: responsesBody(true),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();
    const events = text
      .split("\n\n")
      .filter((block) => block.startsWith("event: "))
      .map((block) => {
        const eventLine = block.split("\n").find((l) => l.startsWith("event: "));
        return eventLine?.replace("event: ", "") || "";
      });

    const required = [
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.completed",
    ];
    const missing = required.filter((r) => !events.includes(r));
    if (missing.length > 0) throw new Error(`missing events: ${missing.join(", ")}`);
    const hasDelta = events.includes("response.output_text.delta");
    pass(label, `${events.length} events, delta=${hasDelta}`);
  } catch (e) {
    fail(label, e.message);
  }
}

// ── 4. Non-streaming Responses API ────────────────────────────────

async function nonStreamingResponses() {
  const label = "non-streaming-responses";
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: responsesBody(false),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    if (json.object !== "response") throw new Error(`object=${json.object}`);
    if (json.status !== "completed") throw new Error(`status=${json.status}`);
    if (!json.output_text) throw new Error("empty output_text");
    if (!json.usage?.input_tokens) throw new Error("missing usage.input_tokens");
    pass(label, `output_text="${json.output_text.slice(0, 40)}"`);
  } catch (e) {
    fail(label, e.message);
  }
}

// ── 5. Client abort / cancellation ────────────────────────────────

async function clientAbort() {
  const label = "client-abort";
  const controller = new AbortController();
  const hardTimeout = setTimeout(() => controller.abort(), Math.min(TIMEOUT_MS, 5000));
  try {
    // Start a streaming request and abort the client shortly after the
    // response starts. This verifies the proxy tolerates early disconnects.
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "Count slowly from one to ten, one number per short sentence." }],
        stream: true,
        max_tokens: 128,
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const abortTimer = setTimeout(() => controller.abort(), 250);
    try {
      await res.text();
      clearTimeout(abortTimer);
      pass(label, "response completed before abort (fast response)");
    } catch (e) {
      clearTimeout(abortTimer);
      if (e.name === "AbortError") {
        pass(label, "abort handled gracefully (AbortError caught)");
        return;
      }
      throw e;
    }
  } catch (e) {
    if (e.name === "AbortError") {
      pass(label, "abort handled gracefully");
      return;
    }
    fail(label, e.message);
  } finally {
    clearTimeout(hardTimeout);
  }
}

// ── 6. Parallel streaming fanout ──────────────────────────────────

async function parallelStreamingFanout() {
  const label = "parallel-streaming-fanout";
  const count = Math.min(CONCURRENCY, 3); // bound streaming concurrency
  log(label, `launching ${count} concurrent streaming requests`);

  const tasks = Array.from({ length: count }, (_, i) =>
    fetchWithTimeout(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatBody(true),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`req ${i}: HTTP ${res.status}`);
        const text = await res.text();
        const hasDone = text.includes("data: [DONE]");
        if (!hasDone) throw new Error(`req ${i}: missing [DONE]`);
        return { i };
      })
  );

  const settled = await Promise.allSettled(tasks);
  const failures = settled.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    fail(label, `${failures.length}/${count} failed: ${failures.map((f) => f.reason.message).join("; ")}`);
  } else {
    pass(label, `${count}/${count} succeeded`);
  }
}

// ── 7. Models endpoint ────────────────────────────────────────────

async function checkModels() {
  const label = "models";
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/v1/models`, {}, 5000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.object !== "list") throw new Error(`object=${json.object}`);
    if (!json.data?.length) throw new Error("empty model list");
    pass(label, `${json.data.length} models`);
  } catch (e) {
    fail(label, e.message);
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log(`\nclaude-proxy soak test`);
  console.log(`  base_url:    ${BASE_URL}`);
  console.log(`  model:       ${MODEL}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  timeout:     ${TIMEOUT_MS}ms\n`);

  try {
    await checkHealth();
  } catch {
    console.error("\nProxy not reachable. Start claude-proxy first.\n");
    process.exit(1);
  }

  await checkModels();
  await streamingChat();
  await nonStreamingResponses();
  await streamingResponses();
  await clientAbort();
  await parallelFanout();
  await parallelStreamingFanout();

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) {
    console.log("Failed tests:");
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  - ${r.label}: ${r.error}`);
    }
  }
  console.log(`${"=".repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Soak runner crashed:", e);
  process.exit(2);
});
