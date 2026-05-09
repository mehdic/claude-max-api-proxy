import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStickyInternalKey,
  disallowedToolsKey,
  isIdleExpired,
  isAbsoluteExpired,
  parseStickyTtlMs,
} from "../subprocess/sticky-session-pool.js";

test("disallowedToolsKey sorts tools for stable fingerprinting", () => {
  assert.equal(disallowedToolsKey(["mcp__b", "mcp__a"]), "mcp__a,mcp__b");
  assert.equal(disallowedToolsKey([]), "");
});

test("internal key changes across model and tool policy", () => {
  const base = {
    sessionKeyHash: "abc123",
    model: "claude-sonnet-4-6",
    runtime: "stream-json" as const,
    disallowedToolsKey: "",
    mcpPolicyKey: "mcp:on",
    cwd: "/tmp/proxy",
    dynamicPromptExclusion: true,
  };
  const same = buildStickyInternalKey(base);
  const differentModel = buildStickyInternalKey({ ...base, model: "claude-opus-4-7" });
  const differentTools = buildStickyInternalKey({ ...base, disallowedToolsKey: "mcp__n8n__list" });
  assert.equal(same, buildStickyInternalKey(base));
  assert.notEqual(same, differentModel);
  assert.notEqual(same, differentTools);
  assert.match(same, /^[a-f0-9]{64}$/);
});

test("idle expiration uses lastUsedAt and ttlMs", () => {
  assert.equal(isIdleExpired({ lastUsedAt: 1000, ttlMs: 5000 }, 7001), true);
  assert.equal(isIdleExpired({ lastUsedAt: 1000, ttlMs: 5000 }, 6000), false);
});

test("absolute expiration can be disabled with zero", () => {
  assert.equal(isAbsoluteExpired({ createdAt: 1000 }, 900000, 0), false);
  assert.equal(isAbsoluteExpired({ createdAt: 1000 }, 900000, 60_000), true);
  assert.equal(isAbsoluteExpired({ createdAt: 1000 }, 30_000, 60_000), false);
});

test("parseStickyTtlMs converts seconds to milliseconds", () => {
  assert.equal(parseStickyTtlMs(60), 60_000);
  assert.equal(parseStickyTtlMs(86400), 86_400_000);
});
