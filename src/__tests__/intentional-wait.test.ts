import test from "node:test";
import assert from "node:assert/strict";
import {
  detectIntentionalWaitFromMessage,
  detectIntentionalWaitFromResult,
  formatIntentionalWaitStatus,
} from "../subprocess/intentional-wait.js";

function resultWith(text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "result" as const,
    subtype: "success" as const,
    is_error: false,
    duration_ms: 1000,
    duration_api_ms: 1000,
    num_turns: 1,
    result: text,
    session_id: "s1",
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    ...overrides,
  };
}

test("detects ScheduleWakeup tool_use stream event", () => {
  const state = detectIntentionalWaitFromMessage({
    type: "stream_event",
    event: {
      type: "content_block_start",
      content_block: { type: "tool_use", name: "ScheduleWakeup", id: "toolu_wait" },
    },
    session_id: "s1",
    uuid: "u1",
  }, 1234);

  assert.deepEqual(state, {
    kind: "schedule_wakeup",
    reason: "Claude scheduled a wakeup/background continuation",
    detectedBy: "tool_use",
    toolName: "ScheduleWakeup",
    startedAt: 1234,
  });
});

test("detects Monitor and TaskOutput wait tools as background waits", () => {
  for (const toolName of ["Monitor", "TaskOutput"]) {
    const state = detectIntentionalWaitFromMessage({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: toolName, id: "toolu_bg" },
      },
      session_id: "s1",
      uuid: "u1",
    }, 5678);
    assert.equal(state?.kind, "background_task");
    assert.equal(state?.toolName, toolName);
    assert.equal(state?.detectedBy, "tool_use");
    assert.equal(state?.startedAt, 5678);
  }
});

test("detects sleeping-loop result text as interim intentional wait", () => {
  const state = detectIntentionalWaitFromResult(resultWith("Sleeping the loop. Will resume when pytest finishes."), 9999);
  assert.equal(state?.kind, "schedule_wakeup");
  assert.equal(state?.detectedBy, "result_text");
  assert.equal(state?.startedAt, 9999);
});

test("does not classify ordinary final answers as intentional waits", () => {
  assert.equal(detectIntentionalWaitFromMessage({ type: "assistant", message: { model: "x", content: [] } }), null);
  assert.equal(detectIntentionalWaitFromResult(resultWith("Tests passed. The fix is live.")), null);
});

test("does not classify broad will-resume prose as intentional wait", () => {
  assert.equal(detectIntentionalWaitFromResult(resultWith("I will resume when the tests are green, but here is the fix.")), null);
  assert.equal(detectIntentionalWaitFromResult(resultWith("The process will resume when the service restarts.")), null);
});

test("does not classify error results as intentional waits", () => {
  assert.equal(detectIntentionalWaitFromResult(resultWith("Sleeping the loop. Will resume when pytest finishes.", {
    subtype: "error",
    is_error: true,
  })), null);
});

test("formats intentional wait status for progress logs", () => {
  const text = formatIntentionalWaitStatus({
    kind: "schedule_wakeup",
    reason: "Claude scheduled a wakeup/background continuation",
    detectedBy: "tool_use",
    toolName: "ScheduleWakeup",
    startedAt: 1000,
  }, 16_000);

  assert.equal(text, "waiting for Claude scheduled wakeup/background continuation · 15s");
});
