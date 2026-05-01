/**
 * Tests for upstream soft-dead watchdog logic.
 *
 * Verifies:
 * - 5-minute threshold triggers soft-dead correctly
 * - Client heartbeat activity does NOT reset upstream liveness
 * - Hard-dead subprocess snapshots trigger immediate failure
 * - Active Claude signals prevent false soft-dead
 * - Diagnostic snapshot includes expected fields
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  UPSTREAM_SOFT_DEAD_MS,
  DESCENDANT_GRACE_CAP_MS,
  DESCENDANT_CPU_FLOOR,
  shouldTriggerSoftDead,
  buildSoftDeadDiagnostic,
  sampleDescendants,
  type SubprocessSnapshot,
  type DescendantInfo,
} from "../server/watchdog.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function aliveSnapshot(overrides: Partial<SubprocessSnapshot> = {}): SubprocessSnapshot {
  return {
    pid: 12345,
    exitCode: null,
    killed: false,
    stdinDestroyed: false,
    stdoutReadable: true,
    stderrReadable: true,
    initialized: true,
    turnInFlight: true,
    ageMs: 60_000,
    ...overrides,
  };
}

function deadSnapshot(overrides: Partial<SubprocessSnapshot> = {}): SubprocessSnapshot {
  return {
    pid: 12345,
    exitCode: 1,
    killed: true,
    stdinDestroyed: true,
    stdoutReadable: false,
    stderrReadable: false,
    initialized: true,
    turnInFlight: true,
    ageMs: 120_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Threshold constant
// ---------------------------------------------------------------------------

test("UPSTREAM_SOFT_DEAD_MS is exactly 5 minutes", () => {
  assert.strictEqual(UPSTREAM_SOFT_DEAD_MS, 5 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// shouldTriggerSoftDead — timing
// ---------------------------------------------------------------------------

test("does NOT trigger when last Claude activity is recent", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 30_000; // 30s ago
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, aliveSnapshot(), now),
    false,
    "30s of silence should not trigger soft-dead",
  );
});

test("does NOT trigger at exactly 5 minutes minus 1ms", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - UPSTREAM_SOFT_DEAD_MS + 1;
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, aliveSnapshot(), now),
    false,
    "4m59.999s should not trigger",
  );
});

test("triggers at exactly 5 minutes", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - UPSTREAM_SOFT_DEAD_MS;
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, aliveSnapshot(), now),
    true,
    "exactly 5 minutes should trigger soft-dead",
  );
});

test("triggers when Claude has been silent for 10 minutes", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 10 * 60 * 1000;
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, aliveSnapshot(), now),
    true,
    "10 minutes silence should trigger",
  );
});

// ---------------------------------------------------------------------------
// shouldTriggerSoftDead — client heartbeats must NOT prevent trigger
// ---------------------------------------------------------------------------

test("client heartbeat activity does NOT reset upstream liveness", () => {
  // Simulate: Claude silent for 6 minutes, but client heartbeats kept firing.
  // The watchdog only looks at lastClaudeActivityAt, not client activity.
  const now = Date.now();
  const lastClaudeActivityAt = now - 6 * 60 * 1000; // 6 min ago
  // snapshot is alive — subprocess is still running, just no Claude output
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, aliveSnapshot(), now),
    true,
    "client heartbeats must not prevent soft-dead trigger",
  );
});

// ---------------------------------------------------------------------------
// shouldTriggerSoftDead — hard-dead subprocess
// ---------------------------------------------------------------------------

test("hard-dead snapshot (exitCode != null) triggers immediately regardless of timing", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 1000; // only 1s ago
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, deadSnapshot({ exitCode: 1 }), now),
    true,
    "dead process should trigger immediately even with recent activity",
  );
});

test("killed subprocess triggers immediately", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 1000;
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, aliveSnapshot({ killed: true }), now),
    true,
    "killed process should trigger immediately",
  );
});

test("stdin destroyed triggers immediately", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 1000;
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, aliveSnapshot({ stdinDestroyed: true }), now),
    true,
    "stdin destroyed should trigger immediately",
  );
});

test("stdinWritableEnded triggers immediately", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 1000;
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, aliveSnapshot({ stdinWritableEnded: true }), now),
    true,
    "stdin writable ended should trigger immediately",
  );
});

test("stdout not readable triggers immediately", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 1000;
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, aliveSnapshot({ stdoutReadable: false }), now),
    true,
    "stdout not readable should trigger immediately",
  );
});

test("stdout destroyed triggers immediately", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 1000;
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, aliveSnapshot({ stdoutDestroyed: true }), now),
    true,
    "stdout destroyed should trigger immediately",
  );
});

// ---------------------------------------------------------------------------
// shouldTriggerSoftDead — active Claude signals prevent false trigger
// ---------------------------------------------------------------------------

test("active Claude signal 1 second ago prevents trigger even with old start", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 1000; // 1s ago
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, aliveSnapshot({ ageMs: 30 * 60 * 1000 }), now),
    false,
    "recent Claude activity on a 30-minute-old process should not trigger",
  );
});

test("does NOT trigger when subprocess is alive and Claude spoke 4 minutes ago", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 4 * 60 * 1000;
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, aliveSnapshot(), now),
    false,
  );
});

test("does NOT trigger when subprocess has recent raw activity despite no parsed messages", () => {
  // Simulate: no parsed Claude messages for 6 minutes, but subprocess stdout
  // still producing data 30s ago (e.g. verbose tool output not yet parsed).
  const now = Date.now();
  const lastClaudeActivityAt = now - 6 * 60 * 1000; // 6 min ago (parsed messages)
  // snapshot shows recent process-level activity
  const snap = aliveSnapshot({ lastProcessActivityAgeMs: 30_000, processActivityCount: 150 });
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, snap, now),
    false,
    "recent subprocess raw activity should prevent soft-dead false positive",
  );
});

test("triggers when both parsed messages AND raw activity are stale", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 6 * 60 * 1000;
  // subprocess activity also stale
  const snap = aliveSnapshot({ lastProcessActivityAgeMs: 6 * 60 * 1000, processActivityCount: 50 });
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, snap, now),
    true,
    "stale subprocess activity should allow soft-dead trigger",
  );
});

test("triggers when lastProcessActivityAgeMs is null (no activity tracking)", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 6 * 60 * 1000;
  const snap = aliveSnapshot({ lastProcessActivityAgeMs: null });
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, snap, now),
    true,
    "null process activity should not prevent trigger",
  );
});

// ---------------------------------------------------------------------------
// shouldTriggerSoftDead — raw activity hard cap (DESCENDANT_GRACE_CAP_MS)
// A noisy/wedged CLI emitting raw stdout/stderr but no stream-json events
// must not suppress soft-dead indefinitely.
// ---------------------------------------------------------------------------

test("raw activity suppresses soft-dead at 6min silence (below cap)", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 6 * 60 * 1000; // 6 min parsed silence
  const snap = aliveSnapshot({ lastProcessActivityAgeMs: 10_000 }); // recent raw
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, snap, now),
    false,
    "6min silence + recent raw activity: should NOT trigger (below cap)",
  );
});

test("raw activity does NOT suppress soft-dead at exactly 10min silence (at cap)", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - DESCENDANT_GRACE_CAP_MS; // exactly 10 min
  const snap = aliveSnapshot({ lastProcessActivityAgeMs: 5_000 }); // very recent raw
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, snap, now),
    true,
    "10min silence + recent raw activity: MUST trigger (at cap)",
  );
});

test("raw activity does NOT suppress soft-dead after 10min silence (above cap)", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - (DESCENDANT_GRACE_CAP_MS + 60_000); // 11 min
  const snap = aliveSnapshot({ lastProcessActivityAgeMs: 1_000 }); // very recent raw
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, snap, now),
    true,
    "11min silence + recent raw activity: MUST trigger (above cap)",
  );
});

test("parsed Claude event recent still prevents trigger regardless of raw activity", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 60_000; // only 1 min ago
  const snap = aliveSnapshot({ lastProcessActivityAgeMs: 500_000 }); // stale raw
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, snap, now),
    false,
    "recent parsed Claude event must always prevent trigger",
  );
});

// ---------------------------------------------------------------------------
// buildSoftDeadDiagnostic
// ---------------------------------------------------------------------------

test("diagnostic includes all expected fields", () => {
  const now = Date.now();
  const snap = aliveSnapshot();
  const diag = buildSoftDeadDiagnostic("req_abc", now - 6 * 60 * 1000, snap, now);

  assert.strictEqual(diag.requestId, "req_abc");
  assert.strictEqual(diag.reason, "upstream_soft_dead");
  assert.ok(diag.silenceMs >= 6 * 60 * 1000);
  assert.deepStrictEqual(diag.subprocess, snap);
  assert.ok(typeof diag.timestamp === "string"); // ISO string
});

test("diagnostic reason is 'upstream_hard_dead' when process exited", () => {
  const now = Date.now();
  const snap = deadSnapshot();
  const diag = buildSoftDeadDiagnostic("req_xyz", now - 1000, snap, now);

  assert.strictEqual(diag.reason, "upstream_hard_dead");
});

test("diagnostic includes optional context when provided", () => {
  const now = Date.now();
  const snap = aliveSnapshot();
  const ctx = {
    model: "claude-sonnet-4",
    runtime: "stream-json" as const,
    stream: true,
    bridgeTools: false,
    lastClientActivityAgeMs: 5000,
    lastClaudeActivityAgeMs: 360000,
    childPid: 12345,
    processActivityCount: 42,
    watchdogAction: "kill" as const,
  };
  const diag = buildSoftDeadDiagnostic("req_ctx", now - 6 * 60 * 1000, snap, now, ctx);

  assert.strictEqual(diag.context?.model, "claude-sonnet-4");
  assert.strictEqual(diag.context?.stream, true);
  assert.strictEqual(diag.context?.childPid, 12345);
  assert.strictEqual(diag.context?.watchdogAction, "kill");
});

test("diagnostic omits context field when not provided", () => {
  const now = Date.now();
  const snap = aliveSnapshot();
  const diag = buildSoftDeadDiagnostic("req_no_ctx", now - 6 * 60 * 1000, snap, now);

  assert.strictEqual(diag.context, undefined);
});

// ---------------------------------------------------------------------------
// Descendant grace cap constant
// ---------------------------------------------------------------------------

test("DESCENDANT_GRACE_CAP_MS is exactly 10 minutes", () => {
  assert.strictEqual(DESCENDANT_GRACE_CAP_MS, 10 * 60 * 1000);
});

test("DESCENDANT_CPU_FLOOR is 0.5", () => {
  assert.strictEqual(DESCENDANT_CPU_FLOOR, 0.5);
});

// ---------------------------------------------------------------------------
// shouldTriggerSoftDead — descendant process suppression
// ---------------------------------------------------------------------------

function activeDescendants(overrides: Partial<DescendantInfo> = {}): DescendantInfo {
  return {
    count: 3,
    running: 2,
    totalCpuPct: 15.5,
    totalRssKb: 50000,
    pids: [10001, 10002, 10003],
    sampledAt: Date.now(),
    ...overrides,
  };
}

test("active descendants suppress soft-dead within grace cap", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 6 * 60 * 1000; // 6 min silence
  const snap = aliveSnapshot({ lastProcessActivityAgeMs: 6 * 60 * 1000 });
  const desc = activeDescendants(); // running=2, cpu=15.5%
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, snap, now, desc),
    false,
    "active descendants (running + CPU) should suppress soft-dead within grace cap",
  );
});

test("descendants with zero CPU do NOT suppress soft-dead", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 6 * 60 * 1000;
  const snap = aliveSnapshot({ lastProcessActivityAgeMs: 6 * 60 * 1000 });
  const desc = activeDescendants({ totalCpuPct: 0.0 });
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, snap, now, desc),
    true,
    "idle descendants (0% CPU) must not suppress soft-dead",
  );
});

test("descendants with very low CPU (< 0.5%) do NOT suppress soft-dead", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 6 * 60 * 1000;
  const snap = aliveSnapshot({ lastProcessActivityAgeMs: 6 * 60 * 1000 });
  const desc = activeDescendants({ totalCpuPct: 0.3 });
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, snap, now, desc),
    true,
    "descendants below CPU floor should not suppress",
  );
});

test("zombie descendants (running=0) do NOT suppress soft-dead", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 6 * 60 * 1000;
  const snap = aliveSnapshot({ lastProcessActivityAgeMs: 6 * 60 * 1000 });
  const desc = activeDescendants({ running: 0, totalCpuPct: 0.0 });
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, snap, now, desc),
    true,
    "zombie-only descendants must not suppress soft-dead",
  );
});

test("descendants do NOT suppress past the grace cap", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - DESCENDANT_GRACE_CAP_MS; // exactly at cap
  const snap = aliveSnapshot({ lastProcessActivityAgeMs: DESCENDANT_GRACE_CAP_MS });
  const desc = activeDescendants(); // active, running, high CPU
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, snap, now, desc),
    true,
    "active descendants must not suppress beyond grace cap",
  );
});

test("descendants suppress at grace_cap - 1ms", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - DESCENDANT_GRACE_CAP_MS + 1;
  const snap = aliveSnapshot({ lastProcessActivityAgeMs: DESCENDANT_GRACE_CAP_MS });
  const desc = activeDescendants();
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, snap, now, desc),
    false,
    "active descendants should suppress just under grace cap",
  );
});

test("null descendants do not suppress (treated as unavailable)", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 6 * 60 * 1000;
  const snap = aliveSnapshot({ lastProcessActivityAgeMs: 6 * 60 * 1000 });
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, snap, now, null),
    true,
    "null descendants must not suppress",
  );
});

test("undefined descendants do not suppress (backward compat)", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 6 * 60 * 1000;
  const snap = aliveSnapshot({ lastProcessActivityAgeMs: 6 * 60 * 1000 });
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, snap, now, undefined),
    true,
    "undefined descendants must not suppress (backward compat)",
  );
});

test("descendants do NOT override hard-dead", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 1000;
  const desc = activeDescendants(); // very active
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, deadSnapshot(), now, desc),
    true,
    "hard-dead must trigger regardless of descendants",
  );
});

test("empty descendants (count=0) do not suppress", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 6 * 60 * 1000;
  const snap = aliveSnapshot({ lastProcessActivityAgeMs: 6 * 60 * 1000 });
  const desc: DescendantInfo = { count: 0, running: 0, totalCpuPct: 0, totalRssKb: 0, pids: [], sampledAt: now };
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, snap, now, desc),
    true,
    "no descendants means nothing to suppress with",
  );
});

// ---------------------------------------------------------------------------
// sampleDescendants — basic behavior
// ---------------------------------------------------------------------------

test("sampleDescendants returns null for nonexistent PID", () => {
  // PID 999999999 almost certainly doesn't exist.
  const result = sampleDescendants(999999999);
  // Either null (pgrep failed) or { count: 0, ... } (no children).
  if (result !== null) {
    assert.strictEqual(result.count, 0);
    assert.strictEqual(result.running, 0);
  }
});

test("sampleDescendants returns a valid shape for current process", () => {
  // process.pid is alive and may or may not have children.
  const result = sampleDescendants(process.pid);
  // Should not throw, should return DescendantInfo or null.
  if (result !== null) {
    assert.ok(typeof result.count === "number");
    assert.ok(typeof result.running === "number");
    assert.ok(typeof result.totalCpuPct === "number");
    assert.ok(typeof result.totalRssKb === "number");
    assert.ok(typeof result.sampledAt === "number");
    assert.ok(result.sampledAt > 0, "sampledAt should be a positive timestamp");
    assert.ok(result.sampledAt <= Date.now(), "sampledAt should not be in the future");
    assert.ok(Array.isArray(result.pids));
    assert.ok(result.pids.length <= 20, "pids should be capped at 20");
  }
});

// ---------------------------------------------------------------------------
// diagnostic includes descendantInfo in context
// ---------------------------------------------------------------------------

test("diagnostic context includes descendant fields when provided", () => {
  const now = Date.now();
  const snap = aliveSnapshot();
  const desc = activeDescendants();
  const diag = buildSoftDeadDiagnostic("req_desc", now - 6 * 60 * 1000, snap, now, {
    model: "claude-sonnet-4",
    descendantCount: desc.count,
    descendantCpuPct: desc.totalCpuPct,
  });
  assert.strictEqual(diag.context?.descendantCount, 3);
  assert.strictEqual(diag.context?.descendantCpuPct, 15.5);
});

// ---------------------------------------------------------------------------
// shouldTriggerSoftDead — stale descendant sample
// ---------------------------------------------------------------------------

test("stale descendant sample does not suppress soft-dead", () => {
  const now = Date.now();
  const lastClaudeActivityAt = now - 6 * 60 * 1000;
  const snap = aliveSnapshot({ lastProcessActivityAgeMs: 6 * 60 * 1000 });
  // Sample taken 2 minutes ago — exceeds DESCENDANT_SAMPLE_MAX_AGE_MS (60s)
  const desc = activeDescendants({ sampledAt: now - 120_000 });
  assert.strictEqual(
    shouldTriggerSoftDead(lastClaudeActivityAt, snap, now, desc),
    true,
    "stale descendant sample must not suppress soft-dead",
  );
});
