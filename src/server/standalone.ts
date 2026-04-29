#!/usr/bin/env node
/**
 * Standalone server for testing without Clawdbot
 *
 * Usage:
 *   npm run start
 *   # or
 *   node dist/server/standalone.js [port]
 */

import { startServer, stopServer } from "./index.js";
import { verifyClaude, verifyAuth } from "../subprocess/manager.js";
import { preWarm } from "../subprocess/init-pool.js";
import { defaultRuntime } from "../subprocess/runtime.js";

const DEFAULT_PORT = 3456;

async function main(): Promise<void> {
  console.log("Claude Code CLI Provider - Standalone Server");
  console.log("============================================\n");

  // Resolve port. Precedence: CLI arg > CLAUDE_PROXY_PORT env > DEFAULT_PORT.
  // CLI arg wins so an existing LaunchAgent that pins the port via
  // ProgramArguments still works; env-only setups can leave argv empty and
  // just set CLAUDE_PROXY_PORT in EnvironmentVariables.
  const portSource = process.argv[2] || process.env.CLAUDE_PROXY_PORT || String(DEFAULT_PORT);
  const port = parseInt(portSource, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${portSource}`);
    process.exit(1);
  }

  // Verify Claude CLI
  console.log("Checking Claude CLI...");
  const cliCheck = await verifyClaude();
  if (!cliCheck.ok) {
    console.error(`Error: ${cliCheck.error}`);
    process.exit(1);
  }
  console.log(`  Claude CLI: ${cliCheck.version || "OK"}`);

  // Verify authentication
  console.log("Checking authentication...");
  const authCheck = await verifyAuth();
  if (!authCheck.ok) {
    console.error(`Error: ${authCheck.error}`);
    console.error("Please run: claude auth login");
    process.exit(1);
  }
  console.log("  Authentication: OK\n");

  // Start server
  try {
    await startServer({ port });
    // Pre-warm the stream-json init-pool when that mode is the default. Each
    // model gets one already-initialized subprocess so first conversations
    // skip the ~5s init handshake. No-op when default runtime is "print".
    if (defaultRuntime() === "stream-json") {
      const models = (process.env.CLAUDE_PROXY_PREWARM_MODELS || "claude-opus-4-7,claude-sonnet-4-6,claude-haiku-4-5-20251001")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      console.log(`[init-pool] Pre-warming ${models.length} model(s) in background...`);
      preWarm(models);
    }

    console.log("\nServer ready. Test with:");
    console.log(`  curl -X POST http://localhost:${port}/v1/chat/completions \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"model": "claude-sonnet-4", "messages": [{"role": "user", "content": "Hello!"}]}'`);
    console.log("\nPress Ctrl+C to stop.\n");
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    await stopServer();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
