import { db } from "./db.js";
import { generateEmbedding, vectorToSql } from "./embeddings.js";
import { resolveModel, resolvePlatform } from "./librarian.js";
import type { AuditedSkillCandidate, ValidationTier } from "./skill_auditor.js";

export const ACCUMULATE_THRESHOLD = 0.90;
export const BRANCH_THRESHOLD = 0.70;

export interface SkillCandidate {
  title: string;
  content: string;
  source_memory_ids?: number[];
  author_model?: string;
  platform?: string;
  project_key?: string;
}

export type SkillUpdateAction = 'accumulated' | 'branched' | 'created';

export interface SkillUpdateResult {
  action: SkillUpdateAction;
  skill_id: number;
  parent_skill_id: number | null;
  similarity: number;
  matched_skill_id: number | null;
}

export interface InjectorContext {
  author_model?: string;
  platform?: string;
  project_key?: string;
  limit?: number;
}

export interface InjectableSkill {
  id: number;
  title: string;
  content: string;
  validation_tier: string;
  use_count: number;
  last_used_at: Date | null;
}

interface MatchingSkill {
  id: number;
  title: string;
  parent_skill_id: number | null;
  similarity: number;
}

interface PersistedSkillFields {
  content: string;
  sources: string;
  validationTier: ValidationTier;
  applicableTo: string;
  auditMetadata: Record<string, unknown>;
}

function singletonArray(value: number | null | undefined): number[] {
  return typeof value === 'number' ? [value] : [];
}

function mergeProjectIntoApplicableTo(
  base: import("./skill_auditor.js").SkillApplicability,
  projectKey: string | undefined
): import("./skill_auditor.js").SkillApplicability {
  if (!projectKey) return base;
  // Auditor already specified projects → respect it (Phase 2 might override).
  if (Array.isArray(base.projects)) return base;
  return { ...base, projects: [projectKey] };
}

function getPersistedSkillFields(
  candidate: SkillCandidate,
  audit?: AuditedSkillCandidate
): PersistedSkillFields {
  if (!audit) {
    const applicable = mergeProjectIntoApplicableTo({}, candidate.project_key);
    return {
      content: candidate.content,
      sources: JSON.stringify([]),
      validationTier: 'unvalidated',
      applicableTo: JSON.stringify(applicable),
      auditMetadata: {},
    };
  }

  const merged = mergeProjectIntoApplicableTo(audit.applicable_to ?? {}, candidate.project_key);
  return {
    content: audit.reconciled_content,
    sources: JSON.stringify(audit.sources),
    validationTier: audit.validation_tier,
    applicableTo: JSON.stringify(merged),
    auditMetadata: {
      validation_tier: audit.validation_tier,
      audit_reasoning: audit.audit_reasoning,
      sources: audit.sources,
      applicable_to: merged,
    },
  };
}

async function findMostSimilarSkill(embeddingSql: string | null): Promise<MatchingSkill | null> {
  if (!embeddingSql) return null;

  const res = await db.query(
    `SELECT id, title, parent_skill_id,
            1 - (embedding <=> $1::vector) AS similarity
     FROM skills
     WHERE status = 'active'
       AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT 1`,
    [embeddingSql]
  );

  if (res.rows.length === 0) return null;
  return {
    id: res.rows[0].id,
    title: res.rows[0].title,
    parent_skill_id: res.rows[0].parent_skill_id,
    similarity: Number(res.rows[0].similarity),
  };
}

export async function getInjectableSkills(ctx: InjectorContext): Promise<InjectableSkill[]> {
  const limit = ctx.limit ?? 5;
  const res = await db.query(
    `SELECT id, title, content, validation_tier, use_count, last_used_at
     FROM skills
     WHERE status = 'active'
       AND (
         applicable_to = '{}'::jsonb
         OR (
           ($1::text IS NULL OR NOT (applicable_to ? 'models')
             OR applicable_to->'models' @> to_jsonb($1::text))
           AND
           ($2::text IS NULL OR NOT (applicable_to ? 'platforms')
             OR applicable_to->'platforms' @> to_jsonb($2::text))
           AND
           ($3::text IS NULL OR NOT (applicable_to ? 'projects')
             OR applicable_to->'projects' @> to_jsonb($3::text))
         )
       )
     ORDER BY use_count DESC, last_used_at DESC NULLS LAST, created_at DESC
     LIMIT $4`,
    [ctx.author_model ?? null, ctx.platform ?? null, ctx.project_key ?? null, limit]
  );

  return res.rows.map((row) => ({
    id: Number(row.id),
    title: row.title,
    content: row.content,
    validation_tier: row.validation_tier,
    use_count: Number(row.use_count),
    last_used_at: row.last_used_at ? new Date(row.last_used_at) : null,
  }));
}

export async function recordSkillExposure(skillIds: number[]): Promise<void> {
  if (skillIds.length === 0) return;
  await db.query(
    `UPDATE skills
     SET last_used_at = NOW()
     WHERE id = ANY($1::int[])`,
    [skillIds]
  );
}

export async function updateOrCreateSkill(
  candidate: SkillCandidate,
  audit?: AuditedSkillCandidate,
  agentCuratorId?: number | null
): Promise<SkillUpdateResult> {
  const persisted = getPersistedSkillFields(candidate, audit);
  const embedding = await generateEmbedding(`${candidate.title}\n\n${persisted.content}`);
  const embeddingSql = vectorToSql(embedding);
  const match = await findMostSimilarSkill(embeddingSql);
  const similarity = match?.similarity ?? 0;

  const resolvedModel = await resolveModel(candidate.author_model);
  const resolvedPlatform = await resolvePlatform(candidate.platform);
  const originModelIds = singletonArray(resolvedModel?.id);
  const originPlatformIds = singletonArray(resolvedPlatform?.id);
  const sourceMemoryIds = candidate.source_memory_ids ?? [];

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    if (match && similarity >= ACCUMULATE_THRESHOLD) {
      // Merge project_key into existing skill's applicable_to.projects.
      // Rules (preserve scope semantics, don't narrow):
      //   - $2 (new project_key) is NULL  → don't touch (ambiguous cluster)
      //   - existing has no 'projects' key → don't narrow a match-all skill
      //   - existing already includes $2  → no-op
      //   - else                         → union: append $2 to projects array
      await client.query(
        `UPDATE skills
         SET use_count = use_count + 1,
             last_used_at = NOW(),
             applicable_to = CASE
               WHEN $2::text IS NULL THEN applicable_to
               WHEN NOT (applicable_to ? 'projects') THEN applicable_to
               WHEN applicable_to->'projects' @> to_jsonb($2::text) THEN applicable_to
               ELSE jsonb_set(applicable_to, '{projects}',
                              applicable_to->'projects' || to_jsonb($2::text))
             END
         WHERE id = $1`,
        [match.id, candidate.project_key ?? null]
      );

      await client.query(
        `INSERT INTO skill_changelog (
           skill_id, change_type, content_diff, source_memory_ids,
           author_model_id, platform_id, metadata, agent_curator_id
         )
         VALUES ($1, 'append', $2, $3, $4, $5, $6, $7)`,
        [
          match.id,
          persisted.content,
          sourceMemoryIds,
          resolvedModel?.id ?? null,
          resolvedPlatform?.id ?? null,
          JSON.stringify({
            candidate_title: candidate.title,
            matched_skill_id: match.id,
            similarity,
            audit: persisted.auditMetadata,
          }),
          agentCuratorId ?? null,
        ]
      );

      await client.query('COMMIT');
      return {
        action: 'accumulated',
        skill_id: match.id,
        parent_skill_id: match.parent_skill_id,
        similarity,
        matched_skill_id: match.id,
      };
    }

    if (match && similarity >= BRANCH_THRESHOLD) {
      await client.query(
        `UPDATE skills
         SET status = 'inactive'
         WHERE id = $1`,
        [match.id]
      );

      const insertRes = await client.query(
        `INSERT INTO skills (
           title, content, embedding, parent_skill_id,
           origin_model_ids, origin_platform_ids, validation_tier, sources, applicable_to, last_used_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         RETURNING id, parent_skill_id`,
        [
          candidate.title,
          persisted.content,
          embeddingSql,
          match.id,
          originModelIds,
          originPlatformIds,
          persisted.validationTier,
          persisted.sources,
          persisted.applicableTo,
        ]
      );

      const skillId = insertRes.rows[0].id;
      await client.query(
        `INSERT INTO skill_changelog (
           skill_id, change_type, content_diff, source_memory_ids,
           author_model_id, platform_id, metadata, agent_curator_id
         )
         VALUES ($1, 'branched', $2, $3, $4, $5, $6, $7)`,
        [
          skillId,
          persisted.content,
          sourceMemoryIds,
          resolvedModel?.id ?? null,
          resolvedPlatform?.id ?? null,
          JSON.stringify({
            branched_from_skill_id: match.id,
            similarity,
            audit: persisted.auditMetadata,
          }),
          agentCuratorId ?? null,
        ]
      );

      await client.query('COMMIT');
      return {
        action: 'branched',
        skill_id: skillId,
        parent_skill_id: insertRes.rows[0].parent_skill_id,
        similarity,
        matched_skill_id: match.id,
      };
    }

    const insertRes = await client.query(
      `INSERT INTO skills (
         title, content, embedding,
         origin_model_ids, origin_platform_ids, validation_tier, sources, applicable_to, last_used_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING id, parent_skill_id`,
      [
        candidate.title,
        persisted.content,
        embeddingSql,
        originModelIds,
        originPlatformIds,
        persisted.validationTier,
        persisted.sources,
        persisted.applicableTo,
      ]
    );

    const skillId = insertRes.rows[0].id;
    await client.query(
      `INSERT INTO skill_changelog (
         skill_id, change_type, content_diff, source_memory_ids,
         author_model_id, platform_id, metadata, agent_curator_id
       )
       VALUES ($1, 'created', $2, $3, $4, $5, $6, $7)`,
      [
        skillId,
        persisted.content,
        sourceMemoryIds,
        resolvedModel?.id ?? null,
        resolvedPlatform?.id ?? null,
        JSON.stringify({
          matched_skill_id: match?.id ?? null,
          similarity,
          audit: persisted.auditMetadata,
        }),
        agentCuratorId ?? null,
      ]
    );

    await client.query('COMMIT');
    return {
      action: 'created',
      skill_id: skillId,
      parent_skill_id: insertRes.rows[0].parent_skill_id,
      similarity,
      matched_skill_id: match?.id ?? null,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
