import { execFile, execFileSync } from "child_process";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { TraceRecord } from "./types.js";

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS traces (
  trace_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER,
  model TEXT NOT NULL,
  runtime TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  stream INTEGER NOT NULL,
  finish_reason TEXT,
  error_class TEXT,
  fallback_triggered INTEGER NOT NULL,
  tool_call_count INTEGER NOT NULL,
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_created_at ON traces(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_traces_model ON traces(model);
CREATE INDEX IF NOT EXISTS idx_traces_error_class ON traces(error_class);
`;

let initializedPaths = new Set<string>();

export function traceSqlitePath(): string | null {
  const p = process.env.CLAUDE_PROXY_TRACE_SQLITE_PATH?.trim();
  return p || null;
}

export function traceSqliteEnabled(): boolean {
  return traceSqlitePath() !== null;
}

export function traceSqliteRetentionMs(): number | null {
  const days = Number(process.env.CLAUDE_PROXY_TRACE_SQLITE_RETENTION_DAYS || "");
  if (Number.isFinite(days) && days > 0) return Math.floor(days * 24 * 60 * 60 * 1000);

  const ms = Number(process.env.CLAUDE_PROXY_TRACE_SQLITE_RETENTION_MS || "");
  if (Number.isFinite(ms) && ms > 0) return Math.floor(ms);

  return null;
}

export function resetTraceSqliteForTests(): void {
  initializedPaths = new Set<string>();
}

export function persistTraceSqlite(trace: TraceRecord): void {
  const dbPath = traceSqlitePath();
  if (!dbPath || trace.completedAt === undefined) return;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    ensureDb(dbPath);
    const sql = `${buildInsertSql(trace)}
${buildPruneSql(Date.now())}`;
    execFile("sqlite3", [dbPath, sql], { timeout: 2_000, maxBuffer: 128_000 }, (err) => {
      if (err && process.env.CLAUDE_PROXY_TRACE_SQLITE_DEBUG === "1") {
        console.error("[trace-sqlite] persist failed", err.message || String(err));
      }
    });
  } catch (err) {
    if (process.env.CLAUDE_PROXY_TRACE_SQLITE_DEBUG === "1") {
      console.error("[trace-sqlite] setup failed", err instanceof Error ? err.message : String(err));
    }
  }
}

export function persistTraceSqliteSyncForTests(trace: TraceRecord, dbPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const prev = process.env.CLAUDE_PROXY_TRACE_SQLITE_PATH;
    process.env.CLAUDE_PROXY_TRACE_SQLITE_PATH = dbPath;
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
      ensureDb(dbPath);
      execFile("sqlite3", [dbPath, `${buildInsertSql(trace)}
${buildPruneSql(Date.now())}`], { timeout: 2_000, maxBuffer: 128_000 }, (err) => {
        if (prev === undefined) delete process.env.CLAUDE_PROXY_TRACE_SQLITE_PATH;
        else process.env.CLAUDE_PROXY_TRACE_SQLITE_PATH = prev;
        if (err) reject(err);
        else resolve();
      });
    } catch (err) {
      if (prev === undefined) delete process.env.CLAUDE_PROXY_TRACE_SQLITE_PATH;
      else process.env.CLAUDE_PROXY_TRACE_SQLITE_PATH = prev;
      reject(err);
    }
  });
}

function ensureDb(dbPath: string): void {
  if (initializedPaths.has(dbPath)) return;
  try {
    execFileSync("sqlite3", [dbPath, CREATE_SQL], { timeout: 2_000, maxBuffer: 128_000 });
    initializedPaths.add(dbPath);
  } catch (err) {
    if (process.env.CLAUDE_PROXY_TRACE_SQLITE_DEBUG === "1") {
      console.error("[trace-sqlite] init failed", err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

function buildPruneSql(now: number): string {
  const retentionMs = traceSqliteRetentionMs();
  if (!retentionMs) return "";
  const cutoff = Math.trunc(now - retentionMs);
  return `DELETE FROM traces WHERE created_at < ${cutoff};`;
}

function buildInsertSql(trace: TraceRecord): string {
  const recordJson = JSON.stringify(trace);
  return `
INSERT INTO traces (
  trace_id, request_id, created_at, completed_at, duration_ms, model, runtime,
  endpoint, stream, finish_reason, error_class, fallback_triggered,
  tool_call_count, record_json
) VALUES (
  ${q(trace.traceId)},
  ${q(trace.requestId)},
  ${n(trace.createdAt)},
  ${nullableN(trace.completedAt)},
  ${nullableN(trace.durationMs)},
  ${q(trace.model)},
  ${q(trace.runtime)},
  ${q(trace.endpoint)},
  ${trace.stream ? 1 : 0},
  ${nullableQ(trace.finishReason)},
  ${nullableQ(trace.errorClass)},
  ${trace.fallbackTriggered ? 1 : 0},
  ${n(trace.toolCallsParsed.length)},
  ${q(recordJson)}
)
ON CONFLICT(trace_id) DO UPDATE SET
  completed_at=excluded.completed_at,
  duration_ms=excluded.duration_ms,
  finish_reason=excluded.finish_reason,
  error_class=excluded.error_class,
  fallback_triggered=excluded.fallback_triggered,
  tool_call_count=excluded.tool_call_count,
  record_json=excluded.record_json;
`;
}

function q(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function nullableQ(value: string | undefined): string {
  return value === undefined ? "NULL" : q(value);
}

function n(value: number): string {
  return Number.isFinite(value) ? String(Math.trunc(value)) : "0";
}

function nullableN(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "NULL" : String(Math.trunc(value));
}
