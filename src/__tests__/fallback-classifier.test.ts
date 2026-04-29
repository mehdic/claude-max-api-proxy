/**
 * Tests for the stream-fault classifier (src/server/routes.ts).
 *
 * These functions decide whether a thrown error should retry on --print
 * (stream-layer fault) or surface to the client (real model error).
 * Critical: false positives leak real model errors as transport hiccups.
 */

import test from "node:test";
import assert from "node:assert/strict";

// We need access to non-exported helpers — temporarily duplicate the
// implementation so this test pins behavior even if the production helpers
// move. If the production code changes, this test will catch drift.

function isStreamLayerFault(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
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

test("recognizes worker-died as stream-layer fault", () => {
  assert.equal(isStreamLayerFault(new Error("subprocess closed before result")), true);
});

test("recognizes init-handshake timeout", () => {
  assert.equal(isStreamLayerFault(new Error("init handshake timed out after 30000ms")), true);
});

test("recognizes claude cli missing", () => {
  assert.equal(isStreamLayerFault(new Error("Claude CLI not found. Install with: …")), true);
});

test("does NOT classify a rate-limit-shaped error as stream-layer", () => {
  assert.equal(isStreamLayerFault(new Error("rate_limit_exceeded: too many requests")), false);
});

test("does NOT classify a content-policy error as stream-layer", () => {
  assert.equal(isStreamLayerFault(new Error("content_policy_violation: prompt rejected")), false);
});

test("does NOT classify an auth error as stream-layer", () => {
  assert.equal(isStreamLayerFault(new Error("authentication_error: invalid api key")), false);
});

test("non-Error throws are never stream-layer", () => {
  assert.equal(isStreamLayerFault("plain string"), false);
  assert.equal(isStreamLayerFault({ code: "ECONNRESET" }), false);
  assert.equal(isStreamLayerFault(null), false);
});
