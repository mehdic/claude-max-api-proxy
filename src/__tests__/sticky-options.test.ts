import test from "node:test";
import assert from "node:assert/strict";
import {
  stickySessionConfigFromEnv,
  resolveSessionOptions,
  isSessionOptionsError,
} from "../server/sticky-options.js";

function req(headers: Record<string, string | undefined>, body: Record<string, unknown> = {}) {
  return { headers, body };
}

test("default request without sticky fields resolves to pool mode", () => {
  const result = resolveSessionOptions(req({}, {}), stickySessionConfigFromEnv({}));
  assert.equal(isSessionOptionsError(result), false);
  if (!isSessionOptionsError(result)) assert.equal(result.mode, "pool");
});

test("header session key opts into sticky mode when enabled", () => {
  const config = stickySessionConfigFromEnv({ CLAUDE_PROXY_STICKY_SESSIONS: "1" });
  const result = resolveSessionOptions(req({
    "x-claude-proxy-session-key": " app:user:conversation ",
    "x-claude-proxy-session-ttl-seconds": "86400",
  }), config);
  assert.equal(isSessionOptionsError(result), false);
  if (!isSessionOptionsError(result)) {
    assert.equal(result.mode, "sticky");
    assert.equal(result.sticky?.rawKey, "app:user:conversation");
    assert.equal(result.sticky?.ttlSeconds, 86400);
    assert.equal(result.sticky?.reset, false);
    assert.match(result.sticky?.keyHashShort || "", /^[a-f0-9]{12}$/);
  }
});

test("body extension opts into sticky mode when body options enabled", () => {
  const config = stickySessionConfigFromEnv({
    CLAUDE_PROXY_STICKY_SESSIONS: "1",
    CLAUDE_PROXY_STICKY_ALLOW_BODY_OPTIONS: "1",
  });
  const result = resolveSessionOptions(req({}, {
    claude_proxy: {
      session_key: "body-session",
      session_mode: "sticky",
      session_ttl_seconds: 3600,
      session_reset: true,
    },
  }), config);
  assert.equal(isSessionOptionsError(result), false);
  if (!isSessionOptionsError(result)) {
    assert.equal(result.mode, "sticky");
    assert.equal(result.sticky?.rawKey, "body-session");
    assert.equal(result.sticky?.ttlSeconds, 3600);
    assert.equal(result.sticky?.reset, true);
  }
});

test("headers override body extension", () => {
  const config = stickySessionConfigFromEnv({
    CLAUDE_PROXY_STICKY_SESSIONS: "1",
    CLAUDE_PROXY_STICKY_ALLOW_BODY_OPTIONS: "1",
  });
  const result = resolveSessionOptions(req({
    "x-claude-proxy-session-key": "header-session",
    "x-claude-proxy-session-mode": "sticky",
    "x-claude-proxy-session-ttl-seconds": "120",
  }, {
    claude_proxy: {
      session_key: "body-session",
      session_mode: "sticky",
      session_ttl_seconds: 3600,
    },
  }), config);
  assert.equal(isSessionOptionsError(result), false);
  if (!isSessionOptionsError(result)) {
    assert.equal(result.mode, "sticky");
    assert.equal(result.sticky?.rawKey, "header-session");
    assert.equal(result.sticky?.ttlSeconds, 120);
  }
});

test("explicit stateless header overrides sticky body", () => {
  const config = stickySessionConfigFromEnv({
    CLAUDE_PROXY_STICKY_SESSIONS: "1",
    CLAUDE_PROXY_STICKY_ALLOW_BODY_OPTIONS: "1",
  });
  const result = resolveSessionOptions(req({
    "x-claude-proxy-session-mode": "stateless",
  }, {
    claude_proxy: {
      session_key: "body-session",
      session_mode: "sticky",
    },
  }), config);
  assert.equal(isSessionOptionsError(result), false);
  if (!isSessionOptionsError(result)) assert.equal(result.mode, "stateless");
});

test("sticky key while feature disabled returns sticky_sessions_disabled", () => {
  const result = resolveSessionOptions(req({
    "x-claude-proxy-session-key": "disabled-session",
  }), stickySessionConfigFromEnv({}));
  assert.equal(isSessionOptionsError(result), true);
  if (isSessionOptionsError(result)) {
    assert.equal(result.status, 400);
    assert.equal(result.code, "sticky_sessions_disabled");
  }
});

test("explicit sticky mode without key returns invalid_session_key", () => {
  const config = stickySessionConfigFromEnv({ CLAUDE_PROXY_STICKY_SESSIONS: "1" });
  const result = resolveSessionOptions(req({
    "x-claude-proxy-session-mode": "sticky",
  }), config);
  assert.equal(isSessionOptionsError(result), true);
  if (isSessionOptionsError(result)) assert.equal(result.code, "invalid_session_key");
});

test("invalid mode returns invalid_session_mode", () => {
  const config = stickySessionConfigFromEnv({ CLAUDE_PROXY_STICKY_SESSIONS: "1" });
  const result = resolveSessionOptions(req({
    "x-claude-proxy-session-key": "abc",
    "x-claude-proxy-session-mode": "forever",
  }), config);
  assert.equal(isSessionOptionsError(result), true);
  if (isSessionOptionsError(result)) assert.equal(result.code, "invalid_session_mode");
});

test("TTL is clamped to configured min and max", () => {
  const config = stickySessionConfigFromEnv({
    CLAUDE_PROXY_STICKY_SESSIONS: "1",
    CLAUDE_PROXY_STICKY_MIN_TTL_SECONDS: "60",
    CLAUDE_PROXY_STICKY_MAX_TTL_SECONDS: "3600",
  });
  const low = resolveSessionOptions(req({
    "x-claude-proxy-session-key": "low",
    "x-claude-proxy-session-ttl-seconds": "5",
  }), config);
  const high = resolveSessionOptions(req({
    "x-claude-proxy-session-key": "high",
    "x-claude-proxy-session-ttl-seconds": "86400",
  }), config);
  assert.equal(isSessionOptionsError(low), false);
  assert.equal(isSessionOptionsError(high), false);
  if (!isSessionOptionsError(low)) assert.equal(low.sticky?.ttlSeconds, 60);
  if (!isSessionOptionsError(high)) assert.equal(high.sticky?.ttlSeconds, 3600);
});

test("invalid key with control character returns invalid_session_key", () => {
  const config = stickySessionConfigFromEnv({ CLAUDE_PROXY_STICKY_SESSIONS: "1" });
  const result = resolveSessionOptions(req({
    "x-claude-proxy-session-key": "bad\nkey",
  }), config);
  assert.equal(isSessionOptionsError(result), true);
  if (isSessionOptionsError(result)) assert.equal(result.code, "invalid_session_key");
});

test("invalid TTL returns invalid_session_ttl", () => {
  const config = stickySessionConfigFromEnv({ CLAUDE_PROXY_STICKY_SESSIONS: "1" });
  const result = resolveSessionOptions(req({
    "x-claude-proxy-session-key": "ttl",
    "x-claude-proxy-session-ttl-seconds": "abc",
  }), config);
  assert.equal(isSessionOptionsError(result), true);
  if (isSessionOptionsError(result)) assert.equal(result.code, "invalid_session_ttl");
});
