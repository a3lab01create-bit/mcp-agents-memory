#!/usr/bin/env node
// db.ts handles env loading via loadEnv() at module-import time —
// importing it first guarantees envs are populated before anything else reads them.
import { db } from "./db.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools, getOrCreateSubject } from "./tools.js";
import { maybeStartPromotionLoop, stopPromotionLoop } from "./promotion.js";
import { maybeStartForgettingLoop, stopForgettingLoop } from "./forgetting.js";
import { PACKAGE_VERSION } from "./version.js";
import fs from "fs";

export let connectedClient: { name: string, version: string } | null = null;

let isShuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`🛑 Shutting down (${reason})...`);

  try { stopPromotionLoop(); } catch {}
  try { stopForgettingLoop(); } catch {}

  try {
    await Promise.race([
      db.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch (err) {
    console.error("Error during shutdown:", err);
  }

  process.exit(0);
}

function installShutdownHandlers(): void {
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGHUP", () => { void shutdown("SIGHUP"); });

  // Parent closing stdin = parent process died (MCP stdio convention).
  // Without this, an orphaned tunnel-ssh socket keeps the event loop alive forever.
  process.stdin.on("end", () => { void shutdown("stdin-end"); });
  process.stdin.on("close", () => { void shutdown("stdin-close"); });
}

function printHelp() {
  console.log(`mcp-agents-memory v${PACKAGE_VERSION}

Usage:
  mcp-agents-memory             Run the MCP server (stdio).
  mcp-agents-memory setup       Interactive setup — write config to ~/.config/mcp-agents-memory/.env and run migrations.
  mcp-agents-memory setup-hook  Install Claude Code SessionEnd auto-save hook (writes settings.json).
  mcp-agents-memory migrate     Apply any pending DB migrations against the configured database.
  mcp-agents-memory help        Show this message.

Configuration is loaded from (first hit wins):
  $MEMORY_CONFIG_PATH > ./.env > ~/.config/mcp-agents-memory/.env > <package>/../.env

Required settings:
  DATABASE_URL=postgres://user:pass@host:5432/db?sslmode=require   (or DB_HOST + DB_USER + DB_PASS + DB_NAME)
  OPENAI_API_KEY=sk-...                                            (semantic search + Librarian fact extraction)`);
}

async function runMcpServer() {
  const server = new McpServer({
    name: "mcp-agents-memory",
    version: PACKAGE_VERSION,
  }, {
    instructions: `This server provides long-term memory and autonomous context management.
- ALWAYS call 'memory_startup' once at the beginning of a session to load user profile and recent state.
- Use 'memory_search' before answering questions that might rely on past interactions or preferences.
- Use 'memory_add' to store new atomic facts, decisions, or project updates discovered during the conversation.
- If multiple conflicting facts are found (status: 'contested'), ask the user for clarification.`,
  });

  const originalConnect = server.connect.bind(server);
  server.connect = async (transport: any) => {
    console.error("🚀 Memory server starting connection...");
    return originalConnect(transport);
  };

  registerTools(server);

  installShutdownHandlers();

  console.error("🚀 Starting Memory MCP Server...");

  if (process.env.SSH_ENABLED === "true" && !process.env.SSH_KEY_PATH) {
    throw new Error("❌ SSH_KEY_PATH is required when SSH is enabled");
  }
  if (process.env.SSH_KEY_PATH && !fs.existsSync(process.env.SSH_KEY_PATH)) {
    console.error(`⚠️ [WARNING] SSH key not found at: ${process.env.SSH_KEY_PATH}`);
  }

  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`🧠 Memory MCP Server (v${PACKAGE_VERSION}) running on stdio — Librarian Engine Active`);

    db.connect().then(() => {
      console.error("✅ Database connected in background.");
      if (process.env.AGENT_KEY) {
        getOrCreateSubject(process.env.AGENT_KEY, "agent").then(() => {
          console.error(`🤖 Agent registered: ${process.env.AGENT_KEY}`);
        }).catch((err) => console.error("Failed to register agent:", err));
      }
    }).catch((err) => {
      console.error("❌ Background DB connection failed:", err);
      console.error("   Run `mcp-agents-memory setup` if this is a fresh install.");
    });
  } catch (err) {
    console.error("❌ Fatal error during startup:", err);
    process.exit(1);
  }

  maybeStartPromotionLoop();
  maybeStartForgettingLoop();
}

async function cli() {
  const cmd = process.argv[2];

  if (!cmd || cmd === "serve") {
    return runMcpServer();
  }

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(PACKAGE_VERSION);
    return;
  }

  if (cmd === "setup") {
    const { runSetupWizard } = await import("./setup.js");
    await runSetupWizard();
    process.exit(0);
  }

  if (cmd === "setup-hook") {
    const { runSetupHookWizard } = await import("./setup_hook.js");
    await runSetupHookWizard();
    process.exit(0);
  }

  if (cmd === "migrate") {
    const { runAllMigrations } = await import("./migrations/runner.js");
    await runAllMigrations();
    process.exit(0);
  }

  console.error(`❌ Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

cli().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
