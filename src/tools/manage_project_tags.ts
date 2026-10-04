/**
 * manage_project_tags — project tag alias suggestion management MCP tool.
 *
 * Stage 2 / DEVLOG §19:
 *   - list pending/terminal alias suggestions
 *   - confirm/reject suggestions
 *   - manually set/unset project tag aliases
 *
 * confirm_alias and set_alias deliberately reuse applyAliasSuggestion() so the
 * write-side cycle guard, supersede behavior, and tagger cache invalidation
 * stay centralized in project_alias_promoter.ts.
 *
 * New project tag suggestions (0.9.25, dtag_promoter.ts): the d_tag promoter no
 * longer creates project tags itself; it leaves a suggestion with a
 * recommendation (project / generic / unsure) and a person decides here.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../db.js";
import { getDefaultUserId } from "../users.js";
import { applyAliasSuggestion } from "../cold_path/project_alias_promoter.js";
import { invalidateCandidateCache } from "../cold_path/tagger.js";
import {
  confirmNewTagSuggestion,
  rejectNewTagSuggestion,
  type NewTagDecision,
} from "../cold_path/dtag_promoter.js";
import { parseRecommendation, planApplyRecommendations } from "../cold_path/dtag_suggest_gate.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const statusSchema = z.enum([
  "pending",
  "confirmed",
  "rejected",
  "auto_applied",
  "superseded",
  "expired",
]);

interface ProjectTagRow {
  id: number;
  name: string;
  aliasOf: number | null;
}

function ok(payload: any) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function toolError(message: string, extra?: any) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...extra }, null, 2) }],
  };
}

function normalizeTagName(name: string | undefined): string | null {
  const normalized = name?.toLowerCase().trim();
  return normalized ? normalized : null;
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function lookupProjectTagByName(name: string): Promise<ProjectTagRow | null> {
  const result = await db.query(
    `SELECT id, name, alias_of
       FROM project_tags
      WHERE name = $1
      LIMIT 1`,
    [name]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: Number(row.id),
    name: String(row.name),
    aliasOf: row.alias_of == null ? null : Number(row.alias_of),
  };
}

async function lookupSuggestionForUser(
  userId: number,
  suggestionId: number
): Promise<{ id: number; status: string } | null> {
  const result = await db.query(
    `SELECT id, status
       FROM project_tag_alias_suggestions
      WHERE id = $1
        AND user_id = $2
      LIMIT 1`,
    [suggestionId, userId]
  );
  if (result.rows.length === 0) return null;
  return {
    id: Number(result.rows[0].id),
    status: String(result.rows[0].status),
  };
}

async function listSuggestions(userId: number, status: string, limit: number) {
  const result = await db.query(
    `SELECT s.id,
            source.name AS source_tag_name,
            target.name AS target_tag_name,
            s.relation,
            s.confidence,
            s.rationale,
            s.created_at
       FROM project_tag_alias_suggestions s
       JOIN project_tags source ON source.id = s.source_tag_id
       JOIN project_tags target ON target.id = s.target_tag_id
      WHERE s.user_id = $1
        AND s.status = $2
      ORDER BY s.created_at DESC
      LIMIT $3`,
    [userId, status, limit]
  );

  const suggestions = result.rows.map((row: any) => ({
    suggestion_id: Number(row.id),
    source_tag: String(row.source_tag_name),
    target_tag: String(row.target_tag_name),
    relation: String(row.relation),
    confidence: Number(row.confidence),
    rationale: String(row.rationale ?? ""),
    created_at: row.created_at,
  }));

  return ok({
    action: "list_suggestions",
    status,
    limit,
    count: suggestions.length,
    suggestions,
  });
}

async function confirmAlias(userId: number, suggestionId: number, reason: string | undefined) {
  const suggestion = await lookupSuggestionForUser(userId, suggestionId);
  if (!suggestion) {
    return toolError("suggestion_id not found for current user", { suggestion_id: suggestionId });
  }
  if (suggestion.status !== "pending") {
    return toolError("suggestion is not pending", {
      suggestion_id: suggestionId,
      status: suggestion.status,
    });
  }

  const result = await applyAliasSuggestion(suggestionId, {
    decidedBy: "user",
    reason,
  });

  return ok({
    action: "confirm_alias",
    ...result,
  });
}

async function rejectAlias(userId: number, suggestionId: number, reason: string | undefined) {
  const suggestion = await lookupSuggestionForUser(userId, suggestionId);
  if (!suggestion) {
    return toolError("suggestion_id not found for current user", { suggestion_id: suggestionId });
  }
  if (suggestion.status !== "pending") {
    return toolError("suggestion is not pending", {
      suggestion_id: suggestionId,
      status: suggestion.status,
    });
  }

  const result = await db.query(
    `UPDATE project_tag_alias_suggestions
        SET status = 'rejected',
            decided_by = 'user',
            decision_reason = $3,
            decided_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND status = 'pending'
      RETURNING id, status, decision_reason, decided_at`,
    [suggestionId, userId, reason ?? null]
  );

  if (result.rows.length === 0) {
    return toolError("suggestion could not be rejected because it is no longer pending", {
      suggestion_id: suggestionId,
    });
  }

  const row = result.rows[0];
  return ok({
    action: "reject_alias",
    suggestion_id: Number(row.id),
    rejected: true,
    status: String(row.status),
    reason: row.decision_reason,
    decided_at: row.decided_at,
  });
}

async function listNewTags(userId: number, status: string, limit: number) {
  const result = await db.query(
    `SELECT id, name, uses, recommendation, rationale, created_at, last_seen_at,
            decided_by, decision_reason, decided_at
       FROM project_tag_new_suggestions
      WHERE user_id = $1
        AND status = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [userId, status, limit]
  );
  const suggestions = result.rows.map((row: any) => ({
    suggestion_id: Number(row.id),
    name: String(row.name),
    uses: Number(row.uses),
    recommendation: row.recommendation ?? null,
    rationale: String(row.rationale ?? ""),
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    decided_by: row.decided_by ?? null,
    decision_reason: row.decision_reason ?? null,
    decided_at: row.decided_at ?? null,
  }));
  return ok({ action: "list_new_tags", status, limit, count: suggestions.length, suggestions });
}

function decisionResult(action: string, result: NewTagDecision) {
  if (result.error) return toolError(result.error, { action, ...result });
  return ok({ action, ...result });
}

/**
 * "추천대로" — 사람에게 보여 준 번호만 처리한다: project=승인, generic=반려, unsure·추천 없음=그대로.
 * 번호를 받는 이유: 보여 준 뒤에 새로 생긴 제안까지 사람이 본 적 없이 처리하지 않게.
 */
async function applyRecommendations(userId: number, ids: number[], reason: string | undefined) {
  const rows = await db.query(
    `SELECT id, name, status, recommendation
       FROM project_tag_new_suggestions
      WHERE user_id = $1
        AND id = ANY($2::bigint[])`,
    [userId, ids]
  );
  const names = new Map<number, string>(rows.rows.map((r: any) => [Number(r.id), String(r.name)]));
  const plan = planApplyRecommendations(
    ids,
    rows.rows.map((r: any) => ({
      id: Number(r.id),
      status: String(r.status),
      recommendation: parseRecommendation(r.recommendation),
    }))
  );
  const why = reason ? `apply_recommendations: ${reason}` : "apply_recommendations";
  const confirmed: NewTagDecision[] = [];
  const rejected: NewTagDecision[] = [];
  const failed: NewTagDecision[] = [];
  // 한 번호가 실패해도 나머지는 계속하고, 어느 번호가 실패했는지 남긴다
  const decide = async (id: number, fn: typeof confirmNewTagSuggestion, done: NewTagDecision[]) => {
    try {
      const r = await fn(userId, id, { decidedBy: "user", reason: why });
      (r.error ? failed : done).push(r);
    } catch (err) {
      failed.push({ suggestion_id: id, name: names.get(id) ?? "", status: "error", error: errorDetail(err) });
    }
  };
  for (const id of plan.confirm) await decide(id, confirmNewTagSuggestion, confirmed);
  for (const id of plan.reject) await decide(id, rejectNewTagSuggestion, rejected);
  const label = (id: number) => ({ suggestion_id: id, name: names.get(id) ?? null });
  return ok({
    action: "apply_recommendations",
    confirmed,
    rejected,
    kept_pending: plan.keep.map(label),
    skipped_not_pending: plan.skipped.map(label),
    failed,
  });
}

/**
 * 프로젝트 명부(DEVLOG §24 L1). 명부에 한 줄이라도 있으면 태거는 명부에서만 고른다.
 * 설명은 필수 — 태거가 언제 이 이름을 붙일지 보는 안내문이다.
 */
async function listRegistry() {
  const result = await db.query(
    `SELECT pt.name, pt.kind, pt.paused, pt.description,
            (SELECT string_agg(a.name, ',' ORDER BY a.name) FROM project_tags a WHERE a.alias_of = pt.id) AS aliases,
            (SELECT count(*) FROM memory m
              WHERE m.p_tag_id IS NOT NULL AND m.created_at >= NOW() - INTERVAL '30 days'
                AND canonical_project_tag_id(m.p_tag_id) = pt.id)::int AS uses_30d
       FROM project_tags pt
      WHERE pt.kind IS NOT NULL
      ORDER BY pt.kind, pt.paused, pt.name`
  );
  return ok({
    action: "list_registry",
    registry_mode: result.rows.length > 0,
    count: result.rows.length,
    entries: result.rows.map((r: any) => ({
      name: String(r.name),
      kind: String(r.kind),
      paused: r.paused === true,
      description: r.description ?? null,
      aliases: r.aliases ? String(r.aliases).split(",") : [],
      uses_30d: Number(r.uses_30d),
    })),
  });
}

async function registerProject(
  tagName: string | undefined,
  description: string | undefined,
  kind: "project" | "category" | undefined,
  paused: boolean | undefined
) {
  const name = normalizeTagName(tagName);
  if (!name) return toolError("tag is required for register_project");
  const desc = description?.trim();
  if (!desc) return toolError("description is required for register_project (one line: what belongs here)");
  const existing = await lookupProjectTagByName(name);
  if (existing?.aliasOf != null) {
    return toolError("tag is an alias of another tag; register the canonical tag instead", { tag: name });
  }
  const result = await db.query(
    `INSERT INTO project_tags (name, kind, description, paused)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (name) DO UPDATE
       SET kind = EXCLUDED.kind, description = EXCLUDED.description, paused = EXCLUDED.paused, updated_at = NOW()
     RETURNING id, (xmax = 0) AS created`,
    [name, kind ?? "project", desc, paused === true]
  );
  invalidateCandidateCache();
  return ok({
    action: "register_project",
    tag: name,
    kind: kind ?? "project",
    paused: paused === true,
    description: desc,
    project_tag_id: Number(result.rows[0].id),
    created: result.rows[0].created === true,
  });
}

async function unregisterProject(tagName: string | undefined) {
  const name = normalizeTagName(tagName);
  if (!name) return toolError("tag is required for unregister_project");
  const result = await db.query(
    `UPDATE project_tags SET kind = NULL, paused = FALSE, updated_at = NOW()
      WHERE name = $1 AND kind IS NOT NULL
     RETURNING id`,
    [name]
  );
  if (result.rows.length === 0) return toolError("tag is not in the registry", { tag: name });
  invalidateCandidateCache();
  return ok({ action: "unregister_project", tag: name, removed: true });
}

async function setAlias(
  userId: number,
  sourceTagName: string | undefined,
  targetTagName: string | undefined,
  reason: string | undefined
) {
  const sourceName = normalizeTagName(sourceTagName);
  const targetName = normalizeTagName(targetTagName);
  if (!sourceName) return toolError("source_tag is required for set_alias");
  if (!targetName) return toolError("target_tag is required for set_alias");

  const sourceTag = await lookupProjectTagByName(sourceName);
  if (!sourceTag) {
    return toolError("source_tag not found in project_tags", { source_tag: sourceName });
  }

  const targetTag = await lookupProjectTagByName(targetName);
  if (!targetTag) {
    return toolError("target_tag not found in project_tags", { target_tag: targetName });
  }

  if (sourceTag.id === targetTag.id) {
    return toolError("source_tag and target_tag must be different", {
      source_tag: sourceTag.name,
      target_tag: targetTag.name,
    });
  }

  const insertResult = await db.query(
    `INSERT INTO project_tag_alias_suggestions (
       user_id,
       source_tag_id,
       target_tag_id,
       relation,
       status,
       confidence,
       candidate_sources,
       signals,
       rationale,
       decided_by
     )
     VALUES (
       $1, $2, $3, 'alias', 'pending', 1.0,
       ARRAY['manual_set_alias']::text[],
       $4::jsonb,
       'manual set_alias',
       'user'
     )
     ON CONFLICT (
       user_id,
       (LEAST(source_tag_id, target_tag_id)),
       (GREATEST(source_tag_id, target_tag_id))
     )
     WHERE status = 'pending'
     DO UPDATE SET
       source_tag_id = EXCLUDED.source_tag_id,
       target_tag_id = EXCLUDED.target_tag_id,
       relation = EXCLUDED.relation,
       confidence = EXCLUDED.confidence,
       candidate_sources = EXCLUDED.candidate_sources,
       signals = EXCLUDED.signals,
       rationale = EXCLUDED.rationale,
       decided_by = EXCLUDED.decided_by,
       decision_reason = NULL,
       decided_at = NULL,
       applied_at = NULL,
       updated_at = NOW()
     RETURNING id`,
    [
      userId,
      sourceTag.id,
      targetTag.id,
      JSON.stringify({
        manual: true,
        action: "set_alias",
        source_tag: sourceTag.name,
        target_tag: targetTag.name,
      }),
    ]
  );

  const suggestionId = Number(insertResult.rows[0].id);
  const result = await applyAliasSuggestion(suggestionId, {
    decidedBy: "user",
    reason: reason ?? "manual set_alias",
  });

  return ok({
    action: "set_alias",
    source_tag: sourceTag.name,
    target_tag: targetTag.name,
    ...result,
  });
}

async function unsetAlias(userId: number, tagName: string | undefined) {
  const normalized = normalizeTagName(tagName);
  if (!normalized) return toolError("tag is required for unset_alias");

  const tag = await lookupProjectTagByName(normalized);
  if (!tag) {
    return toolError("tag not found in project_tags", { tag: normalized });
  }

  const result = await db.query(
    `UPDATE project_tags
        SET alias_of = NULL,
            updated_at = NOW()
      WHERE id = $1
        AND alias_of IS NOT NULL
      RETURNING id, name`,
    [tag.id]
  );

  if (result.rows.length === 0) {
    return ok({
      action: "unset_alias",
      tag: tag.name,
      alias_removed: false,
      reason: "tag is not currently an alias",
      user_id: userId,
    });
  }

  invalidateCandidateCache();
  return ok({
    action: "unset_alias",
    tag: String(result.rows[0].name),
    alias_removed: true,
    user_id: userId,
  });
}

export function registerManageProjectTags(server: McpServer): void {
  server.registerTool(
    "manage_project_tags",
    {
      description: `Project tag suggestion management tool (Stage 2 / DEVLOG §19).

Alias suggestions (two existing tags look like the same project):
  - list_suggestions: list alias suggestions by status for the default user.
  - confirm_alias: confirm a pending suggestion through applyAliasSuggestion().
  - reject_alias: reject a pending suggestion.
  - set_alias: manually set source_tag as an alias of target_tag through a pending suggestion + applyAliasSuggestion().
  - unset_alias: clear alias_of for one project tag.

Project registry (the short, human-chosen list the tagger picks from — DEVLOG §24). When the registry has at least one entry, the tagger only assigns registry tags (or their aliases) and never invents names:
  - list_registry: show registry entries (kind, paused, description, aliases, 30-day uses).
  - register_project: add or update an entry. tag + description (one line: what belongs here) required; kind = project (default) or category (not a project but a standing bucket, e.g. personal facts); paused = true keeps it as a tagger candidate but hides it from "active projects".
  - unregister_project: take a tag off the registry (the tag and its old memories stay).

New project tag suggestions (a frequent d_tag that is not a project tag yet; ids are separate from alias ids; not created while the registry is in use):
  - list_new_tags: list them by status (pending / confirmed / rejected / superseded). Each has a recommendation (project / generic / unsure) and uses = how often that d_tag was used in the window.
  - confirm_new_tag: create the project tag and retro-tag untagged memories carrying that exact d_tag.
  - reject_new_tag: reject it; a rejected name is never suggested again.
  - apply_recommendations: when the user accepts the recommendations ("추천대로"), pass the suggestion_ids that were shown to them. project → confirmed, generic → rejected, unsure / no recommendation → left pending for the user to decide.`,
      inputSchema: {
        action: z.enum([
          "list_suggestions",
          "confirm_alias",
          "reject_alias",
          "set_alias",
          "unset_alias",
          "list_new_tags",
          "confirm_new_tag",
          "reject_new_tag",
          "apply_recommendations",
          "list_registry",
          "register_project",
          "unregister_project",
        ]).describe("작업 종류"),
        status: statusSchema.optional().describe("list_suggestions / list_new_tags status filter (default pending)"),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`list_suggestions / list_new_tags limit (default ${DEFAULT_LIMIT})`),
        suggestion_id: z.number().int().positive().optional().describe("confirm_alias/reject_alias/confirm_new_tag/reject_new_tag 대상 suggestion id"),
        suggestion_ids: z.array(z.number().int().positive()).min(1).max(MAX_LIMIT).optional().describe("apply_recommendations: 사용자에게 보여 준 새 태그 제안 id 목록"),
        reason: z.string().optional().describe("confirm/reject/set decision reason"),
        source_tag: z.string().optional().describe("set_alias source project_tags.name"),
        target_tag: z.string().optional().describe("set_alias target project_tags.name"),
        tag: z.string().optional().describe("unset_alias / register_project / unregister_project 대상 project_tags.name"),
        description: z.string().optional().describe("register_project: 한 줄 설명(무엇이 여기 속하나) — 태거 안내문"),
        kind: z.enum(["project", "category"]).optional().describe("register_project: project(기본) 또는 category"),
        paused: z.boolean().optional().describe("register_project: 멈춘 프로젝트면 true"),
      },
    },
    async (args) => {
      try {
        const userId = await getDefaultUserId();

        if (args.action === "list_suggestions") {
          return listSuggestions(
            userId,
            args.status ?? "pending",
            args.limit ?? DEFAULT_LIMIT
          );
        }

        if (args.action === "confirm_alias") {
          if (args.suggestion_id == null) {
            return toolError("suggestion_id is required for confirm_alias");
          }
          return confirmAlias(userId, args.suggestion_id, args.reason);
        }

        if (args.action === "reject_alias") {
          if (args.suggestion_id == null) {
            return toolError("suggestion_id is required for reject_alias");
          }
          return rejectAlias(userId, args.suggestion_id, args.reason);
        }

        if (args.action === "set_alias") {
          return setAlias(userId, args.source_tag, args.target_tag, args.reason);
        }

        if (args.action === "unset_alias") {
          return unsetAlias(userId, args.tag);
        }

        if (args.action === "list_registry") {
          return listRegistry();
        }

        if (args.action === "register_project") {
          return registerProject(args.tag, args.description, args.kind, args.paused);
        }

        if (args.action === "unregister_project") {
          return unregisterProject(args.tag);
        }

        if (args.action === "list_new_tags") {
          return listNewTags(userId, args.status ?? "pending", args.limit ?? DEFAULT_LIMIT);
        }

        if (args.action === "confirm_new_tag" || args.action === "reject_new_tag") {
          if (args.suggestion_id == null) {
            return toolError(`suggestion_id is required for ${args.action}`);
          }
          const decide = args.action === "confirm_new_tag" ? confirmNewTagSuggestion : rejectNewTagSuggestion;
          return decisionResult(args.action, await decide(userId, args.suggestion_id, { decidedBy: "user", reason: args.reason }));
        }

        if (args.action === "apply_recommendations") {
          if (!args.suggestion_ids?.length) {
            return toolError("suggestion_ids is required for apply_recommendations");
          }
          return applyRecommendations(userId, args.suggestion_ids, args.reason);
        }

        return toolError("unsupported action", { action: args.action });
      } catch (err) {
        return toolError("manage_project_tags failed", { detail: errorDetail(err) });
      }
    }
  );
}
