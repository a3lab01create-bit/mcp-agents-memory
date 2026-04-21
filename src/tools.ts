import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";

export function registerTools(server: McpServer) {
  server.tool(
    "memory_remember",
    "Store persistent long-term memory about the user, project, or task context. Use this whenever you learn important information that should remain useful across future conversations, such as user profile, preferences, constraints, or project-specific rules. Do not use for temporary or one-off information.",
    {
      subject_key: z.string(),
      project_key: z.string().optional(),
      content: z.string(),
      memory_type: z.enum(['preference', 'profile', 'constraint', 'state', 'relationship']),
      memory_scope: z.enum(['global', 'project', 'local']).default('global'),
      source_type: z.enum(['user', 'agent', 'inferred', 'session', 'task', 'system']),
      importance_score: z.number().min(1).max(10).optional().default(5),
      summary: z.string().optional(),
      tags: z.array(z.string()).optional().default([]),
    },
    async (args) => {
      const subRes = await db.query("SELECT id FROM subjects WHERE subject_key = $1", [args.subject_key]);
      if (subRes.rows.length === 0) throw new Error(`Subject ${args.subject_key} not found`);
      
      let projId = null;
      if (args.project_key) {
        const projRes = await db.query("SELECT id FROM subjects WHERE subject_key = $1 AND subject_type = 'project'", [args.project_key]);
        if (projRes.rows.length === 0) throw new Error(`Project ${args.project_key} not found or is not of type 'project'`);
        projId = projRes.rows[0].id;
      }

      await db.query(
        `INSERT INTO memories (subject_id, project_subject_id, content, summary, memory_type, memory_scope, source_type, importance_score, tags) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [subRes.rows[0].id, projId, args.content, args.summary, args.memory_type, args.memory_scope, args.source_type, args.importance_score, args.tags]
      );
      return { content: [{ type: "text", text: "Memory successfully recorded." }] };
    }
  );

  server.tool(
    "memory_recall",
    "Recall relevant long-term memories before or during a task. Use this to retrieve prior context about the current user, project, or topic so responses remain consistent and informed.",
    {
      subject_key: z.string(),
      query: z.string(),
      limit: z.number().optional().default(5),
    },
    async (args) => {
      const subRes = await db.query("SELECT id FROM subjects WHERE subject_key = $1", [args.subject_key]);
      if (subRes.rows.length === 0) throw new Error(`Subject ${args.subject_key} not found`);

      const memories = await db.query(
        `SELECT m.id, m.content, m.summary, m.memory_type, m.memory_scope, m.created_at, s.display_name as project_name
         FROM memories m
         LEFT JOIN subjects s ON m.project_subject_id = s.id
         WHERE m.subject_id = $1 AND (m.content ILIKE $2 OR COALESCE(m.summary, '') ILIKE $2)
         ORDER BY m.importance_score DESC, m.created_at DESC LIMIT $3`,
        [subRes.rows[0].id, `%${args.query}%`, args.limit]
      );

      if (memories.rows.length === 0) {
        return { content: [{ type: "text", text: "No relevant memories found." }] };
      }

      const ids = memories.rows.map(m => m.id);
      await db.query(
        `UPDATE memories SET access_count = access_count + 1, last_accessed_at = NOW() WHERE id = ANY($1::int[])`,
        [ids]
      );

      let formatted = "🧠 Recalled Memories:\n\n";
      memories.rows.forEach(m => {
        formatted += `[ID: ${m.id}] Type: ${m.memory_type} | Scope: ${m.memory_scope}\n`;
        if (m.project_name) formatted += `Project: ${m.project_name}\n`;
        if (m.summary) formatted += `Summary: ${m.summary}\n`;
        formatted += `Content: ${m.content}\n`;
        formatted += `Date: ${new Date(m.created_at).toLocaleString()}\n`;
        formatted += `---\n`;
      });

      return { content: [{ type: "text", text: formatted }] };
    }
  );

  server.tool(
    "memory_log_task",
    "Create a new task record. Use this to track major work items or goals for the user, a project, or a specific agent.",
    {
      title: z.string(),
      task_type: z.string(),
      owner_key: z.string(),
      project_key: z.string(),
      description: z.string().optional(),
    },
    async (args) => {
      const owner = await db.query("SELECT id FROM subjects WHERE subject_key = $1", [args.owner_key]);
      const project = await db.query("SELECT id FROM subjects WHERE subject_key = $1 AND subject_type = 'project'", [args.project_key]);
      
      if (!owner.rows[0]) throw new Error(`Owner ${args.owner_key} not found`);
      if (!project.rows[0]) throw new Error(`Project ${args.project_key} not found or is not of type 'project'`);

      const res = await db.query(
        `INSERT INTO tasks (title, task_type, owner_subject_id, project_subject_id, description) 
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [args.title, args.task_type, owner.rows[0].id, project.rows[0].id, args.description]
      );
      return { content: [{ type: "text", text: `Task created with ID: ${res.rows[0].id}` }] };
    }
  );

  server.tool(
    "memory_complete_task",
    "Mark a task as completed. Use this to record the outcome, success score, and final summary of a tracked task.",
    {
      task_id: z.number(),
      outcome_summary: z.string(),
      success_score: z.number().min(1).max(10),
    },
    async (args) => {
      await db.query(
        `UPDATE tasks SET status = 'done', outcome_summary = $2, success_score = $3, ended_at = NOW() WHERE id = $1`,
        [args.task_id, args.outcome_summary, args.success_score]
      );
      return { content: [{ type: "text", text: `Task ${args.task_id} marked as done.` }] };
    }
  );

  server.tool(
    "memory_log_session",
    "Log the start of an AI session linked to a specific task. Use this to track which agent is working on a task and when they started.",
    {
      task_id: z.number(),
      orchestrator_key: z.string(),
      model_name: z.string(),
      provider: z.string(),
      started_at: z.string().optional(),
    },
    async (args) => {
      const orch = await db.query("SELECT id FROM subjects WHERE subject_key = $1", [args.orchestrator_key]);
      const orchId = orch.rows[0]?.id || null;

      const res = await db.query(
        `INSERT INTO sessions (task_id, orchestrator_subject_id, model_name, provider, started_at) 
         VALUES ($1, $2, $3, $4, COALESCE($5, NOW())) RETURNING id`,
        [args.task_id, orchId, args.model_name, args.provider, args.started_at]
      );
      return { content: [{ type: "text", text: `Session started with ID: ${res.rows[0].id}` }] };
    }
  );

  server.tool(
    "memory_complete_session",
    "Log the completion of an AI session. Use this to record token usage, final outcome, and summary after an agent finishes a block of work.",
    {
      session_id: z.number(),
      ended_at: z.string().optional(),
      final_outcome: z.enum(['success', 'failure', 'partial']),
      summary: z.string().optional(),
      token_usage: z.number().optional(),
    },
    async (args) => {
      await db.query(
        `UPDATE sessions SET ended_at = COALESCE($2, NOW()), final_outcome = $3, summary = $4, token_usage = $5 
         WHERE id = $1`,
        [args.session_id, args.ended_at, args.final_outcome, args.summary, args.token_usage]
      );
      return { content: [{ type: "text", text: `Session ${args.session_id} completed.` }] };
    }
  );

  server.tool(
    "memory_learn",
    "Store reusable learnings from completed work, such as success patterns, failure patterns, heuristics, or routing rules. Use this after meaningful tasks when a lesson could improve future performance.",
    {
      task_id: z.number().optional(),
      task_type: z.string(),
      learning_type: z.enum(['success_pattern', 'failure_pattern', 'heuristic', 'routing_rule']),
      content: z.string(),
      summary: z.string().optional(),
    },
    async (args) => {
      await db.query(
        `INSERT INTO task_learnings (task_id, task_type, learning_type, content, summary) 
         VALUES ($1, $2, $3, $4, $5)`,
        [args.task_id, args.task_type, args.learning_type, args.content, args.summary]
      );
      return { content: [{ type: "text", text: "Learning pattern recorded." }] };
    }
  );

  server.tool(
    "memory_get_learnings",
    "Retrieve past learning patterns. Use this before starting a new task of a specific type to discover known best practices, previous mistakes to avoid, and proven heuristics.",
    {
      task_type: z.string(),
      limit: z.number().optional().default(5),
    },
    async (args) => {
      const learnings = await db.query(
        `SELECT id, content, summary, learning_type, created_at FROM task_learnings 
         WHERE task_type = $1 OR content ILIKE $2 ORDER BY created_at DESC LIMIT $3`,
        [args.task_type, `%${args.task_type}%`, args.limit]
      );

      if (learnings.rows.length === 0) {
        return { content: [{ type: "text", text: "No relevant learnings found." }] };
      }

      const ids = learnings.rows.map(l => l.id);
      await db.query(
        `UPDATE task_learnings SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = ANY($1::int[])`,
        [ids]
      );

      let formatted = "📚 Retrieved Learnings:\n\n";
      learnings.rows.forEach(l => {
        formatted += `[ID: ${l.id}] Type: ${l.learning_type}\n`;
        if (l.summary) formatted += `Summary: ${l.summary}\n`;
        formatted += `Content: ${l.content}\n`;
        formatted += `Date: ${new Date(l.created_at).toLocaleString()}\n`;
        formatted += `---\n`;
      });

      return { content: [{ type: "text", text: formatted }] };
    }
  );

  server.tool(
    "memory_get_subject",
    "Fetch detailed subject information by key. Use this to look up metadata about a person, agent, project, team, or system in the memory ecosystem.",
    {
      subject_key: z.string(),
    },
    async (args) => {
      const subject = await db.query("SELECT * FROM subjects WHERE subject_key = $1", [args.subject_key]);
      if (subject.rows.length === 0) {
        throw new Error(`Subject ${args.subject_key} not found.`);
      }
      return { content: [{ type: "text", text: JSON.stringify(subject.rows[0], null, 2) }] };
    }
  );
}
