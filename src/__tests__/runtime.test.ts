/**
 * Tests for the runtime resolver (src/subprocess/runtime.ts).
 *
 * The resolver reads env vars at module load, so each test invokes a
 * sub-test via dynamic import after mutating process.env, then resets.
 * `node --test` doesn't trivially reset module caches between tests, so
 * we use child workers via `node:worker_threads` for isolation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolves to dist/__tests__/.. → dist/subprocess/runtime.js after build
const RUNTIME_MODULE = path.resolve(__dirname, "..", "subprocess", "runtime.js");

interface ResolveResult {
  defaultMode: string;
  withHeaderPrint: string;
  withHeaderStreamJson: string;
  overrideAllowed: boolean;
}

async function probe(env: Record<string, string | undefined>): Promise<ResolveResult> {
  // Worker scripts must be JS, so use a small inline data: URL.
  const code = `
    const path = require("node:path");
    process.env = ${JSON.stringify({ ...env })};
    (async () => {
      const m = await import(${JSON.stringify(RUNTIME_MODULE)});
      const fakeReqHdrPrint = { header: (name) => name === "x-claude-proxy-runtime" ? "print" : undefined };
      const fakeReqHdrStream = { header: (name) => name === "x-claude-proxy-runtime" ? "stream-json" : undefined };
      const out = {
        defaultMode: m.defaultRuntime(),
        withHeaderPrint: m.resolveRuntime(fakeReqHdrPrint),
        withHeaderStreamJson: m.resolveRuntime(fakeReqHdrStream),
        overrideAllowed: m.runtimeOverrideAllowed(),
      };
      const { parentPort } = require("node:worker_threads");
      parentPort.postMessage(out);
    })().catch((err) => {
      const { parentPort } = require("node:worker_threads");
      parentPort.postMessage({ error: String(err) });
    });
  `;
  return new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true });
    w.on("message", (msg) => {
      w.terminate();
      if (msg && msg.error) reject(new Error(msg.error));
      else resolve(msg);
    });
    w.on("error", reject);
  });
}

test("default runtime is stream-json when no env vars are set", async () => {
  const r = await probe({ PATH: process.env.PATH });
  assert.equal(r.defaultMode, "stream-json");
  assert.equal(r.overrideAllowed, false);
});

test("CLAUDE_PROXY_RUNTIME=print forces print mode", async () => {
  const r = await probe({ PATH: process.env.PATH, CLAUDE_PROXY_RUNTIME: "print" });
  assert.equal(r.defaultMode, "print");
});

test("Legacy CLAUDE_PROXY_STREAM_JSON=0 forces print mode", async () => {
  const r = await probe({ PATH: process.env.PATH, CLAUDE_PROXY_STREAM_JSON: "0" });
  assert.equal(r.defaultMode, "print");
});

test("New env var beats legacy: RUNTIME=stream-json wins over STREAM_JSON=0", async () => {
  const r = await probe({
    PATH: process.env.PATH,
    CLAUDE_PROXY_RUNTIME: "stream-json",
    CLAUDE_PROXY_STREAM_JSON: "0",
  });
  assert.equal(r.defaultMode, "stream-json");
});

test("Header override ignored when CLAUDE_PROXY_ALLOW_RUNTIME_OVERRIDE is unset", async () => {
  // default is stream-json, header asks for print — should still be stream-json
  const r = await probe({ PATH: process.env.PATH });
  assert.equal(r.withHeaderPrint, "stream-json");
});

test("Header override honored when CLAUDE_PROXY_ALLOW_RUNTIME_OVERRIDE=1", async () => {
  const r = await probe({
    PATH: process.env.PATH,
    CLAUDE_PROXY_ALLOW_RUNTIME_OVERRIDE: "1",
  });
  assert.equal(r.overrideAllowed, true);
  assert.equal(r.withHeaderPrint, "print");
  assert.equal(r.withHeaderStreamJson, "stream-json");
});

test("Invalid CLAUDE_PROXY_RUNTIME value falls back to stream-json default", async () => {
  const r = await probe({ PATH: process.env.PATH, CLAUDE_PROXY_RUNTIME: "garbage" });
  assert.equal(r.defaultMode, "stream-json");
});
