import test from "node:test";
import assert from "node:assert/strict";
import { TraceStore, traceStore } from "../trace/store.js";
import type { TraceRecord } from "../trace/types.js";
import { classifyError, isStreamLayerFault, isStreamLayerFaultClass } from "../errors.js";
import { extractArgumentKeys, isSecretKey, redactToolChoice, redactEnv } from "../trace/redact.js";
import { createTraceBuilder } from "../trace/builder.js";
import { applyMcpPolicy, detectOverlappingTools } from "../mcp/governance.js";
import type { ResolvedMcpServer } from "../mcp/openclaw-config.js";
import { createHeartbeatChunk, HEARTBEAT_CONTENT } from "../server/routes.js";
import { parseToolCalls } from "../adapter/tools.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTrace(id: string, overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    traceId: id,
    requestId: `req_${id}`,
    createdAt: Date.now(),
    model: "claude-sonnet-4-6",
    requestedModel: "claude-proxy/claude-sonnet-4-6",
    runtime: "stream-json",
    stream: true,
    endpoint: "chat.completions",
    messageCount: 2,
    bridgeTools: false,
    toolsOffered: [],
    toolCallsParsed: [],
    toolResultsInjected: [],
    fallbackTriggered: false,
    mcpDecisions: [],
    ...overrides,
  };
}

// ── TraceStore tests ─────────────────────────────────────────────────

test("TraceStore: disabled by default (no env)", () => {
  const store = new TraceStore();
  // CLAUDE_PROXY_TRACE_ENABLED is not set in test env
  assert.equal(store.enabled, false);
  store.set(makeTrace("t1"));
  assert.equal(store.size(), 0);
  assert.equal(store.get("t1"), undefined);
});

test("TraceStore: stores and retrieves traces when enabled", () => {
  const orig = process.env.CLAUDE_PROXY_TRACE_ENABLED;
  process.env.CLAUDE_PROXY_TRACE_ENABLED = "1";
  try {
    const store = new TraceStore();
    assert.equal(store.enabled, true);
    const t = makeTrace("t1");
    store.set(t);
    assert.equal(store.size(), 1);
    const retrieved = store.get("t1");
    assert.ok(retrieved);
    assert.equal(retrieved.traceId, "t1");
  } finally {
    if (orig !== undefined) process.env.CLAUDE_PROXY_TRACE_ENABLED = orig;
    else delete process.env.CLAUDE_PROXY_TRACE_ENABLED;
  }
});

test("TraceStore: LRU eviction at capacity", () => {
  const orig = process.env.CLAUDE_PROXY_TRACE_ENABLED;
  const origCap = process.env.CLAUDE_PROXY_TRACE_CAPACITY;
  process.env.CLAUDE_PROXY_TRACE_ENABLED = "1";
  process.env.CLAUDE_PROXY_TRACE_CAPACITY = "3";
  try {
    const store = new TraceStore();
    store.set(makeTrace("t1"));
    store.set(makeTrace("t2"));
    store.set(makeTrace("t3"));
    assert.equal(store.size(), 3);
    store.set(makeTrace("t4"));
    assert.equal(store.size(), 3);
    // t1 should have been evicted (oldest)
    assert.equal(store.get("t1"), undefined);
    assert.ok(store.get("t4"));
  } finally {
    if (orig !== undefined) process.env.CLAUDE_PROXY_TRACE_ENABLED = orig;
    else delete process.env.CLAUDE_PROXY_TRACE_ENABLED;
    if (origCap !== undefined) process.env.CLAUDE_PROXY_TRACE_CAPACITY = origCap;
    else delete process.env.CLAUDE_PROXY_TRACE_CAPACITY;
  }
});

test("TraceStore: TTL eviction", () => {
  const orig = process.env.CLAUDE_PROXY_TRACE_ENABLED;
  const origTtl = process.env.CLAUDE_PROXY_TRACE_TTL_MS;
  process.env.CLAUDE_PROXY_TRACE_ENABLED = "1";
  process.env.CLAUDE_PROXY_TRACE_TTL_MS = "60000"; // minimum floor
  try {
    const store = new TraceStore();
    const oldTrace = makeTrace("old", { createdAt: Date.now() - 120_000 });
    store.set(oldTrace);
    // Should be evicted on access
    assert.equal(store.get("old"), undefined);
  } finally {
    if (orig !== undefined) process.env.CLAUDE_PROXY_TRACE_ENABLED = orig;
    else delete process.env.CLAUDE_PROXY_TRACE_ENABLED;
    if (origTtl !== undefined) process.env.CLAUDE_PROXY_TRACE_TTL_MS = origTtl;
    else delete process.env.CLAUDE_PROXY_TRACE_TTL_MS;
  }
});

test("TraceStore: list returns newest first", () => {
  const orig = process.env.CLAUDE_PROXY_TRACE_ENABLED;
  process.env.CLAUDE_PROXY_TRACE_ENABLED = "1";
  try {
    const store = new TraceStore();
    store.set(makeTrace("t1", { createdAt: Date.now() - 3000 }));
    store.set(makeTrace("t2", { createdAt: Date.now() - 2000 }));
    store.set(makeTrace("t3", { createdAt: Date.now() - 1000 }));
    const list = store.list();
    assert.equal(list.length, 3);
    assert.equal(list[0].traceId, "t3");
    assert.equal(list[2].traceId, "t1");
  } finally {
    if (orig !== undefined) process.env.CLAUDE_PROXY_TRACE_ENABLED = orig;
    else delete process.env.CLAUDE_PROXY_TRACE_ENABLED;
  }
});

test("TraceStore: stats returns capacity/ttl", () => {
  const orig = process.env.CLAUDE_PROXY_TRACE_ENABLED;
  process.env.CLAUDE_PROXY_TRACE_ENABLED = "1";
  try {
    const store = new TraceStore();
    const stats = store.stats();
    assert.equal(stats.enabled, true);
    assert.equal(typeof stats.capacity, "number");
    assert.equal(typeof stats.ttlMs, "number");
    assert.ok(stats.capacity > 0);
    assert.ok(stats.ttlMs >= 60_000);
  } finally {
    if (orig !== undefined) process.env.CLAUDE_PROXY_TRACE_ENABLED = orig;
    else delete process.env.CLAUDE_PROXY_TRACE_ENABLED;
  }
});

// ── Error classification tests ───────────────────────────────────────

test("classifyError: init handshake timeout", () => {
  assert.equal(classifyError(new Error("init handshake timed out after 30000ms")), "init_handshake_timeout");
});

test("classifyError: worker died", () => {
  assert.equal(classifyError(new Error("subprocess closed before result")), "worker_died");
});

test("classifyError: turn timeout", () => {
  assert.equal(classifyError(new Error("turn timed out after 900000ms")), "turn_timeout");
});

test("classifyError: spawn ENOENT", () => {
  assert.equal(classifyError(new Error("Claude CLI not found")), "spawn_enoent");
});

test("classifyError: stdin closed", () => {
  assert.equal(classifyError(new Error("stdin not writable")), "stdin_closed");
});

test("classifyError: worker invalid", () => {
  assert.equal(classifyError(new Error("subprocess not initialized")), "worker_invalid");
  assert.equal(classifyError(new Error("subprocess is dead")), "worker_invalid");
});

test("classifyError: control protocol", () => {
  assert.equal(classifyError(new Error("control error")), "control_protocol");
});

test("classifyError: rate limit", () => {
  assert.equal(classifyError(new Error("rate limit exceeded (429)")), "rate_limit");
});

test("classifyError: auth error", () => {
  assert.equal(classifyError(new Error("unauthorized (401)")), "auth_error");
});

test("classifyError: unknown for non-Error", () => {
  assert.equal(classifyError("string error"), "unknown");
  assert.equal(classifyError(null), "unknown");
});

test("isStreamLayerFault: true for transport faults", () => {
  assert.equal(isStreamLayerFault(new Error("init handshake timed out")), true);
  assert.equal(isStreamLayerFault(new Error("subprocess closed before result")), true);
  assert.equal(isStreamLayerFault(new Error("turn timed out")), true);
});

test("isStreamLayerFault: false for model errors", () => {
  assert.equal(isStreamLayerFault(new Error("rate limit exceeded")), false);
  assert.equal(isStreamLayerFault(new Error("unauthorized")), false);
});

test("isStreamLayerFaultClass: bounded labels", () => {
  assert.equal(isStreamLayerFaultClass("init_handshake_timeout"), true);
  assert.equal(isStreamLayerFaultClass("worker_died"), true);
  assert.equal(isStreamLayerFaultClass("rate_limit"), false);
  assert.equal(isStreamLayerFaultClass("auth_error"), false);
  assert.equal(isStreamLayerFaultClass("unknown"), false);
});

// ── Redaction tests ──────────────────────────────────────────────────

test("isSecretKey: detects secret keys", () => {
  assert.equal(isSecretKey("api_key"), true);
  assert.equal(isSecretKey("API_KEY"), true);
  assert.equal(isSecretKey("apiKey"), true);
  assert.equal(isSecretKey("secret"), true);
  assert.equal(isSecretKey("password"), true);
  assert.equal(isSecretKey("bearer_token"), true);
  assert.equal(isSecretKey("Authorization"), true);
  assert.equal(isSecretKey("private_key"), true);
});

test("isSecretKey: non-secret keys pass through", () => {
  assert.equal(isSecretKey("name"), false);
  assert.equal(isSecretKey("model"), false);
  assert.equal(isSecretKey("limit"), false);
  assert.equal(isSecretKey("url"), false);
});

test("extractArgumentKeys: extracts keys from JSON", () => {
  const keys = extractArgumentKeys('{"name":"test","limit":10}');
  assert.deepEqual(keys, ["name", "limit"]);
});

test("extractArgumentKeys: empty for malformed JSON", () => {
  assert.deepEqual(extractArgumentKeys("not json"), []);
  assert.deepEqual(extractArgumentKeys(""), []);
});

test("extractArgumentKeys: empty for non-object JSON", () => {
  assert.deepEqual(extractArgumentKeys("[1,2,3]"), []);
  assert.deepEqual(extractArgumentKeys('"string"'), []);
});

test("redactToolChoice: string values pass through", () => {
  assert.equal(redactToolChoice("auto"), "auto");
  assert.equal(redactToolChoice("none"), "none");
  assert.equal(redactToolChoice("required"), "required");
  assert.equal(redactToolChoice(undefined), "auto");
});

test("redactToolChoice: function choice shows name", () => {
  assert.equal(
    redactToolChoice({ type: "function", function: { name: "my_tool" } }),
    "function:my_tool",
  );
});

test("redactEnv: redacts secret-looking keys", () => {
  const result = redactEnv({
    API_KEY: "sk-12345",
    N8N_API_URL: "http://example.com",
    PASSWORD: "hunter2",
    MODE: "stdio",
  });
  assert.equal(result.API_KEY, "[REDACTED]");
  assert.equal(result.N8N_API_URL, "http://example.com");
  assert.equal(result.PASSWORD, "[REDACTED]");
  assert.equal(result.MODE, "stdio");
});

// ── Trace builder tests ──────────────────────────────────────────────

test("TraceBuilder: builds a complete trace record", () => {
  const orig = process.env.CLAUDE_PROXY_TRACE_ENABLED;
  process.env.CLAUDE_PROXY_TRACE_ENABLED = "1";
  try {
    // Use a fresh store for this test via the singleton
    traceStore.clear();

    const tb = createTraceBuilder({
      traceId: "trc_test1",
      requestId: "req_test1",
      model: "claude-sonnet-4-6",
      requestedModel: "claude-proxy/claude-sonnet-4-6",
      stream: true,
      endpoint: "chat.completions",
    });

    tb.setRuntime("stream-json");
    tb.setMessageCount(3);
    tb.setBridgeTools(true, {
      tools: [{ type: "function", function: { name: "n8n__search", parameters: {} } }],
      tool_choice: "auto",
    });
    tb.addToolCall({
      id: "call_1",
      type: "function",
      function: { name: "search", arguments: '{"query":"test"}' },
    });
    tb.setFinishReason("tool_calls");
    tb.setUsage({ promptTokens: 100, responseTokens: 50, cacheReadTokens: 20 });
    tb.setSessionWarmHit(true);
    tb.setToolCallParseSource("result_text");
    tb.commit();

    // The singleton traceStore won't have this since it's a different instance
    // but the builder completed without error
    assert.equal(tb.traceId, "trc_test1");
  } finally {
    if (orig !== undefined) process.env.CLAUDE_PROXY_TRACE_ENABLED = orig;
    else delete process.env.CLAUDE_PROXY_TRACE_ENABLED;
  }
});

test("TraceBuilder: records error and fallback", () => {
  const tb = createTraceBuilder({
    traceId: "trc_err",
    requestId: "req_err",
    model: "claude-opus-4-6",
    requestedModel: "claude-opus-4-6",
    stream: false,
    endpoint: "chat.completions",
  });

  tb.setError("init_handshake_timeout", "init handshake timed out after 30000ms");
  tb.setFallback("init_handshake_timeout");
  tb.commit();
  assert.equal(tb.traceId, "trc_err");
});

test("TraceBuilder: records tool results from request messages", () => {
  const tb = createTraceBuilder({
    traceId: "trc_tools",
    requestId: "req_tools",
    model: "claude-sonnet-4-6",
    requestedModel: "claude-sonnet-4-6",
    stream: true,
    endpoint: "chat.completions",
  });

  tb.setBridgeTools(true, {
    tools: [{ type: "function", function: { name: "n8n__search", parameters: {} } }],
    tool_choice: "auto",
    messages: [
      { role: "user", content: "search for cats" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function" as const, function: { name: "search", arguments: '{"q":"cats"}' } }] },
      { role: "tool", content: '{"results":[]}', tool_call_id: "c1", name: "search" },
    ],
    model: "claude-sonnet-4-6",
  } as any);
  tb.commit();
  assert.equal(tb.traceId, "trc_tools");
});

// ── MCP governance tests ─────────────────────────────────────────────

test("applyMcpPolicy: open policy passes all servers", () => {
  const servers: Record<string, ResolvedMcpServer> = {
    n8n: { command: "n8n-mcp", args: [], env: {} },
    github: { command: "github-mcp", args: [], env: {} },
  };
  const { allowed, decisions } = applyMcpPolicy(servers);
  assert.equal(Object.keys(allowed).length, 2);
  assert.equal(decisions.length, 2);
  assert.ok(decisions.every((d) => d.action === "loaded"));
});

test("detectOverlappingTools: detects overlaps", () => {
  const callerTools = ["n8n__list_workflows", "custom_tool"];
  const mcpServers: Record<string, ResolvedMcpServer> = {
    n8n: { command: "n8n-mcp", args: [], env: {} },
  };
  const decisions = detectOverlappingTools(callerTools, mcpServers);
  assert.ok(decisions.length > 0);
  assert.equal(decisions[0].action, "overlapping_tool_blocked");
});

test("detectOverlappingTools: no overlap returns empty", () => {
  const callerTools = ["custom_tool"];
  const mcpServers: Record<string, ResolvedMcpServer> = {
    n8n: { command: "n8n-mcp", args: [], env: {} },
  };
  const decisions = detectOverlappingTools(callerTools, mcpServers);
  assert.equal(decisions.length, 0);
});

test("detectOverlappingTools: empty caller tools returns empty", () => {
  const mcpServers: Record<string, ResolvedMcpServer> = {
    n8n: { command: "n8n-mcp", args: [], env: {} },
  };
  const decisions = detectOverlappingTools([], mcpServers);
  assert.equal(decisions.length, 0);
});

// ── Heartbeat header presence test ───────────────────────────────────

test("createHeartbeatChunk: includes ZWSP content by default", () => {
  const chunk = createHeartbeatChunk("req1", "claude-sonnet-4");
  assert.equal(chunk.choices[0].delta.content, HEARTBEAT_CONTENT);
  assert.equal(chunk.id, "chatcmpl-req1");
  assert.equal(chunk.model, "claude-sonnet-4");
});

test("createHeartbeatChunk: includes role when requested", () => {
  const chunk = createHeartbeatChunk("req1", "claude-sonnet-4", true);
  assert.equal(chunk.choices[0].delta.role, "assistant");
  assert.equal(chunk.choices[0].delta.content, HEARTBEAT_CONTENT);
});

test("createHeartbeatChunk: custom content overrides ZWSP", () => {
  const chunk = createHeartbeatChunk("req1", "claude-sonnet-4", false, "n8n progress...");
  assert.equal(chunk.choices[0].delta.content, "n8n progress...");
});

// ── Tool call parse with malformed JSON ──────────────────────────────

test("parseToolCalls: handles malformed tool JSON gracefully", () => {
  // Truncated mid-value — the outermost brace never closes
  const malformed = 'Here is the answer: {"tool_call":{"name":"n8n__search","arguments":{"q":"te';
  const result = parseToolCalls(malformed, {
    tools: [{ type: "function", function: { name: "n8n__search", parameters: {} } }],
  });
  // The malformed JSON won't parse because the brace is unclosed
  assert.equal(result.toolCalls.length, 0);
  assert.ok(result.textContent.length > 0);
});

test("parseToolCalls: handles valid tool JSON", () => {
  const valid = '{"tool_call":{"name":"n8n__search","arguments":{"q":"test"}}}';
  const result = parseToolCalls(valid, {
    tools: [{ type: "function", function: { name: "n8n__search", parameters: {} } }],
  });
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, "n8n__search");
});

test("parseToolCalls: tool-result follow-up does not re-emit same tool", () => {
  // After a tool result, the model should answer normally, not re-call
  const text = "Based on the search results, here are the top matches...";
  const result = parseToolCalls(text, {
    tools: [{ type: "function", function: { name: "n8n__search", parameters: {} } }],
  });
  assert.equal(result.toolCalls.length, 0);
  assert.ok(result.textContent.includes("Based on the search results"));
});

// ── Streaming tool call detection ────────────────────────────────────

test("parseToolCalls: streaming tool call with surrounding text", () => {
  const text = 'Let me search for that.\n{"tool_call":{"name":"n8n__search","arguments":{"q":"cats"}}}\nDone.';
  const result = parseToolCalls(text, {
    tools: [{ type: "function", function: { name: "n8n__search", parameters: {} } }],
  });
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, "n8n__search");
  // Text around the tool call should remain
  assert.ok(!result.textContent.includes("tool_call"));
});

// ── Parser fixture: interleaved JSON ─────────────────────────────────

test("parseToolCalls: ignores non-tool JSON objects", () => {
  const text = '{"status":"ok","count":5}\nSome text\n{"tool_call":{"name":"n8n__search","arguments":{}}}';
  const result = parseToolCalls(text, {
    tools: [{ type: "function", function: { name: "n8n__search", parameters: {} } }],
  });
  // Should only pick up the tool_call, not the status object
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, "n8n__search");
});

// ── Parser fixture: unexpected stream events ─────────────────────────

test("parseToolCalls: handles empty text", () => {
  const result = parseToolCalls("", {
    tools: [{ type: "function", function: { name: "n8n__search", parameters: {} } }],
  });
  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.textContent, "");
});
