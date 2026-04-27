/**
 * Recall Hook System for Claude Code & AI Agents (v0.4)
 * 
 * Simplified for the new memories-based schema.
 * This layer manages intelligent retrieval and summarization of long-term memories.
 */

export type McpClient = {
  /**
   * Universal interface to call MCP tools.
   * Implementation depends on the client (e.g., Claude Code CLI, custom Node.js client).
   */
  callTool(name: string, args: Record<string, any>): Promise<any>;
};

export type StructuredContext = {
  userContext: string[];
  projectContext: string[];
  decisions: string[];
  finalPromptBlock: string;
};

/**
 * Summarizes search results into a concise structured format.
 */
export function summarizeContext(rawFacts: string): StructuredContext {
  const context: StructuredContext = {
    userContext: [],
    projectContext: [],
    decisions: [],
    finalPromptBlock: ""
  };

  const parseBlocks = (text: string) => {
    if (!text || text.includes("No relevant")) return [];
    return text.split("---").map(b => b.trim()).filter(b => b.length > 0);
  };

  const blocks = parseBlocks(rawFacts);

  blocks.forEach(block => {
    if (block.includes("[profile]") || block.includes("[preference]")) {
      context.userContext.push(block);
    } else if (block.includes("[decision]") || block.includes("[learning]")) {
      context.decisions.push(block);
    } else {
      context.projectContext.push(block);
    }
  });

  const allLines: string[] = [];
  const extractEssential = (block: string) => {
    const contentMatch = block.match(/Content: (.*)/);
    if (contentMatch) return contentMatch[1].substring(0, 100);
    return block.split('\n')[0] || "";
  };

  const addLines = (label: string, blocks: string[], max: number) => {
    for (let i = 0; i < Math.min(blocks.length, max); i++) {
      allLines.push(`[${label}] ${extractEssential(blocks[i])}`);
    }
  };

  addLines("User", context.userContext, 3);
  addLines("Decision", context.decisions, 3);
  addLines("Project", context.projectContext, 3);

  context.finalPromptBlock = allLines.join("\n") || "No prior context available.";
  return context;
}

/**
 * Hook triggered at the start of a session.
 */
export async function onSessionStart(client: McpClient, subjectKey: string): Promise<StructuredContext> {
  console.error(`[Hook] Initializing session for: ${subjectKey}`);

  const factRes = await client.callTool("memory_search", {
    subject_key: subjectKey,
    query: "profile preference decision",
    limit: 8
  });

  return summarizeContext(factRes.content?.[0]?.text || "");
}

/**
 * Hook triggered at the start of a specific task.
 */
export async function onTaskStart(
  client: McpClient,
  projectKey: string,
  taskType: string
): Promise<StructuredContext> {
  console.error(`[Hook] Initializing task: [${projectKey}] ${taskType}`);

  const factRes = await client.callTool("memory_search", {
    subject_key: projectKey,
    query: taskType,
    limit: 5
  });

  return summarizeContext(factRes.content?.[0]?.text || "");
}
