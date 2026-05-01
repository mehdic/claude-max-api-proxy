/**
 * Stream-JSON Persistent Subprocess
 *
 * Uses claude `--input-format stream-json --output-format stream-json` so the
 * subprocess stays alive across multiple turns. This unlocks Anthropic prompt
 * caching of conversation history — turn N reads turn N-1's prefix from cache
 * (verified empirically: 70K tokens cache_read on turn 2 within same process).
 *
 * Protocol (reverse-engineered from @anthropic-ai/claude-agent-sdk-python):
 *   1. Send NDJSON `control_request` { subtype: "initialize", excludeDynamicSections: true }
 *   2. Wait for matching `control_response` { request_id, subtype: "success" }
 *   3. Send NDJSON user messages: { type: "user", message: { role, content }, parent_tool_use_id: null, session_id: "" }
 *   4. Listen for `result` events for each turn
 *   5. Multi-turn: keep stdin open and send more user messages
 *   6. End: close stdin
 *
 * The protocol is officially undocumented (Anthropic issue #24594 closed as
 * not-planned). Reverse-engineered from the public Python SDK; format may
 * shift between claude CLI releases — this is gated behind CLAUDE_PROXY_STREAM_JSON=1.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import type {
  ClaudeCliMessage,
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import type { SubprocessSnapshot } from "../server/watchdog.js";
import { isAssistantMessage, isResultMessage, isContentDelta } from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
import { getSecretResolutionDecisions, loadOpenclawMcpServers, type ResolvedMcpServer } from "../mcp/openclaw-config.js";
import { applyMcpPolicy, secretDecisionsToTrace } from "../mcp/governance.js";
import type { TraceMcpDecision } from "../trace/types.js";
import { parseStreamJsonLine } from "./stream-json-parser.js";
import { pushClaudeFlagIfSupported } from "./claude-flags.js";

const INIT_TIMEOUT_MS = 30000;
const TURN_TIMEOUT_MS = 900000;

/** MCP governance decisions from the last buildOptionAMcpServers() call. */
let lastMcpDecisions: TraceMcpDecision[] = [];

/** Retrieve the MCP governance decisions from the most recent spawn. */
export function getLastMcpDecisions(): TraceMcpDecision[] {
  return lastMcpDecisions;
}

/**
 * Option A MCP-server registry for `--mcp-config` injection.
 *
 * When CLAUDE_PROXY_TOOLS_TRANSLATION=1 the inner claude CLI is spawned
 * with these MCP servers registered, so the model sees them as
 * `mcp__<server>__<tool>` and can invoke them natively.
 *
 * Sources, in priority order (later overrides earlier on name conflict):
 *   1. openclaw.json's `mcp.servers` section, with secret refs resolved
 *      via openclaw's own keychain resolver.
 *   2. Direct env vars (legacy, kept for the n8n case).
 *
 * The server set is filtered through MCP governance policy
 * (CLAUDE_PROXY_MCP_ALLOW / CLAUDE_PROXY_MCP_DENY) before injection.
 */
function buildOptionAMcpServers(): Record<string, ResolvedMcpServer> {
  const raw: Record<string, ResolvedMcpServer> = { ...loadOpenclawMcpServers() };

  // Legacy/fallback: env-var-driven n8n, only if not already set from openclaw.json.
  if (!raw.n8n && process.env.CLAUDE_PROXY_N8N_API_URL && process.env.CLAUDE_PROXY_N8N_API_KEY) {
    raw.n8n = {
      command: process.env.CLAUDE_PROXY_N8N_MCP_BIN
        || "n8n-mcp",
      args: [],
      env: {
        N8N_API_URL: process.env.CLAUDE_PROXY_N8N_API_URL,
        N8N_API_KEY: process.env.CLAUDE_PROXY_N8N_API_KEY,
        MCP_MODE: "stdio",
      },
    };
  }

  // Apply allow/deny governance policy
  const { allowed, decisions } = applyMcpPolicy(raw);
  const secretDecisions = secretDecisionsToTrace(getSecretResolutionDecisions());
  lastMcpDecisions = [...secretDecisions, ...decisions];

  if (lastMcpDecisions.some((d) => d.action !== "loaded" && d.action !== "secret_resolved")) {
    console.error(`[MCP governance] ${lastMcpDecisions.filter((d) => d.action !== "loaded" && d.action !== "secret_resolved").map((d) => `${d.server}:${d.action}`).join(", ")}`);
  }

  return allowed;
}

export interface StreamJsonOptions {
  model: ClaudeModel;
  cwd?: string;
  /** Per-process native Claude tool deny-list. Used for MCP overlap safety. */
  disallowedTools?: string[];
}

export class StreamJsonSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = "";
  private isKilled: boolean = false;
  private initialized: boolean = false;
  private pendingControl: Map<string, (response: unknown) => void> = new Map();
  private spawnedAt: number = 0;
  private model: ClaudeModel | null = null;
  private turnInFlight: boolean = false;
  private lastProcessActivityAt: number = 0;
  private processActivityCount: number = 0;
  private mcpDecisions: TraceMcpDecision[] = [];

  /** Spawn the subprocess and complete the initialize handshake. */
  async start(options: StreamJsonOptions): Promise<void> {
    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model", options.model,
      "--no-session-persistence",
    ];
    // This Claude CLI flag has existed in some builds and disappeared in
    // others. Capability-detect it before use so a CLI update cannot break the
    // whole persistent runtime at spawn time.
    await pushClaudeFlagIfSupported(args, "--exclude-dynamic-system-prompt-sections", {
      requested: process.env.CLAUDE_PROXY_EXCLUDE_DYNAMIC_SYSTEM_PROMPT_SECTIONS === "1",
    });
    if (process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS === "true") {
      args.push("--dangerously-skip-permissions");
    }

    // Option A: register openclaw-known MCP servers with the inner claude
    // CLI via --mcp-config inline JSON. Gated on
    // CLAUDE_PROXY_TOOLS_TRANSLATION=1. Currently only the n8n MCP server
    // is supported; new servers can be added here when their env vars are
    // present. The CLI executes these tools internally — openclaw's audit
    // and approval do NOT see these calls. Documented trade-off; see
    // README "Tools translation modes".
    if (process.env.CLAUDE_PROXY_TOOLS_TRANSLATION === "1") {
      console.error("[MCP] WARNING: CLAUDE_PROXY_TOOLS_TRANSLATION=1 — inner Claude CLI will execute MCP tools directly. OpenClaw audit/approval is bypassed for injected tools.");
      const mcpServers = buildOptionAMcpServers();
      this.mcpDecisions = [...lastMcpDecisions];
      if (Object.keys(mcpServers).length > 0) {
        args.push("--mcp-config", JSON.stringify({ mcpServers }));
      }
    } else {
      this.mcpDecisions = [];
    }

    if (options.disallowedTools && options.disallowedTools.length > 0) {
      args.push("--disallowedTools", options.disallowedTools.join(","));
    }

    this.model = options.model;

    return new Promise((resolve, reject) => {
      this.process = spawn("claude", args, {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, OPENCLAW_PROXY: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.spawnedAt = Date.now();

      this.process.on("error", (err) => {
        if (err.message.includes("ENOENT")) {
          reject(new Error("Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"));
        } else {
          reject(err);
        }
      });

      this.process.stdout?.on("data", (chunk: Buffer) => {
        this.markProcessActivity();
        this.buffer += chunk.toString();
        this.processBuffer();
      });

      this.process.stderr?.on("data", (chunk: Buffer) => {
        this.markProcessActivity();
        const text = chunk.toString().trim();
        if (text) console.error("[StreamJson stderr]:", text.slice(0, 200));
      });

      this.process.on("close", (code) => {
        if (this.buffer.trim()) this.processBuffer();
        this.emit("close", code);
        // Reject any pending control requests
        for (const cb of this.pendingControl.values()) {
          cb(new Error(`subprocess closed with code ${code}`));
        }
        this.pendingControl.clear();
      });

      this.process.once("spawn", () => {
        this.markProcessActivity();
        console.error(`[StreamJson] Spawned PID ${this.process?.pid} for ${options.model}`);
        // Send initialize handshake.
        this.sendInit().then(resolve).catch(reject);
      });
    });
  }

  private async sendInit(): Promise<void> {
    const requestId = `req_init_${randomUUID().slice(0, 8)}`;
    const initRequest = {
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "initialize",
        hooks: null,
        excludeDynamicSections: true,
      },
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId);
        reject(new Error(`init handshake timed out after ${INIT_TIMEOUT_MS}ms`));
      }, INIT_TIMEOUT_MS);

      this.pendingControl.set(requestId, (response) => {
        clearTimeout(timer);
        if (response instanceof Error) reject(response);
        else {
          this.initialized = true;
          resolve();
        }
      });

      this.writeLine(initRequest);
    });
  }

  /**
   * Send a user message and wait for the matching `result` event. Caller
   * receives `assistant`, `content_delta`, `result` events on this emitter.
   * Returns when the result arrives.
   */
  async submitTurn(userText: string): Promise<ClaudeCliResult> {
    if (!this.initialized) throw new Error("subprocess not initialized");
    if (this.turnInFlight) throw new Error("turn already in flight");
    if (this.isKilled || this.process?.exitCode !== null) {
      throw new Error("subprocess is dead");
    }

    this.turnInFlight = true;

    const userMsg = {
      type: "user",
      session_id: "",
      message: { role: "user", content: userText },
      parent_tool_use_id: null,
    };

    return new Promise<ClaudeCliResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnInFlight = false;
        reject(new Error(`turn timed out after ${TURN_TIMEOUT_MS}ms`));
      }, TURN_TIMEOUT_MS);

      const onResult = (result: ClaudeCliResult) => {
        clearTimeout(timer);
        this.turnInFlight = false;
        this.off("result", onResult);
        this.off("close", onClose);
        resolve(result);
      };
      const onClose = () => {
        clearTimeout(timer);
        this.turnInFlight = false;
        this.off("result", onResult);
        this.off("close", onClose);
        reject(new Error("subprocess closed before result"));
      };

      this.on("result", onResult);
      this.on("close", onClose);

      try {
        this.writeLine(userMsg);
      } catch (err) {
        clearTimeout(timer);
        this.turnInFlight = false;
        this.off("result", onResult);
        this.off("close", onClose);
        reject(err);
      }
    });
  }

  private writeLine(obj: unknown): void {
    if (!this.process?.stdin || this.process.stdin.destroyed || this.process.stdin.writableEnded) {
      throw new Error("stdin not writable");
    }
    this.process.stdin.write(JSON.stringify(obj) + "\n");
    this.markProcessActivity();
  }

  private markProcessActivity(): void {
    this.lastProcessActivityAt = Date.now();
    this.processActivityCount++;
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseStreamJsonLine(trimmed);
      if (parsed.kind === "empty") continue;
      if (parsed.kind === "malformed") {
        this.emit("raw", parsed.raw);
        continue;
      }

      if (parsed.kind === "control_response") {
        const cr = parsed.value;
        const reqId = cr.response?.request_id;
        const cb = this.pendingControl.get(reqId);
        if (cb) {
          this.pendingControl.delete(reqId);
          if (cr.response.subtype === "error") cb(new Error(cr.response.error || "control error"));
          else cb(cr.response);
        }
        continue;
      }

      this.emit("message", parsed.value as ClaudeCliMessage);
      const m = parsed.value as ClaudeCliMessage;
      if (isContentDelta(m)) this.emit("content_delta", m as ClaudeCliStreamEvent);
      else if (isAssistantMessage(m)) this.emit("assistant", m as ClaudeCliAssistant);
      else if (isResultMessage(m)) this.emit("result", m as ClaudeCliResult);
    }
  }

  /** Politely close stdin so claude exits after current turn. */
  endInput(): void {
    if (this.process?.stdin && !this.process.stdin.destroyed) {
      this.process.stdin.end();
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.process && !this.isKilled) {
      this.isKilled = true;
      this.process.kill(signal);
    }
  }

  isHealthy(): boolean {
    return (
      this.process !== null &&
      !this.isKilled &&
      this.process.exitCode === null &&
      this.initialized &&
      !this.turnInFlight
    );
  }

  getModel(): ClaudeModel | null {
    return this.model;
  }

  getMcpDecisions(): TraceMcpDecision[] {
    return [...this.mcpDecisions];
  }

  getAge(): number {
    return this.spawnedAt ? Date.now() - this.spawnedAt : 0;
  }

  /**
   * Return a safe, serializable snapshot of subprocess health for watchdog
   * diagnostics. No secrets, no circular refs.
   */
  snapshot(): SubprocessSnapshot {
    const now = Date.now();
    return {
      pid: this.process?.pid,
      exitCode: this.process?.exitCode ?? null,
      signalCode: this.process?.signalCode ?? null,
      killed: this.isKilled,
      stdinDestroyed: this.process?.stdin?.destroyed ?? true,
      stdinWritableEnded: this.process?.stdin?.writableEnded ?? true,
      stdoutReadable: this.process?.stdout?.readable ?? false,
      stdoutDestroyed: this.process?.stdout?.destroyed ?? true,
      stderrReadable: this.process?.stderr?.readable ?? false,
      stderrDestroyed: this.process?.stderr?.destroyed ?? true,
      initialized: this.initialized,
      turnInFlight: this.turnInFlight,
      ageMs: this.getAge(),
      lastProcessActivityAgeMs: this.lastProcessActivityAt ? now - this.lastProcessActivityAt : null,
      processActivityCount: this.processActivityCount,
    };
  }
}
