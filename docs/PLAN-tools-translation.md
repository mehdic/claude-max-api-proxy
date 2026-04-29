# Plan: full OpenAI tools ↔ Claude tools translation

Branch: `feature/openai-tools-translation`. Target: solid, well-tested, minimal blast-radius. Reviewable before any code lands.

## 1. Why we're doing this

Today the proxy strips the OpenAI `tools[]` field from incoming requests. So when openclaw registers an MCP server (e.g. `n8n`), openclaw lists those tools in its system prompt as text and includes their schemas in the OpenAI request — but the schemas never reach the inner claude. Sevro (running inside `claude --input-format stream-json`) sees only:

- Claude Code CLI's built-in tools (Bash, Read, Write, Edit, …)
- Whatever MCPs are registered at the CLI level (`~/.claude.json` / `--mcp-config`) — currently none from openclaw

She does **not** see the openclaw-registered MCPs as invokable tools. Her recent Telegram message ("I don't have the n8n MCP tools in this Claude Code context") is correctly self-reporting this fact.

**The desired end state:** when openclaw sends an OpenAI request with `tools: [...]`, the inner claude actually exposes those tools to the model, the model can call them, and openclaw's own dispatcher executes them — keeping audit / security / approval flows in openclaw's hands.

## 2. The architectural challenge (read carefully)

OpenAI's tool-calling model:
- Client sends `tools[]` schemas in the request.
- Model emits `tool_calls` in its response, then **stops**.
- Client executes the tool, sends back a `role: tool, tool_call_id: ...` message.
- Loop continues.

Claude (Anthropic API) tool-calling model: same shape, different field names (`input_schema`, `tool_use`, `tool_result`).

Claude **CLI** tool execution model: very different. The CLI owns its own tool runtime. When the model emits `tool_use`, the CLI **executes the tool itself** (running Bash, hitting an MCP server, etc.) and continues the conversation transparently. There is no "stop and return tool_calls to my caller" mode in `claude --print` or `claude --input-format stream-json` — at least not officially exposed.

This means we cannot just "forward" the OpenAI tools to claude as Claude tools and expect tool_calls to bubble back to the proxy and out to openclaw. The CLI will try to execute them locally.

Three architectural responses:

### Option A — register openclaw's MCPs into claude CLI via `--mcp-config`

claude-proxy spawns `claude` with `--mcp-config <inline json>` listing the same MCP servers openclaw has. The CLI loads them, the inner claude can invoke them, the CLI executes them locally. No translation, no interception. Final response to openclaw is a text-only assistant message; openclaw doesn't see tool_calls because the tools were dispatched inside the CLI.

- **Pros:** ~30 lines of code in `stream-json-manager.ts`. Sevro gets working n8n MCP today. Claude understands tool-calling natively → high quality.
- **Cons:** openclaw's dispatcher is bypassed. openclaw won't show n8n tool calls in its audit log, can't gate them via exec-approval, can't enforce per-agent tool allowlists for MCP tools (those are openclaw policy primitives that only fire on tools openclaw dispatches).

### Option B — proxy hosts a fake MCP endpoint, intercepts calls, returns them to openclaw

claude-proxy stands up a stdio MCP server of its own. When spawning the inner claude, the `--mcp-config` registers *this* server. When claude invokes a tool:

1. CLI forwards the call to our proxy MCP endpoint.
2. Our endpoint stalls (holds the call open).
3. We translate the call to an OpenAI `tool_calls` chunk, emit it back to openclaw, and *end* the current claude turn cleanly.
4. openclaw dispatches the tool through its own machinery, sends back the next request with `role: tool, tool_call_id, content`.
5. We translate that to a `tool_result` MCP response and return it to the held-open claude call.
6. Claude continues generation.

This is a **real proxy in both directions** — full translation, openclaw stays authoritative. It's the clean answer to "make claude-proxy a real OpenAI tools → Claude tools translator."

- **Pros:** Architecturally correct. openclaw audit / approval / allowlists keep working for MCP tools. No drift between openclaw's stated tool catalog and what claude can actually invoke.
- **Cons:** Genuinely complex. Stateful per-conversation. Three new failure modes (stuck MCP call, mid-turn cancel, tool-result race). Stream-json subprocess lifecycle becomes a state machine.

### Option C — text-protocol round-trip (the openclaw-style fallback)

If the inner claude can't be made to do native tool-calling without executing locally, fall back to a text protocol: openclaw's tool descriptions get injected as a system-prompt addendum, claude is instructed to emit `<<tool_call name="…" args="…">>` markers in its text response, the proxy parses those markers, translates to OpenAI `tool_calls`, and ends the turn.

- **Pros:** No MCP-protocol surgery. Simpler than B.
- **Cons:** Quality drop — claude doesn't natively understand this protocol. Marker-parsing is fragile. We'd be reinventing a poor man's tool API on top of an existing one.

## 3. Decision

**Option B** is what was asked for and what's architecturally right. **Option A is a 30-line stopgap I can ship in 10 minutes** if you'd rather unblock Sevro on n8n today and revisit B later. Option C is a non-starter — it's worse than what openclaw already does in its system prompt.

The rest of this plan covers Option B. If you want A as an interim bridge, I'll add a small section.

## 4. Option B — implementation plan

### 4.1 Surface area

New / modified files (claude-proxy):

| File | Role |
|------|------|
| `src/tools/proxy-mcp-server.ts` (new) | Implements an MCP-stdio server that claude-proxy embeds. Receives `tools/list` and `tools/call` from the inner claude, holds calls until openclaw answers. |
| `src/tools/translate.ts` (new) | Pure functions: OpenAI tool schema → MCP tool definition; OpenAI `tool_calls` → MCP responses (and back); name-mangling roundtrip. |
| `src/tools/pending-calls.ts` (new) | Per-conversation map of pending tool calls awaiting openclaw responses. Keyed by tool_call_id. |
| `src/subprocess/stream-json-manager.ts` (modified) | At spawn time, write a temp `--mcp-config` JSON that points at our embedded MCP server (over a unix socket or stdio fd). Pass `--mcp-config <path>` in `buildArgs`. |
| `src/server/routes.ts` (modified) | When the OpenAI request contains `tools[]`, register them with the embedded MCP server *for this conversation only*, scoped by session-pool key. When the request includes `role: tool` messages, route their `content` back into the matching pending call's promise. |
| `src/types/openai.ts` (modified) | Add `tools`, `tool_choice`, `tool_calls`, `tool_call_id` fields. |
| `src/types/claude-cli.ts` (modified) | Add stream-json's `tool_use` event type if not already present. |

No changes to: openclaw config, agents, anything outside the proxy repo.

### 4.2 Data flow (single tool round-trip)

```
[T0] openclaw sends OpenAI request:
     POST /chat/completions
     {
       model: "claude-opus-4-7",
       messages: [...],
       tools: [{type:"function", function:{name:"n8n__n8n_list_workflows", parameters:{...}}}, ...],
       tool_choice: "auto",
       stream: true
     }

[T1] claude-proxy receives. acquireSession() returns a worker.
     Before submitting the user turn, registers the tools with our
     embedded MCP server keyed by the conversation's session id:
       proxyMcp.registerForConversation(sessionId, tools)
     If the worker was warm and already had a different tool set,
     re-register (cheap — just a map update).

[T2] claude-proxy submits the user message in stream-json.
     The inner claude — which was spawned with --mcp-config pointing at
     our embedded MCP server — now sees `n8n__n8n_list_workflows` as a
     real callable tool.

[T3] Inner claude generates, decides to call the tool, emits
     stream-json `tool_use` event. The CLI forwards the call to our
     embedded MCP server.

[T4] proxyMcp receives the call. Stores a pending entry:
       pendingCalls.put({tool_call_id: "openai_call_<uuid>",
                         conversationId, toolName, args, deferred: Promise})
     Translates to an OpenAI streaming chunk:
       data: {"choices":[{"delta":{"tool_calls":[{"id":"openai_call_<uuid>",
              "type":"function","function":{"name":"...","arguments":"..."}}]}}]}\n\n
     Emits the chunk to openclaw. Then ends the SSE stream cleanly with
     finish_reason="tool_calls" and "data: [DONE]".

[T5] claude is now waiting for an MCP response. We do NOT terminate the
     subprocess — it stays warm for when the conversation continues.
     The pending call's deferred Promise is still unresolved.

[T6] openclaw dispatches the tool through its own machinery, then comes
     back with a follow-up request:
       POST /chat/completions
       {messages: [..., {role:"assistant", tool_calls:[...]},
                   {role:"tool", tool_call_id:"openai_call_<uuid>",
                    content:"<json result>"}]}

[T7] claude-proxy detects `role:tool` in the latest message. Looks up
     pending call by tool_call_id. Resolves the Promise with the
     tool_result. The MCP server returns the result to claude. Claude
     resumes generation.

[T8] Claude finishes, normal text response streams back to openclaw,
     done.
```

### 4.3 Detailed component design

**Embedded MCP server (`proxy-mcp-server.ts`):**

- Speaks the [Model Context Protocol](https://modelcontextprotocol.io) over stdio.
- Spawned as a child process per claude subprocess (or shared — see open question 1).
- Maintains an `EventEmitter` interface so `stream-json-manager` can intercept calls.
- Implements only `tools/list` and `tools/call` — bare minimum.
- For `tools/list`: returns the tools registered for the current conversation (looked up via env var passed at spawn time).
- For `tools/call`: emits a `pending` event with the call details, awaits its deferred Promise, returns the resolved result.

**Translation (`translate.ts`):**

```ts
export function openAiToolToMcpTool(t: OpenAITool): McpTool;
export function mcpToolCallToOpenAi(call: McpToolCall, callId: string): OpenAIToolCall;
export function openAiToolResultToMcp(msg: OpenAIToolMessage): McpToolResult;
```

Pure functions. Trivial unit tests.

Name-mangling: openclaw uses `<server>__<tool>` (e.g. `n8n__n8n_list_workflows`). Pass through unchanged — both sides accept it.

**Pending calls (`pending-calls.ts`):**

```ts
class PendingCallStore {
  pendingPut(callId: string, toolName: string, args: unknown): Deferred<unknown>
  resolve(callId: string, result: unknown): void
  cancel(callId: string, reason: string): void
  // TTL eviction: any unresolved call older than 10 min → cancel with timeout error
}
```

Keyed globally by `callId` (UUID). `callId` includes a random component so two conversations never collide.

**routes.ts changes:**

- Detect `body.tools` present → enable tools-mode flow.
- Register tools with the embedded MCP server before submitting the user turn.
- After submission, watch for stream-json `tool_use` events in the worker output. When seen:
  - Generate a fresh `callId`.
  - Create pending entry.
  - Emit OpenAI `tool_calls` chunk to client.
  - Emit `data: {…finish_reason: "tool_calls"}` and `[DONE]`.
  - End response. **Do NOT close the worker.**
  - Worker is now idle, waiting for the MCP server to return the tool_result.
- On the next request, detect `role:tool` messages. For each:
  - Look up pending call by `tool_call_id`.
  - Resolve its deferred with the `content` field.
- Continue the worker's stream until the next tool_use or final completion.

**stream-json-manager.ts changes:**

- `buildArgs`: add `--mcp-config <temp-file-path>`. The temp file is written per-spawn with content like:
  ```json
  {
    "mcpServers": {
      "openclaw_proxy": {
        "command": "node",
        "args": ["/abs/path/to/dist/tools/proxy-mcp-server.js"],
        "env": { "PROXY_MCP_SOCKET": "/tmp/claude-proxy-mcp-<pid>.sock" }
      }
    }
  }
  ```
- Track the temp file in `start()`, clean it up in `kill()`.

### 4.4 Edge cases and how each is handled

| Case | Handling |
|------|----------|
| Client sends `tools[]` but model doesn't call any | Worker finishes normally, no MCP traffic, no pending calls. |
| Model calls multiple tools in parallel (Anthropic supports this) | OpenAI also supports parallel `tool_calls`. We collect all tool_use events from the same assistant message before emitting one chunk with the full `tool_calls[]` array. End response after collecting them. |
| Model calls tool, openclaw never sends the result | Pending call TTL fires after 10 min → resolve with `{error: "timeout"}`. Worker continues with that result. Subprocess eventually goes idle, evicted by session-pool. |
| Client sends `role:tool` with `tool_call_id` we don't know | Either the proxy was restarted between turns, or the client has a bug. Return 400 with explanation. Don't try to recover. |
| Worker dies mid-turn while a tool call is pending | Cancel the pending call with "worker_died". Send error chunk to client. session-pool removes the worker. |
| Client streams (`stream:true`) vs non-stream | Both supported. Non-stream collects everything, returns one OpenAI response with `tool_calls`. Stream emits chunks as before, plus the tool_calls chunk before `[DONE]`. |
| Tool with very large result (>1MB) | Pass through — claude API handles large tool_results. We don't need to chunk. |
| Client sends `tool_choice: "none"` | Don't register the tools with our MCP server. Claude won't see them, won't call them. |
| Client sends `tool_choice: {type:"function", function:{name:"x"}}` | Forward to claude as `tool_choice: {type:"tool", name:"x"}`. |
| Inner claude's built-in tools (Bash, Read, etc.) | Untouched. They still work. Only openclaw-registered tools route through our embedded MCP. |
| `--print` mode | NOT supported in v1. Tools-mode requires the persistent stream-json subprocess. If a `--print` request includes `tools[]`, we either error or ignore the tools field with a warning. Lean toward ignoring for backward compatibility. |

### 4.5 Testing strategy

**Unit tests (`src/__tests__/`):**

- `tool-translate.test.ts`: every translation direction. Multi-tool calls. `tool_choice` variants. Edge cases: empty `parameters`, no `description`, weird names.
- `pending-calls.test.ts`: put/resolve/cancel happy path. TTL eviction. Concurrent puts. Resolving an unknown ID is a no-op.
- `proxy-mcp-server.test.ts`: spawns the embedded server, sends MCP `tools/list` and `tools/call`, validates response shape.

**Integration tests:**

- `e2e-tools.test.ts`: end-to-end with a mock claude subprocess that emits canned stream-json events, including a tool_use. Verify the SSE stream ends with `tool_calls` chunk and `finish_reason: "tool_calls"`. Then send a follow-up request with `role:tool`, verify the worker resumes and emits the final text.

**Live smoke tests (manual checklist before merge):**

1. Sevro: send a Telegram message asking her to list n8n workflows. Confirm she returns workflow names.
2. Sevro: trigger the `🤖 Debate Deep` workflow via `n8n_test_workflow`. Confirm the workflow runs.
3. Confirm openclaw's audit log shows the `n8n_*` tool calls (the whole point of Option B).
4. `openclaw gateway probe` healthy throughout.
5. `claude-proxy /metrics` shows `claude_proxy_requests_total{status="ok"}` incrementing.

### 4.6 Rollout

Behind a feature flag: `CLAUDE_PROXY_TOOLS_TRANSLATION=1`. Default off. When the env var is set, requests with `tools[]` go through the new translation path. When unset, requests with `tools[]` have the field stripped (current behavior). Lets the operator opt in per-LaunchAgent without code changes.

Once stable, flip default in a follow-up commit.

### 4.7 Rollback

The flag makes rollback a single env-var unset + LaunchAgent kickstart — same surface area as turning off stream-json mode. No data migration. No openclaw config change needed.

## 5. Open questions for the review

1. **One MCP server per claude subprocess, or one shared?** Per-subprocess is simpler (no cross-conversation interference) but spawns N more processes. Shared is more efficient but introduces a multiplexing layer. **My pick: per-subprocess.** The cost is ~5 MB / process, which we can afford given the session-pool cap of 4.
2. **What happens if openclaw doesn't actually round-trip with `role:tool`?** I.e. it expects the proxy to dispatch tools internally. If so, Option B fundamentally doesn't fit openclaw's model and we should pivot to Option A. **Need to confirm openclaw's dispatch model before implementing.** Action: check openclaw's `openai-completions` adapter to see whether it does round-trips or expects auto-execution.
3. **Should the temp `--mcp-config` file leak protection** (chmod 600, signed socket path) be in v1? **My pick: yes, chmod 600 + path-randomized socket. Cheap.**
4. **What about `--print` mode?** Tool-translation only works in stream-json mode (we need a persistent worker). If openclaw uses `--print` for some agents, those don't get tools. **My pick: hard-require stream-json when tools are present. Document it.**

## 6. Brutal-honesty pre-mortem

What's likely to go wrong:

- **The MCP stdio protocol is tighter than I'm describing.** I haven't actually read the wire format end-to-end. There's a real chance an Anthropic update breaks our embedded server. Mitigation: ship it behind the flag, monitor.
- **Stream-json's `tool_use` event semantics differ from what I'm assuming.** If the CLI doesn't expose tool_use in the output stream until *after* it's executed locally, Option B is impossible without writing our own claude SDK fork. Mitigation: prototype that single piece (intercept tool_use in stream-json) **first**, before implementing the rest. If it doesn't work, we pivot to Option A.
- **Pending-call lifecycle leaks.** If openclaw retries on its end and sends two `role:tool` for the same `tool_call_id`, or sends mismatched ones, we get into a wedged state. Mitigation: explicit resolve-once semantics with logged duplicate-resolve attempts.
- **Sevro is back online after a ton of yak-shaving today.** Do not regress her. Mitigation: behavior unchanged when the flag is off, and the flag default is off through this entire PR.
- **My estimate is probably off by 2x.** I said "~30 lines for Option A" and "Option B is significant." Realistic estimate for B: 800-1200 lines including tests. 1-2 days of focused work, not an afternoon.

## 7. What I want from the review

1. Confirm Option B is what you actually want, given the cost. Option A would solve the immediate Sevro problem in 10 minutes.
2. Sanity-check the data-flow diagram in §4.2 — especially the "end the SSE response cleanly with `finish_reason: tool_calls`, keep the worker alive" step. That's the cleverest part.
3. Tell me which of the four open questions in §5 you want to nail down before implementation.
4. Anything in the brutal pre-mortem (§6) you want me to mitigate up-front rather than punt to "we'll see."

When you're satisfied, say "go" and I'll implement, test, then come back with a brutally-honest self-review (what I actually built vs. what this plan said).
