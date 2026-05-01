/**
 * Bounded in-memory trace store.
 *
 * Configurable via env:
 *   CLAUDE_PROXY_TRACE_ENABLED=1      — enable trace recording (default: off)
 *   CLAUDE_PROXY_TRACE_CAPACITY=200   — max stored traces (default: 200)
 *   CLAUDE_PROXY_TRACE_TTL_MS=3600000 — TTL per trace in ms (default: 1 hour)
 *
 * Traces are evicted LRU when capacity is exceeded and by TTL on access.
 * The store is localhost-gated at the route level, not here.
 */

import type { TraceRecord, TraceListItem } from "./types.js";

const DEFAULT_CAPACITY = 200;
const DEFAULT_TTL_MS = 3_600_000; // 1 hour

export class TraceStore {
  private traces: Map<string, TraceRecord> = new Map();
  private readonly capacity: number;
  private readonly ttlMs: number;
  readonly enabled: boolean;

  constructor() {
    this.enabled = process.env.CLAUDE_PROXY_TRACE_ENABLED === "1";
    this.capacity = Math.max(1, parseInt(process.env.CLAUDE_PROXY_TRACE_CAPACITY || "", 10) || DEFAULT_CAPACITY);
    this.ttlMs = Math.max(60_000, parseInt(process.env.CLAUDE_PROXY_TRACE_TTL_MS || "", 10) || DEFAULT_TTL_MS);
  }

  /**
   * Record or update a trace. If the store is disabled, this is a no-op.
   */
  set(trace: TraceRecord): void {
    if (!this.enabled) return;
    this.evictExpired();

    // LRU eviction: if at capacity, remove oldest
    if (!this.traces.has(trace.traceId) && this.traces.size >= this.capacity) {
      const oldest = this.traces.keys().next().value;
      if (oldest !== undefined) this.traces.delete(oldest);
    }

    // Move to end (most recently accessed)
    this.traces.delete(trace.traceId);
    this.traces.set(trace.traceId, trace);
  }

  /**
   * Retrieve a single trace by ID. Returns undefined if not found or expired.
   */
  get(traceId: string): TraceRecord | undefined {
    const trace = this.traces.get(traceId);
    if (!trace) return undefined;
    if (this.isExpired(trace)) {
      this.traces.delete(traceId);
      return undefined;
    }
    return trace;
  }

  /**
   * List recent traces, newest first. Returns summary items (not full records).
   */
  list(limit: number = 50, offset: number = 0): TraceListItem[] {
    this.evictExpired();
    const all = Array.from(this.traces.values()).reverse();
    return all.slice(offset, offset + limit).map(toListItem);
  }

  /**
   * Current store size (after eviction).
   */
  size(): number {
    this.evictExpired();
    return this.traces.size;
  }

  /**
   * Stats for health/metrics endpoints.
   */
  stats(): { enabled: boolean; size: number; capacity: number; ttlMs: number } {
    return {
      enabled: this.enabled,
      size: this.enabled ? this.size() : 0,
      capacity: this.capacity,
      ttlMs: this.ttlMs,
    };
  }

  /** For tests */
  clear(): void {
    this.traces.clear();
  }

  private isExpired(trace: TraceRecord): boolean {
    return Date.now() - trace.createdAt > this.ttlMs;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, trace] of this.traces) {
      if (now - trace.createdAt > this.ttlMs) {
        this.traces.delete(id);
      } else {
        // Map is ordered by insertion; once we hit a non-expired entry,
        // all subsequent are newer. But we can't rely on that after
        // updates, so scan all.
      }
    }
  }
}

function toListItem(t: TraceRecord): TraceListItem {
  return {
    traceId: t.traceId,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
    durationMs: t.durationMs,
    model: t.model,
    runtime: t.runtime,
    endpoint: t.endpoint,
    stream: t.stream,
    finishReason: t.finishReason,
    errorClass: t.errorClass,
    toolCallCount: t.toolCallsParsed.length,
    fallbackTriggered: t.fallbackTriggered,
  };
}

/**
 * Singleton trace store instance. Shared across the proxy process.
 */
export const traceStore = new TraceStore();
