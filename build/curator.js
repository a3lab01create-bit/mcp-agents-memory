import { db } from "./db.js";
import { callRole } from "./model_registry.js";
import { updateOrCreateSkill } from "./skills.js";
import { auditSkill } from "./skill_auditor.js";
export const CURATOR_MIN_CLUSTER_SIZE = parseInt(process.env.CURATOR_MIN_CLUSTER_SIZE || '3');
export const CURATOR_SIMILARITY_THRESHOLD = parseFloat(process.env.CURATOR_SIMILARITY_THRESHOLD || '0.85');
export const CURATOR_MIN_IMPORTANCE = parseFloat(process.env.CURATOR_MIN_IMPORTANCE || '5');
export const CURATOR_MAX_CLUSTERS_PER_RUN = parseInt(process.env.CURATOR_MAX_CLUSTERS_PER_RUN || '10');
export const CURATOR_SYSTEM_PROMPT = `You are the Skill Curator for a long-term memory system.
Analyze a semantic cluster of memories and decide whether it contains reusable know-how worth promoting into a skill.

Return strict JSON:
{
  "skill_worthy": boolean,
  "title": "5-10 word skill title (omit if !skill_worthy)",
  "content": "Markdown skill body (omit if !skill_worthy)",
  "reason": "Brief explanation (1-2 sentences)"
}

Only mark skill_worthy=true when the memories reveal a repeatable behavior, workflow, technical rule, project convention, or decision pattern.
The content must be directly useful as operational guidance in future sessions.`;
async function resolveSubjectId(subjectKey) {
    if (!subjectKey)
        return null;
    const res = await db.query("SELECT id FROM subjects WHERE subject_key = $1 LIMIT 1", [subjectKey]);
    return res.rows.length > 0 ? res.rows[0].id : -1;
}
function parsePgIntArray(value) {
    if (Array.isArray(value))
        return value.map(Number);
    if (typeof value !== 'string')
        return [];
    return value
        .replace(/[{}]/g, '')
        .split(',')
        .filter(Boolean)
        .map(Number);
}
function overlapRatio(left, right) {
    if (left.length === 0 || right.length === 0)
        return 0;
    const rightSet = new Set(right);
    const overlap = left.filter(id => rightSet.has(id)).length;
    return overlap / left.length;
}
function avgImportance(members) {
    if (members.length === 0)
        return 0;
    return members.reduce((sum, member) => sum + Number(member.importance), 0) / members.length;
}
function buildMemoryScope(subjectId, projectId, alias, params) {
    const conditions = [
        `${alias}.is_active = TRUE`,
        `${alias}.embedding IS NOT NULL`,
    ];
    if (subjectId !== null) {
        params.push(subjectId);
        conditions.push(`${alias}.subject_id = $${params.length}`);
    }
    if (projectId !== null) {
        params.push(projectId);
        conditions.push(`(${alias}.project_subject_id = $${params.length} OR ${alias}.subject_id = $${params.length})`);
    }
    return conditions;
}
async function getSeedMemories(options) {
    const params = [];
    const conditions = buildMemoryScope(options.subjectId, options.projectId, 'm', params);
    const res = await db.query(`SELECT id, content, fact_type, importance, created_at
     FROM memories m
     WHERE ${conditions.join(' AND ')}
     ORDER BY importance DESC, created_at DESC`, params);
    return res.rows.map((row) => ({
        id: row.id,
        content: row.content,
        fact_type: row.fact_type,
        importance: Number(row.importance),
        created_at: row.created_at,
    }));
}
async function getClusterMembers(seed, usedIds, options) {
    const params = [seed.id, Array.from(usedIds), options.similarityThreshold];
    const conditions = buildMemoryScope(options.subjectId, options.projectId, 'm', params);
    conditions.push(`m.id <> $1`);
    conditions.push(`NOT (m.id = ANY($2::int[]))`);
    conditions.push(`1 - (m.embedding <=> seed.embedding) >= $3`);
    const res = await db.query(`SELECT m.id, m.content, m.fact_type, m.importance, m.created_at,
            1 - (m.embedding <=> seed.embedding) AS similarity
     FROM memories seed
     JOIN memories m ON TRUE
     WHERE seed.id = $1
       AND ${conditions.join(' AND ')}
     ORDER BY m.embedding <=> seed.embedding
     LIMIT 25`, params);
    const members = [{
            id: seed.id,
            content: seed.content,
            fact_type: seed.fact_type,
            importance: seed.importance,
            created_at: seed.created_at,
            similarity: 1,
        }];
    members.push(...res.rows.map((row) => ({
        id: row.id,
        content: row.content,
        fact_type: row.fact_type,
        importance: Number(row.importance),
        created_at: row.created_at,
        similarity: Number(row.similarity),
    })));
    return members;
}
export async function findClusters(options) {
    const seeds = await getSeedMemories(options);
    const usedIds = new Set();
    const clusters = [];
    for (const seed of seeds) {
        if (usedIds.has(seed.id))
            continue;
        const members = await getClusterMembers(seed, usedIds, options);
        const importance = avgImportance(members);
        if (members.length >= options.minClusterSize && importance >= options.minImportance) {
            const memberIds = members.map(member => member.id);
            clusters.push({
                seed_memory_id: seed.id,
                member_ids: memberIds,
                members,
                size: members.length,
                avg_importance: importance,
            });
            memberIds.forEach(id => usedIds.add(id));
        }
        if (clusters.length >= options.maxClusters)
            break;
    }
    return { clusters, scanned: seeds.length };
}
export async function isClusterAlreadyCovered(cluster) {
    const res = await db.query(`SELECT source_memory_ids
     FROM skill_changelog
     WHERE source_memory_ids && $1::int[]`, [cluster.member_ids]);
    return res.rows.some((row) => {
        const sourceIds = parsePgIntArray(row.source_memory_ids);
        return overlapRatio(cluster.member_ids, sourceIds) >= 0.5;
    });
}
function buildClusterPrompt(cluster) {
    const memories = cluster.members.map(member => {
        return [
            `ID: ${member.id}`,
            `Type: ${member.fact_type}`,
            `Importance: ${member.importance}`,
            `Similarity to seed: ${member.similarity.toFixed(3)}`,
            `Content: ${member.content}`,
        ].join('\n');
    }).join('\n\n---\n\n');
    return `Analyze this memory cluster for reusable skill-worthy know-how.

Cluster size: ${cluster.size}
Average importance: ${cluster.avg_importance.toFixed(2)}
Source memory IDs: ${cluster.member_ids.join(', ')}

MEMORIES:
${memories}`;
}
function parseCuratorResponse(raw) {
    const trimmed = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(trimmed || '{"skill_worthy":false,"reason":"Empty curator response."}');
}
export async function runCurator(options = {}) {
    const subjectId = await resolveSubjectId(options.subjectKey);
    const projectId = await resolveSubjectId(options.projectKey);
    const normalized = {
        subjectId,
        projectId,
        dryRun: options.dryRun ?? false,
        minClusterSize: options.minClusterSize ?? CURATOR_MIN_CLUSTER_SIZE,
        similarityThreshold: options.similarityThreshold ?? CURATOR_SIMILARITY_THRESHOLD,
        minImportance: options.minImportance ?? CURATOR_MIN_IMPORTANCE,
        maxClusters: options.maxClusters ?? CURATOR_MAX_CLUSTERS_PER_RUN,
    };
    const { clusters, scanned } = await findClusters(normalized);
    const result = {
        dry_run: normalized.dryRun,
        scanned_memories: scanned,
        clusters_found: clusters.length,
        clusters_skipped: 0,
        skills_saved: 0,
        candidates: [],
    };
    for (const cluster of clusters) {
        try {
            const covered = await isClusterAlreadyCovered(cluster);
            if (covered) {
                result.clusters_skipped++;
                result.candidates.push({
                    cluster,
                    covered: true,
                    skill_worthy: false,
                    reason: "Cluster already has 50%+ overlap with an existing skill changelog entry.",
                    dry_run: normalized.dryRun,
                    skill_result: null,
                });
                continue;
            }
            const raw = await callRole('skill_curator', {
                system: CURATOR_SYSTEM_PROMPT,
                user: buildClusterPrompt(cluster),
                responseFormat: 'json',
            });
            const parsed = parseCuratorResponse(raw);
            const skillWorthy = parsed.skill_worthy === true && !!parsed.title && !!parsed.content;
            if (!skillWorthy) {
                result.candidates.push({
                    cluster,
                    covered: false,
                    skill_worthy: false,
                    reason: parsed.reason || "Curator did not find a reusable skill pattern.",
                    dry_run: normalized.dryRun,
                    skill_result: null,
                });
                continue;
            }
            const candidate = {
                title: parsed.title,
                content: parsed.content,
                source_memory_ids: cluster.member_ids,
                author_model: 'curator',
                platform: 'system',
            };
            let audit;
            let audited;
            try {
                audited = await auditSkill(candidate);
                audit = {
                    validation_tier: audited.validation_tier,
                    sources_count: audited.sources.length,
                    audit_reasoning: audited.audit_reasoning,
                };
            }
            catch (auditErr) {
                const auditMessage = auditErr?.message || String(auditErr);
                console.error(`⚠️ [Curator] Skill audit failed for "${candidate.title}": ${auditMessage}`);
                audit = {
                    validation_tier: 'unvalidated',
                    sources_count: 0,
                    audit_reasoning: `Audit failed: ${auditMessage}`,
                };
            }
            let skillResult = null;
            if (!normalized.dryRun) {
                skillResult = await updateOrCreateSkill(candidate, audited);
                result.skills_saved++;
            }
            result.candidates.push({
                cluster,
                covered: false,
                skill_worthy: true,
                title: parsed.title,
                content: parsed.content,
                reason: parsed.reason || "Curator identified reusable know-how.",
                dry_run: normalized.dryRun,
                skill_result: skillResult,
                audit,
            });
        }
        catch (err) {
            result.candidates.push({
                cluster,
                covered: false,
                skill_worthy: false,
                reason: "Curator failed while processing this cluster.",
                dry_run: normalized.dryRun,
                skill_result: null,
                error: err?.message || String(err),
            });
        }
    }
    return result;
}
