import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { getOrCreateSubject } from "./tools.js";
import fs from 'fs';

const server = new McpServer({
  name: "mcp-agents-memory",
  version: "1.0.0"
});

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
    console.error("🧠 Memory MCP Server (v2.0) running on stdio");

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
