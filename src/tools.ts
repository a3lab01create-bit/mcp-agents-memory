import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";
import { generateEmbedding, vectorToSql } from "./embeddings.js";
import { processBatch } from "./librarian.js";

// ─────────────────────────────────────────────────────────────
// Shared Helpers
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Tool Registration (v0.4 — 4 tools)
// ─────────────────────────────────────────────────────────────

export function registerTools(server: McpServer) {

  // ═══════════════════════════════════════════════════════════
  // memory_startup — Smart Briefing (MUST be called first)
  // ═══════════════════════════════════════════════════════════
  server.registerTool(
    "memory_startup",
    {
      description: "🚨 MANDATORY FIRST CALL — Run this at the very start of every new session.\n\nReturns a structured briefing:\n- User profile & preferences\n- Recent project states\n- Key decisions & learnings\n\nDo NOT skip this step.",
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
          `SELECT content, fact_type, tags, importance, confidence
           FROM facts
           WHERE subject_id = $1 AND fact_type IN ('profile', 'preference') AND is_active = TRUE
           ORDER BY importance DESC, updated_at DESC
           LIMIT 8`,
          [userId]
        );
        if (profileRes.rows.length > 0) {
          sections.push("👤 USER PROFILE");
          sections.push("───────────────");
          profileRes.rows.forEach((r: any) => {
            sections.push(`• [${r.fact_type}] ${r.content}`);
            if (r.tags?.length > 0) sections.push(`  tags: ${r.tags.join(', ')}`);
          });
          sections.push("");
        }
      } catch (e) { /* silent fallback */ }

      // 2. Active Projects & Recent States
      try {
        const projRes = await db.query(
          `SELECT s.subject_key, s.display_name,
                  (SELECT content FROM facts
                   WHERE (project_subject_id = s.id OR subject_id = s.id) AND is_active = TRUE
                   ORDER BY updated_at DESC LIMIT 1) as latest_fact
           FROM subjects s
           WHERE s.subject_type = 'project' AND s.is_active = TRUE
           ORDER BY s.updated_at DESC
           LIMIT 6`
        );
        if (projRes.rows.length > 0) {
          sections.push("📂 ACTIVE PROJECTS");
          sections.push("──────────────────");
          projRes.rows.forEach((r: any) => {
            const latest = r.latest_fact ? ` — ${r.latest_fact.substring(0, 80)}` : '';
            sections.push(`• ${r.display_name} (${r.subject_key})${latest}`);
          });
          sections.push("");
        }
      } catch (e) { /* silent fallback */ }

      // 3. Key Decisions & Learnings
      try {
        const decisionRes = await db.query(
          `SELECT content, fact_type, tags, created_at
           FROM facts
           WHERE fact_type IN ('decision', 'learning') AND is_active = TRUE
           ORDER BY importance DESC, created_at DESC
           LIMIT 5`
        );
        if (decisionRes.rows.length > 0) {
          sections.push("💡 KEY DECISIONS & LEARNINGS");
          sections.push("───────────────────────────");
          decisionRes.rows.forEach((r: any) => {
            const date = new Date(r.created_at).toLocaleDateString('ko-KR');
            sections.push(`• [${r.fact_type}] ${r.content}`);
            if (r.tags?.length > 0) sections.push(`  tags: ${r.tags.join(', ')} | ${date}`);
          });
          sections.push("");
        }
      } catch (e) { /* silent fallback */ }

      // 4. Skills
      try {
        const skillRes = await db.query(
          `SELECT content, tags
           FROM facts
           WHERE fact_type = 'skill' AND is_active = TRUE
           ORDER BY importance DESC
           LIMIT 6`
        );
        if (skillRes.rows.length > 0) {
          sections.push("🛠️ SKILLS & TECH STACK");
          sections.push("─────────────────────");
          skillRes.rows.forEach((r: any) => {
            sections.push(`• ${r.content}`);
          });
          sections.push("");
        }
      } catch (e) { /* silent fallback */ }

      // 5. Usage Instructions
      sections.push("📌 INSTRUCTIONS");
      sections.push("───────────────");
      sections.push("• Use memory_add to save important information (raw text → auto-extraction)");
      sections.push("• Use memory_search to find specific past context");
      sections.push("• Use memory_status to check memory health");
      sections.push("═══════════════════════════════════════");

      return { content: [{ type: "text", text: sections.join("\n") }] };
    }
  );

  // ═══════════════════════════════════════════════════════════
  // memory_add — Librarian-Powered Memory Storage
  // ═══════════════════════════════════════════════════════════
  server.registerTool(
    "memory_add",
    {
      description: "Store information in long-term memory. The Librarian AI will automatically:\n1. Extract atomic facts from your text\n2. Classify each fact (preference, skill, decision, etc.)\n3. Detect & resolve contradictions with existing knowledge\n4. Calculate Effective Confidence based on model trust\n5. Save provenance (who, where, when)\n\nJust provide the raw text — the system handles the rest.",
      inputSchema: {
        text: z.string().describe("Raw text containing information to remember."),
        subject_key: z.string().optional().default("user_hoon").describe("Primary subject key."),
        project_key: z.string().optional().describe("Project key if relevant."),
        author_model: z.string().optional().describe("Model name or alias (e.g., 'sonnet', 'opus', 'gemini')."),
        platform: z.string().optional().describe("Platform (e.g., 'antigravity', 'claude-code')."),
        session_id: z.string().optional().describe("Unique session identifier."),
      }
    },
    async (args) => {
      const subjectId = await getOrCreateSubject(args.subject_key, 'person');

      let projectId: number | null = null;
      if (args.project_key) {
        projectId = await getOrCreateSubject(args.project_key, 'project');
      }

      const result = await processBatch(
        args.text, 
        subjectId, 
        projectId, 
        args.text,
        {
          author_model: args.author_model,
          platform: args.platform,
          session_id: args.session_id
        }
      );

      // Format result
      const lines: string[] = [];
      lines.push(`📚 Librarian Report (v0.5.3 Provenance Layer)`);
      lines.push(`──────────────────────────────────────────`);
      lines.push(`Extracted: ${result.extracted} | Saved: ${result.saved} | Contradictions: ${result.contradictions_resolved}`);

      if (result.facts.length > 0) {
        lines.push("");
        lines.push("Saved Facts:");
        result.facts.forEach(f => {
          const superseded = f.superseded ? ` (superseded #${f.superseded})` : '';
          lines.push(`  [${f.fact_type}] ${f.content}${superseded}`);
        });
      }

      if (result.errors.length > 0) {
        lines.push("");
        lines.push("⚠️ Errors:");
        result.errors.forEach(e => lines.push(`  ${e}`));
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ═══════════════════════════════════════════════════════════
  // memory_search — Unified Semantic Search
  // ═══════════════════════════════════════════════════════════
  server.registerTool(
    "memory_search",
    {
      description: "Search long-term memory for relevant facts. Combines semantic (vector) search with keyword matching.",
      inputSchema: {
        query: z.string().describe("Search query — can be a question or topic."),
        subject_key: z.string().optional().describe("Filter by subject. Omit for global search."),
        fact_type: z.enum(['preference', 'profile', 'state', 'skill', 'decision', 'learning', 'relationship']).optional().describe("Filter by fact type."),
        tags: z.array(z.string()).optional().describe("Filter by tags."),
        limit: z.number().optional().default(5),
      }
    },
    async (args) => {
      const queryEmbedding = await generateEmbedding(args.query);
      const embeddingSql = vectorToSql(queryEmbedding);

      // ── Base Context ──
      let baseContext = "";
      try {
        const profileRes = await db.query(
          `SELECT content, fact_type FROM facts
           WHERE fact_type IN ('profile', 'preference') AND is_active = TRUE
           ORDER BY importance DESC, updated_at DESC LIMIT 3`
        );
        if (profileRes.rows.length > 0) {
          baseContext = "👤 Base Context:\n";
          profileRes.rows.forEach((r: any) => {
            baseContext += `  • [${r.fact_type}] ${r.content}\n`;
          });
          baseContext += "\n";
        }
      } catch (e) { /* silent */ }

      // ── Search Logic ──
      const params: any[] = [embeddingSql, args.limit, `%${args.query}%`];
      const conditions: string[] = [
        "f.is_active = TRUE",
        `(
          (f.embedding IS NOT NULL AND 1 - (f.embedding <=> $1::vector) > 0.3)
          OR (f.embedding IS NULL AND (f.content ILIKE $3 OR f.tags::text ILIKE $3))
        )`
      ];

      if (args.subject_key) {
        const subId = await getOrCreateSubject(args.subject_key, 'system');
        params.push(subId);
        conditions.push(`(f.subject_id = $${params.length} OR f.project_subject_id = $${params.length})`);
      }

      if (args.fact_type) {
        params.push(args.fact_type);
        conditions.push(`f.fact_type = $${params.length}`);
      }

      if (args.tags && args.tags.length > 0) {
        params.push(args.tags);
        conditions.push(`f.tags && $${params.length}::text[]`);
      }

      const whereClause = conditions.join(" AND ");

      const results = await db.query(
        `SELECT f.id, f.content, f.fact_type, f.confidence, f.importance, f.tags, f.created_at,
                f.effective_confidence, m.model_name as author_model,
                subj.display_name as subject_name,
                proj.display_name as project_name,
                CASE WHEN f.embedding IS NOT NULL
                     THEN 1 - (f.embedding <=> $1::vector)
                     ELSE 0.0
                END AS similarity
         FROM facts f
         LEFT JOIN subjects subj ON f.subject_id = subj.id
         LEFT JOIN subjects proj ON f.project_subject_id = proj.id
         LEFT JOIN models m ON f.author_model_id = m.id
         WHERE ${whereClause}
         ORDER BY similarity DESC, f.importance DESC
         LIMIT $2`,
        params
      );

      if (results.rows.length === 0) {
        return { content: [{ type: "text", text: baseContext + "No relevant memories found." }] };
      }

      // Update access counts
      const ids = results.rows.map((r: any) => r.id);
      await db.query(
        `UPDATE facts SET access_count = access_count + 1, last_accessed_at = NOW() WHERE id = ANY($1::int[])`,
        [ids]
      );

      let formatted = baseContext + "🧠 Recalled Facts:\n\n";
      results.rows.forEach((r: any) => {
        const sim = (r.similarity * 100).toFixed(0);
        const conf = r.effective_confidence ? `${r.effective_confidence} (eff)` : r.confidence;
        const author = r.author_model ? ` | via ${r.author_model}` : '';
        
        formatted += `[#${r.id}] [${r.fact_type}] (imp: ${r.importance}, conf: ${conf}, sim: ${sim}%${author})\n`;
        if (r.subject_name) formatted += `Subject: ${r.subject_name}`;
        if (r.project_name) formatted += ` | Project: ${r.project_name}`;
        if (r.subject_name || r.project_name) formatted += `\n`;
        if (r.tags?.length > 0) formatted += `Tags: ${r.tags.join(", ")}\n`;
        formatted += `Content: ${r.content}\n`;
        formatted += `Date: ${new Date(r.created_at).toLocaleDateString('ko-KR')}\n`;
        formatted += `---\n`;
      });

      return { content: [{ type: "text", text: formatted }] };
    }
  );

  // ═══════════════════════════════════════════════════════════
  // memory_status — Health Check & Statistics
  // ═══════════════════════════════════════════════════════════
  server.registerTool(
    "memory_status",
    {
      description: "Check memory system health and statistics. Shows fact counts by type, recent additions, and system info.",
      inputSchema: {}
    },
    async () => {
      const lines: string[] = [];
      lines.push("📊 Memory Status Report (v0.5.3)");
      lines.push("═══════════════════════════════\n");

      // Total facts
      try {
        const total = await db.query(`SELECT COUNT(*) as count FROM facts WHERE is_active = TRUE`);
        const inactive = await db.query(`SELECT COUNT(*) as count FROM facts WHERE is_active = FALSE`);
        lines.push(`Total active facts: ${total.rows[0].count}`);
        lines.push(`Superseded facts: ${inactive.rows[0].count}`);
        lines.push("");
      } catch (e) { lines.push("⚠️ Could not fetch totals\n"); }

      // Facts by type
      try {
        const byType = await db.query(
          `SELECT fact_type, COUNT(*) as count
           FROM facts WHERE is_active = TRUE
           GROUP BY fact_type ORDER BY count DESC`
        );
        if (byType.rows.length > 0) {
          lines.push("📋 Facts by Type");
          lines.push("────────────────");
          byType.rows.forEach((r: any) => {
            lines.push(`  ${r.fact_type}: ${r.count}`);
          });
          lines.push("");
        }
      } catch (e) { /* silent */ }

      // System info
      lines.push("⚙️ System Info");
      lines.push("─────────────");
      lines.push(`  Version: v0.5.3 (Provenance Layer)`);
      lines.push(`  Librarian Model: ${process.env.LIBRARIAN_MODEL || 'gpt-4o-mini'}`);
      lines.push(`  Embedding Model: text-embedding-3-small`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
