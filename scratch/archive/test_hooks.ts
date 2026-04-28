import { onSessionStart, onTaskStart } from "../src/hooks.js";
import type { McpClient } from "../src/hooks.js";

/**
 * Mock MCP Client for testing hooks without a running server.
 */
const mockClient: McpClient = {
  async callTool(name: string, args: any) {
    console.log(`[Mock] Calling ${name} with:`, JSON.stringify(args));
    
    // Simulate responses based on the tool name
    if (name === "memory_recall") {
      return {
        content: [{
          text: `🧠 Recalled Memories:
[ID: 1] Type: profile | Scope: global | Imp: 10 | Conf: 10
Content: User Hoon prefers TypeScript and modular architecture.
Date: 2026-04-23
---
[ID: 2] Type: preference | Scope: project | Imp: 8 | Conf: 9
Project: YoonTube
Content: Use dark mode for UI components.
---`
        }]
      };
    }
    
    if (name === "memory_get_learnings") {
      // Simulate "general" being empty to test fallback
      if (args.task_type === "general") {
        return { content: [{ text: "No relevant learnings found." }] };
      }
      
      return {
        content: [{
          text: `📚 Retrieved Learnings:
[ID: 10] Type: heuristic | Imp: 9 | Conf: 8
Content: Always establish an SSH tunnel before DB connection in Node environments.
---`
        }]
      };
    }
    
    return { content: [{ text: "Empty result." }] };
  }
};

async function test() {
  console.log("--- Testing onSessionStart ---");
  const sessionCtx = await onSessionStart(mockClient, "user_hoon");
  console.log("Structured Context (Session):", JSON.stringify(sessionCtx, null, 2));

  console.log("\n--- Testing onTaskStart ---");
  const taskCtx = await onTaskStart(mockClient, "project_centragens", "marketing");
  console.log("Structured Context (Task):", JSON.stringify(taskCtx, null, 2));
}

test().catch(console.error);
