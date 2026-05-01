/**
 * MCP governance — allow/deny policy for injected MCP servers and
 * overlapping tool names.
 *
 * Policy is configured via environment:
 *   CLAUDE_PROXY_MCP_ALLOW=server1,server2   — allow only these servers
 *   CLAUDE_PROXY_MCP_DENY=server3             — deny these servers (takes precedence)
 *
 * If neither is set, all openclaw.json servers are allowed (open policy).
 * If ALLOW is set, only listed servers are injected.
 * If DENY is set, listed servers are never injected.
 * DENY takes precedence over ALLOW.
 *
 * Overlapping tool names: when CLAUDE_PROXY_TOOLS_TRANSLATION=1 and a
 * caller-dispatched tool name overlaps with an MCP tool, the MCP tool
 * is blocked (via --disallowedTools) and a trace decision is recorded.
 */

import type { TraceMcpDecision } from "../trace/types.js";
import type { ResolvedMcpServer, SecretResolutionDecision } from "./openclaw-config.js";

export function parseList(envVar: string | undefined): Set<string> | null {
  if (!envVar) return null;
  const items = envVar.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? new Set(items) : null;
}

const allowSet = parseList(process.env.CLAUDE_PROXY_MCP_ALLOW);
const denySet = parseList(process.env.CLAUDE_PROXY_MCP_DENY);

/**
 * Apply allow/deny policy to a map of resolved MCP servers.
 * Returns the filtered map and a list of trace decisions.
 */
export function applyMcpPolicy(
  servers: Record<string, ResolvedMcpServer>,
): { allowed: Record<string, ResolvedMcpServer>; decisions: TraceMcpDecision[] } {
  const allowed: Record<string, ResolvedMcpServer> = {};
  const decisions: TraceMcpDecision[] = [];

  for (const [name, server] of Object.entries(servers)) {
    // DENY takes precedence
    if (denySet?.has(name)) {
      decisions.push({ server: name, action: "denied_by_policy", reason: "CLAUDE_PROXY_MCP_DENY" });
      continue;
    }

    // ALLOW filter: if set, only listed servers pass
    if (allowSet && !allowSet.has(name)) {
      decisions.push({ server: name, action: "skipped", reason: "not in CLAUDE_PROXY_MCP_ALLOW" });
      continue;
    }

    allowed[name] = server;
    decisions.push({ server: name, action: "loaded" });
  }

  return { allowed, decisions };
}

/**
 * Detect overlapping tool names between caller-dispatched tools and
 * MCP-injected tools. Returns trace decisions for each overlap.
 */
export function detectOverlappingTools(
  callerToolNames: string[],
  mcpServers: Record<string, ResolvedMcpServer>,
): TraceMcpDecision[] {
  if (callerToolNames.length === 0 || Object.keys(mcpServers).length === 0) return [];

  const callerSet = new Set(callerToolNames);
  const decisions: TraceMcpDecision[] = [];

  for (const serverName of Object.keys(mcpServers)) {
    // MCP tools surface as mcp__<server>__<tool>. If the caller dispatches
    // a tool whose name is <server>__<tool> or just <tool>, there's an
    // overlap risk. We record the detection; the actual blocking is done
    // via externalNativeToolDisallowList in tools.ts.
    const overlapping = callerToolNames.filter((name) => {
      // Direct overlap: caller tool name matches a potential MCP pattern
      if (name.startsWith(`${serverName}__`)) return true;
      // Reverse: MCP tool would shadow caller tool
      if (callerSet.has(`mcp__${serverName}__${name}`)) return true;
      return false;
    });

    if (overlapping.length > 0) {
      decisions.push({
        server: serverName,
        action: "overlapping_tool_blocked",
        reason: "caller-dispatched tool name overlaps MCP tool",
        tools: overlapping,
      });
    }
  }

  return decisions;
}

/**
 * Whether MCP injection is enabled and a warning should be logged.
 */
export function isMcpInjectionEnabled(): boolean {
  return process.env.CLAUDE_PROXY_TOOLS_TRANSLATION === "1";
}

/**
 * Apply allow/deny policy with explicit allow/deny sets (for testing).
 * Production callers use applyMcpPolicy() which reads from env at module load.
 */
export function applyMcpPolicyWithEnv(
  servers: Record<string, ResolvedMcpServer>,
  allow: Set<string> | null,
  deny: Set<string> | null,
): { allowed: Record<string, ResolvedMcpServer>; decisions: TraceMcpDecision[] } {
  const allowed: Record<string, ResolvedMcpServer> = {};
  const decisions: TraceMcpDecision[] = [];

  for (const [name, server] of Object.entries(servers)) {
    if (deny?.has(name)) {
      decisions.push({ server: name, action: "denied_by_policy", reason: "CLAUDE_PROXY_MCP_DENY" });
      continue;
    }
    if (allow && !allow.has(name)) {
      decisions.push({ server: name, action: "skipped", reason: "not in CLAUDE_PROXY_MCP_ALLOW" });
      continue;
    }
    allowed[name] = server;
    decisions.push({ server: name, action: "loaded" });
  }

  return { allowed, decisions };
}

/**
 * Convert secret resolution decisions to TraceMcpDecision records.
 */
export function secretDecisionsToTrace(decisions: SecretResolutionDecision[]): TraceMcpDecision[] {
  return decisions.map((d) => ({
    server: d.server,
    action: d.action,
    reason: d.reason,
    envKey: d.envKey,
  }));
}

/**
 * Emit a startup warning to stderr when MCP injection is enabled.
 * Called once at server boot.
 */
export function emitMcpInjectionWarning(): void {
  if (!isMcpInjectionEnabled()) return;
  const summary = mcpGovernanceSummary();
  console.warn(
    `[MCP_GOVERNANCE] ⚠ MCP injection enabled (CLAUDE_PROXY_TOOLS_TRANSLATION=1). ` +
    `Claude will execute injected MCP tools locally — openclaw's audit/approval path will NOT see those calls. ` +
    `Allow policy: ${summary.allowPolicy ? summary.allowPolicy.join(",") : "open (all servers)"}. ` +
    `Deny policy: ${summary.denyPolicy ? summary.denyPolicy.join(",") : "none"}.`,
  );
}

/**
 * Summary for logging/health endpoints.
 */
export function mcpGovernanceSummary(): {
  injectionEnabled: boolean;
  allowPolicy: string[] | null;
  denyPolicy: string[] | null;
} {
  return {
    injectionEnabled: isMcpInjectionEnabled(),
    allowPolicy: allowSet ? Array.from(allowSet) : null,
    denyPolicy: denySet ? Array.from(denySet) : null,
  };
}
