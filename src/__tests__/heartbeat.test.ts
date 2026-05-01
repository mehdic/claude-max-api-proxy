/**
 * Tests for heartbeat/keepalive chunk generation.
 *
 * Verifies:
 * - HEARTBEAT_CONTENT is a non-empty string (U+200B)
 * - createHeartbeatChunk always produces non-empty content in delta
 * - Both bridgeTools and non-bridge paths never emit empty delta:{} or delta:{content:""}
 */

import test from "node:test";
import assert from "node:assert/strict";
import { HEARTBEAT_CONTENT, createHeartbeatChunk } from "../server/routes.js";

test("HEARTBEAT_CONTENT is non-empty and is U+200B", () => {
  assert.ok(HEARTBEAT_CONTENT.length > 0, "HEARTBEAT_CONTENT must be non-empty");
  assert.strictEqual(HEARTBEAT_CONTENT, "\u200B", "HEARTBEAT_CONTENT must be U+200B (zero-width space)");
});

test("createHeartbeatChunk with default content produces non-empty delta.content", () => {
  const chunk = createHeartbeatChunk("req123", "claude-sonnet-4");
  const delta = chunk.choices[0].delta;
  assert.ok(delta.content, "delta.content must be truthy (non-empty)");
  assert.ok(delta.content!.length > 0, "delta.content must have length > 0");
});

test("createHeartbeatChunk with explicit empty string falls back to HEARTBEAT_CONTENT", () => {
  const chunk = createHeartbeatChunk("req123", "claude-sonnet-4", false, "");
  const delta = chunk.choices[0].delta;
  assert.strictEqual(delta.content, HEARTBEAT_CONTENT, "empty content must fall back to HEARTBEAT_CONTENT");
});

test("createHeartbeatChunk with custom content preserves it", () => {
  const chunk = createHeartbeatChunk("req123", "claude-sonnet-4", false, "progress: running");
  const delta = chunk.choices[0].delta;
  assert.strictEqual(delta.content, "progress: running");
});

test("createHeartbeatChunk with includeRole=true includes role: assistant", () => {
  const chunk = createHeartbeatChunk("req123", "claude-sonnet-4", true);
  const delta = chunk.choices[0].delta;
  assert.strictEqual(delta.role, "assistant");
  assert.ok(delta.content!.length > 0, "content must still be non-empty even with role");
});

test("createHeartbeatChunk with includeRole=false omits role", () => {
  const chunk = createHeartbeatChunk("req123", "claude-sonnet-4", false);
  const delta = chunk.choices[0].delta;
  assert.strictEqual(delta.role, undefined, "role should be undefined when includeRole=false");
});

test("createHeartbeatChunk never produces empty delta object", () => {
  // Simulate all combinations that could yield empty delta
  const cases: Array<{ includeRole: boolean; content: string; label: string }> = [
    { includeRole: false, content: "", label: "no role + empty content (bridgeTools-like)" },
    { includeRole: true, content: "", label: "role + empty content" },
    { includeRole: false, content: "\u200B", label: "no role + ZWSP (non-bridge)" },
    { includeRole: true, content: "\u200B", label: "role + ZWSP" },
  ];

  for (const { includeRole, content, label } of cases) {
    const chunk = createHeartbeatChunk("req123", "claude-sonnet-4", includeRole, content);
    const delta = chunk.choices[0].delta;
    // delta must have at least content (non-empty)
    assert.ok(
      delta.content && delta.content.length > 0,
      `Case "${label}": delta.content must be non-empty, got ${JSON.stringify(delta.content)}`,
    );
  }
});

test("heartbeat chunk has correct OpenAI structure", () => {
  const chunk = createHeartbeatChunk("abc123", "claude-opus-4");
  assert.strictEqual(chunk.id, "chatcmpl-abc123");
  assert.strictEqual(chunk.object, "chat.completion.chunk");
  assert.strictEqual(chunk.model, "claude-opus-4");
  assert.strictEqual(chunk.choices.length, 1);
  assert.strictEqual(chunk.choices[0].index, 0);
  assert.strictEqual(chunk.choices[0].finish_reason, null);
});
