import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { StreamJsonSubprocess } from "../subprocess/stream-json-manager.js";

function makeInitializedSubprocess(): StreamJsonSubprocess {
  const sub = new StreamJsonSubprocess();
  const writable = {
    destroyed: false,
    writableEnded: false,
    write: (_line: string) => true,
  };

  Object.assign(sub as unknown as {
    initialized: boolean;
    isKilled: boolean;
    turnInFlight: boolean;
    process: { exitCode: number | null; stdin: typeof writable };
  }, {
    initialized: true,
    isKilled: false,
    turnInFlight: false,
    process: { exitCode: null, stdin: writable },
  });

  return sub;
}

function markProcessActivity(sub: StreamJsonSubprocess): void {
  (sub as unknown as { markProcessActivity: () => void }).markProcessActivity();
}

const result = {
  type: "result" as const,
  subtype: "success" as const,
  is_error: false,
  duration_ms: 0,
  duration_api_ms: 0,
  num_turns: 1,
  result: "ok",
  session_id: "s",
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 },
  modelUsage: {},
};

test("submitTurn resets idle timeout on real subprocess activity", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  try {
    const sub = makeInitializedSubprocess();
    const turn = sub.submitTurn("work");

    mock.timers.tick(899_000);
    markProcessActivity(sub);
    mock.timers.tick(899_000);
    sub.emit("result", result);

    assert.equal(await turn, result);
  } finally {
    mock.timers.reset();
  }
});

test("submitTurn enforces a 60 minute absolute max cap despite activity", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  try {
    const sub = makeInitializedSubprocess();
    const turn = sub.submitTurn("long work");

    for (let elapsed = 0; elapsed < 3_600_000; elapsed += 899_000) {
      mock.timers.tick(899_000);
      markProcessActivity(sub);
    }

    await assert.rejects(turn, /turn exceeded absolute max after 3600000ms/);
  } finally {
    mock.timers.reset();
  }
});

test("submitTurn keeps turn open after ScheduleWakeup interim result", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  try {
    const sub = makeInitializedSubprocess();
    const turn = sub.submitTurn("run tests");

    sub.emit("message", {
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", name: "ScheduleWakeup", id: "tu_wait" } },
      session_id: "s1",
      uuid: "u1",
    });

    sub.emit("result", {
      ...result,
      result: "Sleeping the loop. Will resume when pytest finishes.",
    });

    let resolved = false;
    void turn.then(() => { resolved = true; });
    await Promise.resolve();
    assert.equal(resolved, false, "interim wait result must not resolve submitTurn");

    const finalResult = { ...result, result: "Tests passed. Final answer.", num_turns: 2 };
    sub.emit("result", finalResult);

    assert.equal(await turn, finalResult);
  } finally {
    mock.timers.reset();
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

  sub.emit("result", { ...result, result: "Done after wakeup." });

  await turn;
  assert.equal(seen.length, 1);
  assert.equal((seen[0] as { kind?: string }).kind, "schedule_wakeup");
});

test("submitTurn does not let ScheduleWakeup tool_use alone suppress an empty final result", async () => {
  const sub = makeInitializedSubprocess();
  const turn = sub.submitTurn("run tests");

  sub.emit("message", {
    type: "stream_event",
    event: { type: "content_block_start", content_block: { type: "tool_use", name: "ScheduleWakeup", id: "tu_wait" } },
    session_id: "s1",
    uuid: "u1",
  });

  const emptyFinal = { ...result, result: "" };
  sub.emit("result", emptyFinal);

  assert.equal(await turn, emptyFinal);
});

test("submitTurn restores idle timeout after Claude resumes from intentional wait", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  try {
    const sub = makeInitializedSubprocess();
    const turn = sub.submitTurn("run tests");

    sub.emit("result", { ...result, result: "Sleeping the loop. Will resume when pytest finishes." });
    mock.timers.tick(1_800_000);

    sub.emit("message", {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Back from pytest..." },
      },
      session_id: "s1",
      uuid: "u1",
    });

    mock.timers.tick(900_000);
    await assert.rejects(turn, /turn idle timed out after 900000ms/);
  } finally {
    mock.timers.reset();
  }
});

test("submitTurn resolves error results during intentional wait", async () => {
  const sub = makeInitializedSubprocess();
  const turn = sub.submitTurn("run tests");

  sub.emit("result", { ...result, result: "Sleeping the loop. Will resume when pytest finishes." });

  const errorResult = { ...result, subtype: "error" as const, is_error: true, result: "" };
  sub.emit("result", errorResult);

  assert.equal(await turn, errorResult);
});

test("processBuffer detects wait result before resolving final result", async () => {
  const sub = makeInitializedSubprocess();
  const turn = sub.submitTurn("run tests");
  const seen: unknown[] = [];
  sub.on("intentional_wait", (state) => seen.push(state));

  const interim = JSON.stringify({ ...result, result: "Sleeping the loop. Will resume when pytest finishes." });
  const final = JSON.stringify({ ...result, result: "Tests passed after wakeup.", num_turns: 2 });
  Object.assign(sub as unknown as { buffer: string }, { buffer: `${interim}\n${final}\n` });
  (sub as unknown as { processBuffer: () => void }).processBuffer();

  const resolved = await turn;
  assert.equal(resolved.result, "Tests passed after wakeup.");
  assert.equal(seen.length, 1);
  assert.equal((seen[0] as { detectedBy?: string }).detectedBy, "result_text");
});
