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
  createInterimNarrationProgressText,
  createLivenessProgressText,
  createProgressChunk,
  createResponsesProgressFrame,
  createSseKeepaliveComment,
  hasRenderableAssistantContent,
  interimNarrationProgressEnabled,
  livenessProgressEnabled,
  shouldSuppressSoftDeadForIntentionalWait,
} from "../server/routes.js";
import { attachPhaseTracker } from "../server/phase-tracker.js";

function assertProgressBody(text: string, expectedBody: string): void {
  assert.strictEqual(text, `Bubbling...\n${expectedBody}`);
}

test("generic keepalive is an SSE comment, not a data chunk", () => {
  const frame = createSseKeepaliveComment("req123", 7);
  assert.strictEqual(frame, ":keepalive req_id=req123 count=7\n\n");
  assert.ok(!frame.startsWith("data:"), "generic keepalive must not be parsed as OpenAI content");
  assert.ok(!frame.includes("delta"), "generic keepalive must not include assistant delta content");
});

test("liveness progress is disabled by default and opt-in by env", () => {
  assert.equal(livenessProgressEnabled({}), false);
  assert.equal(livenessProgressEnabled({ CLAUDE_PROXY_LIVENESS_PROGRESS: "0" }), false);
  assert.equal(livenessProgressEnabled({ CLAUDE_PROXY_LIVENESS_PROGRESS: "1" }), true);
});

test("interim narration progress is disabled by default and opt-in by env", () => {
  assert.equal(interimNarrationProgressEnabled({}), false);
  assert.equal(interimNarrationProgressEnabled({ CLAUDE_PROXY_INTERIM_NARRATION_PROGRESS: "0" }), false);
  assert.equal(interimNarrationProgressEnabled({ CLAUDE_PROXY_INTERIM_NARRATION_PROGRESS: "1" }), true);
});

test("interim narration progress wraps text as progress, not plain assistant text", () => {
  const text = createInterimNarrationProgressText("Found the root cause. Now applying the fix.");
  assertProgressBody(text.trim(), "🧠 Thinking: Found the root cause. Now applying the fix.");
  const chunk = createProgressChunk("req_narration", "claude-sonnet-4", false, text);
  assert.strictEqual(chunk.choices[0].delta.content, text);
});

test("interim narration progress ignores incomplete sentence fragments", () => {
  const fragment = "I found the root cause and I am now tracing the progress emission path through the route handler before applying";
  assert.strictEqual(createInterimNarrationProgressText(fragment), "");
});

test("liveness progress is a recognizable hidden provider progress sentinel", () => {
  const text = createLivenessProgressText();
  assertProgressBody(text.trim(), "🫧 Working maybe: thinking…");
  assert.ok(hasRenderableAssistantContent(text), "liveness progress must be renderable");
  const chunk = createProgressChunk("req_live", "claude-sonnet-4", false, text);
  assert.strictEqual(chunk.choices[0].delta.content, text);
});

test("intentional wait only suppresses soft-dead after strict result-text detection", () => {
  assert.equal(shouldSuppressSoftDeadForIntentionalWait(null), false);
  assert.equal(shouldSuppressSoftDeadForIntentionalWait({
    kind: "schedule_wakeup",
    reason: "Claude scheduled a wakeup/background continuation",
    detectedBy: "tool_use",
    toolName: "ScheduleWakeup",
    startedAt: 1000,
  }), false);
  assert.equal(shouldSuppressSoftDeadForIntentionalWait({
    kind: "schedule_wakeup",
    reason: "Claude scheduled a wakeup/background continuation",
    detectedBy: "result_text",
    toolName: "ScheduleWakeup",
    startedAt: 1000,
  }), true);
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

test("createResponsesProgressFrame emits provider-parseable Responses lifecycle progress without text delta corruption", () => {
  const frame = createResponsesProgressFrame("resp_test", "claude-sonnet-4", "progress: still running");
  assert.ok(frame.startsWith("event: response.in_progress\n"));
  const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(dataLine, "frame must contain an SSE data line");
  const payload = JSON.parse(dataLine.slice("data: ".length));
  assert.strictEqual(payload.type, "response.in_progress");
  assert.strictEqual(payload.response.id, "resp_test");
  assert.strictEqual(payload.response.status, "in_progress");
  assert.strictEqual(payload.response.metadata.proxy_progress, "progress: still running");
  assert.equal(frame.includes("response.output_text.delta"), false);
});

test("createResponsesProgressFrame refuses non-renderable progress", () => {
  assert.throws(() => createResponsesProgressFrame("resp_test", "claude-sonnet-4", ""), /renderable progress text/);
  assert.throws(() => createResponsesProgressFrame("resp_test", "claude-sonnet-4", "\u200B"), /renderable progress text/);
  assert.throws(() => createResponsesProgressFrame("resp_test", "claude-sonnet-4", "   "), /renderable progress text/);
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
  assert.ok(chunk.choices[0].delta.content?.includes("Exec"));

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
    assertProgressBody(phase.text, "🫧 Working: thinking\u2026");
    // Verify it can produce a valid progress chunk (no throw).
    const chunk = createProgressChunk("req_think", "claude-sonnet-4", true, "\n" + phase.text + "\n");
    assert.strictEqual(chunk.choices[0].delta.role, "assistant");
    assert.ok(chunk.choices[0].delta.content?.includes("thinking"));
  } finally {
    tracker.detach();
    Date.now = originalNow;
  }
});
