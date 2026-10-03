/**
 * D-Tag Frequency Promoter — 자주 쓰인 d_tag를 새 프로젝트 태그 후보로 제안.
 *
 * 배경: §6 p_tag 미등록 문제. Grok tagger는 explosion 방어를 위해 보수적.
 * 결과적으로 새 프로젝트 초기엔 d_tag만 박히고 p_tag=null 인 row가 쌓임.
 *
 * 흐름:
 *   1. 최근 N일 d_tag 빈도 집계 (exact count)
 *   2. LLM(clusterer role)으로 의미 유사 d_tag를 클러스터로 묶기
 *      (yt-viral-signal / yt-signal-finder → 같은 그룹, 합산). 대표 이름은 실제 d_tag만 인정
 *      (dtag_suggest_gate.normalizeClusters — 지어낸 합성어는 버림)
 *   3. 클러스터 합산 횟수 ≥ DTAG_PROMOTE_MIN_COUNT 인 것 중
 *      - 이미 project_tags에 있는 이름 → 그 이름의 d_tag를 가진 미태깅 row 소급 UPDATE
 *      - 새 이름 → project_tags에 넣지 않고 project_tag_new_suggestions에 제안만 남김 (0.9.25).
 *        같은 LLM에게 "프로젝트 이름인가, 일반어인가"를 물어 추천을 같이 적는다.
 *        사람이 manage_project_tags로 승인하면 그때 태그를 만들고 소급 태깅한다.
 *        한 번 반려·승인된 이름은 다시 제안하지 않는다.
 *      소급 태깅은 그 이름의 d_tag에만 한다(0.9.25). 클러스터 멤버는 합산에만 쓴다 — 클러스터러의 묶음은
 *      헛짚을 때가 많고(합성어 66건), 사람은 이름만 보고 승인한다.
 *
 * 환경변수:
 *   DTAG_PROMOTE_MIN_COUNT    (default 10) — 승급 임계 횟수 (클러스터 합산 기준)
 *   DTAG_PROMOTE_WINDOW_DAYS  (default 30) — 빈도 계산 기간 (일)
 *   DTAG_PROMOTE_ENABLED      'false' 로 disable
 *
 * AI 호출: clusterer role. 클러스터링 10분마다 1회 + 새 후보가 생길 때만 후보당 분류 1회.
 */

import { db } from "../db.js";
import { getDefaultUserId } from "../users.js";
import { callRole, ROLE_REGISTRY } from "../model_registry.js";
import { invalidateCandidateCache } from "./tagger.js";
import {
  normalizeClusters,
  normalizeTag,
  parseRecommendation,
  type ClusterRules,
  type Cluster,
  type RawCluster,
  type Recommendation,
} from "./dtag_suggest_gate.js";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

export interface SuggestionPreview {
  name: string;
  members: string[];
  uses: number;
  recommendation: Recommendation | null;
  rationale: string;
}

export interface PromotionSummary {
  /** 새로 제안한 후보 */
  suggested: SuggestionPreview[];
  /** 이미 대기 중인 제안의 횟수·멤버 갱신 */
  refreshed: number;
  /** 끝난 이름이라 건너뜀 (반려된 이름은 빈도 상위에 있기만 해도 셈) */
  blocked: number;
  /** 이름이 이미 project_tags에 생겨서 닫은 대기 제안 */
  superseded: number;
  /** 기존 태그로 소급 업데이트된 row 수 합계 */
  retrotagged: number;
}

const CLUSTER_SYSTEM = `You are a keyword clustering assistant for a personal memory system.

Given a list of d_tags (short hyphenated keywords) with their occurrence counts,
group semantically similar tags that refer to the same project or topic.

OUTPUT strict JSON object (NOT a bare array):
{ "clusters": [
  { "canonical": "<one of the input tags>", "members": ["<tag1>", "<tag2>", ...] }
] }

Rules:
- canonical must be copied exactly from the input tags (pick the most descriptive one). Never invent a new name.
- Only group tags that clearly refer to the same project/topic
- Tags with no similar counterparts become their own single-member cluster
- Do NOT merge unrelated topics just because they share one word`;

/** JSON Schema for clusterer output — wraps the cluster list in an OBJECT root.
 *  Object root (not a top-level array) so llama.cpp/OpenAI strict json_schema accepts it,
 *  matching how tagger/librarian/judge schemas already work (TAGGER_SCHEMA etc.). */
const CLUSTER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          canonical: { type: 'string' },
          members: { type: 'array', items: { type: 'string' } },
        },
        required: ['canonical', 'members'],
        additionalProperties: false,
      },
    },
  },
  required: ['clusters'],
  additionalProperties: false,
};

// 2026-10-03 오프라인 실측(로컬 Qwen3-14B, 실제 이름 70개): 알려진 프로젝트 5개 모두 project,
// 고유 이름(cafe24·smartstore·buzz…)은 unsure, 실제 프로젝트를 generic으로 본 것 0건.
// 이유를 한국어로 쓰라고 하면 예시 문구를 따라 하며 판단이 흔들려서(mcp→project, airparrot→generic)
// 이유는 영어로 두고, 사람에게 보여 줄 땐 이름·횟수만 쓴다.
const CLASSIFY_SYSTEM = `You review keyword tags from a personal work-memory system and decide whether a tag should become a PROJECT tag.

A PROJECT tag names one specific thing the user's own work is organized around: their product, app, service, brand, company/client, YouTube channel, code repository, or named initiative.
NOT a project: generic activities or topics (bug, fix, upload, login, review, approval, logging, error-handling, translation, policy), feature or UI words, and third-party tools/platforms/OSes the user merely uses (windows, ubuntu, photoshop, cloudflare, playwright, app-store) — unless the samples show the user is building something with that exact name.

Answer:
- "project": clearly a specific named thing of the user's own work.
- "generic": clearly a generic word or a third-party tool merely used.
- "unsure": a specific name, but the samples do not make clear whether it is the user's own project or just a tool/platform they use.
Never answer "generic" for a specific proper name (a brand, product, app or company name) — use "unsure" instead.
reason: one short sentence (max 60 characters) in the same language as the samples.

OUTPUT strict JSON object: { "verdict": "project" | "generic" | "unsure", "reason": "<short sentence>" }`;

const CLASSIFY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['project', 'generic', 'unsure'] },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
  additionalProperties: false,
};

const CLASSIFY_SAMPLE_LIMIT = 3;
const CLASSIFY_SAMPLE_CHARS = 160;

interface DTagFreq {
  tag: string;
  cnt: number;
}

/** ok=false면 클러스터러가 실패해 단독 클러스터로 대신한 것 — 그 실행에선 새 제안을 만들지 않는다. */
async function clusterDTags(tags: DTagFreq[], rules: ClusterRules): Promise<{ clusters: Cluster[]; ok: boolean }> {
  if (tags.length === 0) return { clusters: [], ok: true };
  const freq = new Map(tags.map((t) => [t.tag, t.cnt]));
  const singletons = () => ({ clusters: normalizeClusters([], freq, rules), ok: false });

  const tagList = tags.map((t) => `${t.tag} (${t.cnt}x)`).join(", ");
  const userPrompt = `Cluster these d_tags by project/topic:\n${tagList}`;

  let raw: string;
  try {
    raw = await callRole('clusterer', {
      system: CLUSTER_SYSTEM,
      user: userPrompt,
      jsonSchema: CLUSTER_SCHEMA,
      enableThinking: false,
      maxTokens: 4096,  // was 512 — 50개 태그 클러스터링 출력이 잘려 invalid JSON 폴백됨 (ctx 8192 내 여유)
    });
  } catch (err) {
    console.error("⚠️ [DTagPromoter] clusterer call failed, falling back to no clustering:", err);
    return singletons();
  }

  let parsed: RawCluster[];
  try {
    const obj = JSON.parse(raw);
    parsed = obj?.clusters;  // object root: { clusters: [...] }
    if (!Array.isArray(parsed)) throw new Error("no clusters array");
  } catch {
    console.error("⚠️ [DTagPromoter] clusterer returned invalid JSON, falling back:", raw.slice(0, 200));
    return singletons();
  }

  return { clusters: normalizeClusters(parsed, freq, rules), ok: true };
}

/** 후보 이름이 프로젝트 이름인지 일반어인지 판단. 실패하면 추천 없음(null)으로 제안한다. */
async function classifyCandidate(
  userId: number,
  name: string,
  uses: number,
  windowDays: number
): Promise<{ recommendation: Recommendation | null; rationale: string }> {
  try {
    const samples = await db.query(
      `SELECT left(regexp_replace(message, '\\s+', ' ', 'g'), $3) AS preview
         FROM memory
        WHERE user_id = $1
          AND d_tag @> ARRAY[$2]::text[]
          AND role = 'user'
          AND is_active = TRUE
        ORDER BY created_at DESC
        LIMIT $4`,
      [userId, name, CLASSIFY_SAMPLE_CHARS, CLASSIFY_SAMPLE_LIMIT]
    );
    const lines = samples.rows.map((r: any) => `- ${r.preview}`).join("\n") || "(none)";
    const raw = await callRole('clusterer', {
      system: CLASSIFY_SYSTEM,
      user: `tag: ${name}\nuses (${windowDays} days): ${uses}\nrecent user messages with this tag:\n${lines}`,
      responseFormat: 'json',      // local 외 프로바이더용 (local은 jsonSchema가 우선)
      jsonSchema: CLASSIFY_SCHEMA,
      enableThinking: false,
      maxTokens: 200,
    });
    const obj = JSON.parse(raw);
    return {
      recommendation: parseRecommendation(obj?.verdict),
      rationale: String(obj?.reason ?? "").slice(0, 300),
    };
  } catch (err) {
    console.error(`⚠️ [DTagPromoter] classify "${name}" failed, suggesting without recommendation:`, err);
    return { recommendation: null, rationale: "" };
  }
}

/** 대기 중인데 이름이 이미 project_tags에 생긴 제안(태거가 직접 만들었거나 사람이 만듦)을 닫는다. */
async function supersedeExisting(userId: number): Promise<number> {
  const result = await db.query(
    `UPDATE project_tag_new_suggestions s
        SET status = 'superseded',
            decided_by = 'system',
            decision_reason = 'project tag already exists',
            decided_at = NOW(),
            project_tag_id = pt.id,
            updated_at = NOW()
       FROM project_tags pt
      WHERE s.user_id = $1
        AND s.status = 'pending'
        AND pt.name = s.name
     RETURNING s.id`,
    [userId]
  );
  return result.rows.length;
}

/** 이름과 같은 d_tag를 가진 미태깅 row에 그 프로젝트 태그를 붙인다. */
async function retrotag(
  client: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> },
  userId: number,
  pTagId: number,
  tag: string
): Promise<number> {
  const updated = await client.query(
    `UPDATE memory
        SET p_tag_id = $1, updated_at = NOW()
      WHERE user_id = $2
        AND tag_processed = TRUE
        AND p_tag_id IS NULL
        AND d_tag @> ARRAY[$3]::text[]
     RETURNING id`,
    [pTagId, userId, tag]
  );
  return updated.rows.length;
}

/**
 * 사람이 반려한 새 태그 이름인가 — 태거가 `NEW:<이름>`으로 같은 이름을 만들지 않게 쓴다.
 * 마이그레이션 030 전이거나 조회가 실패하면 false (태깅을 막지 않는다).
 */
export async function isRejectedNewTagName(name: string): Promise<boolean> {
  try {
    const r = await db.query(
      `SELECT 1 FROM project_tag_new_suggestions WHERE name = $1 AND status = 'rejected' LIMIT 1`,
      [normalizeTag(name)]
    );
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

export async function runDtagPromotion(opts: { dryRun?: boolean } = {}): Promise<PromotionSummary> {
  const dryRun = opts.dryRun === true;
  const minCount = envInt('DTAG_PROMOTE_MIN_COUNT', 10);
  const windowDays = envInt('DTAG_PROMOTE_WINDOW_DAYS', 30);
  const userId = await getDefaultUserId();
  const summary: PromotionSummary = { suggested: [], refreshed: 0, blocked: 0, superseded: 0, retrotagged: 0 };

  if (!dryRun) summary.superseded = await supersedeExisting(userId);

  // 1. 최근 N일 d_tag 빈도 집계 (tag_processed=TRUE인 row만)
  const freqResult = await db.query(
    `SELECT unnest(d_tag) AS tag, COUNT(*)::int AS cnt
       FROM memory
      WHERE user_id = $1
        AND tag_processed = TRUE
        AND is_active = TRUE
        AND created_at >= NOW() - ($2 || ' days')::INTERVAL
      GROUP BY tag
     HAVING COUNT(*) >= 2
      ORDER BY cnt DESC
      LIMIT 50`,
    [userId, String(windowDays)]
  );

  if (freqResult.rows.length === 0) return summary;

  const tags: DTagFreq[] = freqResult.rows.map((r: any) => ({
    tag: normalizeTag(r.tag),
    cnt: Number(r.cnt),
  })).filter((t) => t.tag.length > 0);

  // 2. LLM으로 클러스터링. 대표 이름은 실제 d_tag만, 이미 있는 태그는 남의 멤버가 못 되고, 반려된 이름은 빠진다.
  const names = tags.map((t) => t.tag);
  const reserved = new Set<string>((await db.query(
    `SELECT name FROM project_tags WHERE name = ANY($1::text[])`, [names]
  )).rows.map((r: any) => String(r.name)));
  const rejected = new Set<string>((await db.query(
    `SELECT name FROM project_tag_new_suggestions WHERE user_id = $1 AND status = 'rejected' AND name = ANY($2::text[])`,
    [userId, names]
  )).rows.map((r: any) => String(r.name)));
  summary.blocked += rejected.size;
  const { clusters, ok: clustered } = await clusterDTags(tags, { reserved, rejected });
  if (!clustered) console.error("⚠️ [DTagPromoter] clusterer failed — this run only retro-tags existing tags, no new suggestions");

  // 3. 임계값 미달 클러스터 필터
  const toPromote = clusters.filter((c) => c.total >= minCount);

  for (const cluster of toPromote) {
    // 4a. 이미 있는 태그 → 같은 이름의 d_tag만 소급 (0.9.24까지는 클러스터 멤버까지 붙였다)
    const existing = await db.query(
      `SELECT id FROM project_tags WHERE name = $1 LIMIT 1`,
      [cluster.canonical]
    );
    if (existing.rows.length > 0) {
      if (dryRun) continue;
      const n = await retrotag(db, userId, Number(existing.rows[0].id), cluster.canonical);
      if (n > 0) {
        summary.retrotagged += n;
        console.error(`🏷️ [DTagPromoter] retrotagged ${n} rows with "${cluster.canonical}"`);
      }
      continue;
    }

    // 4b. 새 이름 → 제안. 이미 행이 있으면: 대기 중이면 갱신, 끝난 이름(반려·승인·대체)이면 건너뜀.
    const prior = await db.query(
      `SELECT id, status, recommendation FROM project_tag_new_suggestions WHERE user_id = $1 AND name = $2`,
      [userId, cluster.canonical]
    );
    if (prior.rows.length > 0) {
      const row = prior.rows[0];
      if (String(row.status) !== 'pending') {
        summary.blocked++;
        continue;
      }
      if (dryRun) continue;
      // 횟수만 갱신 — 멤버는 처음 제안할 때 것으로 둔다(태깅에 안 쓰고 기록용)
      const touched = await db.query(
        `UPDATE project_tag_new_suggestions
            SET uses = $2, last_seen_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'pending'
         RETURNING id`,
        [row.id, cluster.total]
      );
      if (touched.rows.length === 0) continue;
      summary.refreshed++;
      // 처음 분류가 실패했던 제안은 클러스터러가 살아 있을 때 다시 분류한다
      if (row.recommendation == null && clustered) {
        const again = await classifyCandidate(userId, cluster.canonical, cluster.total, windowDays);
        if (again.recommendation) {
          const spec = ROLE_REGISTRY.clusterer;
          await db.query(
            `UPDATE project_tag_new_suggestions
                SET recommendation = $2, rationale = $3, model_provider = $4, model_name = $5, updated_at = NOW()
              WHERE id = $1 AND status = 'pending' AND recommendation IS NULL`,
            [row.id, again.recommendation, again.rationale, spec.provider, spec.model_name]
          );
        }
      }
      continue;
    }

    // 클러스터러가 실패한 실행에선 새 제안을 만들지 않는다 (모델이 죽어 있으면 분류도 실패해 추천 없는 제안만 쏟아짐)
    if (!clustered) continue;

    const verdict = await classifyCandidate(userId, cluster.canonical, cluster.total, windowDays);
    const preview: SuggestionPreview = {
      name: cluster.canonical,
      members: cluster.members,
      uses: cluster.total,
      ...verdict,
    };
    if (!dryRun) {
      const spec = ROLE_REGISTRY.clusterer;
      const inserted = await db.query(
        `INSERT INTO project_tag_new_suggestions
           (user_id, name, members, uses, recommendation, rationale, model_provider, model_name)
         VALUES ($1, $2, $3::text[], $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, name) DO NOTHING
         RETURNING id`,
        [userId, preview.name, preview.members, preview.uses, preview.recommendation,
         preview.rationale, verdict.recommendation ? spec.provider : null, verdict.recommendation ? spec.model_name : null]
      );
      if (inserted.rows.length === 0) continue;
      console.error(`🏷️ [DTagPromoter] suggested "${preview.name}" (total=${preview.uses}, recommendation=${preview.recommendation ?? 'none'}, members=${preview.members.join(', ')})`);
    }
    summary.suggested.push(preview);
  }

  return summary;
}

export interface NewTagDecision {
  suggestion_id: number;
  name: string;
  status: string;
  project_tag_id?: number;
  created?: boolean;
  retrotagged?: number;
  error?: string;
}

/**
 * 대기 중인 새 태그 제안을 승인: project_tags에 만들고(이미 있으면 그 행) 같은 이름의 d_tag를 가진 미태깅 row를 소급한다.
 * 대기 중이 아니면 아무것도 바꾸지 않고 error를 돌려준다.
 */
export async function confirmNewTagSuggestion(
  userId: number,
  suggestionId: number,
  opts: { decidedBy: 'user' | 'system'; reason?: string }
): Promise<NewTagDecision> {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const row = await client.query(
      `SELECT id, name, status FROM project_tag_new_suggestions
        WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [suggestionId, userId]
    );
    if (row.rows.length === 0) {
      await client.query("ROLLBACK");
      return { suggestion_id: suggestionId, name: "", status: "missing", error: "suggestion_id not found for current user" };
    }
    const { name, status } = row.rows[0];
    if (status !== 'pending') {
      await client.query("ROLLBACK");
      return { suggestion_id: suggestionId, name, status, error: "suggestion is not pending" };
    }

    const inserted = await client.query(
      `INSERT INTO project_tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id`,
      [name]
    );
    const created = inserted.rows.length > 0;
    const pTagId = created
      ? Number(inserted.rows[0].id)
      : Number((await client.query(`SELECT id FROM project_tags WHERE name = $1`, [name])).rows[0].id);
    // 사람이 본 건 이름뿐이라 그 이름의 d_tag에만 붙인다 (멤버는 기록용)
    const n = await retrotag(client, userId, pTagId, name);

    await client.query(
      `UPDATE project_tag_new_suggestions
          SET status = 'confirmed', decided_by = $2, decision_reason = $3, decided_at = NOW(),
              project_tag_id = $4, retrotagged = $5, updated_at = NOW()
        WHERE id = $1`,
      [suggestionId, opts.decidedBy, opts.reason ?? null, pTagId, n]
    );
    await client.query("COMMIT");
    invalidateCandidateCache();
    return { suggestion_id: suggestionId, name, status: 'confirmed', project_tag_id: pTagId, created, retrotagged: n };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

/** 대기 중인 새 태그 제안을 반려. 반려된 이름은 다시 제안되지 않는다. */
export async function rejectNewTagSuggestion(
  userId: number,
  suggestionId: number,
  opts: { decidedBy: 'user' | 'system'; reason?: string }
): Promise<NewTagDecision> {
  const result = await db.query(
    `UPDATE project_tag_new_suggestions
        SET status = 'rejected', decided_by = $3, decision_reason = $4, decided_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'pending'
     RETURNING id, name, status`,
    [suggestionId, userId, opts.decidedBy, opts.reason ?? null]
  );
  if (result.rows.length > 0) {
    return { suggestion_id: suggestionId, name: String(result.rows[0].name), status: 'rejected' };
  }
  const row = await db.query(
    `SELECT name, status FROM project_tag_new_suggestions WHERE id = $1 AND user_id = $2`,
    [suggestionId, userId]
  );
  if (row.rows.length === 0) {
    return { suggestion_id: suggestionId, name: "", status: "missing", error: "suggestion_id not found for current user" };
  }
  return { suggestion_id: suggestionId, name: String(row.rows[0].name), status: String(row.rows[0].status), error: "suggestion is not pending" };
}
