import dotenv from 'dotenv';
dotenv.config(); // Load .env BEFORE any module reads process.env

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { getOrCreateSubject } from "./tools.js";
import { maybeStartPromotionLoop } from "./promotion.js";
import fs from 'fs';

export let connectedClient: { name: string, version: string } | null = null;

const server = new McpServer({
  name: "mcp-agents-memory",
  version: "0.6.0",
}, {
  instructions: `This server provides long-term memory and autonomous context management.
- ALWAYS call 'memory_startup' once at the beginning of a session to load user profile and recent state.
- Use 'memory_search' before answering questions that might rely on past interactions or preferences.
- Use 'memory_add' to store new atomic facts, decisions, or project updates discovered during the conversation.
- If multiple conflicting facts are found (status: 'contested'), ask the user for clarification.`
});

// We'll intercept the connection to get client info
const originalConnect = server.connect.bind(server);
server.connect = async (transport: any) => {
  // The SDK doesn't expose the initialize params easily, 
  // but we can try to infer from the environment or transport if needed.
  // For now, we'll look for standard environment signals.
  console.error("🚀 Memory server starting connection...");
  return originalConnect(transport);
};

// Register all memory tools with enriched descriptions
registerTools(server);

async function main() {
  console.error("🚀 Starting Memory MCP Server...");

  // ENV CHECK
  if (process.env.SSH_ENABLED === 'true' && !process.env.SSH_KEY_PATH) {
    throw new Error("❌ SSH_KEY_PATH is required when SSH is enabled");
  }
  if (process.env.SSH_KEY_PATH && !fs.existsSync(process.env.SSH_KEY_PATH)) {
    console.error(`⚠️ [WARNING] SSH key not found at: ${process.env.SSH_KEY_PATH}`);
  }

  try {
    // 1. Connect stdio immediately so Claude Code does not fail SessionStart hook
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("🧠 Memory MCP Server (v0.5.0) running on stdio — Librarian Engine Active");

    // 2. Initialize DB asynchronously in the background
    db.connect().then(() => {
      console.error("✅ Database connected in background.");
      if (process.env.AGENT_KEY) {
        getOrCreateSubject(process.env.AGENT_KEY, 'agent').then(() => {
          console.error(`🤖 Agent registered: ${process.env.AGENT_KEY}`);
        }).catch(err => console.error("Failed to register agent:", err));
      }
    }).catch(err => {
      console.error("❌ Background DB connection failed:", err);
    });

  } catch (err) {
    console.error("❌ Fatal error during startup:", err);
    process.exit(1);
  }
}

main().catch(console.error);
maybeStartPromotionLoop();
