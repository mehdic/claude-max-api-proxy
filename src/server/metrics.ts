/**
 * Prometheus-format /metrics endpoint.
 *
 * Hand-rolled (no prom-client dep) to keep dependency surface small.
 * The exposition format we need is plain text with TYPE/HELP comments
 * and `name{label="value"} number\n` lines — straightforward.
 *
 * Cardinality discipline: we never label by request id, prompt hash,
 * full model id from request (only canonical ids from MODEL_MAP), or
 * any user-controlled string. Reasons for fallback are from a fixed
 * allowlist defined in routes.ts classifyFallbackReason().
 *
 * Counters live where they're produced (poolCounters in session-pool.ts,
 * fallbackCounters in routes.ts) and we read them at scrape time.
 */

import type { Request, Response } from "express";
import { poolCounters, poolStats } from "../subprocess/session-pool.js";
import { fallbackCounters } from "./routes.js";
import { defaultRuntime } from "../subprocess/runtime.js";

// Per-request counters maintained inline by the chat-completion handlers.
// Recorded with a fixed label set: runtime + canonical model + status.
export interface RequestRecord {
  runtime: "stream-json" | "print";
  model: string;
  status: "ok" | "error";
  durationMs: number;
}

interface RequestBucket {
  count: number;
  sumDurationMs: number;
  // Histogram buckets in ms — fixed set keeps cardinality bounded
  buckets: { [le: number]: number };
}

const HIST_BUCKETS_MS = [100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000];
const requestRecords: Map<string, RequestBucket> = new Map();
const subprocessSpawnFailures: Record<string, number> = {};

/** Call from chat handlers when a request finishes. */
export function recordRequest(rec: RequestRecord): void {
  const key = `${rec.runtime}|${rec.model}|${rec.status}`;
  let bucket = requestRecords.get(key);
  if (!bucket) {
    bucket = { count: 0, sumDurationMs: 0, buckets: Object.fromEntries(HIST_BUCKETS_MS.map((b) => [b, 0])) };
    requestRecords.set(key, bucket);
  }
  bucket.count++;
  bucket.sumDurationMs += rec.durationMs;
  for (const le of HIST_BUCKETS_MS) {
    if (rec.durationMs <= le) bucket.buckets[le]++;
  }
}

export function recordSpawnFailure(runtime: "stream-json" | "print"): void {
  subprocessSpawnFailures[runtime] = (subprocessSpawnFailures[runtime] || 0) + 1;
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function handleMetrics(_req: Request, res: Response): void {
  const lines: string[] = [];

  // claude_proxy_requests_total
  lines.push("# HELP claude_proxy_requests_total Total chat-completion requests.");
  lines.push("# TYPE claude_proxy_requests_total counter");
  for (const [key, bucket] of requestRecords) {
    const [runtime, model, status] = key.split("|");
    lines.push(
      `claude_proxy_requests_total{runtime="${escapeLabel(runtime)}",model="${escapeLabel(model)}",status="${escapeLabel(status)}"} ${bucket.count}`,
    );
  }

  // claude_proxy_request_duration_seconds (histogram)
  lines.push("# HELP claude_proxy_request_duration_seconds Request handler latency.");
  lines.push("# TYPE claude_proxy_request_duration_seconds histogram");
  for (const [key, bucket] of requestRecords) {
    const [runtime, model, status] = key.split("|");
    const labels = `runtime="${escapeLabel(runtime)}",model="${escapeLabel(model)}",status="${escapeLabel(status)}"`;
    for (const le of HIST_BUCKETS_MS) {
      lines.push(`claude_proxy_request_duration_seconds_bucket{${labels},le="${(le / 1000).toFixed(3)}"} ${bucket.buckets[le]}`);
    }
    lines.push(`claude_proxy_request_duration_seconds_bucket{${labels},le="+Inf"} ${bucket.count}`);
    lines.push(`claude_proxy_request_duration_seconds_sum{${labels}} ${(bucket.sumDurationMs / 1000).toFixed(6)}`);
    lines.push(`claude_proxy_request_duration_seconds_count{${labels}} ${bucket.count}`);
  }

  // claude_proxy_stream_fallback_total
  lines.push("# HELP claude_proxy_stream_fallback_total Stream-json → print fallbacks by reason.");
  lines.push("# TYPE claude_proxy_stream_fallback_total counter");
  if (Object.keys(fallbackCounters.byReason).length === 0) {
    lines.push(`claude_proxy_stream_fallback_total{reason="none"} 0`);
  } else {
    for (const [reason, n] of Object.entries(fallbackCounters.byReason)) {
      lines.push(`claude_proxy_stream_fallback_total{reason="${escapeLabel(reason)}"} ${n}`);
    }
  }

  // claude_proxy_pool_size
  lines.push("# HELP claude_proxy_pool_size Live workers in the session pool.");
  lines.push("# TYPE claude_proxy_pool_size gauge");
  const ps = poolStats();
  lines.push(`claude_proxy_pool_size{state="live"} ${ps.size}`);
  lines.push(`claude_proxy_pool_size{state="max"} ${ps.max}`);

  // claude_proxy_pool_ttl_evictions_total + lru_evictions_total
  lines.push("# HELP claude_proxy_pool_ttl_evictions_total Workers evicted for idle TTL.");
  lines.push("# TYPE claude_proxy_pool_ttl_evictions_total counter");
  lines.push(`claude_proxy_pool_ttl_evictions_total ${poolCounters.ttlEvictions}`);

  lines.push("# HELP claude_proxy_pool_lru_evictions_total Workers evicted to honor MAX_SESSIONS cap.");
  lines.push("# TYPE claude_proxy_pool_lru_evictions_total counter");
  lines.push(`claude_proxy_pool_lru_evictions_total ${poolCounters.lruEvictions}`);

  lines.push("# HELP claude_proxy_pool_fingerprint_mismatches_total Slots discarded for fingerprint drift.");
  lines.push("# TYPE claude_proxy_pool_fingerprint_mismatches_total counter");
  lines.push(`claude_proxy_pool_fingerprint_mismatches_total ${poolCounters.fingerprintMismatches}`);

  lines.push("# HELP claude_proxy_pool_warm_hits_total Conversations served from a warm pool slot.");
  lines.push("# TYPE claude_proxy_pool_warm_hits_total counter");
  lines.push(`claude_proxy_pool_warm_hits_total ${poolCounters.warmHits}`);

  lines.push("# HELP claude_proxy_pool_cold_spawns_total Conversations that took the cold path.");
  lines.push("# TYPE claude_proxy_pool_cold_spawns_total counter");
  lines.push(`claude_proxy_pool_cold_spawns_total ${poolCounters.coldSpawns}`);

  // claude_proxy_subprocess_spawn_failures_total
  lines.push("# HELP claude_proxy_subprocess_spawn_failures_total Failed claude subprocess spawns.");
  lines.push("# TYPE claude_proxy_subprocess_spawn_failures_total counter");
  if (Object.keys(subprocessSpawnFailures).length === 0) {
    lines.push(`claude_proxy_subprocess_spawn_failures_total{runtime="none"} 0`);
  } else {
    for (const [runtime, n] of Object.entries(subprocessSpawnFailures)) {
      lines.push(`claude_proxy_subprocess_spawn_failures_total{runtime="${escapeLabel(runtime)}"} ${n}`);
    }
  }

  // claude_proxy_runtime_default — informational gauge for the resolved default runtime
  lines.push("# HELP claude_proxy_runtime_default 1 if the named runtime is the default.");
  lines.push("# TYPE claude_proxy_runtime_default gauge");
  lines.push(`claude_proxy_runtime_default{runtime="stream-json"} ${defaultRuntime() === "stream-json" ? 1 : 0}`);
  lines.push(`claude_proxy_runtime_default{runtime="print"} ${defaultRuntime() === "print" ? 1 : 0}`);

  res.setHeader("Content-Type", "text/plain; version=0.0.4");
  res.send(lines.join("\n") + "\n");
}
