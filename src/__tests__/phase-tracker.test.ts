/**
 * Tests for the PhaseTracker — truthful progress from Claude runtime events.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { attachPhaseTracker, agentNameFor, extractActivity, sanitizeActivity } from "../server/phase-tracker.js";

function makeStreamEvent(eventType: string, extra: Record<string, unknown> = {}) {
  return {
    type: "stream_event",
    event: { type: eventType, ...extra },
    session_id: "",
    uuid: "",
  };
}

// ── agentNameFor ────────────────────────────────────────────────────

test("agentNameFor returns a string from the built-in list", () => {
  const name = agentNameFor("tu_agent_1");
  assert.ok(typeof name === "string");
  assert.ok(name.length > 0);
});

test("agentNameFor is deterministic for the same id", () => {
  assert.strictEqual(agentNameFor("tu_agent_1"), agentNameFor("tu_agent_1"));
  assert.strictEqual(agentNameFor("xyz_123"), agentNameFor("xyz_123"));
});

test("agentNameFor produces different names for different ids", () => {
  // With 8 names in the pool, different ids should (usually) map to different names.
  // We test a few pairs — at least some should differ.
  const names = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map(agentNameFor));
  assert.ok(names.size > 1, "different ids should produce different names (at least some)");
});

// ── extractActivity ─────────────────────────────────────────────────

test("extractActivity from complete JSON with description field", () => {
  const json = JSON.stringify({ description: "Inspect auth flow", prompt: "Check the auth middleware" });
  const result = extractActivity(json);
  assert.ok(result);
  assert.match(result, /inspect auth flow/i);
});

test("extractActivity prioritizes description over prompt", () => {
  const json = JSON.stringify({ prompt: "Long prompt about everything", description: "Quick summary" });
  const result = extractActivity(json);
  assert.ok(result);
  assert.match(result, /quick summary/i);
});

test("extractActivity falls back to subagent_type when no description", () => {
  const json = JSON.stringify({ subagent_type: "Explore", prompt: "Find all routes" });
  const result = extractActivity(json);
  assert.ok(result);
  // subagent_type is second priority
  assert.match(result, /explore/i);
});

test("extractActivity from partial JSON via regex", () => {
  // Simulate partial JSON as it would arrive mid-stream.
  const partial = '{"description":"Search for error handlers","pro';
  const result = extractActivity(partial);
  assert.ok(result);
  assert.match(result, /search for error handlers/i);
});

test("extractActivity returns null for empty or useless input", () => {
  assert.strictEqual(extractActivity(""), null);
  assert.strictEqual(extractActivity("{}"), null);
  assert.strictEqual(extractActivity("{\"description\":\"\"}"), null);
});

// ── sanitizeActivity ────────────────────────────────────────────────

test("sanitizeActivity collapses whitespace and truncates", () => {
  const long = "A".repeat(100);
  const result = sanitizeActivity(long);
  assert.ok(result.length <= 60);
  assert.ok(result.endsWith("\u2026")); // ellipsis
});

test("sanitizeActivity lowercases first char", () => {
  const result = sanitizeActivity("Inspect the files");
  assert.strictEqual(result[0], "i");
});

test("sanitizeActivity strips secret-like tokens", () => {
  const result = sanitizeActivity("Use token sk-abc123456789xyz for auth");
  assert.ok(!result.includes("sk-abc123456789xyz"));
  assert.ok(result.includes("***"));
});

test("sanitizeActivity collapses newlines", () => {
  const result = sanitizeActivity("line one\nline two\nline three");
  assert.ok(!result.includes("\n"));
  assert.match(result, /line one line two line three/);
});

// ── PhaseTracker: basic tool_use ────────────────────────────────────

test("reports tool_use start with tool name", () => {
  const ee = new EventEmitter();
  const tracker = attachPhaseTracker(ee);

  ee.emit("message", makeStreamEvent("content_block_start", {
    content_block: { type: "tool_use", name: "Read", id: "tu_1" },
  }));

  const snap = tracker.poll();
  assert.ok(snap, "should return a phase snapshot");
  assert.match(snap.text, /Read/);
  assert.match(snap.text, /\[Working: using Read…\]/);

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

// ── PhaseTracker: Agent tool with funny names ───────────────────────

test("Agent tool displays with a funny subagent name", () => {
  const ee = new EventEmitter();
  const tracker = attachPhaseTracker(ee);

  ee.emit("message", makeStreamEvent("content_block_start", {
    content_block: { type: "tool_use", name: "Agent", id: "tu_agent_1" },
  }));

  const snap = tracker.poll();
  assert.ok(snap, "should return a phase snapshot");
  const expectedName = agentNameFor("tu_agent_1");
  assert.ok(snap.text.includes(expectedName), `should contain funny name "${expectedName}" but got "${snap.text}"`);
  assert.match(snap.text, /\[Working: using .+…\]/);
  // Should NOT show raw "Agent" or "Subagent" in the display text.
  assert.ok(!snap.text.includes("[Working: using Agent…]"), "should not show raw 'Agent'");
  // Dedup key must still use the raw tool name so tracking semantics are preserved.
  assert.ok(snap.key.includes("Agent"), "dedup key should contain raw tool name 'Agent'");
  assert.ok(!snap.key.includes("Subagent"), "dedup key must not use display name");

  tracker.detach();
});

test("Agent tool with activity from input_json_delta", () => {
  const ee = new EventEmitter();
  const tracker = attachPhaseTracker(ee);

  ee.emit("message", makeStreamEvent("content_block_start", {
    content_block: { type: "tool_use", name: "Agent", id: "tu_agent_act" },
  }));

  // First poll: no activity yet.
  const snap1 = tracker.poll();
  assert.ok(snap1);
  const expectedName = agentNameFor("tu_agent_act");
  assert.ok(snap1.text.includes(expectedName));

  // Stream in tool input with a description field.
  ee.emit("message", makeStreamEvent("content_block_delta", {
    delta: { type: "input_json_delta", partial_json: '{"description":"Inspect auth flow","prompt":"Check' },
  }));

  // Next poll: should re-emit with activity appended.
  const snap2 = tracker.poll();
  assert.ok(snap2, "should re-emit with activity");
  assert.ok(snap2.text.includes(expectedName));
  assert.ok(snap2.text.includes("\u2014"), "should contain em-dash separator");
  assert.match(snap2.text, /inspect auth flow/i);

  tracker.detach();
});

test("Agent tool wait displays funny name and activity", () => {
  const ee = new EventEmitter();
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const tracker = attachPhaseTracker(ee);

  try {
    ee.emit("message", makeStreamEvent("content_block_start", {
      content_block: { type: "tool_use", name: "Agent", id: "tu_agent_wait" },
    }));

    // Stream activity.
    ee.emit("message", makeStreamEvent("content_block_delta", {
      delta: { type: "input_json_delta", partial_json: '{"description":"Search codebase"}' },
    }));

    const usingSnap = tracker.poll();
    assert.ok(usingSnap);
    // Consume the activity update.
    const actSnap = tracker.poll();

    // Advance time past threshold.
    now += 12_000;
    const waitSnap = tracker.poll();
    assert.ok(waitSnap, "should report wait phase after threshold");
    const expectedName = agentNameFor("tu_agent_wait");
    assert.ok(waitSnap.text.includes(expectedName));
    assert.ok(waitSnap.text.includes("12s"), "should include elapsed seconds");
    assert.match(waitSnap.text, /\[Working: waiting for .+, 12s…\]/);
    assert.match(waitSnap.key, /Agent/, "dedup key should still use raw tool name");
  } finally {
    tracker.detach();
    Date.now = originalNow;
  }
});

test("Agent tool deterministic name: same id always gets same name", () => {
  const ee = new EventEmitter();
  const tracker1 = attachPhaseTracker(ee);

  ee.emit("message", makeStreamEvent("content_block_start", {
    content_block: { type: "tool_use", name: "Agent", id: "stable_id_123" },
  }));
  const snap1 = tracker1.poll();
  tracker1.detach();

  const ee2 = new EventEmitter();
  const tracker2 = attachPhaseTracker(ee2);
  ee2.emit("message", makeStreamEvent("content_block_start", {
    content_block: { type: "tool_use", name: "Agent", id: "stable_id_123" },
  }));
  const snap2 = tracker2.poll();
  tracker2.detach();

  assert.ok(snap1 && snap2);
  assert.strictEqual(snap1.text, snap2.text, "same id should produce identical display text");
});

test("Agent tool without activity shows just the funny name", () => {
  const ee = new EventEmitter();
  const tracker = attachPhaseTracker(ee);

  ee.emit("message", makeStreamEvent("content_block_start", {
    content_block: { type: "tool_use", name: "Agent", id: "tu_no_activity" },
  }));

  const snap = tracker.poll();
  assert.ok(snap);
  const expectedName = agentNameFor("tu_no_activity");
  assert.strictEqual(snap.text, `[Working: using ${expectedName}…]`);
  // No em-dash separator when there's no activity.
  assert.ok(!snap.text.includes("\u2014"));

  tracker.detach();
});

// ── PhaseTracker: non-Agent tools unchanged ─────────────────────────

test("non-Agent tool names are not renamed", () => {
  const ee = new EventEmitter();
  const tracker = attachPhaseTracker(ee);

  for (const name of ["Read", "Write", "Bash", "Task", "Grep"]) {
    ee.emit("message", makeStreamEvent("content_block_start", {
      content_block: { type: "tool_use", name, id: `tu_${name}` },
    }));
    const snap = tracker.poll();
    assert.ok(snap);
    assert.strictEqual(snap.text, `[Working: using ${name}…]`, `${name} should not be renamed`);
    // Reset state by emitting a text block.
    ee.emit("message", makeStreamEvent("content_block_start", {
      content_block: { type: "text", text: "" },
    }));
  }

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

// ── Activity extraction edge cases ──────────────────────────────────

test("Agent tool extracts activity on content_block_stop if not yet extracted", () => {
  const ee = new EventEmitter();
  const tracker = attachPhaseTracker(ee);

  ee.emit("message", makeStreamEvent("content_block_start", {
    content_block: { type: "tool_use", name: "Agent", id: "tu_late_extract" },
  }));

  // Short partial — not enough to trigger extraction (< 10 chars).
  ee.emit("message", makeStreamEvent("content_block_delta", {
    delta: { type: "input_json_delta", partial_json: '{"d' },
  }));
  // Another short chunk.
  ee.emit("message", makeStreamEvent("content_block_delta", {
    delta: { type: "input_json_delta", partial_json: 'escription":"Fix tests"}' },
  }));

  // content_block_stop triggers final extraction attempt.
  ee.emit("message", makeStreamEvent("content_block_stop", {}));

  const snap = tracker.poll();
  assert.ok(snap);
  // Consume the first snap; check if a second arrives with activity.
  const snap2 = tracker.poll();
  // One of the two should contain "fix tests".
  const text = snap2 ? snap2.text : snap.text;
  assert.ok(
    text.includes("fix tests") || text.includes("Fix tests"),
    `should extract "fix tests" but got "${text}"`,
  );

  tracker.detach();
});

// ── PhaseTracker: thinking phase (inferred silence) ─────────────────

test("reports thinking after 8s silence before any activity", () => {
  const ee = new EventEmitter();
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const tracker = attachPhaseTracker(ee);

  try {
    // No events at all — pure silence.
    const snap1 = tracker.poll();
    assert.strictEqual(snap1, null, "should not report thinking before threshold");

    // Advance past the 8s threshold.
    now += 9_000;
    const snap2 = tracker.poll();
    assert.ok(snap2, "should report thinking after 8s silence");
    assert.strictEqual(snap2.text, "[Working: thinking\u2026]");
    assert.ok(snap2.key.startsWith("thinking:"), "key should start with thinking:");
  } finally {
    tracker.detach();
    Date.now = originalNow;
  }
});

test("thinking deduplicates: does not emit twice for the same silent period", () => {
  const ee = new EventEmitter();
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const tracker = attachPhaseTracker(ee);

  try {
    now += 9_000;
    const snap1 = tracker.poll();
    assert.ok(snap1, "first thinking should emit");

    const snap2 = tracker.poll();
    assert.strictEqual(snap2, null, "same silent period should not re-emit thinking");

    // Even more time passes — still the same silent period.
    now += 10_000;
    const snap3 = tracker.poll();
    assert.strictEqual(snap3, null, "still same silent period, no re-emit");
  } finally {
    tracker.detach();
    Date.now = originalNow;
  }
});

test("thinking is suppressed once tool_use starts", () => {
  const ee = new EventEmitter();
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const tracker = attachPhaseTracker(ee);

  try {
    // Tool starts before thinking threshold.
    now += 3_000;
    ee.emit("message", makeStreamEvent("content_block_start", {
      content_block: { type: "tool_use", name: "Read", id: "tu_think_1" },
    }));

    // Advance well past threshold.
    now += 15_000;
    const snap = tracker.poll();
    // Should report tool_use, not thinking.
    assert.ok(snap);
    assert.match(snap.text, /\[Working: (?:using|waiting for) Read/);
    assert.ok(!snap.text.includes("thinking"), "should not report thinking when tool is active");
  } finally {
    tracker.detach();
    Date.now = originalNow;
  }
});

test("thinking is suppressed once text_delta arrives", () => {
  const ee = new EventEmitter();
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const tracker = attachPhaseTracker(ee);

  try {
    // Text delta arrives before thinking threshold.
    now += 3_000;
    ee.emit("message", makeStreamEvent("content_block_delta", {
      delta: { type: "text_delta", text: "Hello" },
    }));

    // Advance well past threshold from the original attach time, but only
    // 6s since the text_delta (which reset lastActivityAt).
    now += 5_000; // total 8s from attach, 5s from text_delta
    const snap = tracker.poll();
    assert.strictEqual(snap, null, "text delta should suppress thinking");
  } finally {
    tracker.detach();
    Date.now = originalNow;
  }
});

test("thinking is suppressed once text block starts", () => {
  const ee = new EventEmitter();
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const tracker = attachPhaseTracker(ee);

  try {
    now += 3_000;
    ee.emit("message", makeStreamEvent("content_block_start", {
      content_block: { type: "text", text: "" },
    }));

    now += 10_000;
    const snap = tracker.poll();
    assert.strictEqual(snap, null, "text block start should suppress thinking");
  } finally {
    tracker.detach();
    Date.now = originalNow;
  }
});

test("thinking does not override active tool phase", () => {
  const ee = new EventEmitter();
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const tracker = attachPhaseTracker(ee);

  try {
    // Start a tool.
    ee.emit("message", makeStreamEvent("content_block_start", {
      content_block: { type: "tool_use", name: "Bash", id: "tu_think_3" },
    }));
    const toolSnap = tracker.poll();
    assert.ok(toolSnap);
    assert.match(toolSnap.text, /Bash/);

    // Advance past threshold. Tool is still active.
    now += 12_000;
    const snap = tracker.poll();
    // Should be the wait phase, not thinking.
    assert.ok(snap);
    assert.match(snap.text, /waiting for Bash/);
    assert.ok(!snap.text.includes("thinking"));
  } finally {
    tracker.detach();
    Date.now = originalNow;
  }
});

test("Agent tool sanitizes secrets from activity", () => {
  const ee = new EventEmitter();
  const tracker = attachPhaseTracker(ee);

  ee.emit("message", makeStreamEvent("content_block_start", {
    content_block: { type: "tool_use", name: "Agent", id: "tu_secret_check" },
  }));

  ee.emit("message", makeStreamEvent("content_block_delta", {
    delta: { type: "input_json_delta", partial_json: '{"description":"Use token sk-abc123456789xyz for auth"}' },
  }));

  const snap = tracker.poll();
  assert.ok(snap);
  // Get the updated snap with activity.
  const snap2 = tracker.poll();
  const text = snap2 ? snap2.text : snap.text;
  assert.ok(!text.includes("sk-abc123456789xyz"), "should not leak secrets");
  assert.ok(text.includes("***"), "should mask secrets");

  tracker.detach();
});
