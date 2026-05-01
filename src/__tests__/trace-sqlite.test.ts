import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistTraceSqliteSyncForTests, resetTraceSqliteForTests } from "../trace/sqlite.js";
import type { TraceRecord } from "../trace/types.js";

function sqliteAvailable(): boolean {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function trace(): TraceRecord {
  return {
    traceId: "trace_sqlite_1",
    requestId: "req_sqlite_1",
    createdAt: 1000,
    completedAt: 1250,
    durationMs: 250,
    model: "claude-sonnet-4-6",
    requestedModel: "sonnet",
    runtime: "stream-json",
    stream: false,
    endpoint: "responses",
    messageCount: 1,
    bridgeTools: true,
    toolsOffered: ["lookup"],
    toolChoice: "auto",
    toolCallsParsed: [{ id: "call_1", name: "lookup", argumentKeys: ["id"] }],
    toolResultsInjected: [],
    finishReason: "tool_calls",
    responseTokens: 3,
    promptTokens: 7,
    cacheReadTokens: 0,
    fallbackTriggered: false,
    mcpDecisions: [{ server: "github", action: "secret_resolved", envKey: "GITHUB_TOKEN" }],
    sessionWarmHit: false,
  };
}

test("persistTraceSqlite writes queryable durable trace rows", { skip: !sqliteAvailable() }, async () => {
  resetTraceSqliteForTests();
  const db = join(mkdtempSync(join(tmpdir(), "claude-proxy-traces-")), "traces.sqlite");
  await persistTraceSqliteSyncForTests(trace(), db);

  const count = execFileSync("sqlite3", [db, "SELECT COUNT(*) FROM traces WHERE trace_id='trace_sqlite_1';"], { encoding: "utf8" }).trim();
  assert.equal(count, "1");
  const row = execFileSync("sqlite3", [db, "SELECT model || '|' || runtime || '|' || endpoint || '|' || tool_call_count FROM traces WHERE trace_id='trace_sqlite_1';"], { encoding: "utf8" }).trim();
  assert.equal(row, "claude-sonnet-4-6|stream-json|responses|1");

  const json = execFileSync("sqlite3", [db, "SELECT record_json FROM traces WHERE trace_id='trace_sqlite_1';"], { encoding: "utf8" });
  assert.match(json, /GITHUB_TOKEN/);
  assert.doesNotMatch(json, /secret-value|Bearer|sk-/i);
});
