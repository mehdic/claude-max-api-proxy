/**
 * Tests for the PhaseTracker — truthful progress from Claude runtime events.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { attachPhaseTracker } from "../server/phase-tracker.js";

function makeStreamEvent(eventType: string, extra: Record<string, unknown> = {}) {
  return {
    type: "stream_event",
    event: { type: eventType, ...extra },
    session_id: "",
    uuid: "",
  };
}

test("reports tool_use start with tool name", () => {
  const ee = new EventEmitter();
  const tracker = attachPhaseTracker(ee);

  ee.emit("message", makeStreamEvent("content_block_start", {
    content_block: { type: "tool_use", name: "Read", id: "tu_1" },
  }));

  const snap = tracker.poll();
  assert.ok(snap, "should return a phase snapshot");
  assert.match(snap.text, /Read/);
  assert.match(snap.text, /\[progress: using Read…\]/);

  tracker.detach();
});

test("deduplicates consecutive same-phase polls", () => {
  const ee = new EventEmitter();
  const tracker = attachPhaseTracker(ee);

  ee.emit("message", makeStreamEvent("content_block_start", {
    content_block: { type: "tool_use", name: "Bash", id: "tu_2" },
  }));

  const first = tracker.poll();
  assert.ok(first);
  const second = tracker.poll();
  assert.strictEqual(second, null, "same phase should not be re-reported");

  tracker.detach();
});

test("new tool_use produces a new phase", () => {
  const ee = new EventEmitter();
  const tracker = attachPhaseTracker(ee);

  ee.emit("message", makeStreamEvent("content_block_start", {
    content_block: { type: "tool_use", name: "Read", id: "tu_3" },
  }));
  const first = tracker.poll();
  assert.ok(first);

  // Text block resets tool state
  ee.emit("message", makeStreamEvent("content_block_start", {
    content_block: { type: "text", text: "" },
  }));

  ee.emit("message", makeStreamEvent("content_block_start", {
    content_block: { type: "tool_use", name: "Write", id: "tu_4" },
  }));
  const second = tracker.poll();
  assert.ok(second, "new tool should produce a new phase");
  assert.match(second.text, /Write/);

  tracker.detach();
});

test("text delta clears tool phase", () => {
  const ee = new EventEmitter();
  const tracker = attachPhaseTracker(ee);

  ee.emit("message", makeStreamEvent("content_block_start", {
    content_block: { type: "tool_use", name: "Bash", id: "tu_5" },
  }));
  tracker.poll(); // consume tool_use phase

  ee.emit("message", makeStreamEvent("content_block_delta", {
    delta: { type: "text_delta", text: "Hello" },
  }));

  const snap = tracker.poll();
  assert.strictEqual(snap, null, "text delta should clear tool phase");

  tracker.detach();
});

test("ignores non-stream_event messages", () => {
  const ee = new EventEmitter();
  const tracker = attachPhaseTracker(ee);

  ee.emit("message", { type: "system", subtype: "init" });
  ee.emit("message", { type: "result", subtype: "success" });
  ee.emit("message", null);
  ee.emit("message", "garbage");

  assert.strictEqual(tracker.poll(), null);

  tracker.detach();
});

test("poll returns null when no events received", () => {
  const ee = new EventEmitter();
  const tracker = attachPhaseTracker(ee);
  assert.strictEqual(tracker.poll(), null);
  tracker.detach();
});

test("detach stops listening", () => {
  const ee = new EventEmitter();
  const tracker = attachPhaseTracker(ee);
  tracker.detach();

  ee.emit("message", makeStreamEvent("content_block_start", {
    content_block: { type: "tool_use", name: "Read", id: "tu_6" },
  }));

  assert.strictEqual(tracker.poll(), null, "should not track after detach");
});
