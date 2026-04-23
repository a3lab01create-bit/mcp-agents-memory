import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";
import { generateEmbedding, vectorToSql } from "./embeddings.js";

export async function getOrCreateSubject(subject_key: string | undefined | null, fallback_type: string = 'system'): Promise<number> {
  const finalKey = subject_key || 'system_global';
  const res = await db.query("SELECT id FROM subjects WHERE subject_key = $1", [finalKey]);
  if (res.rows.length > 0) return res.rows[0].id;

  let guessedType = fallback_type;
  if (finalKey.startsWith('user_')) guessedType = 'person';
  else if (finalKey.startsWith('project_')) guessedType = 'project';
  else if (finalKey.startsWith('agent_')) guessedType = 'agent';
  else if (finalKey.startsWith('team_')) guessedType = 'team';
  else if (finalKey.startsWith('category_')) guessedType = 'category';
  else if (finalKey.startsWith('system_')) guessedType = 'system';

  const insertRes = await db.query(
    `INSERT INTO subjects (subject_type, subject_key, display_name) VALUES ($1, $2, $3) RETURNING id`,
    [guessedType, finalKey, finalKey]
  );
  return insertRes.rows[0].id;
}

export function registerTools(server: McpServer) {

  // ─────────────────────────────────────────────────────────────
  // memory_startup — Smart Briefing (MUST be called first)
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "memory_startup",
    {
      description: "🚨 MANDATORY FIRST CALL — Run this tool at the very start of every new session before doing anything else.\n\nReturns a structured briefing containing:\n- User profile & preferences\n- Recent session summaries (last 3)\n- Active project list with latest context\n- Top learning patterns\n\nThis ensures you have full context from prior sessions. Do NOT skip this step.",
      inputSchema: {
        user_key: z.string().optional().default("user_hoon").describe("User subject key. Defaults to 'user_hoon'."),
      }
    },
    async (args) => {
      const sections: string[] = [];
      sections.push("═══════════════════════════════════════");
      sections.push("🧠 MEMORY BRIEFING — Session Context");
      sections.push("═══════════════════════════════════════\n");

      // 1. User Profile & Preferences
      try {
        const userId = await getOrCreateSubject(args.user_key, 'person');
        const profileRes = await db.query(
          `SELECT content, summary, memory_type, tags, importance_score
           FROM memories
           WHERE subject_id = $1 AND memory_type IN ('profile', 'preference', 'constraint')
           ORDER BY importance_score DESC, updated_at DESC
           LIMIT 8`,
          [userId]
        );
        if (profileRes.rows.length > 0) {
          sections.push("👤 USER PROFILE");
          sections.push("───────────────");
          profileRes.rows.forEach(r => {
            const label = r.summary || r.content.substring(0, 120);
            sections.push(`• [${r.memory_type}] ${label}`);
            if (r.tags?.length > 0) sections.push(`  tags: ${r.tags.join(', ')}`);
          });
          sections.push("");
        }
      } catch (e) { /* silent fallback */ }

      // 2. Recent Session Summaries (latest state memories)
      try {
        const sessionRes = await db.query(
          `SELECT m.content, m.summary, m.tags, m.created_at,
                  s.display_name as project_name
           FROM memories m
           LEFT JOIN subjects s ON m.project_subject_id = s.id
           WHERE m.source_type = 'session' AND m.memory_type = 'state'
           ORDER BY m.created_at DESC
           LIMIT 3`
        );
        if (sessionRes.rows.length > 0) {
          sections.push("📋 RECENT SESSIONS");
          sections.push("──────────────────");
          sessionRes.rows.forEach((r, i) => {
            const date = new Date(r.created_at).toLocaleDateString('ko-KR');
            const project = r.project_name ? ` [${r.project_name}]` : '';
            sections.push(`${i + 1}. ${date}${project}`);
            sections.push(`   ${r.summary || r.content.substring(0, 150)}`);
            if (r.tags?.length > 0) sections.push(`   tags: ${r.tags.join(', ')}`);
          });
          sections.push("");
        }
      } catch (e) { /* silent fallback */ }

      // 3. Active Projects
      try {
        const projRes = await db.query(
          `SELECT s.subject_key, s.display_name,
                  (SELECT content FROM memories WHERE project_subject_id = s.id ORDER BY updated_at DESC LIMIT 1) as latest_memory
           FROM subjects s
           WHERE s.subject_type = 'project' AND s.is_active = TRUE
           ORDER BY s.updated_at DESC
           LIMIT 6`
        );
        if (projRes.rows.length > 0) {
          sections.push("📂 ACTIVE PROJECTS");
          sections.push("──────────────────");
          projRes.rows.forEach(r => {
            const latest = r.latest_memory ? ` — ${r.latest_memory.substring(0, 80)}` : '';
            sections.push(`• ${r.display_name} (${r.subject_key})${latest}`);
          });
          sections.push("");
        }
      } catch (e) { /* silent fallback */ }

      // 4. Top Learnings
      try {
        const learnRes = await db.query(
          `SELECT content, summary, learning_type, impact_score, tags
           FROM task_learnings
           ORDER BY impact_score DESC, usage_count DESC
           LIMIT 5`
        );
        if (learnRes.rows.length > 0) {
          sections.push("💡 TOP LEARNINGS");
          sections.push("────────────────");
          learnRes.rows.forEach(r => {
            const label = r.summary || r.content.substring(0, 120);
            sections.push(`• [${r.learning_type}] (impact: ${r.impact_score}) ${label}`);
          });
          sections.push("");
        }
      } catch (e) { /* silent fallback */ }

      // 5. Usage Instructions
      sections.push("📌 INSTRUCTIONS");
      sections.push("───────────────");
      sections.push("• Use memory_recall to search for specific past context");
      sections.push("• Use memory_remember to save NEW important facts (one fact per call)");
      sections.push("• Use memory_learn to record reusable patterns from completed work");
      sections.push("• Save facts atomically: one clear fact per memory_remember call");
      sections.push("═══════════════════════════════════════");

      return { content: [{ type: "text", text: sections.join("\n") }] };
    }
  );

  server.registerTool(
    "memory_remember",
    {
      description: "Store persistent long-term memory. Call this whenever you learn important information that should persist across sessions.\n\n[CRITICAL: ATOMIC SAVING]\nEach call must contain exactly ONE clear fact. If you learned 5 facts, call this tool 5 times.\n❌ BAD: 'Worked on YoonTube, fixed various bugs and updated configs'\n✅ GOOD: 'YoonTube Android TV uses React Native with WebView bridge'\n\n[RULES]\n1. subject_key is optional — defaults to 'system_global' if omitted.\n2. Common keys: 'user_hoon', 'project_centragens', 'project_yoontube', 'agent_claude'.\n3. New keys are auto-created using prefix convention: user_, project_, agent_, team_, category_, system_.\n4. Always provide a short summary (≤20 chars) for each memory.\n5. Always add 2-4 relevant tags.\n6. Do NOT store vague summaries or temporary info. Only concrete, reusable facts.",
      inputSchema: {
        subject_key: z.string().optional().describe("Key of the subject (e.g., 'user_hoon'). If omitted, defaults to 'system_global'."),
        project_key: z.string().optional(),
        content: z.string(),
        memory_type: z.enum(['preference', 'profile', 'constraint', 'state', 'relationship']),
        memory_scope: z.enum(['global', 'project', 'local', 'category']).default('global'),
        source_type: z.enum(['user', 'agent', 'inferred', 'session', 'task', 'system']),
        importance_score: z.number().min(1).max(10).optional().default(5),
        confidence_score: z.number().min(1).max(10).optional().default(5),
        summary: z.string().optional(),
        tags: z.array(z.string()).optional().default([]),
        expires_at: z.string().optional(),
      }
    },
    async (args) => {
      const subId = await getOrCreateSubject(args.subject_key, 'system');
      
      let projId = null;
      if (args.project_key) {
        projId = await getOrCreateSubject(args.project_key, 'project');
      }

      const embedText = [args.summary, args.content].filter(Boolean).join(" ");
      const embedding = await generateEmbedding(embedText);

      await db.query(
        `INSERT INTO memories (subject_id, project_subject_id, content, summary, memory_type, memory_scope, source_type, importance_score, confidence_score, tags, expires_at, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [subId, projId, args.content, args.summary, args.memory_type, args.memory_scope, args.source_type, args.importance_score, args.confidence_score, args.tags, args.expires_at, vectorToSql(embedding)]
      );
      return { content: [{ type: "text", text: "Memory successfully recorded." }] };
    }
  );

  server.registerTool(
    "memory_recall",
    {
      description: "Recall relevant long-term memories before or during a task. Use this to retrieve prior context about the current user, project, or topic so responses remain consistent and informed.\n\n[RULES]\n1. 'subject_key' is optional — if omitted, searches ALL subjects globally.\n2. Common keys: 'user_hoon' (Main User), 'project_centragens', 'project_yoontube'.\n3. 'tags' is optional — filter or boost results by specific tags (e.g. ['embedding', 'bugfix']).\n4. If unsure of the key, omit subject_key to do a global search across everything.",
      inputSchema: {
        subject_key: z.string().optional().describe("Key of the subject to recall. If omitted, searches across ALL subjects."),
        query: z.string(),
        tags: z.array(z.string()).optional().describe("Optional tags to filter by (e.g. ['bugfix', 'embedding'])"),
        limit: z.number().optional().default(5),
      }
    },
    async (args) => {
      const queryEmbedding = await generateEmbedding(args.query);
      const embeddingSql = vectorToSql(queryEmbedding);

      const params: any[] = [embeddingSql, args.limit, `%${args.query}%`];
      let subjectFilter = '';

      if (args.subject_key) {
        const subId = await getOrCreateSubject(args.subject_key, 'system');
        params.push(subId);
        subjectFilter = `AND m.subject_id = $${params.length}`;
      }

      let tagFilter = '';
      if (args.tags && args.tags.length > 0) {
        params.push(args.tags);
        tagFilter = `AND m.tags && $${params.length}::text[]`;
      }

      // 벡터 유사도 검색 + ILIKE 폴백 + 태그 매칭 합산
      const memories = await db.query(
        `SELECT m.id, m.content, m.summary, m.memory_type, m.memory_scope, m.created_at,
                m.confidence_score, m.importance_score, m.tags,
                subj.display_name as subject_name,
                s.display_name as project_name,
                CASE WHEN m.embedding IS NOT NULL
                     THEN 1 - (m.embedding <=> $1::vector)
                     ELSE 0.0
                END AS similarity
         FROM memories m
         LEFT JOIN subjects subj ON m.subject_id = subj.id
         LEFT JOIN subjects s ON m.project_subject_id = s.id
         WHERE (
             (m.embedding IS NOT NULL AND 1 - (m.embedding <=> $1::vector) > 0.3)
             OR (m.embedding IS NULL AND (m.content ILIKE $3 OR COALESCE(m.summary,'') ILIKE $3))
             OR (m.tags IS NOT NULL AND m.tags::text ILIKE $3)
           )
           ${subjectFilter}
           ${tagFilter}
         ORDER BY similarity DESC, m.importance_score DESC
         LIMIT $2`,
        params
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
        formatted += `[ID: ${m.id}] Type: ${m.memory_type} | Scope: ${m.memory_scope} | Imp: ${m.importance_score} | Conf: ${m.confidence_score}\n`;
        if (m.subject_name) formatted += `Subject: ${m.subject_name}\n`;
        if (m.project_name) formatted += `Project: ${m.project_name}\n`;
        if (m.tags && m.tags.length > 0) formatted += `Tags: ${m.tags.join(", ")}\n`;
        if (m.summary) formatted += `Summary: ${m.summary}\n`;
        formatted += `Content: ${m.content}\n`;
        formatted += `Date: ${new Date(m.created_at).toLocaleString()}\n`;
        formatted += `---\n`;
      });

      return { content: [{ type: "text", text: formatted }] };
    }
  );

  server.registerTool(
    "memory_log_task",
    {
      description: "Create a new task record. Use this to track major work items or goals for the user, a project, or a specific agent.\n\n[RULES]\n1. 'owner_key' defaults to 'user_hoon' if omitted.\n2. 'project_key' defaults to 'project_general' if omitted. New keys are auto-created using prefix convention.",
      inputSchema: {
        title: z.string(),
        task_type: z.string(),
        owner_key: z.string().optional().describe("Owner of the task, defaults to 'user_hoon' if omitted"),
        project_key: z.string().optional().describe("Project key, defaults to 'system_global' if omitted"),
        description: z.string().optional(),
      }
    },
    async (args) => {
      const ownerId = await getOrCreateSubject(args.owner_key || 'user_hoon', 'person');
      const projId = await getOrCreateSubject(args.project_key || 'project_general', 'project');

      const res = await db.query(
        `INSERT INTO tasks (title, task_type, owner_subject_id, project_subject_id, description) 
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [args.title, args.task_type, ownerId, projId, args.description]
      );
      return { content: [{ type: "text", text: `Task created with ID: ${res.rows[0].id}` }] };
    }
  );

  server.registerTool(
    "memory_complete_task",
    {
      description: "Mark a task as completed. Use this to record the outcome, success score, and final summary of a tracked task.",
      inputSchema: {
        task_id: z.number(),
        outcome_summary: z.string(),
        success_score: z.number().min(1).max(10),
      }
    },
    async (args) => {
      const res = await db.query(
        `UPDATE tasks SET status = 'done', outcome_summary = $2, success_score = $3, ended_at = NOW() WHERE id = $1`,
        [args.task_id, args.outcome_summary, args.success_score]
      );
      if (res.rowCount === 0) throw new Error(`Task ${args.task_id} not found.`);
      return { content: [{ type: "text", text: `Task ${args.task_id} marked as done.` }] };
    }
  );

  server.registerTool(
    "memory_log_session",
    {
      description: "Log the start of an AI session linked to a specific task. Use this to track which agent is working on a task and when they started.",
      inputSchema: {
        task_id: z.number(),
        orchestrator_key: z.string(),
        model_name: z.string(),
        provider: z.string(),
        started_at: z.string().optional(),
      }
    },
    async (args) => {
      const orchId = await getOrCreateSubject(args.orchestrator_key, 'agent');

      const res = await db.query(
        `INSERT INTO sessions (task_id, orchestrator_subject_id, model_name, provider, started_at) 
         VALUES ($1, $2, $3, $4, COALESCE($5, NOW())) RETURNING id`,
        [args.task_id, orchId, args.model_name, args.provider, args.started_at]
      );
      return { content: [{ type: "text", text: `Session started with ID: ${res.rows[0].id}` }] };
    }
  );

  server.registerTool(
    "memory_complete_session",
    {
      description: "Log the completion of an AI session. Use this to record token usage, final outcome, and summary after an agent finishes a block of work.",
      inputSchema: {
        session_id: z.number(),
        ended_at: z.string().optional(),
        final_outcome: z.enum(['success', 'failure', 'partial']),
        summary: z.string().optional(),
        token_usage: z.number().optional(),
      }
    },
    async (args) => {
      const res = await db.query(
        `UPDATE sessions SET ended_at = COALESCE($2, NOW()), final_outcome = $3, summary = $4, token_usage = $5 
         WHERE id = $1`,
        [args.session_id, args.ended_at, args.final_outcome, args.summary, args.token_usage]
      );
      if (res.rowCount === 0) throw new Error(`Session ${args.session_id} not found.`);
      return { content: [{ type: "text", text: `Session ${args.session_id} completed.` }] };
    }
  );

  server.registerTool(
    "memory_learn",
    {
      description: "Store reusable learnings from completed work, such as success patterns, failure patterns, heuristics, or routing rules. Use this after meaningful tasks when a lesson could improve future performance.",
      inputSchema: {
        task_id: z.number().optional(),
        task_type: z.string(),
        learning_type: z.enum(['success_pattern', 'failure_pattern', 'heuristic', 'routing_rule']),
        content: z.string(),
        summary: z.string().optional(),
        confidence_score: z.number().min(1).max(10).optional().default(5),
        impact_score: z.number().min(1).max(10).optional().default(5),
        tags: z.array(z.string()).optional().default([]),
      }
    },
    async (args) => {
      const embedText = [args.summary, args.content].filter(Boolean).join(" ");
      const embedding = await generateEmbedding(embedText);

      await db.query(
        `INSERT INTO task_learnings (task_id, task_type, learning_type, content, summary, confidence_score, impact_score, tags, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [args.task_id, args.task_type, args.learning_type, args.content, args.summary, args.confidence_score, args.impact_score, args.tags, vectorToSql(embedding)]
      );
      return { content: [{ type: "text", text: "Learning pattern recorded." }] };
    }
  );

  server.registerTool(
    "memory_get_learnings",
    {
      description: "Retrieve past learning patterns. Use this before starting a new task of a specific type to discover known best practices, previous mistakes to avoid, and proven heuristics.",
      inputSchema: {
        task_type: z.string().optional(),
        learning_type: z.enum(['success_pattern', 'failure_pattern', 'heuristic', 'routing_rule']).optional(),
        limit: z.number().optional().default(5),
      }
    },
    async (args) => {
      let learnings;

      if (args.task_type) {
        const queryEmbedding = await generateEmbedding(args.task_type);
        const embeddingSql = vectorToSql(queryEmbedding);

        let whereClause = `WHERE (
          (embedding IS NOT NULL AND 1 - (embedding <=> $1::vector) > 0.3)
          OR (embedding IS NULL AND (task_type = $2 OR content ILIKE $3))
        )`;
        const params: any[] = [embeddingSql, args.task_type, `%${args.task_type}%`];
        let paramCount = 4;

        if (args.learning_type) {
          whereClause += ` AND learning_type = $${paramCount}`;
          params.push(args.learning_type);
          paramCount++;
        }

        learnings = await db.query(
          `SELECT id, content, summary, learning_type, created_at, confidence_score, impact_score, tags,
                  CASE WHEN embedding IS NOT NULL THEN 1 - (embedding <=> $1::vector) ELSE 0.0 END AS similarity
           FROM task_learnings ${whereClause}
           ORDER BY similarity DESC, created_at DESC LIMIT $${paramCount}`,
          [...params, args.limit]
        );
      } else {
        let whereClause = `WHERE 1=1`;
        const params: any[] = [];
        let paramCount = 1;

        if (args.learning_type) {
          whereClause += ` AND learning_type = $${paramCount}`;
          params.push(args.learning_type);
          paramCount++;
        }

        learnings = await db.query(
          `SELECT id, content, summary, learning_type, created_at, confidence_score, impact_score, tags, 0.0 AS similarity
           FROM task_learnings ${whereClause}
           ORDER BY created_at DESC LIMIT $${paramCount}`,
          [...params, args.limit]
        );
      }

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
        formatted += `[ID: ${l.id}] Type: ${l.learning_type} | Imp: ${l.impact_score} | Conf: ${l.confidence_score}\n`;
        if (l.tags && l.tags.length > 0) formatted += `Tags: ${l.tags.join(", ")}\n`;
        if (l.summary) formatted += `Summary: ${l.summary}\n`;
        formatted += `Content: ${l.content}\n`;
        formatted += `Date: ${new Date(l.created_at).toLocaleString()}\n`;
        formatted += `---\n`;
      });

      return { content: [{ type: "text", text: formatted }] };
    }
  );

  server.registerTool(
    "memory_get_subject",
    {
      description: "Fetch detailed subject information by key. Use this to verify if a subject exists or check its metadata. \n\n[COMMON KEYS]\nUsers: 'user_hoon'\nProjects: 'project_centragens', 'project_yoontube'\nCategories: 'category_marketing', 'category_healthcare', 'category_development'\nAgents: 'agent_claude'",
      inputSchema: {
        subject_key: z.string(),
      }
    },
    async (args) => {
      const subject = await db.query("SELECT * FROM subjects WHERE subject_key = $1", [args.subject_key]);
      if (subject.rows.length === 0) {
        throw new Error(`Subject ${args.subject_key} not found.`);
      }
      
      const s = subject.rows[0];
      let formatted = `🔎 Subject Info\n\n`;
      formatted += `ID: ${s.id}\n`;
      formatted += `Type: ${s.subject_type}\n`;
      formatted += `Key: ${s.subject_key}\n`;
      formatted += `Display Name: ${s.display_name}\n`;
      formatted += `Active: ${s.is_active}\n`;
      formatted += `Metadata: ${JSON.stringify(s.metadata, null, 2)}\n`;
      formatted += `Created: ${new Date(s.created_at).toLocaleString()}\n`;
      
      return { content: [{ type: "text", text: formatted }] };
    }
  );

  server.registerTool(
    "memory_register_subject",
    {
      description: "Explicitly register a new subject. Use this to track a new project, user, or category before logging memories.",
      inputSchema: {
        subject_key: z.string().describe("Unique key, e.g., 'project_new_app', 'user_john'"),
        subject_type: z.enum(['person', 'agent', 'project', 'team', 'system', 'category', 'heuristic']),
        display_name: z.string().describe("Human readable name"),
        metadata: z.record(z.any()).optional().default({}),
      }
    },
    async (args) => {
      const res = await db.query("SELECT id FROM subjects WHERE subject_key = $1", [args.subject_key]);
      if (res.rows.length > 0) {
        await db.query(
          "UPDATE subjects SET subject_type = $1, display_name = $2, metadata = $3 WHERE subject_key = $4",
          [args.subject_type, args.display_name, args.metadata, args.subject_key]
        );
        return { content: [{ type: "text", text: `Subject '${args.subject_key}' updated.` }] };
      }

      await db.query(
        `INSERT INTO subjects (subject_type, subject_key, display_name, metadata) VALUES ($1, $2, $3, $4)`,
        [args.subject_type, args.subject_key, args.display_name, args.metadata]
      );
      return { content: [{ type: "text", text: `Subject '${args.subject_key}' created.` }] };
    }
  );

  server.registerTool(
    "memory_log_raw",
    {
      description: "Log an unprocessed observation, conversation snippet, or reflection. Use this to capture raw data that can be refined into structured memories later.",
      inputSchema: {
        subject_key: z.string().optional(),
        project_key: z.string().optional(),
        session_id: z.number().optional(),
        task_id: z.number().optional(),
        content: z.string(),
        raw_type: z.enum(['conversation', 'message', 'observation', 'draft', 'reflection', 'event']).default('observation'),
        source_type: z.enum(['user', 'agent', 'system', 'tool']).default('agent'),
        tags: z.array(z.string()).optional().default([]),
      }
    },
    async (args) => {
      let subId = null;
      if (args.subject_key) {
        subId = await getOrCreateSubject(args.subject_key, 'system');
      }

      let projId = null;
      if (args.project_key) {
        projId = await getOrCreateSubject(args.project_key, 'project');
      }

      const res = await db.query(
        `INSERT INTO raw_memories (subject_id, project_subject_id, session_id, task_id, content, raw_type, source_type, tags) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [subId, projId, args.session_id, args.task_id, args.content, args.raw_type, args.source_type, args.tags]
      );
      return { content: [{ type: "text", text: `Raw memory logged with ID: ${res.rows[0].id}` }] };
    }
  );
}
