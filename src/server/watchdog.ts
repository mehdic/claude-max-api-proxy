/**
 * Upstream Soft-Dead Watchdog
 *
 * Pure helpers for detecting a wedged/dead Claude CLI subprocess during
 * stream-json requests. The watchdog triggers when Claude has been silent
 * (no stream events) for UPSTREAM_SOFT_DEAD_MS, or immediately when the
 * subprocess is detectably dead (exited, killed, pipes destroyed).
 *
 * Client-side heartbeats are explicitly excluded — they keep OpenClaw's
 * idle timer happy but must NOT mask a wedged upstream.
 *
 * Process-tree monitoring: when Claude spawns subprocesses (bash, node,
 * etc.) that are actively consuming CPU, their activity can suppress a
 * soft-dead false positive — but only up to DESCENDANT_GRACE_CAP_MS.
 * Idle/zombie descendants do NOT suppress.
 */

import { execFileSync } from "child_process";

export interface SubprocessSnapshot {
  pid: number | undefined;
  exitCode: number | null;
  signalCode?: NodeJS.Signals | null;
  killed: boolean;
  stdinDestroyed: boolean;
  stdinWritableEnded?: boolean;
  stdoutReadable: boolean;
  stdoutDestroyed?: boolean;
  stderrReadable: boolean;
  stderrDestroyed?: boolean;
  initialized: boolean;
  turnInFlight: boolean;
  ageMs: number;
  lastProcessActivityAgeMs?: number | null;
  processActivityCount?: number;
}

export interface DescendantInfo {
  /** Total descendant process count. */
  count: number;
  /** Non-zombie, non-stopped descendants with CPU > 0 or state R/S. */
  running: number;
  /** Aggregate %CPU across all descendants. */
  totalCpuPct: number;
  /** Aggregate RSS (KB) across all descendants. */
  totalRssKb: number;
  /** Descendant PIDs (for diagnostics, capped at 20). */
  pids: number[];
  /** When this sample was taken (Date.now()). */
  sampledAt: number;
}

export interface SoftDeadDiagnostic {
  requestId: string;
  reason: "upstream_soft_dead" | "upstream_hard_dead";
  silenceMs: number;
  subprocess: SubprocessSnapshot;
  timestamp: string;
  /** Additional request context for structured logging */
  context?: {
    model?: string;
    runtime?: string;
    stream?: boolean;
    bridgeTools?: boolean;
    lastClientActivityAgeMs?: number;
    lastClaudeActivityAgeMs?: number;
    childPid?: number;
    processActivityCount?: number;
    watchdogAction?: "kill" | "discard";
    descendantCount?: number;
    descendantCpuPct?: number;
  };
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 5 minutes by default — silence threshold before upstream is declared soft-dead. */
export const UPSTREAM_SOFT_DEAD_MS = parsePositiveIntEnv("CLAUDE_PROXY_UPSTREAM_SOFT_DEAD_MS", 300_000);

/**
 * Maximum silence before soft-dead fires even with active descendants.
 * Default 10 minutes (2× soft-dead threshold). Prevents zombie/idle
 * descendants from masking a dead Claude forever.
 */
export const DESCENDANT_GRACE_CAP_MS = parsePositiveIntEnv("CLAUDE_PROXY_DESCENDANT_GRACE_MS", 600_000);

/** Minimum aggregate %CPU across descendants to count as "meaningful activity". */
export const DESCENDANT_CPU_FLOOR = 0.5;

/** Maximum age of a descendant sample to be considered fresh (60s). */
const DESCENDANT_SAMPLE_MAX_AGE_MS = 60_000;

/**
 * Determine whether the upstream Claude subprocess should be considered dead.
 *
 * Returns true if:
 *   1. The subprocess is detectably hard-dead (exited, killed, pipes gone), OR
 *   2. Claude has been silent for >= UPSTREAM_SOFT_DEAD_MS AND no meaningful
 *      process-tree activity is detected
 *
 * Client heartbeat timestamps are NOT accepted — only `lastClaudeActivityAt`
 * (updated by real Claude stream events) counts.
 *
 * Descendant process activity (e.g. bash running `npm test`) can suppress a
 * soft-dead, but only if: descendants are running with aggregate CPU above
 * DESCENDANT_CPU_FLOOR, AND total silence is below DESCENDANT_GRACE_CAP_MS.
 * This prevents zombies from masking a dead Claude forever.
 */
export function shouldTriggerSoftDead(
  lastClaudeActivityAt: number,
  snapshot: SubprocessSnapshot,
  now: number = Date.now(),
  descendants?: DescendantInfo | null,
): boolean {
  // Hard-dead: process is gone or pipes are broken — fail immediately.
  if (snapshot.exitCode !== null) return true;
  if (snapshot.killed) return true;
  if (snapshot.stdinDestroyed || snapshot.stdinWritableEnded) return true;
  if (!snapshot.stdoutReadable || snapshot.stdoutDestroyed) return true;

  // Soft-dead: Claude has been silent too long.
  // But also consider raw subprocess activity (stdout/stderr data) — if the
  // process is still producing data, it's alive even if no parsed JSON
  // messages have arrived. This prevents false positives during verbose
  // tool work or thinking that emits stderr but not stream-json messages.
  const silenceMs = now - lastClaudeActivityAt;
  if (silenceMs < UPSTREAM_SOFT_DEAD_MS) return false;

  // If subprocess-level activity is more recent than parsed messages,
  // use that as the liveness signal (broader interpretation).
  // BUT: cap this suppression at DESCENDANT_GRACE_CAP_MS of total parsed-Claude
  // silence — a noisy/wedged CLI emitting raw output but no stream-json events
  // must not avoid soft-dead indefinitely.
  if (
    snapshot.lastProcessActivityAgeMs != null &&
    snapshot.lastProcessActivityAgeMs < UPSTREAM_SOFT_DEAD_MS &&
    silenceMs < DESCENDANT_GRACE_CAP_MS
  ) {
    return false;
  }

  // Check descendant processes: running children with meaningful CPU
  // can suppress soft-dead, but only if:
  //   a) the sample is fresh (taken within DESCENDANT_SAMPLE_MAX_AGE_MS)
  //   b) descendants have CPU above the floor (not idle zombies)
  //   c) total silence hasn't exceeded the grace cap (prevents masking forever)
  if (
    descendants &&
    descendants.running > 0 &&
    descendants.totalCpuPct >= DESCENDANT_CPU_FLOOR &&
    silenceMs < DESCENDANT_GRACE_CAP_MS &&
    (now - descendants.sampledAt) < DESCENDANT_SAMPLE_MAX_AGE_MS
  ) {
    return false;
  }

  return true;
}

/**
 * Build a structured diagnostic object for logging when soft-dead fires.
 */
export function buildSoftDeadDiagnostic(
  requestId: string,
  lastClaudeActivityAt: number,
  snapshot: SubprocessSnapshot,
  now: number = Date.now(),
  context?: SoftDeadDiagnostic["context"],
): SoftDeadDiagnostic {
  const isHardDead =
    snapshot.exitCode !== null ||
    snapshot.killed ||
    snapshot.stdinDestroyed ||
    snapshot.stdinWritableEnded === true ||
    !snapshot.stdoutReadable ||
    snapshot.stdoutDestroyed === true;

  return {
    requestId,
    reason: isHardDead ? "upstream_hard_dead" : "upstream_soft_dead",
    silenceMs: now - lastClaudeActivityAt,
    subprocess: snapshot,
    timestamp: new Date(now).toISOString(),
    ...(context ? { context } : {}),
  };
}

// ---------------------------------------------------------------------------
// Process-tree descendant sampler
// ---------------------------------------------------------------------------

const MAX_DESCENDANT_DEPTH = 4;
const SAMPLE_TIMEOUT_MS = 2000;
const MAX_REPORTED_PIDS = 20;

/**
 * Recursively collect all descendant PIDs of `rootPid` via `pgrep -P`.
 * Bounded by MAX_DESCENDANT_DEPTH to avoid runaway recursion.
 */
function getDescendantPids(rootPid: number, depth: number = 0): number[] {
  if (depth >= MAX_DESCENDANT_DEPTH) return [];
  try {
    const raw = execFileSync("pgrep", ["-P", String(rootPid)], {
      timeout: SAMPLE_TIMEOUT_MS,
      encoding: "utf8",
    });
    const children = raw.trim().split("\n").filter(Boolean).map(Number).filter(n => !isNaN(n));
    const all = [...children];
    for (const child of children) {
      all.push(...getDescendantPids(child, depth + 1));
    }
    return all;
  } catch {
    // pgrep exits 1 when no children found — normal, not an error.
    return [];
  }
}

/**
 * Sample the process tree rooted at `rootPid` and return aggregate stats.
 *
 * Returns null on any sampling failure (non-fatal — the watchdog treats
 * null as "no descendant info available" and does not suppress soft-dead).
 *
 * Intentionally synchronous: runs only in the watchdog timer (every 30s,
 * only after the silence threshold is breached), never on the hot path.
 */
export function sampleDescendants(rootPid: number): DescendantInfo | null {
  try {
    const pids = getDescendantPids(rootPid);
    const sampledAt = Date.now();
    if (pids.length === 0) return { count: 0, running: 0, totalCpuPct: 0, totalRssKb: 0, pids: [], sampledAt };

    // Get state + CPU + RSS for all descendants in one ps call.
    // macOS BSD ps: -o state=,%cpu=,rss= suppresses headers; -p accepts
    // comma-separated PIDs.
    const raw = execFileSync(
      "ps",
      ["-o", "state=,%cpu=,rss=", "-p", pids.join(",")],
      { timeout: SAMPLE_TIMEOUT_MS, encoding: "utf8" },
    );

    const lines = raw.trim().split("\n").filter(Boolean);
    let running = 0;
    let totalCpuPct = 0;
    let totalRssKb = 0;

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const state = parts[0];
      const cpu = parseFloat(parts[1]) || 0;
      const rss = parseInt(parts[2], 10) || 0;
      totalCpuPct += cpu;
      totalRssKb += rss;
      // Z = zombie, T = stopped, X = dead — everything else counts as running.
      if (state !== "Z" && state !== "T" && state !== "X") running++;
    }

    return {
      count: pids.length,
      running,
      totalCpuPct: Math.round(totalCpuPct * 100) / 100,
      totalRssKb,
      pids: pids.slice(0, MAX_REPORTED_PIDS),
      sampledAt,
    };
  } catch {
    return null;
  }
}
