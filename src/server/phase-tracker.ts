/**
 * Phase Tracker
 *
 * Watches raw stream-json events from a Claude subprocess and derives
 * truthful progress descriptions for meaningful runtime phases:
 *
 *   - tool_use start  → "Bubbling...\n📖 Read" (real tool name from the event)
 *   - long tool wait   → "Bubbling...\n🛠️ Exec: npm test (in /repo) · 12s"
 *   - Agent tool       → "Bubbling...\n🧑🔧 Sub-agent: Sir Greps-a-Lot Subagent — inspect auth flow…"
 *                        (deterministic funny name + extracted activity)
 *   - thinking         → "Bubbling...\n🫧 Working: thinking…" (inferred: no tool/text activity
 *                        for ≥8s — conservative, fires once per silent period)
 *   - n8n progress     → delegated to the existing n8n progress module
 *
 * Does NOT fabricate status. Only reports what the event stream proves
 * (tool/text phases) or conservatively infers from silence (thinking).
 * Deduplicates: consecutive calls with the same phase return null.
 */

import type { EventEmitter } from "events";

/** Minimum silence (ms) before we report "waiting for tool result". */
const TOOL_WAIT_THRESHOLD_MS = 8_000;

/**
 * Short visible status prefixes. A random prefix is chosen only when a new
 * semantic phase is emitted; the phase body remains event-derived.
 */
export const STATUS_PREFIXES: readonly string[] = [
  "Thinking",
  "Tinkering",
  "Checking",
  "Reviewing",
  "Inspecting",
  "Tracing",
  "Working",
  "Reading",
  "Scanning",
  "Sorting",
  "Drafting",
  "Testing",
] as const;

const PROGRESS_HEADER = "Bubbling...";

function openClawToolKey(rawToolName: string | null): string {
  if (!rawToolName) return "working";
  const normalized = normalizeToolName(rawToolName);
  const lower = normalized.toLowerCase();
  if (lower === "bash" || lower === "shell" || lower === "exec") return "exec";
  if (lower === "read") return "read";
  if (lower === "write") return "write";
  if (lower === "edit" || lower === "multiedit") return "edit";
  if (lower === "websearch") return "web_search";
  if (lower === "webfetch") return "web_fetch";
  if (lower === "agent" || lower === "task") return "sessions_spawn";
  return normalized;
}

function toolIcon(rawToolName: string | null): string {
  const key = openClawToolKey(rawToolName).toLowerCase();
  if (key === "working") return "🫧";
  if (key === "exec") return "🛠️";
  if (key === "process") return "🧰";
  if (key === "read") return "📖";
  if (key === "write") return "✍️";
  if (key === "edit") return "📝";
  if (key === "browser") return "🌐";
  if (key === "sessions_spawn") return "🧑‍🔧";
  if (key === "memory_search") return "🧠";
  if (key === "memory_get") return "📓";
  if (key === "web_search") return "🔎";
  if (key === "web_fetch") return "📄";
  if (key.includes("openbrain") || key.includes("serena")) return "🧩";
  return "🧩";
}

function titleCaseToken(token: string): string {
  if (!token) return token;
  return token[0].toUpperCase() + token.slice(1);
}

function titleCaseToolAction(value: string): string {
  return value
    .split(/[_-]+/g)
    .filter(Boolean)
    .map(titleCaseToken)
    .join(" ");
}

function titleCaseNamespace(value: string): string {
  const normalized = value.toLowerCase().replace(/_/g, "-");
  if (normalized === "openbrain-local") return "Openbrain-local";
  return value
    .split(/[_-]+/g)
    .filter(Boolean)
    .map(titleCaseToken)
    .join(" ");
}

function displayToolTitle(rawToolName: string | null): string {
  if (!rawToolName) return "Working";
  const key = openClawToolKey(rawToolName);
  const mapped = displayName(key);
  if (mapped !== key) return mapped;
  const raw = key;
  const withoutMcpPrefix = raw.startsWith("mcp__") ? raw.slice("mcp__".length) : raw;
  const namespaceMatch = withoutMcpPrefix.match(/^([^_]+(?:-[^_]+)?)__(.+)$/);
  if (namespaceMatch?.[1] && namespaceMatch[2]) {
    const namespace = titleCaseNamespace(namespaceMatch[1]);
    const action = titleCaseToolAction(namespaceMatch[2]);
    return `${namespace} ${action}`.trim();
  }
  const withoutNamespace = raw.includes("__") ? raw.split("__").pop()! : raw;
  return titleCaseToolAction(withoutNamespace) || raw;
}

function renderProgress(rawToolName: string | null, body: string, options: { includeHeader?: boolean } = {}): string {
  const title = displayToolTitle(rawToolName);
  const line = body ? `${toolIcon(rawToolName)} ${title}: ${body}` : `${toolIcon(rawToolName)} ${title}`;
  return options.includeHeader === false ? line : `${PROGRESS_HEADER}\n${line}`;
}

/**
 * small so names feel familiar/recurring rather than random noise.
 */
const AGENT_NAMES: readonly string[] = [
  "Sir Greps-a-Lot",
  "Captain Patchwork",
  "The Lint Whisperer",
  "Baron von Stacktrace",
  "Sergeant Refactor",
  "Professor Typecheck",
  "The Merge Marshal",
  "Deputy Debugger",
] as const;

/**
 * Pick a deterministic funny name from a tool-call identifier string.
 * Uses a simple hash → modulo so the same call always gets the same name.
 */
export function agentNameFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return AGENT_NAMES[Math.abs(hash) % AGENT_NAMES.length];
}

/** Max display length for extracted activity text. */
const ACTIVITY_MAX_LEN = 60;

/**
 * to derive a short activity description.
 */
const ACTIVITY_FIELDS = ["description", "subagent_type", "prompt", "task", "instructions"] as const;

/**
 * Returns null if nothing usable is found.
 */
export function extractActivity(partialJson: string): string | null {
  // Try to parse accumulated JSON. If it's still partial, try extracting
  // field values via regex (the JSON may be incomplete mid-stream).
  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(partialJson);
  } catch {
    // Partial JSON — fall through to regex extraction.
  }

  if (obj && typeof obj === "object") {
    for (const field of ACTIVITY_FIELDS) {
      const val = obj[field];
      if (typeof val === "string" && val.trim()) {
        return sanitizeActivity(val);
      }
    }
    return null;
  }

  // Regex fallback for partial JSON: look for "field":"value" patterns.
  for (const field of ACTIVITY_FIELDS) {
    const re = new RegExp(`"${field}"\\s*:\\s*"([^"]{1,200})"`);
    const match = partialJson.match(re);
    if (match && match[1].trim()) {
      return sanitizeActivity(match[1]);
    }
  }
  return null;
}

/**
 * Sanitize an extracted activity string for display: single line, truncated,
 * no secrets or excessive content.
 */
export function sanitizeActivity(raw: string): string | null {
  // Collapse whitespace/newlines to single spaces.
  let clean = raw.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  // Strip anything that looks like a secret/token/path.
  clean = clean.replace(/(?:sk-|ghp_|gho_|Bearer )[^\s"]{6,}/g, "***");
  // Lowercase first char for flow (e.g. "— inspect auth flow…").
  if (clean.length > 0 && clean[0] === clean[0].toUpperCase() && clean[0] !== clean[0].toLowerCase()) {
    clean = clean[0].toLowerCase() + clean.slice(1);
  }
  if (clean.length > ACTIVITY_MAX_LEN) {
    clean = clean.slice(0, ACTIVITY_MAX_LEN - 1).trimEnd() + "\u2026";
  }
  return clean || null;
}

interface ToolInputSummary {
  command?: string;
  cwd?: string;
  query?: string;
  args?: Record<string, unknown>;
}

function safeJsonValue(partialJson: string, field: string): string | undefined {
  try {
    const obj = JSON.parse(partialJson) as Record<string, unknown>;
    const val = obj[field];
    return typeof val === "string" && val.trim() ? val.trim() : undefined;
  } catch {
    const re = new RegExp(`"${field}"\\s*:\\s*"([^"]{1,240})"`);
    const match = partialJson.match(re);
    return match?.[1]?.trim() || undefined;
  }
}

function parseToolArgs(partialJson: string): Record<string, unknown> | undefined {
  try {
    const obj = JSON.parse(partialJson) as Record<string, unknown>;
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : undefined;
  } catch {
    return undefined;
  }
}

function summarizeToolInput(rawToolName: string | null, partialJson: string): ToolInputSummary | null {
  if (!rawToolName || !partialJson) return null;
  const args = parseToolArgs(partialJson);
  const command = safeJsonValue(partialJson, "command");
  const cwd = safeJsonValue(partialJson, "cwd") || safeJsonValue(partialJson, "workdir");
  const query = safeJsonValue(partialJson, "query")
    || safeJsonValue(partialJson, "text")
    || safeJsonValue(partialJson, "path")
    || safeJsonValue(partialJson, "file_path")
    || safeJsonValue(partialJson, "relative_path")
    || safeJsonValue(partialJson, "substring_pattern")
    || safeJsonValue(partialJson, "pattern")
    || safeJsonValue(partialJson, "project")
    || safeJsonValue(partialJson, "url");
  const summary: ToolInputSummary = {};
  if (command) summary.command = sanitizeActivity(command) || undefined;
  if (cwd) summary.cwd = cwd;
  if (query) summary.query = sanitizeActivity(query) || undefined;
  if (args) summary.args = args;
  return Object.keys(summary).length > 0 ? summary : null;
}

function summaryKey(summary: ToolInputSummary | null): string {
  if (!summary) return "";
  return [summary.command, summary.cwd, summary.query, summary.args ? JSON.stringify(summary.args) : ""].filter(Boolean).join("|");
}

function compactOneLine(raw: string, maxLength = 120): string {
  const oneLine = raw.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

function openClawDetailFromSummary(rawToolName: string, summary: ToolInputSummary | null): string {
  const key = openClawToolKey(rawToolName).toLowerCase();
  const args = summary?.args ?? {};
  if (key === "exec") {
    const cwd = summary?.cwd ? ` (in ${summary.cwd})` : "";
    return summary?.command ? `${compactOneLine(summary.command)}${cwd}` : "";
  }
  if (key === "read") {
    const path = summary?.query;
    const offset = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.max(1, Math.floor(args.offset)) : undefined;
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : undefined;
    if (!path) return "";
    if (offset !== undefined && limit !== undefined) return `${limit === 1 ? "line" : "lines"} ${offset}-${offset + limit - 1} from ${path}`;
    if (offset !== undefined) return `from line ${offset} in ${path}`;
    if (limit !== undefined) return `first ${limit} ${limit === 1 ? "line" : "lines"} of ${path}`;
    return `from ${path}`;
  }
  if (key === "write" || key === "edit") {
    const path = summary?.query;
    const content = typeof args.content === "string" ? args.content : typeof args.newText === "string" ? args.newText : typeof args.new_string === "string" ? args.new_string : undefined;
    if (!path) return "";
    const destinationPrefix = key === "edit" ? "in" : "to";
    return content && content.length > 0 ? `${destinationPrefix} ${path} (${content.length} chars)` : `${destinationPrefix} ${path}`;
  }
  if (key === "web_search") {
    const query = summary?.query;
    const count = typeof args.count === "number" && Number.isFinite(args.count) && args.count > 0 ? Math.floor(args.count) : undefined;
    if (!query) return "";
    return count !== undefined ? `for "${query}" (top ${count})` : `for "${query}"`;
  }
  if (key === "web_fetch") {
    return summary?.query ? `from ${summary.query}` : "";
  }
  return summary?.query ? compactOneLine(summary.query) : "";
}

function renderToolAction(rawToolName: string, label: string, summary: ToolInputSummary | null, phase: "start" | "wait", secs?: number): string {
  if (rawToolName === "Agent") {
    if (phase === "wait") return `waiting for ${label}${secs ? `, ${secs}s` : ""}…`;
    return label;
  }
  const detail = openClawDetailFromSummary(rawToolName, summary);
  if (detail) return phase === "wait" && secs ? `${detail} · ${secs}s` : detail;
  return phase === "wait" && secs ? `${secs}s` : "";
}

/**
 */
function agentDisplayLabel(toolCallId: string, activity: string | null): string {
  const name = `${agentNameFor(toolCallId)} Subagent`;
  if (activity) {
    return `${name} \u2014 ${activity}`;
  }
  return name;
}

/**
 * Map raw Claude tool names to user-friendly display labels.
 * Agent is handled specially via agentDisplayLabel(); this map is for
 * simple static renames only.
 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  Bash: "Exec",
  bash: "Exec",
  shell: "Exec",
  exec: "Exec",
  read: "Read",
  write: "Write",
  edit: "Edit",
  sessions_spawn: "Sub-agent",
  memory_search: "Memory Search",
  openbrain_local__search_thoughts: "Openbrain-local Search Thoughts",
  "openbrain-local__search_thoughts": "Openbrain-local Search Thoughts",
  openbrain_local__capture_thought: "Openbrain-local Capture Thought",
  "openbrain-local__capture_thought": "Openbrain-local Capture Thought",
};

function normalizeToolName(rawToolName: string): string {
  return rawToolName.startsWith("mcp__") ? rawToolName.slice("mcp__".length) : rawToolName;
}

function displayName(rawToolName: string): string {
  const normalized = normalizeToolName(rawToolName);
  return TOOL_DISPLAY_NAMES[rawToolName] ?? TOOL_DISPLAY_NAMES[normalized] ?? rawToolName;
}

export interface PhaseSnapshot {
  /** Human-readable description of the current phase, or null if nothing new. */
  text: string;
  /** Monotonic phase key for dedup (same key ⇒ don't re-emit). */
  key: string;
}

export interface PhaseTracker {
  /**
   * Return a new progress snapshot if the phase has changed since the last
   * call. Returns null if nothing new to report (dedup).
   */
  poll(): PhaseSnapshot | null;
  detach(): void;
}

export function attachPhaseTracker(subprocess: EventEmitter): PhaseTracker {
  let currentPhase: string = "";        // key of the last reported phase
  let activeToolName: string | null = null;
  let activeToolCallId: string = "";     // id from content_block_start for Agent naming
  let toolStartedAt: number = 0;
  let toolWaitReported: boolean = false;
  let lastContentDeltaAt: number = 0;
  let progressGroupOpen: boolean = false;

  // Thinking phase: inferred silence while the main agent has no tool/text
  // activity. Fires once per silent period after the silence threshold.
  let lastActivityAt: number = Date.now();
  let thinkingReported: boolean = false;

  let agentInputBuffer: string = "";
  let agentActivity: string | null = null;
  let agentActivityExtracted: boolean = false;

  let toolInputBuffer: string = "";
  let toolInputSummary: ToolInputSummary | null = null;

  const onMessage = (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as {
      type?: string;
      event?: {
        type?: string;
        content_block?: { type?: string; name?: string; id?: string };
        delta?: { type?: string; partial_json?: string };
      };
    };
    if (m.type !== "stream_event") return;
    const ev = m.event;
    if (!ev) return;

    if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      activeToolName = ev.content_block.name || "unknown";
      activeToolCallId = ev.content_block.id || "";
      toolStartedAt = Date.now();
      toolWaitReported = false;
      lastActivityAt = Date.now();
      thinkingReported = true; // tool is now active — suppress thinking
      toolInputBuffer = "";
      toolInputSummary = null;
      // Reset Agent input accumulator.
      if (activeToolName === "Agent") {
        agentInputBuffer = "";
        agentActivity = null;
        agentActivityExtracted = false;
      } else {
        agentInputBuffer = "";
        agentActivity = null;
        agentActivityExtracted = true; // no extraction needed for non-Agent
      }
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
      const partial = ev.delta.partial_json || "";
      if (partial && activeToolName) {
        toolInputBuffer += partial;
        toolInputSummary = summarizeToolInput(activeToolName, toolInputBuffer) || toolInputSummary;
      }
      if (activeToolName === "Agent" && !agentActivityExtracted) {
        if (partial) {
          agentInputBuffer += partial;
          // Try to extract activity after we have some data (don't try on every tiny chunk).
          if (agentInputBuffer.length > 10) {
            const activity = extractActivity(agentInputBuffer);
            if (activity) {
              agentActivity = activity;
              agentActivityExtracted = true;
              // Clear buffer — we don't need more.
              agentInputBuffer = "";
            }
          }
        }
      }
    } else if (ev.type === "content_block_stop" && activeToolName) {
      // Tool input finished — claude is now executing/waiting for the tool result.
      // Last chance to extract activity from accumulated Agent input.
      if (activeToolName === "Agent" && !agentActivityExtracted && agentInputBuffer) {
        const activity = extractActivity(agentInputBuffer);
        if (activity) {
          agentActivity = activity;
        }
        agentActivityExtracted = true;
        agentInputBuffer = "";
      }
      toolInputSummary = summarizeToolInput(activeToolName, toolInputBuffer) || toolInputSummary;
      // Keep activeToolName set so the wait phase can fire.
    } else if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
      // Claude started a new text block — tool execution is over.
      progressGroupOpen = false;
      activeToolName = null;
      toolInputBuffer = "";
      toolInputSummary = null;
      toolWaitReported = false;
      lastActivityAt = Date.now();
      thinkingReported = true; // text is flowing — suppress thinking
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      lastContentDeltaAt = Date.now();
      progressGroupOpen = false;
      // Text flowing means no tool wait.
      activeToolName = null;
      toolInputBuffer = "";
      toolInputSummary = null;
      toolWaitReported = false;
      lastActivityAt = Date.now();
      thinkingReported = true; // text is flowing — suppress thinking
    }
  };

  subprocess.on("message", onMessage);

  /**
   * plus optional activity; other tools use the static display name.
   */
  const getToolLabel = (): string => {
    if (activeToolName === "Agent") {
      return agentDisplayLabel(activeToolCallId, agentActivity);
    }
    return displayToolTitle(activeToolName!);
  };

  const getToolPhaseKey = (): string => {
    const inputKey = summaryKey(toolInputSummary);
    if (activeToolName === "Agent") {
      return [agentActivity || "", inputKey].filter(Boolean).join(":");
    }
    return inputKey;
  };

  const renderGroupedProgress = (rawToolName: string | null, body: string): string => {
    const text = renderProgress(rawToolName, body, { includeHeader: !progressGroupOpen });
    progressGroupOpen = true;
    return text;
  };

  return {
    poll(): PhaseSnapshot | null {
      const now = Date.now();
      const label = activeToolName ? getToolLabel() : "";

      // Phase 1: tool_use start (or activity update for Agent).
      // Agent activity is included in the semantic key so that when activity is
      // extracted after the initial report, the phase naturally re-emits once.
      if (activeToolName && !toolWaitReported) {
        const key = `tool_use:${activeToolName}:${toolStartedAt}:${getToolPhaseKey()}`;
        if (key !== currentPhase) {
          currentPhase = key;
          return { text: renderGroupedProgress(activeToolName, renderToolAction(activeToolName, label, toolInputSummary, "start")), key };
        }
      }

      // Phase 2: tool wait exceeded threshold — report once.
      if (activeToolName && toolStartedAt > 0 && !toolWaitReported) {
        const elapsed = now - toolStartedAt;
        if (elapsed >= TOOL_WAIT_THRESHOLD_MS) {
          toolWaitReported = true;
          const key = `tool_wait:${activeToolName}:${toolStartedAt}`;
          if (key !== currentPhase) {
            currentPhase = key;
            const secs = Math.round(elapsed / 1000);
            return { text: renderGroupedProgress(activeToolName, renderToolAction(activeToolName, label, toolInputSummary, "wait", secs)), key };
          }
        }
      }

      // Phase 3: inferred thinking — main agent is silent with no tool active.
      // Conservative: fires once per silent period after the same 8s threshold.
      // Lower priority than tool phases; suppressed once text or tool activity appears.
      if (!activeToolName && !thinkingReported) {
        const silence = now - lastActivityAt;
        if (silence >= TOOL_WAIT_THRESHOLD_MS) {
          thinkingReported = true;
          const key = `thinking:${lastActivityAt}`;
          if (key !== currentPhase) {
            currentPhase = key;
            return { text: renderGroupedProgress(null, "thinking\u2026"), key };
          }
        }
      }

      return null;
    },

    detach() {
      subprocess.off("message", onMessage);
    },
  };
}
