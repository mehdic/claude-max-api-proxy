/**
 * Read MCP-server registrations from openclaw.json (or any compatible JSON
 * file) and produce inline `--mcp-config` shape, with secret references
 * resolved via openclaw's own keychain resolver.
 *
 * Path precedence:
 *   1. CLAUDE_PROXY_OPENCLAW_CONFIG env var
 *   2. ~/.openclaw/openclaw.json
 * If the file doesn't exist or is malformed, returns an empty map and
 * logs once. The proxy degrades gracefully — env-var-only paths
 * (e.g. CLAUDE_PROXY_N8N_API_*) still work as a fallback.
 *
 * Secret resolution:
 * openclaw env values can be either plain strings or refs like
 *   { "source": "exec", "provider": "keychain", "id": "n8n/apiKey" }
 * The proxy invokes the resolver `cfg.secrets.providers.keychain.command`
 * with `{ids: [...]}` on stdin (matching openclaw's protocol — see
 * ~/.openclaw/bin/openclaw-secret-keychain-resolver.py) and substitutes
 * the returned values. Unresolved refs are dropped with a logged warning.
 */

import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { resolve } from "path";

interface SecretRef {
  source: "exec" | "env" | "file";
  provider?: string;
  id?: string;
}

type EnvValue = string | number | boolean | SecretRef;

interface OpenclawMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, EnvValue>;
}

interface OpenclawConfig {
  mcp?: { servers?: Record<string, OpenclawMcpServer> };
  secrets?: { providers?: Record<string, { source?: string; command?: string }> };
}

export interface ResolvedMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface SecretResolutionDecision {
  server: string;
  envKey: string;
  action: "secret_resolved" | "secret_unresolved";
  reason?: string;
}

const RESOLVER_TIMEOUT_MS = 5000;

/** Accumulated secret resolution decisions from last load — for trace/audit. */
let lastSecretDecisions: SecretResolutionDecision[] = [];

/** Return the secret resolution decisions from the most recent config load. */
export function getSecretResolutionDecisions(): SecretResolutionDecision[] {
  return lastSecretDecisions;
}

let cached: { servers: Record<string, ResolvedMcpServer>; loadedAt: number } | null = null;

function isSecretRef(v: unknown): v is SecretRef {
  return v !== null && typeof v === "object" && !Array.isArray(v) && "source" in (v as Record<string, unknown>);
}

function defaultConfigPath(): string {
  return process.env.CLAUDE_PROXY_OPENCLAW_CONFIG
    || resolve(homedir(), ".openclaw", "openclaw.json");
}

function callResolver(cmd: string, ids: string[]): Record<string, string> {
  try {
    const stdout = execSync(cmd, {
      input: JSON.stringify({ ids }),
      timeout: RESOLVER_TIMEOUT_MS,
      encoding: "utf-8",
    });
    const parsed = JSON.parse(stdout) as { values?: Record<string, string>; errors?: Record<string, unknown> };
    if (parsed.errors && Object.keys(parsed.errors).length > 0) {
      console.error("[openclaw-config] resolver returned errors:", parsed.errors);
    }
    return parsed.values || {};
  } catch (err) {
    console.error("[openclaw-config] resolver invocation failed:", err instanceof Error ? err.message : err);
    return {};
  }
}

/**
 * Read openclaw.json, extract mcp.servers, resolve secret refs, return a
 * normalized map. Cached for the proxy's lifetime — config changes
 * require a proxy restart, which matches openclaw's own hot-reload model
 * (mcp.servers changes are flagged as "requires gateway restart").
 */
export function loadOpenclawMcpServers(): Record<string, ResolvedMcpServer> {
  if (cached) return cached.servers;

  const path = defaultConfigPath();
  if (!existsSync(path)) {
    console.error(`[openclaw-config] not found: ${path} — skipping openclaw-config import`);
    cached = { servers: {}, loadedAt: Date.now() };
    return cached.servers;
  }

  let cfg: OpenclawConfig;
  try {
    cfg = JSON.parse(readFileSync(path, "utf-8")) as OpenclawConfig;
  } catch (err) {
    console.error(`[openclaw-config] failed to parse ${path}:`, err instanceof Error ? err.message : err);
    cached = { servers: {}, loadedAt: Date.now() };
    return cached.servers;
  }

  const servers = cfg.mcp?.servers || {};
  if (Object.keys(servers).length === 0) {
    cached = { servers: {}, loadedAt: Date.now() };
    return cached.servers;
  }

  // Collect every secret id we need; batch into one resolver call.
  const idsByProvider: Map<string, Set<string>> = new Map();
  for (const server of Object.values(servers)) {
    for (const value of Object.values(server.env || {})) {
      if (isSecretRef(value) && value.id) {
        const provider = value.provider || "keychain";
        if (!idsByProvider.has(provider)) idsByProvider.set(provider, new Set());
        idsByProvider.get(provider)!.add(value.id);
      }
    }
  }

  const resolved: Map<string, Record<string, string>> = new Map();
  for (const [provider, ids] of idsByProvider) {
    const providerCfg = cfg.secrets?.providers?.[provider];
    if (!providerCfg?.command) {
      console.error(`[openclaw-config] no resolver command for provider "${provider}", skipping ${ids.size} secret(s)`);
      continue;
    }
    resolved.set(provider, callResolver(providerCfg.command, [...ids]));
  }

  const out: Record<string, ResolvedMcpServer> = {};
  const secretDecisions: SecretResolutionDecision[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(server.env || {})) {
      if (typeof v === "string") {
        env[k] = v;
      } else if (typeof v === "number" || typeof v === "boolean") {
        env[k] = String(v);
      } else if (isSecretRef(v) && v.id) {
        const providerValues = resolved.get(v.provider || "keychain") || {};
        const value = providerValues[v.id];
        if (value !== undefined) {
          env[k] = value;
          secretDecisions.push({ server: name, envKey: k, action: "secret_resolved" });
        } else {
          console.error(`[openclaw-config] unresolved secret ${v.id} for ${name}.${k} — skipping`);
          secretDecisions.push({ server: name, envKey: k, action: "secret_unresolved", reason: `secret ${v.id} not resolved by provider ${v.provider || "keychain"}` });
        }
      }
    }
    out[name] = { command: server.command, args: server.args || [], env };
  }
  lastSecretDecisions = secretDecisions;

  console.error(`[openclaw-config] loaded ${Object.keys(out).length} MCP server(s) from ${path}`);
  cached = { servers: out, loadedAt: Date.now() };
  return out;
}

/** For tests: drop the cache so a subsequent load re-reads the file. */
export function _clearCacheForTesting(): void {
  cached = null;
  lastSecretDecisions = [];
}
