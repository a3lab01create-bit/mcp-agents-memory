/**
 * Recall Hook System for Claude Code & AI Agents
 * This layer manages the intelligent retrieval and summarization of long-term memories.
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
  globalHeuristics: string[];
  categoryLearnings: string[];
  projectContext: string[];
  finalPromptBlock: string;
};

/**
 * Summarizes long search results into a concise structured format.
 * Preserves the hierarchy of information.
 */
export function summarizeContext(rawMemories: string, rawLearnings: string): StructuredContext {
  const context: StructuredContext = {
    userContext: [],
    globalHeuristics: [],
    categoryLearnings: [],
    projectContext: [],
    finalPromptBlock: ""
  };

  // Helper to parse the custom text format returned by our MCP tools
  const parseBlocks = (text: string) => {
    if (!text || text.includes("No relevant")) return [];
    return text.split("---").map(b => b.trim()).filter(b => b.length > 0);
  };

  const memoryBlocks = parseBlocks(rawMemories);
  const learningBlocks = parseBlocks(rawLearnings);

  // Categorize Memories
  memoryBlocks.forEach(block => {
    if (block.includes("Type: profile") || block.includes("Type: preference")) {
      context.userContext.push(block);
    } else if (block.includes("Scope: global")) {
      context.globalHeuristics.push(block);
    } else {
      context.projectContext.push(block);
    }
  });

  // Categorize Learnings
  learningBlocks.forEach(block => {
    if (block.includes("Type: heuristic") || block.includes("Type: routing_rule")) {
      context.globalHeuristics.push(block);
    } else {
      context.categoryLearnings.push(block);
    }
  });

  // Build Final Prompt Block (Compressed to 5-8 lines)
  const allLines: string[] = [];
  
  const extractEssential = (block: string) => {
    const summaryMatch = block.match(/Summary: (.*)/);
    if (summaryMatch) return summaryMatch[1];
    const contentMatch = block.match(/Content: (.*)/);
    if (contentMatch) return contentMatch[1].substring(0, 100) + "...";
    return block.split('\n')[1] || "";
  };

  const addLines = (label: string, blocks: string[], max: number) => {
    for (let i = 0; i < Math.min(blocks.length, max); i++) {
      allLines.push(`[${label}] ${extractEssential(blocks[i])}`);
    }
  };

  addLines("User", context.userContext, 2);
  addLines("Global", context.globalHeuristics, 2);
  addLines("Category", context.categoryLearnings, 2);
  addLines("Project", context.projectContext, 2);
  
  context.finalPromptBlock = allLines.join("\n") || "No prior context available.";

  return context;
}

/**
 * Hook triggered at the start of a session.
 * Loads user profile and global rules.
 */
export async function onSessionStart(client: McpClient, subjectKey: string): Promise<StructuredContext> {
  console.error(`[Hook] Initializing session for: ${subjectKey}`);

  // 1. Recall user profile and preferences
  const memoryRes = await client.callTool("memory_recall", {
    subject_key: subjectKey,
    query: "profile preference",
    limit: 5
  });

  // 2. Recall global learnings (with fallback)
  let learningRes = await client.callTool("memory_get_learnings", {
    task_type: "general",
    limit: 5
  });

  // Fallback: If no general learnings, look for heuristics/rules
  if (!learningRes.content || learningRes.content[0].text.includes("No relevant")) {
    console.error("[Hook] No 'general' learnings found, falling back to heuristics...");
    learningRes = await client.callTool("memory_get_learnings", {
      learning_type: "heuristic", 
      limit: 3
    });
  }

  return summarizeContext(
    memoryRes.content?.[0]?.text || "", 
    learningRes.content?.[0]?.text || ""
  );
}

/**
 * Hook triggered at the start of a specific task.
 * Loads project-specific context and specialized patterns.
 */
export async function onTaskStart(
  client: McpClient, 
  projectKey: string, 
  taskType: string
): Promise<StructuredContext> {
  console.error(`[Hook] Initializing task: [${projectKey}] ${taskType}`);

  // 1. Recall project-specific memories
  const memoryRes = await client.callTool("memory_recall", {
    subject_key: projectKey,
    query: taskType,
    limit: 5
  });

  // 2. Recall specialized task learnings
  const learningRes = await client.callTool("memory_get_learnings", {
    task_type: taskType,
    limit: 5
  });

  return summarizeContext(
    memoryRes.content?.[0]?.text || "", 
    learningRes.content?.[0]?.text || ""
  );
}
