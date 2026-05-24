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
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../db.js";
import { getDefaultUserId } from "../users.js";
import { applyAliasSuggestion } from "../cold_path/project_alias_promoter.js";
import { invalidateCandidateCache } from "../cold_path/tagger.js";

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
      description: `Project tag alias suggestion management tool (Stage 2 / DEVLOG §19).

Actions:
  - list_suggestions: list alias suggestions by status for the default user.
  - confirm_alias: confirm a pending suggestion through applyAliasSuggestion().
  - reject_alias: reject a pending suggestion.
  - set_alias: manually set source_tag as an alias of target_tag through a pending suggestion + applyAliasSuggestion().
  - unset_alias: clear alias_of for one project tag.`,
      inputSchema: {
        action: z.enum([
          "list_suggestions",
          "confirm_alias",
          "reject_alias",
          "set_alias",
          "unset_alias",
        ]).describe("작업 종류"),
        status: statusSchema.optional().describe("list_suggestions status filter (default pending)"),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`list_suggestions limit (default ${DEFAULT_LIMIT})`),
        suggestion_id: z.number().int().positive().optional().describe("confirm_alias/reject_alias 대상 suggestion id"),
        reason: z.string().optional().describe("confirm/reject/set decision reason"),
        source_tag: z.string().optional().describe("set_alias source project_tags.name"),
        target_tag: z.string().optional().describe("set_alias target project_tags.name"),
        tag: z.string().optional().describe("unset_alias 대상 project_tags.name"),
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

        return toolError("unsupported action", { action: args.action });
      } catch (err) {
        return toolError("manage_project_tags failed", { detail: errorDetail(err) });
      }
    }
  );
}
