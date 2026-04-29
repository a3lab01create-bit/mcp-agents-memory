import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";
import { generateEmbedding, vectorToSql } from "./embeddings.js";
import { processBatch } from "./librarian.js";
import { getInjectableSkills, recordSkillExposure, updateOrCreateSkill } from "./skills.js";
import { auditSkill } from "./skill_auditor.js";
import { runCurator } from "./curator.js";
import { restoreMemories, RestoreInputError } from "./forgetting.js";
import { runConnectorSync } from "./connectors/sync.js";
import { processMostRecentPending } from "./transcript_processor.js";
import { PACKAGE_VERSION } from "./version.js";

// ─────────────────────────────────────────────────────────────
// Shared Helpers
// ─────────────────────────────────────────────────────────────

export { getSubjectId, getOrCreateSubject } from "./subjects.js";
import { getSubjectId, getOrCreateSubject } from "./subjects.js";

// ─────────────────────────────────────────────────────────────
// Tool Registration
// ─────────────────────────────────────────────────────────────

export function registerTools(server: McpServer) {

  // ═══════════════════════════════════════════════════════════
  // memory_startup — Smart Briefing (MUST be called first)
  // ═══════════════════════════════════════════════════════════
  server.registerTool(
    "memory_startup",
    {
      description: "🚨 MANDATORY FIRST CALL — Run this at the very start of every new session.\n\nReturns a structured briefing:\n- User profile & preferences\n- Recent project states\n- Key decisions & learnings\n- Active skills (auto-injected know-how)\n\nDo NOT skip this step.",
      inputSchema: {
        user_key: z.string().optional().default(process.env.MEMORY_DEFAULT_SUBJECT || "default_user").describe("User subject key."),
        author_model: z.string().optional().describe("Caller's author model (for skill filtering)."),
        platform: z.string().optional().describe("Caller's platform (for skill filtering)."),
        project_key: z.string().optional().describe("Active project key. Skills scoped to specific projects only inject when this matches; unscoped skills (applicable_to.projects unset) inject regardless."),
      }
    },
    async (args) => {
      const sections: string[] = [];
      sections.push("═══════════════════════════════════════");
      sections.push("🧠 MEMORY BRIEFING — Session Context");
      sections.push("═══════════════════════════════════════\n");

      // 0. Drain the most recent pending transcript so this briefing reflects
      //    the session that just ended. Bounded to 1 row to keep startup
      //    latency under ~10s; remaining backlog flows through the background
      //    processor (transcript_processor.ts).
      try {
        const drained = await processMostRecentPending(1);
        if (drained.processed > 0 || drained.failed > 0 || drained.remaining_pending > 0) {
          sections.push("📝 TRANSCRIPT INTAKE");
          sections.push("───────────────────");
          if (drained.processed > 0) {
            sections.push(`• Just processed: ${drained.processed} session(s)`);
          }
          if (drained.failed > 0) {
            sections.push(`• Failed: ${drained.failed} (check transcript_queue.error)`);
          }
          if (drained.remaining_pending > 0) {
            sections.push(`• Pending in background: ${drained.remaining_pending}`);
          }
          sections.push("");
        }
      } catch (e) { /* silent — startup must never fail */ }

      // 1. User Profile & Preferences
      try {
        const userId = await getOrCreateSubject(args.user_key, 'person');
        const staticProfileRes = await db.query(
          `SELECT content, fact_type, tags
           FROM memories
           WHERE subject_id = $1
             AND fact_type IN ('profile', 'preference')
             AND is_active = TRUE
             AND (
               'profile_static' = ANY(tags)
               OR (NOT ('profile_dynamic' = ANY(tags)) AND NOT ('profile_static' = ANY(tags)))
             )
           ORDER BY importance DESC, updated_at DESC
           LIMIT 8`,
          [userId]
        );
        if (staticProfileRes.rows.length > 0) {
          sections.push("👤 USER PROFILE");
          sections.push("───────────────");
          staticProfileRes.rows.forEach((r: any) => {
            sections.push(`• [${r.fact_type}] ${r.content}`);
            if (r.tags?.length > 0) sections.push(`  tags: ${r.tags.join(', ')}`);
          });
          sections.push("");
        }

        const dynamicProfileRes = await db.query(
          `SELECT content, fact_type, tags
           FROM memories
           WHERE subject_id = $1
             AND fact_type IN ('profile', 'preference')
             AND is_active = TRUE
             AND 'profile_dynamic' = ANY(tags)
           ORDER BY updated_at DESC, importance DESC
           LIMIT 6`,
          [userId]
        );
        if (dynamicProfileRes.rows.length > 0) {
          sections.push("🌊 CURRENT CONTEXT");
          sections.push("────────────────");
          dynamicProfileRes.rows.forEach((r: any) => {
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
                  (SELECT content FROM memories
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
      // Scoped to the current user_key (default_user) — global query previously
      // mixed in facts about other subjects. spec.md §11 cleanup.
      try {
        const userId = await getOrCreateSubject(args.user_key, 'person');
        const decisionRes = await db.query(
          `SELECT content, fact_type, tags, created_at
           FROM memories
           WHERE fact_type IN ('decision', 'learning')
             AND is_active = TRUE
             AND subject_id = $1
           ORDER BY importance DESC, created_at DESC
           LIMIT 5`,
          [userId]
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

      // 4.5. Active Skills (from new skills table — Phase 2)
      try {
        const skills = await getInjectableSkills({
          author_model: args.author_model,
          platform: args.platform,
          project_key: args.project_key,
          limit: 5,
        });
        if (skills.length > 0) {
          sections.push("🛠️ ACTIVE SKILLS");
          sections.push("────────────────");
          skills.forEach((r) => {
            const tierBadge =
              r.validation_tier === 'validated_external' ? '🔬' :
              r.validation_tier === 'validated_internal' ? '✓' :
              r.validation_tier === 'contested' ? '⚠️' :
              r.validation_tier === 'pending_revalidation' ? '⏳' :
              '·';
            sections.push(`${tierBadge} [#${r.id}] ${r.title}`);
            const firstChunk = r.content.split('\n\n')[0].trim().substring(0, 200);
            const truncated = r.content.length > firstChunk.length ? '…' : '';
            sections.push(`   ${firstChunk}${truncated}`);
          });
          sections.push("");
          await recordSkillExposure(skills.map((s) => s.id)).catch(() => {});
        }
      } catch (e) { /* silent fallback — skills table may not exist yet */ }

      // 4. Skills (legacy — fact_type='skill' rows in memories table; the new
      // skills system uses the dedicated skills table shown in section 4.5).
      // Scoped to user_key — global query previously mixed in third-party
      // skill descriptions ingested from transcripts. spec.md §11 cleanup.
      try {
        const userId = await getOrCreateSubject(args.user_key, 'person');
        const skillRes = await db.query(
          `SELECT content, tags
           FROM memories
           WHERE fact_type = 'skill'
             AND is_active = TRUE
             AND subject_id = $1
           ORDER BY importance DESC
           LIMIT 6`,
          [userId]
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
        subject_key: z.string().optional().default(process.env.MEMORY_DEFAULT_SUBJECT || "default_user").describe("Primary subject key."),
        project_key: z.string().optional().describe("Project key if relevant."),
        author_model: z.string().optional().describe("Model name or alias (e.g., 'sonnet', 'opus', 'gemini')."),
        curator_model: z.string().optional().describe('Curator model override — the model running memory_add. Defaults to author_model (Producer == Curator solo case).'),
        agent_key: z.string().optional().describe("Agent persona key (e.g., 'agent_openclaw_reviewer'). Multi-persona harnesses pass this per-call to differentiate personas in calibration data. Defaults to env AGENT_KEY."),
        platform: z.string().optional().describe("Platform (e.g., 'antigravity', 'claude-code')."),
        session_id: z.string().optional().describe("Unique session identifier."),
      }
    },
    async (args) => {
      // Curator identity: agent_platform stays env-driven (harness identity is stable).
      // agent_model is captured per-call via args.curator_model (defaults to
      // args.author_model) — env was wrong because /model can switch mid-session.
      const agentPlatform = process.env.AGENT_PLATFORM;
      const agentKeyRaw = args.agent_key ?? process.env.AGENT_KEY ?? null;
      const agentCuratorId = agentKeyRaw
        ? await getOrCreateSubject(agentKeyRaw, 'agent')
        : null;

      const subjectId = await getOrCreateSubject(args.subject_key, 'person');

      let projectId: number | null = null;
      if (args.project_key) {
        projectId = await getOrCreateSubject(args.project_key, 'project');
      }

      // Default Curator to Producer's model when caller doesn't specify.
      // Producer == Curator is the common case; explicit curator_model is for
      // delegation scenarios (orchestrator saving subagent output).
      const authorModel = args.author_model ?? undefined;
      const curatorModel = args.curator_model ?? args.author_model ?? undefined;
      const platform = args.platform ?? agentPlatform;

      const result = await processBatch(
        args.text,
        subjectId,
        projectId,
        args.text,
        {
          author_model: authorModel,
          platform,
          agent_platform: agentPlatform,
          agent_model: curatorModel,
          agent_curator_id: agentCuratorId,
          session_id: args.session_id
        }
      );

      // Format result
      const lines: string[] = [];
      lines.push(`📚 Librarian Report (v${PACKAGE_VERSION})`);
      lines.push(`──────────────────────────────────────────`);
      lines.push(`Extracted: ${result.extracted} | Saved: ${result.saved} | Deduped: ${result.deduped} | Contradictions: ${result.contradictions_resolved} | Edges: ${result.edges_saved} | Audited: ${result.audited}`);

      if (result.facts.length > 0) {
        lines.push("");
        lines.push("Saved Facts:");
        result.facts.forEach(f => {
          const tag = f.deduped
            ? ` (deduped → access_count++ on #${f.id})`
            : f.superseded
              ? ` (superseded #${f.superseded})`
              : '';
          lines.push(`  [${f.fact_type}] ${f.content}${tag}`);
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
  // memory_save_skill — Explicit Skill Storage
  // ═══════════════════════════════════════════════════════════
  server.registerTool(
    "memory_save_skill",
    {
      description: "Explicitly save a reusable skill. The Skill Updater compares it against active skills and decides whether to accumulate, branch, or create.",
      inputSchema: {
        title: z.string().describe("Short skill title."),
        content: z.string().describe("Reusable skill content or rule body."),
        source_memory_ids: z.array(z.number()).optional().describe("Memory IDs that produced this skill."),
        author_model: z.string().optional().describe("Model name or alias that authored the skill."),
        platform: z.string().optional().describe("Platform where the skill was authored."),
        project_key: z.string().optional().describe("Project subject key. If set, skill is scoped to this project (only injects when memory_startup gets matching project_key). Omit for cross-project skills."),
        agent_key: z.string().optional().describe("Agent persona key. See memory_add for details."),
        audit: z.boolean().optional().default(true).describe("Run Skill Auditor before saving. Default: true."),
      }
    },
    async (args) => {
      const candidate = {
        title: args.title,
        content: args.content,
        source_memory_ids: args.source_memory_ids,
        author_model: args.author_model,
        platform: args.platform,
        project_key: args.project_key,
      };
      const agentKeyRaw = args.agent_key ?? process.env.AGENT_KEY ?? null;
      const agentCuratorId = agentKeyRaw
        ? await getOrCreateSubject(agentKeyRaw, 'agent')
        : null;
      const audited = args.audit !== false ? await auditSkill(candidate) : undefined;
      const result = await updateOrCreateSkill(candidate, audited, agentCuratorId);
      const validationTier = audited?.validation_tier ?? 'unvalidated';
      const auditReasoning = audited?.audit_reasoning ?? 'audit disabled';
      const sourcesCount = audited?.sources.length ?? 0;

      const lines: string[] = [];
      lines.push(`SKILL ${result.action.toUpperCase()}`);
      lines.push(`Skill ID: ${result.skill_id}`);
      lines.push(`Similarity: ${(result.similarity * 100).toFixed(1)}%`);
      lines.push(`validation_tier: ${validationTier}`);
      lines.push(`sources_count: ${sourcesCount}`);
      lines.push(`audit_reasoning: ${auditReasoning}`);
      if (result.parent_skill_id) lines.push(`Parent Skill ID: ${result.parent_skill_id}`);

      if (result.action === 'accumulated') {
        lines.push("Appended this candidate to the matched skill changelog.");
      } else if (result.action === 'branched') {
        lines.push("Created a new active skill version linked to the matched parent.");
      } else {
        lines.push("Created a new root skill.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ═══════════════════════════════════════════════════════════
  // memory_curator_run — Explicit Skill Curator Trigger
  // ═══════════════════════════════════════════════════════════
  server.registerTool(
    "memory_curator_run",
    {
      description: "Run the Skill Curator: scan active memories for semantic clusters, auto-extract reusable know-how into skills. Use dry_run: true to see candidates without saving.",
      inputSchema: {
        subject_key: z.string().optional().describe("Limit scan to a subject key."),
        project_key: z.string().optional().describe("Limit scan to a project key."),
        dry_run: z.boolean().optional().default(false).describe("Preview candidates without saving skills."),
        min_cluster_size: z.number().optional().describe("Minimum memory count per cluster."),
        similarity_threshold: z.number().optional().describe("Minimum cosine similarity for cluster membership."),
        min_importance: z.number().optional().describe("Minimum average importance for accepted clusters."),
        max_clusters: z.number().optional().describe("Maximum clusters to analyze in one run."),
        agent_key: z.string().optional().describe("Agent persona key for the curator caller. Auto-promotion loop passes none (NULL)."),
      }
    },
    async (args) => {
      const agentKeyRaw = args.agent_key ?? process.env.AGENT_KEY ?? null;
      const agentCuratorId = agentKeyRaw
        ? await getOrCreateSubject(agentKeyRaw, 'agent')
        : null;

      const result = await runCurator({
        subjectKey: args.subject_key,
        projectKey: args.project_key,
        dryRun: args.dry_run,
        minClusterSize: args.min_cluster_size,
        similarityThreshold: args.similarity_threshold,
        minImportance: args.min_importance,
        maxClusters: args.max_clusters,
        agentCuratorId,
      });

      const lines: string[] = [];
      lines.push(`SKILL CURATOR ${result.dry_run ? 'DRY RUN' : 'RUN'}`);
      lines.push(`Scanned memories: ${result.scanned_memories}`);
      lines.push(`Clusters found: ${result.clusters_found}`);
      lines.push(`Clusters skipped: ${result.clusters_skipped}`);
      lines.push(`Skills saved: ${result.skills_saved}`);

      if (result.candidates.length > 0) {
        lines.push("");
        lines.push("Candidates:");
        result.candidates.forEach((candidate, idx) => {
          const ids = candidate.cluster.member_ids.join(", ");
          const label = candidate.covered
            ? "covered"
            : candidate.skill_worthy
              ? "skill-worthy"
              : "not-worthy";
          lines.push(`${idx + 1}. ${label} | size=${candidate.cluster.size} | avg_importance=${candidate.cluster.avg_importance.toFixed(1)} | memories=[${ids}]`);
          if (candidate.title) lines.push(`   Title: ${candidate.title}`);
          lines.push(`   Reason: ${candidate.reason}`);
          if (candidate.skill_result) {
            lines.push(`   Saved: ${candidate.skill_result.action} skill #${candidate.skill_result.skill_id}`);
          }
          if (candidate.error) {
            lines.push(`   Error: ${candidate.error}`);
          }
        });
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
        expand_via_graph: z.boolean().optional().default(false).describe("When subject_key is set, also include memories whose subject is 1 hop away via subject_relationships. Off by default."),
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
          `SELECT content, fact_type FROM memories
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
        const subId = await getSubjectId(args.subject_key);
        if (subId === null) {
          return { content: [{ type: "text", text: baseContext + `No memories found for subject_key='${args.subject_key}' (subject does not exist)` }] };
        }
        if (args.expand_via_graph) {
          const neighbors = await db.query(
            `SELECT $1::int AS id
             UNION
             SELECT to_subject_id FROM subject_relationships WHERE from_subject_id = $1
             UNION
             SELECT from_subject_id FROM subject_relationships WHERE to_subject_id = $1`,
            [subId]
          );
          const ids = neighbors.rows.map((r: any) => r.id);
          params.push(ids);
          conditions.push(`(f.subject_id = ANY($${params.length}::int[]) OR f.project_subject_id = ANY($${params.length}::int[]))`);
        } else {
          params.push(subId);
          conditions.push(`(f.subject_id = $${params.length} OR f.project_subject_id = $${params.length})`);
        }
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
                m.model_name as author_model,
                subj.display_name as subject_name,
                proj.display_name as project_name,
                CASE WHEN f.embedding IS NOT NULL
                     THEN 1 - (f.embedding <=> $1::vector)
                     ELSE 0.0
                END AS similarity
         FROM memories f
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
        `UPDATE memories SET access_count = access_count + 1, last_accessed_at = NOW() WHERE id = ANY($1::int[])`,
        [ids]
      );

      let formatted = baseContext + "🧠 Recalled Facts:\n\n";
      results.rows.forEach((r: any) => {
        const sim = (r.similarity * 100).toFixed(0);
        const author = r.author_model ? ` | via ${r.author_model}` : '';

        formatted += `[#${r.id}] [${r.fact_type}] (imp: ${r.importance}, conf: ${r.confidence}, sim: ${sim}%${author})\n`;
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
      lines.push(`📊 Memory Status Report (v${PACKAGE_VERSION})`);
      lines.push("═══════════════════════════════\n");

      // Total facts
      try {
        const total = await db.query(`SELECT COUNT(*) as count FROM memories WHERE is_active = TRUE`);
        const superseded = await db.query(
          `SELECT COUNT(*) as count FROM memories
           WHERE is_active = FALSE AND superseded_by IS NOT NULL`
        );
        lines.push(`Total active facts: ${total.rows[0].count}`);
        lines.push(`Superseded facts: ${superseded.rows[0].count}`);
        lines.push("");
      } catch (e) { lines.push("⚠️ Could not fetch totals\n"); }

      // Facts by type
      try {
        const byType = await db.query(
          `SELECT fact_type, COUNT(*) as count
           FROM memories WHERE is_active = TRUE
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

      // Memory Graph (v5.0)
      try {
        const totalEdges = await db.query(`SELECT COUNT(*)::int AS count FROM subject_relationships`);
        const byRel = await db.query(
          `SELECT relationship_type, COUNT(*)::int AS count
           FROM subject_relationships
           GROUP BY relationship_type ORDER BY count DESC`
        );
        const total = totalEdges.rows[0]?.count ?? 0;
        if (total > 0 || byRel.rows.length > 0) {
          lines.push("🕸️ Memory Graph");
          lines.push("───────────────");
          lines.push(`  Total edges: ${total}`);
          byRel.rows.forEach((r: any) => {
            lines.push(`  ${r.relationship_type}: ${r.count}`);
          });
          lines.push("");
        }
      } catch (e) { /* silent — table may not exist yet */ }

      // Auto Forgetting (v5.0 Phase 3)
      try {
        const forgottenTotal = await db.query(
          `SELECT COUNT(*)::int AS count FROM memories
           WHERE is_active = FALSE AND metadata ? 'forgotten_at'`
        );
        const byTypeForgotten = await db.query(
          `SELECT fact_type, COUNT(*)::int AS count FROM memories
           WHERE is_active = FALSE AND metadata ? 'forgotten_at'
           GROUP BY fact_type ORDER BY count DESC`
        );
        const total = forgottenTotal.rows[0]?.count ?? 0;
        if (total > 0) {
          lines.push("🗑️ Forgetting");
          lines.push("─────────────");
          lines.push(`  Total forgotten: ${total}`);
          byTypeForgotten.rows.forEach((r: any) => {
            lines.push(`  ${r.fact_type}: ${r.count}`);
          });
          lines.push("");
        }
      } catch (e) { /* silent — metadata column may not exist on older deployments */ }

      // System info
      lines.push("⚙️ System Info");
      lines.push("─────────────");
      lines.push(`  Version: ${PACKAGE_VERSION}`);
      lines.push(`  Librarian Model: ${process.env.LIBRARIAN_MODEL || 'gpt-4o-mini'}`);
      lines.push(`  Embedding Model: text-embedding-3-small`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ═══════════════════════════════════════════════════════════
  // memory_restore — kill-switch for Auto Forgetting (v5.0)
  // Restores soft-deleted memories that were forgotten by the
  // decay loop. Refuses to revive superseded rows (those were
  // intentionally replaced and the newer fact is canonical).
  // ═══════════════════════════════════════════════════════════
  server.registerTool(
    "memory_restore",
    {
      description:
        "Restore memories that were soft-deleted by Auto Forgetting (v5.0). Provide either `memory_id` for a single restore, or `since_minutes` to bulk-restore everything forgotten in the last N minutes (useful when forgetting fired too aggressively). Use `dry_run` to preview without changes. Only restores rows with metadata.forgotten_at — superseded rows are intentionally replaced and cannot be revived through this tool.",
      inputSchema: {
        memory_id: z.number().int().positive().optional().describe("Restore this specific memory id."),
        since_minutes: z.number().int().positive().optional().describe("Restore all forgotten rows whose forgotten_at falls in the last N minutes."),
        dry_run: z.boolean().optional().default(false).describe("Preview which rows would be restored without flipping is_active."),
      }
    },
    async (args) => {
      try {
        const result = await restoreMemories({
          memoryId: args.memory_id,
          sinceMinutes: args.since_minutes,
          dryRun: args.dry_run,
        });

        if (result.rows.length === 0) {
          const reason = args.memory_id
            ? `No restorable memory with id=${args.memory_id} (either active already, never forgotten, or superseded — superseded rows cannot be restored).`
            : `No memories were forgotten in the last ${args.since_minutes} minutes.`;
          return { content: [{ type: "text", text: `ℹ️ ${reason}` }] };
        }

        const heading = result.dry_run
          ? `🔍 Dry-run — ${result.rows.length} memory/memories would be restored:`
          : `♻️ Restored ${result.rows.length} memory/memories:`;
        const lines = [heading, ""];
        result.rows.forEach((r) => {
          const preview = String(r.content).slice(0, 80).replace(/\s+/g, " ");
          const tail = String(r.content).length > 80 ? "…" : "";
          if (result.dry_run) {
            lines.push(`  [#${r.id}] (${r.fact_type}) forgotten_at=${r.forgotten_at ?? "?"}`);
            lines.push(`    "${preview}${tail}"`);
          } else {
            lines.push(`  [#${r.id}] (${r.fact_type}) "${preview}${tail}"`);
          }
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        if (err instanceof RestoreInputError) {
          return { content: [{ type: "text", text: `❌ ${err.message}` }], isError: true };
        }
        throw err;
      }
    }
  );

  // ═══════════════════════════════════════════════════════════
  // connector_sync — pull external content into memory (v5.0 Phase 3)
  // v1: Notion only. Manual trigger; auto-polling deferred.
  // ═══════════════════════════════════════════════════════════
  server.registerTool(
    "connector_sync",
    {
      description:
        "Sync external content into memory via a Connector. v1 supports Notion only. Provide either a `page` id (top-level blocks of one page) or a `database` id (iterates child pages). Hash-based dedup via memory_sources table — re-syncing unchanged content is a no-op. Requires NOTION_API_KEY in your config.",
      inputSchema: {
        provider: z.enum(["notion"]).describe("Connector provider. Only 'notion' is implemented in v1."),
        external_id: z.string().min(1).describe("Notion page id (UUID-like)."),
        resource_type: z.enum(["page"]).default("page").describe("v1 only supports 'page'. Database/multi-page sync arrives with the next connector slice."),
      },
    },
    async (args) => {
      try {
        const result = await runConnectorSync({
          provider: args.provider,
          external_id: args.external_id,
          resource_type: args.resource_type,
        });

        const lines = [
          `🔌 connector_sync(${args.provider}, ${args.resource_type}) result:`,
          ``,
          `  pages seen:                ${result.pages_seen}`,
          `  pages synced (changed):    ${result.pages_synced}`,
          `  pages skipped (unchanged): ${result.pages_skipped_unchanged}`,
          `  facts added:               ${result.facts_added}`,
        ];
        if (result.errors.length > 0) {
          lines.push(``, `⚠️  ${result.errors.length} error(s):`);
          result.errors.slice(0, 10).forEach((e) => lines.push(`    - ${e}`));
          if (result.errors.length > 10) lines.push(`    … (${result.errors.length - 10} more)`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `❌ connector_sync failed: ${err?.message ?? err}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------
  // 5. Prompts (Slash Commands)
  // ---------------------------------------------------------
  server.prompt(
    "briefing",
    "Get a full briefing of the user profile and project state.",
    {},
    (args) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: "Please run the 'memory_startup' tool and provide me with a summary of who I am and what we were working on."
        }
      }]
    })
  );

  server.prompt(
    "recall",
    "Recall information from long-term memory.",
    { query: z.string().describe("Search query") },
    (args) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Please use the 'memory_search' tool with the query: "${args.query}" and tell me what you found.`
        }
      }]
    })
  );

  server.prompt(
    "save",
    "Save a new fact or decision to memory.",
    { text: z.string().describe("Information to save") },
    (args) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Please use the 'memory_add' tool to store this information: "${args.text}"`
        }
      }]
    })
  );
}
