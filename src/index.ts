import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { db } from "./db.js";

// Tool Schemas
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

const LogSessionSchema = z.object({
  task_id: z.number(),
  orchestrator_key: z.string(),
  model_name: z.string(),
  provider: z.string(),
  token_usage: z.number().optional(),
  summary: z.string().optional(),
});

const LearnSchema = z.object({
  task_id: z.number().optional(),
  task_type: z.string(),
  learning_type: z.enum(['success_pattern', 'failure_pattern', 'heuristic', 'routing_rule']),
  content: z.string(),
  summary: z.string().optional(),
});

const GetLearningsSchema = z.object({
  task_type: z.string(),
  limit: z.number().optional().default(5),
});

const GetSubjectSchema = z.object({
  subject_key: z.string(),
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
      },
      {
        name: "log_session",
        description: "Log an AI session linked to a task",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "number" },
            orchestrator_key: { type: "string" },
            model_name: { type: "string" },
            provider: { type: "string" },
            token_usage: { type: "number" },
            summary: { type: "string" }
          },
          required: ["task_id", "orchestrator_key", "model_name", "provider"]
        }
      },
      {
        name: "learn",
        description: "Capture learning patterns/heuristics",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "number" },
            task_type: { type: "string" },
            learning_type: { type: "string", enum: ['success_pattern', 'failure_pattern', 'heuristic', 'routing_rule'] },
            content: { type: "string" },
            summary: { type: "string" }
          },
          required: ["task_type", "learning_type", "content"]
        }
      },
      {
        name: "get_learnings",
        description: "Retrieve past learning patterns",
        inputSchema: {
          type: "object",
          properties: {
            task_type: { type: "string" },
            limit: { type: "number" }
          },
          required: ["task_type"]
        }
      },
      {
        name: "get_subject",
        description: "Fetch subject information by key",
        inputSchema: {
          type: "object",
          properties: {
            subject_key: { type: "string" }
          },
          required: ["subject_key"]
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
          `SELECT m.id, m.content, m.summary, m.memory_type, m.memory_scope, m.created_at, s.display_name as project_name
           FROM memories m
           LEFT JOIN subjects s ON m.project_subject_id = s.id
           WHERE m.subject_id = $1 AND (m.content ILIKE $2 OR m.summary ILIKE $2)
           ORDER BY m.importance_score DESC, m.created_at DESC LIMIT $3`,
          [subRes.rows[0].id, `%${query}%`, limit]
        );

        // Update access count for recalled memories
        if (memories.rows.length > 0) {
          const ids = memories.rows.map(m => m.id);
          await db.query(
            `UPDATE memories SET access_count = access_count + 1, last_accessed_at = NOW() WHERE id = ANY($1::int[])`,
            [ids]
          );
        }

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

      case "log_session": {
        const parsed = LogSessionSchema.parse(args);
        const orch = await db.query("SELECT id FROM subjects WHERE subject_key = $1", [parsed.orchestrator_key]);
        const orchId = orch.rows[0]?.id || null;

        await db.query(
          `INSERT INTO sessions (task_id, orchestrator_subject_id, model_name, provider, token_usage, summary) 
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [parsed.task_id, orchId, parsed.model_name, parsed.provider, parsed.token_usage, parsed.summary]
        );
        return { content: [{ type: "text", text: "Session logged successfully." }] };
      }

      case "learn": {
        const parsed = LearnSchema.parse(args);
        await db.query(
          `INSERT INTO task_learnings (task_id, task_type, learning_type, content, summary) 
           VALUES ($1, $2, $3, $4, $5)`,
          [parsed.task_id, parsed.task_type, parsed.learning_type, parsed.content, parsed.summary]
        );
        return { content: [{ type: "text", text: "Learning pattern recorded." }] };
      }

      case "get_learnings": {
        const { task_type, limit } = GetLearningsSchema.parse(args);
        const learnings = await db.query(
          `SELECT content, summary, learning_type, created_at FROM task_learnings 
           WHERE task_type = $1 OR content ILIKE $2 ORDER BY created_at DESC LIMIT $3`,
          [task_type, `%${task_type}%`, limit]
        );
        return { content: [{ type: "text", text: JSON.stringify(learnings.rows, null, 2) }] };
      }

      case "get_subject": {
        const { subject_key } = GetSubjectSchema.parse(args);
        const subject = await db.query("SELECT * FROM subjects WHERE subject_key = $1", [subject_key]);
        return { content: [{ type: "text", text: JSON.stringify(subject.rows[0] || {}, null, 2) }] };
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
  console.error("Memory MCP Server (v1.1 Advanced) running on stdio");
}

main().catch(console.error);
