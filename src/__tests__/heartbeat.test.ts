/**
 * Tests for stream-json keepalive/progress generation.
 *
 * Generic idle protection must be transport-only SSE comments, not assistant
 * delta.content. Visible chunks are reserved for real, renderable progress.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import {
  createProgressChunk,
  createSseKeepaliveComment,
  hasRenderableAssistantContent,
} from "../server/routes.js";
import { attachPhaseTracker, STATUS_PREFIXES } from "../server/phase-tracker.js";

function assertProgressBody(text: string, expectedBody: string): void {
  const match = text.match(/^\[([^:]+): (.*)\]$/);
  assert.ok(match, `progress text should be bracketed with a prefix: ${text}`);
  assert.ok(STATUS_PREFIXES.includes(match[1]), `prefix should be in allowed list: ${match[1]}`);
  assert.strictEqual(match[2], expectedBody);
}

test("generic keepalive is an SSE comment, not a data chunk", () => {
  const frame = createSseKeepaliveComment("req123", 7);
  assert.strictEqual(frame, ":keepalive req_id=req123 count=7\n\n");
  assert.ok(!frame.startsWith("data:"), "generic keepalive must not be parsed as OpenAI content");
  assert.ok(!frame.includes("delta"), "generic keepalive must not include assistant delta content");
});

test("renderable-content helper rejects empty, whitespace, and ZWSP-only text", () => {
  assert.equal(hasRenderableAssistantContent(""), false);
  assert.equal(hasRenderableAssistantContent("   \n\t"), false);
  assert.equal(hasRenderableAssistantContent("\u200B"), false);
  assert.equal(hasRenderableAssistantContent("\u200B \u200C \uFEFF"), false);
  assert.equal(hasRenderableAssistantContent("progress: running"), true);
});

test("createProgressChunk preserves visible progress content", () => {
  const chunk = createProgressChunk("req123", "claude-sonnet-4", false, "progress: running");
  const delta = chunk.choices[0].delta;
  assert.strictEqual(delta.role, undefined);
  assert.strictEqual(delta.content, "progress: running");
});

test("createProgressChunk can include the assistant role on the first visible chunk", () => {
  const chunk = createProgressChunk("req123", "claude-sonnet-4", true, "\n[n8n: workflow · 12s · exec 73]\n");
  const delta = chunk.choices[0].delta;
  assert.strictEqual(delta.role, "assistant");
  assert.strictEqual(delta.content, "\n[n8n: workflow · 12s · exec 73]\n");
});

test("createProgressChunk refuses non-renderable assistant content", () => {
  assert.throws(() => createProgressChunk("req123", "claude-sonnet-4", false, ""), /renderable assistant text/);
  assert.throws(() => createProgressChunk("req123", "claude-sonnet-4", false, "\u200B"), /renderable assistant text/);
  assert.throws(() => createProgressChunk("req123", "claude-sonnet-4", false, "   "), /renderable assistant text/);
});

test("progress chunk has correct OpenAI structure", () => {
  const chunk = createProgressChunk("abc123", "claude-opus-4", false, "still working");
  assert.strictEqual(chunk.id, "chatcmpl-abc123");
  assert.strictEqual(chunk.object, "chat.completion.chunk");
  assert.strictEqual(chunk.model, "claude-opus-4");
  assert.strictEqual(chunk.choices.length, 1);
  assert.strictEqual(chunk.choices[0].index, 0);
  assert.strictEqual(chunk.choices[0].finish_reason, null);
});

test("phase tracker progress produces valid progress chunks", () => {
  const ee = new EventEmitter();
  const tracker = attachPhaseTracker(ee);

  ee.emit("message", {
    type: "stream_event",
    event: {
      type: "content_block_start",
      content_block: { type: "tool_use", name: "Bash", id: "tu_1" },
    },
    session_id: "",
    uuid: "",
  });

  const phase = tracker.poll();
  assert.ok(phase, "phase tracker should report tool_use start");
  assert.ok(hasRenderableAssistantContent(phase.text), "phase text must be renderable");
  // Verify it can produce a valid progress chunk (no throw).
  const chunk = createProgressChunk("req_test", "claude-sonnet-4", true, "\n" + phase.text + "\n");
  assert.strictEqual(chunk.choices[0].delta.role, "assistant");
  assert.ok(chunk.choices[0].delta.content?.includes("Bash"));

  tracker.detach();
});

test("thinking phase produces valid progress chunks", () => {
  const ee = new EventEmitter();
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const tracker = attachPhaseTracker(ee);

  try {
    // Advance past 8s silence threshold.
    now += 9_000;
    const phase = tracker.poll();
    assert.ok(phase, "phase tracker should report thinking after silence");
    assert.ok(hasRenderableAssistantContent(phase.text), "thinking text must be renderable");
    assertProgressBody(phase.text, "thinking\u2026");
    // Verify it can produce a valid progress chunk (no throw).
    const chunk = createProgressChunk("req_think", "claude-sonnet-4", true, "\n" + phase.text + "\n");
    assert.strictEqual(chunk.choices[0].delta.role, "assistant");
    assert.ok(chunk.choices[0].delta.content?.includes("thinking"));
  } finally {
    tracker.detach();
    Date.now = originalNow;
  }
});
