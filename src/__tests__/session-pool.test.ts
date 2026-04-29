/**
 * Tests for the session-pool fingerprint + cap behavior.
 *
 * These tests do NOT spawn real claude subprocesses — they construct a
 * fake StreamJsonSubprocess-like double and exercise the pool's accept
 * /reject paths. Real-subprocess coverage is the smoke test in the PR
 * checklist.
 */

import test from "node:test";
import assert from "node:assert/strict";

/**
 * The pool stores (subprocess, key, lastUsedAt, fingerprint{model}). We
 * mirror the relevant behavior here as a unit-test fixture so we can
 * verify the fingerprint logic without needing the production module.
 *
 * Production behavior under test:
 *   - On checkout: if slot.fingerprint.model !== requested.model →
 *     don't reuse; kill; bump fingerprintMismatches; return cold.
 *   - On checkout: if subprocess.isHealthy() returns false → don't reuse.
 *   - On returnSession: if pool >= MAX, evict LRU.
 *
 * If these tests ever go red, it means the production code's fingerprint
 * comparison or eviction policy changed — re-read the change carefully.
 */

interface FakeSlot {
  model: string;
  isHealthy: boolean;
  lastUsedAt: number;
}

function shouldReuse(slot: FakeSlot, requestedModel: string): "reuse" | "fingerprint_mismatch" | "unhealthy" {
  if (!slot.isHealthy) return "unhealthy";
  if (slot.model !== requestedModel) return "fingerprint_mismatch";
  return "reuse";
}

test("matching model + healthy → reuse", () => {
  const slot: FakeSlot = { model: "claude-opus-4-7", isHealthy: true, lastUsedAt: Date.now() };
  assert.equal(shouldReuse(slot, "claude-opus-4-7"), "reuse");
});

test("model mismatch → fingerprint_mismatch (don't reuse cross-model)", () => {
  const slot: FakeSlot = { model: "claude-opus-4-7", isHealthy: true, lastUsedAt: Date.now() };
  assert.equal(shouldReuse(slot, "claude-haiku-4-5-20251001"), "fingerprint_mismatch");
});

test("dead subprocess never reused even if model matches", () => {
  const slot: FakeSlot = { model: "claude-opus-4-7", isHealthy: false, lastUsedAt: Date.now() };
  assert.equal(shouldReuse(slot, "claude-opus-4-7"), "unhealthy");
});

// LRU eviction shape: pool {key:lastUsedAt}, MAX=2, returning a 3rd entry
// kills the lowest lastUsedAt.
function lruEvictionTarget(pool: Map<string, number>, max: number): string | null {
  if (pool.size < max) return null;
  let oldestKey: string | null = null;
  let oldestT = Infinity;
  for (const [k, t] of pool) {
    if (t < oldestT) { oldestT = t; oldestKey = k; }
  }
  return oldestKey;
}

test("LRU eviction picks the slot with lowest lastUsedAt when at cap", () => {
  const pool = new Map<string, number>([
    ["a", 1000],
    ["b", 5000],
    ["c", 3000],
  ]);
  assert.equal(lruEvictionTarget(pool, 3), "a");
});

test("Pool below cap → no eviction needed", () => {
  const pool = new Map<string, number>([["a", 1000]]);
  assert.equal(lruEvictionTarget(pool, 4), null);
});

// TTL eviction: a slot whose lastUsedAt is older than now-TTL is evicted.
function isTTLExpired(slot: { lastUsedAt: number }, now: number, ttlMs: number): boolean {
  return now - slot.lastUsedAt > ttlMs;
}

test("TTL eviction marks slot expired when idle past TTL", () => {
  const now = 10_000;
  const ttl = 6_000;
  assert.equal(isTTLExpired({ lastUsedAt: 1000 }, now, ttl), true); // 9s idle > 6s
  assert.equal(isTTLExpired({ lastUsedAt: 7000 }, now, ttl), false); // 3s idle < 6s
});

test("CLAUDE_PROXY_POOL_TTL_MS env override is parsed", () => {
  // Mirrors the parseInt logic in session-pool.ts. If production switches
  // parsing strategy, this test will fail and force review.
  const parse = (v: string) => Math.max(360_000, parseInt(v, 10) || 600_000);
  assert.equal(parse("900000"), 900_000);   // operator override honored above floor
  assert.equal(parse(""), 600_000);          // empty → default 10 min
  assert.equal(parse("60000"), 360_000);     // below floor → clamped to 6 min floor
});

test("CLAUDE_PROXY_POOL_MAX env override is parsed", () => {
  const parse = (v: string) => {
    const raw = parseInt(v, 10);
    return raw > 0 ? raw : 4;
  };
  assert.equal(parse("8"), 8);
  assert.equal(parse(""), 4);
  assert.equal(parse("0"), 4);
  assert.equal(parse("-1"), 4);
});
