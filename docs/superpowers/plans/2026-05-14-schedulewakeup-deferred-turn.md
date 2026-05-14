# ScheduleWakeup Deferred Turn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Claude Proxy from closing OpenAI-compatible streams when Claude Code intentionally sleeps via `ScheduleWakeup` or background-task waiting, so Telegram/OpenClaw receives the true final answer after resume.

**Architecture:** Add a small intentional-wait detector for Claude stream-json wait-tool events and, more importantly, the known interim `result` text shape `Sleeping the loop. Will resume when ...`. `StreamJsonSubprocess.submitTurn()` must defer only clearly-classified non-error interim wait results; tool-use alone is progress metadata and must never suppress a final result. The chat-completions HTTP/SSE route already keeps streams warm; the subprocess must remain busy and unreleased until the later real final result or the absolute cap fires.

**Tech Stack:** TypeScript, Node `EventEmitter`, Claude Code `--output-format stream-json`, Express SSE, Node test runner.

---

## Research Summary

### Observed production failure

- Sevro turn `515ad035080d49228dc7ee76` completed with `finishReason=stop` after roughly 531s.
- The user-visible assistant message ended with Claude Code progress: `🧩 ScheduleWakeup` followed by `Sleeping the loop. Will resume when pytest finishes.`
- Claude Proxy treated that as a normal completed turn because `StreamJsonSubprocess.processBuffer()` emits every `type: "result"`, and `submitTurn()` resolves on the first `result`.
- Once `handleStreamJsonRequest()` receives that first result, it writes `[DONE]`, ends the SSE response, and releases the worker back to the pool.

### Current code behavior

- `src/subprocess/stream-json-manager.ts`
  - `processBuffer()` emits `message`, `content_delta`, `assistant`, and `result`.
  - `submitTurn()` resolves immediately on the first `result`.
  - Turn timeout already has `TURN_IDLE_TIMEOUT_MS = 900000` and `TURN_ABSOLUTE_MAX_MS = 60 * 60 * 1000`.
- `src/server/routes.ts`
  - `handleStreamJsonRequest()` already emits SSE keepalives and renderable progress every ~10s.
  - `handleStreamJsonRequest()` only finalizes after `await subprocess.submitTurn(userText)`.
  - Therefore the route can already hold the connection open if `submitTurn()` does not resolve early.
- `src/server/phase-tracker.ts`
  - Already sees Claude tool-use phases such as `ScheduleWakeup` because it renders tool names from `content_block_start` with `content_block.type === "tool_use"`.

### OCTO Debate Synthesis

- **Codex/pragmatic view:** model `ScheduleWakeup` as explicit intentional wait; do not globally raise timeouts; do not release the subprocess; keep existing absolute cap.
- **Gemini/innovative view:** long-term best architecture is “park + detach + reattach” for broken client sockets, but first step should preserve OpenAI compatibility by parking the current stream and keeping SSE open.
- **Reaper synthesis:** implement the tactical safe fix now: defer only clearly-classified interim ScheduleWakeup result text inside the live turn. Do not let `ScheduleWakeup` tool-use alone suppress a result. Do not attempt detached reattachment in this first patch because it changes proxy/session semantics and needs a separate design.

---

## OCTO Review Addendum Before Implementation

The second OCTO review required these corrections, which override earlier wording in this plan:

1. Tool-use events (`ScheduleWakeup`, `Monitor`, `TaskOutput`) are progress metadata only. They may set visible wait state, but must not by themselves cause `submitTurn()` to suppress a result.
2. Defer only strict, known, non-error interim result text: `Sleeping the loop. Will resume when ...`.
3. Never swallow `is_error` results. Resolve them normally so the route can return the error/final status instead of hanging.
4. While a strict intentional wait is active, suppress the route soft-dead watchdog and avoid the 15-minute idle timer terminating the turn before the 60-minute absolute cap.
5. Add negative tests for ordinary final prose containing “will resume when”, error results, and long explanatory final answers.
6. Add at least one real parser/process-buffer ordering test so `message` detection is proven to happen before the same stream’s `result` handling.
7. Scope: chat completions and `/v1/responses` both get full SSE keepalive/progress, intentional-wait, and soft-dead watchdog parity. Responses uses `response.output_text.delta` progress events instead of chat-completion chunks.

---

## File Structure

- Create: `src/subprocess/intentional-wait.ts`
  - Pure detector helpers for Claude stream-json wait-tool messages and strict interim result text.
  - Exports `IntentionalWaitState`, `detectIntentionalWaitFromMessage()`, `detectIntentionalWaitFromResult()`, `formatIntentionalWaitStatus()`.
- Modify: `src/subprocess/stream-json-manager.ts`
  - Track intentional wait state while a turn is in flight.
  - Emit `intentional_wait` when a wait tool or strict interim wait result is detected.
  - Ignore/defer only non-error `result` objects classified as intentional-wait interim results.
  - During intentional waits, do not let the 15-minute idle timer win before the absolute cap; reset/extend idle only when a wait result is detected and rely on the absolute cap for hard stop.
  - Keep cleanup behavior unchanged.
- Modify: `src/server/routes.ts`
  - Listen for `intentional_wait` to improve observability and optional progress wording.
  - Include intentional-wait state in watchdog diagnostics and suppress soft-dead while an intentional wait is active, bounded by the existing absolute cap.
- Modify: `src/server/phase-tracker.ts`
  - Add friendly display name for `ScheduleWakeup` and optionally `Monitor`/`TaskOutput` if needed.
- Create: `src/__tests__/intentional-wait.test.ts`
  - Unit tests for detector behavior.
- Modify: `src/__tests__/stream-json-manager-timeout.test.ts`
  - Add tests proving interim wait results do not resolve and final results do.
- Modify: `src/__tests__/heartbeat.test.ts`
  - Add/adjust route-level test proving keepalives/progress continue until final result.
- Modify: `docs/configuration.md`
  - Document behavior and relevant timeouts.
- Modify: `docs/setup.md`
  - Add short operations note.

---

## Task 1: Add Pure Intentional-Wait Detector

**Files:**
- Create: `src/subprocess/intentional-wait.ts`
- Test: `src/__tests__/intentional-wait.test.ts`

- [ ] **Step 1: Write failing detector tests**

Create `src/__tests__/intentional-wait.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectIntentionalWaitFromMessage,
  detectIntentionalWaitFromResult,
  formatIntentionalWaitStatus,
} from "../subprocess/intentional-wait.js";

test("detects ScheduleWakeup tool_use stream event", () => {
  const state = detectIntentionalWaitFromMessage({
    type: "stream_event",
    event: {
      type: "content_block_start",
      content_block: { type: "tool_use", name: "ScheduleWakeup", id: "toolu_wait" },
    },
    session_id: "s1",
    uuid: "u1",
  });

  assert.deepEqual(state, {
    kind: "schedule_wakeup",
    reason: "Claude scheduled a wakeup/background continuation",
    detectedBy: "tool_use",
    toolName: "ScheduleWakeup",
    startedAt: state?.startedAt,
  });
  assert.ok(typeof state?.startedAt === "number");
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
    });
    assert.equal(state?.kind, "background_task");
    assert.equal(state?.toolName, toolName);
    assert.equal(state?.detectedBy, "tool_use");
  }
});

test("detects sleeping-loop result text as interim intentional wait", () => {
  const result = {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1000,
    duration_api_ms: 1000,
    num_turns: 1,
    result: "Sleeping the loop. Will resume when pytest finishes.",
    session_id: "s1",
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  };

  const state = detectIntentionalWaitFromResult(result);
  assert.equal(state?.kind, "schedule_wakeup");
  assert.equal(state?.detectedBy, "result_text");
});

test("does not classify ordinary final answers as intentional waits", () => {
  const result = {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1000,
    duration_api_ms: 1000,
    num_turns: 1,
    result: "Tests passed. The fix is live.",
    session_id: "s1",
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  };

  assert.equal(detectIntentionalWaitFromMessage({ type: "assistant", message: { model: "x", content: [] } }), null);
  assert.equal(detectIntentionalWaitFromResult(result), null);
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
```

- [ ] **Step 2: Run failing detector tests**

Run:

```bash
npm run build && npm test -- intentional-wait.test
```

Expected: TypeScript build fails because `src/subprocess/intentional-wait.ts` does not exist.

- [ ] **Step 3: Implement detector**

Create `src/subprocess/intentional-wait.ts`:

```ts
import type { ClaudeCliMessage, ClaudeCliResult } from "../types/claude-cli.js";

export type IntentionalWaitKind = "schedule_wakeup" | "background_task";
export type IntentionalWaitDetectedBy = "tool_use" | "result_text";

export interface IntentionalWaitState {
  kind: IntentionalWaitKind;
  reason: string;
  detectedBy: IntentionalWaitDetectedBy;
  toolName?: string;
  startedAt: number;
}

const WAIT_TOOL_NAMES = new Set(["ScheduleWakeup", "Monitor", "TaskOutput"]);

export function detectIntentionalWaitFromMessage(msg: unknown, now: number = Date.now()): IntentionalWaitState | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as {
    type?: string;
    event?: {
      type?: string;
      content_block?: { type?: string; name?: string };
    };
  };

  if (m.type !== "stream_event") return null;
  if (m.event?.type !== "content_block_start") return null;
  const block = m.event.content_block;
  if (block?.type !== "tool_use") return null;
  const toolName = block.name || "";
  if (!WAIT_TOOL_NAMES.has(toolName)) return null;

  if (toolName === "ScheduleWakeup") {
    return {
      kind: "schedule_wakeup",
      reason: "Claude scheduled a wakeup/background continuation",
      detectedBy: "tool_use",
      toolName,
      startedAt: now,
    };
  }

  return {
    kind: "background_task",
    reason: `Claude is waiting on ${toolName}`,
    detectedBy: "tool_use",
    toolName,
    startedAt: now,
  };
}

export function detectIntentionalWaitFromResult(result: ClaudeCliResult, now: number = Date.now()): IntentionalWaitState | null {
  const text = (result.result || "").trim();
  if (!text) return null;

  if (result.subtype !== "success" || result.is_error) return null;

  if (/^Sleeping the loop\.\s+Will resume when\b[\s\S]*\.?$/i.test(text)) {
    return {
      kind: "schedule_wakeup",
      reason: "Claude scheduled a wakeup/background continuation",
      detectedBy: "result_text",
      toolName: "ScheduleWakeup",
      startedAt: now,
    };
  }

  return null;
}

export function formatIntentionalWaitStatus(state: IntentionalWaitState, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - state.startedAt) / 1000));
  if (state.kind === "schedule_wakeup") return `waiting for Claude scheduled wakeup/background continuation · ${seconds}s`;
  return `waiting for Claude background task${state.toolName ? ` (${state.toolName})` : ""} · ${seconds}s`;
}
```

- [ ] **Step 4: Verify detector tests pass**

Run:

```bash
npm run build && npm test -- intentional-wait.test
```

Expected: PASS.

- [ ] **Step 5: Commit detector**

Run:

```bash
git add src/subprocess/intentional-wait.ts src/__tests__/intentional-wait.test.ts
git commit -m "feat: detect Claude intentional wait events"
```

---

## Task 2: Defer Interim Results in StreamJsonSubprocess

**Files:**
- Modify: `src/subprocess/stream-json-manager.ts`
- Test: `src/__tests__/stream-json-manager-timeout.test.ts`

- [ ] **Step 1: Add failing submitTurn tests**

Append to `src/__tests__/stream-json-manager-timeout.test.ts`:

```ts
test("submitTurn keeps turn open after ScheduleWakeup interim result", async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers: Array<() => void> = [];
  global.setTimeout = ((fn: (...args: unknown[]) => void) => {
    timers.push(() => fn());
    return { __fake: true } as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  global.clearTimeout = (() => {}) as typeof clearTimeout;

  try {
    const sub = makeInitializedSubprocess();
    const turn = sub.submitTurn("run tests");

    // This listener-level test complements a processBuffer ordering test added below.
    sub.emit("message", {
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", name: "ScheduleWakeup", id: "tu_wait" } },
      session_id: "s1",
      uuid: "u1",
    });

    sub.emit("result", {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: "Sleeping the loop. Will resume when pytest finishes.",
      session_id: "s1",
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
    });

    let resolved = false;
    void turn.then(() => { resolved = true; });
    await Promise.resolve();
    assert.equal(resolved, false, "interim wait result must not resolve submitTurn");

    sub.emit("result", {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 2,
      duration_api_ms: 2,
      num_turns: 2,
      result: "Tests passed. Final answer.",
      session_id: "s1",
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
    });

    const result = await turn;
    assert.equal(result.result, "Tests passed. Final answer.");
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("submitTurn emits intentional_wait when ScheduleWakeup is detected", async () => {
  const sub = makeInitializedSubprocess();
  const seen: unknown[] = [];
  sub.on("intentional_wait", (state) => seen.push(state));
  const turn = sub.submitTurn("run tests");

  sub.emit("message", {
    type: "stream_event",
    event: { type: "content_block_start", content_block: { type: "tool_use", name: "ScheduleWakeup", id: "tu_wait" } },
    session_id: "s1",
    uuid: "u1",
  });

  sub.emit("result", {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 2,
    duration_api_ms: 2,
    num_turns: 2,
    result: "Done after wakeup.",
    session_id: "s1",
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  });

  await turn;
  assert.equal(seen.length, 1);
  assert.equal((seen[0] as { kind?: string }).kind, "schedule_wakeup");
});
```

- [ ] **Step 2: Run failing submitTurn tests**

Run:

```bash
npm run build && npm test -- stream-json-manager-timeout.test
```

Expected: first new test fails because submitTurn currently resolves on the interim result.

- [ ] **Step 3: Implement deferred result handling**

Modify imports in `src/subprocess/stream-json-manager.ts`:

```ts
import {
  detectIntentionalWaitFromMessage,
  detectIntentionalWaitFromResult,
  type IntentionalWaitState,
} from "./intentional-wait.js";
```

Inside `submitTurn()` after timer variables, add:

```ts
      let intentionalWait: IntentionalWaitState | null = null;
```

Inside `cleanup()`, unregister the new listener:

```ts
        this.off("message", onMessage);
```

Add `onMessage` before listener registration:

```ts
      const onMessage = (message: ClaudeCliMessage) => {
        const detected = detectIntentionalWaitFromMessage(message);
        if (!detected) return;
        intentionalWait = detected;
        this.emit("intentional_wait", detected);
      };
```

Replace `onResult` with:

```ts
      const onResult = (result: ClaudeCliResult) => {
        const resultWait = detectIntentionalWaitFromResult(result);
        if (resultWait) {
          intentionalWait = intentionalWait || resultWait;
          this.emit("intentional_wait", intentionalWait);
          resetIdleTimer();
          return;
        }

        if (result.is_error) {
          settle(() => resolve(result));
          return;
        }

        settle(() => resolve(result));
      };
```

Register the message listener:

```ts
      this.on("message", onMessage);
```

- [ ] **Step 4: Verify submitTurn tests pass**

Run:

```bash
npm run build && npm test -- stream-json-manager-timeout.test intentional-wait.test
```

Expected: PASS.

- [ ] **Step 5: Commit submitTurn behavior**

Run:

```bash
git add src/subprocess/stream-json-manager.ts src/__tests__/stream-json-manager-timeout.test.ts
git commit -m "fix: keep stream-json turns open during scheduled wakeups"
```

---

## Task 3: Route-Level Progress and Watchdog Observability

**Files:**
- Modify: `src/server/routes.ts`
- Test: `src/__tests__/heartbeat.test.ts`

- [ ] **Step 1: Add failing route progress test**

Add a test to `src/__tests__/heartbeat.test.ts` that uses the existing stream-json route test helpers. If no helper exists for direct intentional-wait events, add a fake subprocess that emits `intentional_wait` and delays final `result` until after at least one keepalive tick.

Required assertion code inside the test body:

```ts
assert.match(bodyText, /waiting for Claude scheduled wakeup\/background continuation|Working: thinking|Bubbling/);
assert.ok(!bodyText.includes("data: [DONE]") || bodyText.lastIndexOf("data: [DONE]") > bodyText.indexOf("Tests passed after wakeup"));
assert.match(bodyText, /Tests passed after wakeup/);
```

- [ ] **Step 2: Run failing route test**

Run:

```bash
npm run build && npm test -- heartbeat.test
```

Expected: route test fails if no intentional-wait-specific status is emitted. If the existing liveness fallback already satisfies user-visible progress, keep route source changes minimal and assert the stream stays open until the final result.

- [ ] **Step 3: Add route listener and progress priority**

Modify imports in `src/server/routes.ts`:

```ts
import { formatIntentionalWaitStatus, type IntentionalWaitState } from "../subprocess/intentional-wait.js";
```

Inside `handleStreamJsonRequest()` near phase tracker setup, add:

```ts
  let intentionalWaitState: IntentionalWaitState | null = null;
  let lastIntentionalWaitProgressKey = "";
  const onIntentionalWait = (state: IntentionalWaitState) => {
    intentionalWaitState = state;
    console.error(`[StreamJson] intentional wait req_id=${requestId} kind=${state.kind} detectedBy=${state.detectedBy} tool=${state.toolName || ""}`);
  };
  subprocess.on("intentional_wait", onIntentionalWait);
```

Inside `writeKeepaliveChunk()`, after phase progress and before liveness fallback, add:

```ts
    // Priority 3: Claude explicitly parked the turn waiting for wakeup/background completion.
    if (!hasRenderableAssistantContent(content) && intentionalWaitState) {
      const waitText = formatIntentionalWaitStatus(intentionalWaitState);
      const waitKey = `${intentionalWaitState.kind}:${Math.floor((Date.now() - intentionalWaitState.startedAt) / 30000)}`;
      if (waitKey !== lastIntentionalWaitProgressKey) {
        content = "\n" + renderProgress(null, waitText, { includeHeader: true }) + "\n";
        lastIntentionalWaitProgressKey = waitKey;
        mode = "progress";
      }
    }
```

If `renderProgress` is not exported, either export it from `phase-tracker.ts` or use:

```ts
        content = "\nBubbling...\n🫧 Working: " + waitText + "\n";
```

In watchdog diagnostics context, add:

```ts
      intentionalWaitKind: intentionalWaitState?.kind,
      intentionalWaitAgeMs: intentionalWaitState ? now - intentionalWaitState.startedAt : undefined,
```

In `finally`, detach listener:

```ts
    subprocess.off("intentional_wait", onIntentionalWait);
```

- [ ] **Step 4: Verify route test passes**

Run:

```bash
npm run build && npm test -- heartbeat.test stream-json-manager-timeout.test intentional-wait.test
```

Expected: PASS.

- [ ] **Step 5: Commit route observability**

Run:

```bash
git add src/server/routes.ts src/__tests__/heartbeat.test.ts
git commit -m "chore: surface scheduled-wakeup progress while streaming"
```

---

## Task 4: Improve Phase Tracker Display for Wakeup Tools

**Files:**
- Modify: `src/server/phase-tracker.ts`
- Test: `src/__tests__/phase-tracker.test.ts`

- [ ] **Step 1: Add failing display test**

Append to `src/__tests__/phase-tracker.test.ts`:

```ts
test("ScheduleWakeup progress uses friendly label", () => {
  const ee = new EventEmitter();
  const tracker = attachPhaseTracker(ee);

  ee.emit("message", makeStreamEvent("content_block_start", {
    content_block: { type: "tool_use", name: "ScheduleWakeup", id: "tu_wakeup" },
  }));

  const snap = tracker.poll();
  assert.ok(snap);
  assertProgressBody(snap.text, "🧩 ScheduleWakeup");

  tracker.detach();
});
```

- [ ] **Step 2: Run display test**

Run:

```bash
npm run build && npm test -- phase-tracker.test
```

Expected: either already passes or fails because label/icon differs.

- [ ] **Step 3: Add display name if needed**

In `TOOL_DISPLAY_NAMES`, ensure:

```ts
  ScheduleWakeup: "ScheduleWakeup",
  Monitor: "Monitor",
  TaskOutput: "TaskOutput",
```

If icon mapping exists in `toolIcon()`, ensure `ScheduleWakeup` maps to `🧩` or another consistent non-error icon.

- [ ] **Step 4: Verify display tests pass**

Run:

```bash
npm run build && npm test -- phase-tracker.test
```

Expected: PASS.

- [ ] **Step 5: Commit phase tracker display**

Run:

```bash
git add src/server/phase-tracker.ts src/__tests__/phase-tracker.test.ts
git commit -m "chore: label scheduled wakeup progress"
```

---

## Task 5: Document Operational Behavior

**Files:**
- Modify: `docs/configuration.md`
- Modify: `docs/setup.md`
- Modify: `/Users/mehdichaouachi/.openclaw/workspace/memory/infra/claude-proxy.md`

- [ ] **Step 1: Update configuration docs**

Add to `docs/configuration.md`:

```md
### Scheduled wakeup / background-task waits

Claude Code may intentionally park a turn with tools such as `ScheduleWakeup`, `Monitor`, or `TaskOutput` while a background command finishes. Claude Proxy treats these as intentional waits, not completed turns.

Behavior:

- the OpenAI SSE stream stays open;
- keepalive/progress chunks continue so OpenClaw and Telegram do not drop the turn silently;
- the Claude subprocess remains busy and is not returned to the pool;
- a later real final `result` becomes the OpenAI final answer;
- the existing absolute cap (`TURN_ABSOLUTE_MAX_MS`, currently 60 minutes) still terminates wedged turns.

This is deliberately not a detached async protocol. If the client disconnects, the current implementation discards the worker as before. Durable detach/reattach is a future protocol-level feature. `/v1/chat/completions` gets full keepalive behavior in this patch; `/v1/responses` benefits from deferred `submitTurn()` finalization but should be treated as keepalive-limited until a separate responses keepalive task is implemented.
```

- [ ] **Step 2: Update setup docs**

Add to `docs/setup.md`:

```md
### Long background waits

If Claude Code says `Sleeping the loop. Will resume when ...`, Claude Proxy now keeps the request open instead of finalizing on that interim status. Operators should still avoid restarting Claude Proxy during active long waits because the subprocess owns the parked turn until the final result arrives.
```

- [ ] **Step 3: Update infrastructure memory doc**

Append to `/Users/mehdichaouachi/.openclaw/workspace/memory/infra/claude-proxy.md`:

```md
## ScheduleWakeup / background-task deferred turns

Claude Proxy should not treat Claude Code `ScheduleWakeup` / `Sleeping the loop. Will resume when ...` status as a final assistant answer. The intended design is: detect the intentional wait, keep the SSE stream open with low-noise progress, keep the subprocess busy/out of the pool, ignore the interim wait result, then finalize only on the later real result or the 60-minute absolute cap.

Future enhancement: detached park/reattach for network disconnects. Current implementation preserves OpenAI compatibility and keeps existing client-disconnect discard semantics.
```

- [ ] **Step 4: Verify docs are present**

Run:

```bash
grep -R "Scheduled wakeup" -n docs/configuration.md docs/setup.md /Users/mehdichaouachi/.openclaw/workspace/memory/infra/claude-proxy.md
```

Expected: all three files contain the new note.

- [ ] **Step 5: Commit docs**

Run:

```bash
git add docs/configuration.md docs/setup.md
git commit -m "docs: explain scheduled wakeup deferred turns"
```

---

## Task 6: Full Verification and Safe Restart

**Files:**
- No source changes unless tests expose defects.

- [ ] **Step 1: Run targeted test suite**

Run:

```bash
npm run build && npm test -- intentional-wait.test stream-json-manager-timeout.test heartbeat.test phase-tracker.test stream-json-final-text.test
```

Expected: all tests pass.

- [ ] **Step 2: Inspect active Claude Proxy requests before restart**

Run:

```bash
python3 - <<'PY'
import sqlite3,json,time
p='/Users/mehdichaouachi/.claude-proxy/traces.sqlite'
con=sqlite3.connect(p)
cur=con.cursor()
for (record,) in cur.execute('select record_json from traces order by created_at desc limit 10'):
    r=json.loads(record)
    if not r.get('completedAt'):
        print('ACTIVE', r.get('requestId'), r.get('model'), r.get('createdAt'))
PY
```

Expected: no active uncompleted requests before restart. If active requests exist, stop and ask Mehdi whether to wait or proceed.

- [ ] **Step 3: Restart Claude Proxy with safe wrapper only**

Run:

```bash
/Users/mehdichaouachi/.openclaw/scripts/claude-proxy-safe-restart.sh
```

Expected: health OK and live env preserved.

- [ ] **Step 4: Verify deployed dist contains the new behavior**

Run:

```bash
grep -R "intentional_wait\|detectIntentionalWait\|Sleeping the loop" -n dist/src dist 2>/dev/null | head -50
curl -sS http://127.0.0.1:3456/health
```

Expected: built JS includes the detector and health returns OK.

- [ ] **Step 5: Capture durable memory**

Use OpenBrain capture:

```text
Claude Proxy now defers ScheduleWakeup/background-task interim results: detects ScheduleWakeup/Monitor/TaskOutput, keeps SSE open, leaves subprocess busy, ignores sleeping-loop interim result, and finalizes only on true final result or 60-minute cap. Verified with targeted tests and safe restart.
```

---

## Self-Review

### Spec coverage

- Complete research: covered production traces, current code paths, and local Claude CLI behavior constraints.
- OCTO debate before plan: incorporated Codex and Gemini recommendations.
- Planning skill: this document follows `writing-plans` header and step format.
- Save to infrastructure docs: this file should be mirrored/summarized in `/Users/mehdichaouachi/.openclaw/workspace/memory/infra/claude-proxy.md`.
- Review again with OCTO debate: run after saving this plan, before implementation.
- Start implementation: begin Task 1 after OCTO review.

### Placeholder scan

No `TBD`, `TODO`, or “implement later” placeholders. Where helper availability is uncertain, exact fallback code is provided.

### Type consistency

- `IntentionalWaitState` is defined once in `src/subprocess/intentional-wait.ts` and imported by stream manager and route.
- Event name is consistently `intentional_wait`.
- Detector names are consistently `detectIntentionalWaitFromMessage()` and `detectIntentionalWaitFromResult()`.
