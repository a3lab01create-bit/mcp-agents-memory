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
    console.error("📡 Pre-connecting to Database...");
    await db.connect();
    console.error("✅ Database ready.");

    // Auto-register agent if AGENT_KEY env is set (e.g. "agent_claude", "agent_gemini")
    if (process.env.AGENT_KEY) {
      await getOrCreateSubject(process.env.AGENT_KEY, 'agent');
      console.error(`🤖 Agent registered: ${process.env.AGENT_KEY}`);
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("🧠 Memory MCP Server (v2.0) running on stdio");
  } catch (err) {
    console.error("❌ Fatal error during startup:", err);
    process.exit(1);
  }
}

main().catch(console.error);
