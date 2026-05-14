/**
 * Composable external OpenAI/OpenClaw tool bridge.
 *
 * The proxy does not execute these tools. It teaches Claude Code about the
 * caller-dispatched external tool catalog, parses Claude's JSON tool request,
 * and returns OpenAI-compatible tool_calls so the caller (OpenClaw) dispatches
 * the tool under its own audit/approval/allowlist controls.
 */

import type { OpenAIChatMessage, OpenAIChatRequest, OpenAITool, OpenAIToolCall } from "../types/openai.js";

export interface ToolCallParseResult {
  toolCalls: OpenAIToolCall[];
  textContent: string;
  /** Structured parser diagnostics. No prompt/tool argument values. */
  diagnostics: ToolCallParseDiagnostics;
}

export interface ToolCallParseDiagnostics {
  /** Number of syntactically valid JSON objects scanned. */
  jsonObjects: number;
  /** Number of JSON-looking spans that could not be parsed. */
  malformedJsonObjects: number;
  /** Number of JSON objects that looked like tool calls but were not allowed/valid. */
  rejectedToolCalls: number;
  /** True when the output appeared to attempt a bridged tool call but none could be emitted. */
  attemptedToolCall: boolean;
}

const EMPTY_DIAGNOSTICS: ToolCallParseDiagnostics = {
  jsonObjects: 0,
  malformedJsonObjects: 0,
  rejectedToolCalls: 0,
  attemptedToolCall: false,
};

export function isSchemaStyleTool(tool: OpenAITool): boolean {
  const name = tool.function.name || "";
  if (name.includes("__")) return false;
  if (/^(get|fetch|search|query|list|read|write|update|delete|create)_/i.test(name)) return false;
  if (/^(get|fetch|search|query|list|read|write|update|delete|create)[A-Z]/.test(name)) return false;
  return true;
}

export function shouldBridgeExternalTools(req: Pick<OpenAIChatRequest, "tools" | "tool_choice">): boolean {
  const tools = (req.tools || []).filter((tool) => tool.type === "function" && tool.function?.name);
  if (tools.length === 0) return false;
  if (req.tool_choice === "none") return false;

  // A single schema-style synthetic function is usually a structured-output
  // call. Do not hijack it into the external caller-dispatched bridge.
  if ((req.tool_choice === "auto" || req.tool_choice === undefined) && tools.length === 1 && isSchemaStyleTool(tools[0])) {
    return false;
  }

  return true;
}

function allowedToolNames(req: Pick<OpenAIChatRequest, "tools" | "tool_choice">): Set<string> {
  const all = new Set((req.tools || []).filter((tool) => tool.type === "function").map((tool) => tool.function.name));
  const choice = req.tool_choice;
  if (choice && typeof choice === "object" && choice.type === "function") {
    return all.has(choice.function.name) ? new Set([choice.function.name]) : new Set();
  }
  return all;
}

function nativeMcpOverlapAllowSet(): Set<string> {
  const raw = process.env.CLAUDE_PROXY_ALLOW_NATIVE_MCP_OVERLAPS || "";
  return new Set(raw.split(",").map((part) => part.trim()).filter(Boolean));
}

function isNativeMcpOverlapAllowed(server: string): boolean {
  const allowed = nativeMcpOverlapAllowSet();
  return allowed.has("*") || allowed.has(server);
}

export function externalNativeToolDisallowList(req: Pick<OpenAIChatRequest, "tools" | "tool_choice">): string[] {
  if (!shouldBridgeExternalTools(req)) return [];
  const names = Array.from(allowedToolNames(req));
  const disallowed = new Set<string>();
  for (const name of names) {
    disallowed.add(name);
    const marker = name.indexOf("__");
    if (marker > 0) {
      const server = name.slice(0, marker);
      if (isNativeMcpOverlapAllowed(server)) continue;
      const tool = name.slice(marker + 2);
      disallowed.add(`mcp__${server}__${tool}`);
      disallowed.add(`mcp__${server}__${name}`);
    }
  }
  return Array.from(disallowed).sort();
}

export function toolDefsToPrompt(req: Pick<OpenAIChatRequest, "tools" | "tool_choice">): string {
  if (!shouldBridgeExternalTools(req)) return "";
  const allowed = allowedToolNames(req);
  const tools = (req.tools || [])
    .filter((tool) => allowed.has(tool.function.name))
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description || "",
      parameters: tool.function.parameters || { type: "object" },
    }));

  const nativeOverlapAllowed = nativeMcpOverlapAllowSet();
  const nativeOverlapNote = nativeOverlapAllowed.size > 0
    ? `Native MCP overlap allowlist is active for: ${Array.from(nativeOverlapAllowed).sort().join(", ")}. For these servers, you may use the native MCP/Claude Code tool directly when it is the better fit; otherwise return the JSON tool_call so the caller can dispatch it under its own audit and approval controls.`
    : "If a listed external tool resembles or overlaps a native MCP/Claude Code tool name, do NOT invoke the native tool for this request. Return the JSON tool_call so the caller can dispatch it under its own audit and approval controls.";

  const choice = req.tool_choice && typeof req.tool_choice === "object"
    ? `The caller explicitly requested external tool ${req.tool_choice.function.name}; use that external tool if a tool call is needed.`
    : req.tool_choice === "required"
      ? "The caller requires one external tool call. Choose the appropriate listed external tool."
      : "If no external tool is needed, answer normally and do not use the JSON tool_call shape.";

  return `<claude_proxy_openai_tools>
The following external OpenAI/OpenClaw tools are available in addition to your native Claude Code capabilities/tools.
These external tools are dispatched by the caller (for example OpenClaw); the proxy will not execute them for you.
${nativeOverlapNote}
To request one external tool, return ONLY a valid JSON object in this exact shape:
{"tool_call":{"name":"tool_name","arguments":{}}}
Use one of the external tool names listed below and fill arguments according to its schema.
Do not treat this bridge as replacing or disabling Claude Code native tools/capabilities. Use your native Claude Code capabilities whenever they are useful, and request an external OpenAI/OpenClaw tool only when the caller-dispatched tool is the right source or action.
If a <tool_result> is present, consume it to answer the user's request; do NOT repeat the same external tool call unless the user explicitly asks for another call.
${choice}
External tools:
${JSON.stringify(tools)}
</claude_proxy_openai_tools>`;
}

export function parseToolCalls(text: string, req: Pick<OpenAIChatRequest, "tools" | "tool_choice">): ToolCallParseResult {
  if (!shouldBridgeExternalTools(req)) return { toolCalls: [], textContent: text, diagnostics: { ...EMPTY_DIAGNOSTICS } };
  const allowed = allowedToolNames(req);
  const toolCalls: OpenAIToolCall[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const diagnostics: ToolCallParseDiagnostics = {
    jsonObjects: 0,
    malformedJsonObjects: countMalformedJsonObjectCandidates(text),
    rejectedToolCalls: 0,
    attemptedToolCall: /tool_call|"name"\s*:|"arguments"\s*:|"parameters"\s*:/i.test(text),
  };

  for (const found of iterJsonObjects(text)) {
    diagnostics.jsonObjects++;
    if (spans.some((span) => found.start >= span.start && found.end <= span.end)) continue;
    const candidate = found.value.tool_call && typeof found.value.tool_call === "object"
      ? found.value.tool_call
      : found.value;
    const call = candidate as Record<string, unknown>;
    if (typeof call.name !== "string") {
      if (looksLikeToolCallCandidate(found.value)) {
        diagnostics.rejectedToolCalls++;
        spans.push({ start: found.start, end: found.end });
      }
      continue;
    }
    diagnostics.attemptedToolCall = true;
    const toolName = normalizeRequestedToolName(call.name, allowed);
    if (!toolName) {
      diagnostics.rejectedToolCalls++;
      spans.push({ start: found.start, end: found.end });
      continue;
    }
    const rawArgs = call.arguments ?? call.parameters;
    const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? rawArgs as Record<string, unknown>
      : {};
    const id = typeof call.id === "string" && call.id ? call.id : `call_${randomId()}`;
    toolCalls.push({
      id,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify(args) },
    });
    spans.push({ start: found.start, end: found.end });
  }

  let textContent = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    textContent = textContent.slice(0, spans[i].start) + textContent.slice(spans[i].end);
  }
  textContent = textContent
    .replace(/```(?:json)?\s*```/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { toolCalls, textContent, diagnostics };
}

export function toolResultToPrompt(msg: OpenAIChatMessage): string {
  const name = msg.name || msg.tool_call_id || "unknown_tool";
  const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
  return `<tool_result name="${escapeXmlAttribute(name)}" tool_call_id="${escapeXmlAttribute(msg.tool_call_id || "")}">\n${content}\n</tool_result>`;
}

export function assistantToolCallsToPrompt(msg: OpenAIChatMessage): string {
  if (!msg.tool_calls?.length) return "";
  return msg.tool_calls.map((tc) => {
    const args = tc.function.arguments || "{}";
    return `{"tool_call":{"id":"${escapeJsonString(tc.id)}","name":"${escapeJsonString(tc.function.name)}","arguments":${args}}}`;
  }).join("\n");
}

export function iterJsonObjects(text: string): Array<{ value: Record<string, unknown>; start: number; end: number }> {
  const out: Array<{ value: Record<string, unknown>; start: number; end: number }> = [];
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\" && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          const raw = text.slice(start, i + 1);
          try {
            const value = JSON.parse(stripJsonFence(raw));
            if (value && typeof value === "object" && !Array.isArray(value)) out.push({ value, start, end: i + 1 });
          } catch {
            // keep scanning
          }
          break;
        }
      }
    }
  }
  return out;
}


function looksLikeToolCallCandidate(value: Record<string, unknown>): boolean {
  if (value.tool_call !== undefined) return true;
  return value.name !== undefined && (value.arguments !== undefined || value.parameters !== undefined);
}

function countMalformedJsonObjectCandidates(text: string): number {
  if (!/tool_call|"name"\s*:|"arguments"\s*:|"parameters"\s*:/i.test(text)) return 0;
  const opens = (text.match(/\{/g) || []).length;
  const closes = (text.match(/\}/g) || []).length;
  if (opens > closes) return 1;

  let malformed = 0;
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```|\{[\s\S]*?\}/gi)) {
    const candidate = (match[1] || match[0]).trim();
    if (!/tool_call|"name"\s*:|"arguments"\s*:|"parameters"\s*:/i.test(candidate)) continue;
    try {
      JSON.parse(stripJsonFence(candidate));
    } catch {
      malformed++;
    }
  }
  return malformed;
}

function normalizeRequestedToolName(name: string, allowed: Set<string>): string | null {
  if (allowed.has(name)) return name;
  if (name.startsWith("mcp__")) {
    const withoutPrefix = name.replace(/^mcp__[^_]+__/, "");
    const server = name.match(/^mcp__([^_]+)__/i)?.[1];
    const openClawStyle = server ? `${server}__${withoutPrefix}` : withoutPrefix;
    if (allowed.has(openClawStyle)) return openClawStyle;
    if (allowed.has(withoutPrefix)) return withoutPrefix;
  }
  return null;
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeJsonString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

let callCounter = 0;
function randomId(): string {
  callCounter++;
  return `${Date.now().toString(36)}_${callCounter.toString(36)}`;
}
