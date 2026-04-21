import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { db } from "./db.js";

// Tool Schemas updated for new DB columns
const RememberSchema = z.object({
  subject_key: z.string(),
  project_key: z.string().optional(),
  content: z.string(),
  memory_type: z.enum(['preference', 'profile', 'constraint', 'state', 'relationship']),
  memory_scope: z.enum(['global', 'project', 'local']).default('global'),
  source_type: z.enum(['user', 'agent', 'inferred', 'session', 'task', 'system']),
  importance_score: z.number().min(1).max(10).optional().default(5),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
});

const RecallSchema = z.object({
  subject_key: z.string(),
  query: z.string(),
  limit: z.number().optional().default(5),
});

const LogTaskSchema = z.object({
  title: z.string(),
  task_type: z.string(),
  owner_key: z.string(),
  project_key: z.string(),
  description: z.string().optional(),
});

const CompleteTaskSchema = z.object({
  task_id: z.number(),
  outcome_summary: z.string(),
  success_score: z.number().min(1).max(10),
});

const server = new Server(
  { name: "mcp-agents-memory", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "remember",
        description: "Store a long-term memory with rich context",
        inputSchema: {
          type: "object",
          properties: {
            subject_key: { type: "string" },
            project_key: { type: "string" },
            content: { type: "string" },
            memory_type: { type: "string", enum: ['preference', 'profile', 'constraint', 'state', 'relationship'] },
            memory_scope: { type: "string", enum: ['global', 'project', 'local'] },
            source_type: { type: "string", enum: ['user', 'agent', 'inferred', 'session', 'task', 'system'] },
            importance_score: { type: "number" },
            summary: { type: "string" },
            tags: { type: "array", items: { type: "string" } }
          },
          required: ["subject_key", "content", "memory_type", "source_type"]
        }
      },
      {
        name: "recall",
        description: "Recall memories using text search",
        inputSchema: {
          type: "object",
          properties: {
            subject_key: { type: "string" },
            query: { type: "string" },
            limit: { type: "number" }
          },
          required: ["subject_key", "query"]
        }
      },
      {
        name: "log_task",
        description: "Create a new task record",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            task_type: { type: "string" },
            owner_key: { type: "string" },
            project_key: { type: "string" },
            description: { type: "string" }
          },
          required: ["title", "task_type", "owner_key", "project_key"]
        }
      },
      {
        name: "complete_task",
        description: "Complete a task with outcome and score",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "number" },
            outcome_summary: { type: "string" },
            success_score: { type: "number" }
          },
          required: ["task_id", "outcome_summary", "success_score"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "remember": {
        const parsed = RememberSchema.parse(args);
        
        const subRes = await db.query("SELECT id FROM subjects WHERE subject_key = $1", [parsed.subject_key]);
        if (subRes.rows.length === 0) throw new Error(`Subject ${parsed.subject_key} not found`);
        
        let projId = null;
        if (parsed.project_key) {
          const projRes = await db.query("SELECT id FROM subjects WHERE subject_key = $1", [parsed.project_key]);
          projId = projRes.rows[0]?.id || null;
        }

        await db.query(
          `INSERT INTO memories (subject_id, project_subject_id, content, summary, memory_type, memory_scope, source_type, importance_score, tags) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [subRes.rows[0].id, projId, parsed.content, parsed.summary, parsed.memory_type, parsed.memory_scope, parsed.source_type, parsed.importance_score, parsed.tags]
        );
        return { content: [{ type: "text", text: "Memory successfully recorded." }] };
      }

      case "recall": {
        const { subject_key, query, limit } = RecallSchema.parse(args);
        const subRes = await db.query("SELECT id FROM subjects WHERE subject_key = $1", [subject_key]);
        if (subRes.rows.length === 0) throw new Error(`Subject ${subject_key} not found`);

        const memories = await db.query(
          `SELECT m.content, m.summary, m.memory_type, m.memory_scope, m.created_at, s.display_name as project_name
           FROM memories m
           LEFT JOIN subjects s ON m.project_subject_id = s.id
           WHERE m.subject_id = $1 AND (m.content ILIKE $2 OR m.summary ILIKE $2)
           ORDER BY m.importance_score DESC, m.created_at DESC LIMIT $3`,
          [subRes.rows[0].id, `%${query}%`, limit]
        );
        return { content: [{ type: "text", text: JSON.stringify(memories.rows, null, 2) }] };
      }

      case "log_task": {
        const parsed = LogTaskSchema.parse(args);
        const owner = await db.query("SELECT id FROM subjects WHERE subject_key = $1", [parsed.owner_key]);
        const project = await db.query("SELECT id FROM subjects WHERE subject_key = $1", [parsed.project_key]);
        
        if (!owner.rows[0] || !project.rows[0]) throw new Error("Invalid owner_key or project_key");

        const res = await db.query(
          `INSERT INTO tasks (title, task_type, owner_subject_id, project_subject_id, description) 
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [parsed.title, parsed.task_type, owner.rows[0].id, project.rows[0].id, parsed.description]
        );
        return { content: [{ type: "text", text: `Task created with ID: ${res.rows[0].id}` }] };
      }

      case "complete_task": {
        const { task_id, outcome_summary, success_score } = CompleteTaskSchema.parse(args);
        await db.query(
          `UPDATE tasks SET status = 'done', outcome_summary = $2, success_score = $3, ended_at = NOW() WHERE id = $1`,
          [task_id, outcome_summary, success_score]
        );
        return { content: [{ type: "text", text: `Task ${task_id} marked as done.` }] };
      }

      default:
        throw new Error("Unknown tool");
    }
  } catch (error: any) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Memory MCP Server (v1 Clean) running on stdio");
}

main().catch(console.error);
