/**
 * D-Tag Frequency Promoter — LLM 클러스터링 기반 p_tag 자동 승급.
 *
 * 배경: §6 p_tag 미등록 문제. Grok tagger는 explosion 방어를 위해 보수적.
 * 결과적으로 새 프로젝트 초기엔 d_tag만 박히고 p_tag=null 인 row가 쌓임.
 *
 * 해결 (A+B+C):
 *   1. 최근 N일 d_tag 빈도 집계 (exact count)
 *   2. LLM(clusterer role)으로 의미 유사 d_tag를 클러스터로 묶기
 *      (yt-viral-signal / yt-signal-finder → 같은 그룹, 합산)
 *   3. 클러스터 합산 횟수 ≥ DTAG_PROMOTE_MIN_COUNT 이면 canonical name으로
 *      project_tags INSERT
 *   4. 해당 d_tag 보유 + p_tag_id=NULL 인 row 소급 UPDATE
 *
 * 환경변수:
 *   DTAG_PROMOTE_MIN_COUNT    (default 10) — 승급 임계 횟수 (클러스터 합산 기준)
 *   DTAG_PROMOTE_WINDOW_DAYS  (default 30) — 빈도 계산 기간 (일)
 *   DTAG_PROMOTE_ENABLED      'false' 로 disable
 *
 * AI 호출: clusterer role (grok-4-1-fast-non-reasoning default).
 *   입력 ~100 토큰, 출력 ~200 토큰, 10분마다 1회 → 비용 사실상 0.
 */

import { db } from "../db.js";
import { getDefaultUserId } from "../users.js";
import { callRole } from "../model_registry.js";
import { invalidateCandidateCache } from "./tagger.js";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

interface DTagFreq {
  tag: string;
  cnt: number;
}

interface Cluster {
  canonical: string;  // 대표 이름 (LLM이 결정)
  members: string[];  // 클러스터 내 d_tag 목록
  total: number;      // 합산 빈도
}

export interface PromotionSummary {
  promoted: string[];   // 새로 project_tag로 승급된 canonical 이름
  retrotagged: number;  // 소급 업데이트된 row 수 합계
}

const CLUSTER_SYSTEM = `You are a keyword clustering assistant for a personal memory system.

Given a list of d_tags (short hyphenated keywords) with their occurrence counts,
group semantically similar tags that refer to the same project or topic.

OUTPUT strict JSON array:
[
  { "canonical": "<best-slug>", "members": ["<tag1>", "<tag2>", ...] },
  ...
]

Rules:
- canonical must be one of the input tags (pick the most descriptive one) or a clean slug if none fit
- canonical must be lowercase, hyphenated (e.g. "yt-signal-finder")
- Only group tags that clearly refer to the same project/topic
- Tags with no similar counterparts become their own single-member cluster
- Do NOT merge unrelated topics just because they share one word`;

async function clusterDTags(tags: DTagFreq[]): Promise<Cluster[]> {
  if (tags.length === 0) return [];

  const tagList = tags.map((t) => `${t.tag} (${t.cnt}x)`).join(", ");
  const userPrompt = `Cluster these d_tags by project/topic:\n${tagList}`;

  let raw: string;
  try {
    raw = await callRole('clusterer', {
      system: CLUSTER_SYSTEM,
      user: userPrompt,
      responseFormat: 'json',
      maxTokens: 512,
    });
  } catch (err) {
    console.error("⚠️ [DTagPromoter] clusterer call failed, falling back to no clustering:", err);
    // fallback: 각 tag를 단독 클러스터로
    return tags.map((t) => ({ canonical: t.tag, members: [t.tag], total: t.cnt }));
  }

  let parsed: Array<{ canonical: string; members: string[] }>;
  try {
    parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
  } catch {
    console.error("⚠️ [DTagPromoter] clusterer returned invalid JSON, falling back:", raw.slice(0, 200));
    return tags.map((t) => ({ canonical: t.tag, members: [t.tag], total: t.cnt }));
  }

  const freqMap = new Map(tags.map((t) => [t.tag, t.cnt]));

  return parsed.map((c) => {
    const canonical = String(c.canonical || '').toLowerCase().trim().replace(/\s+/g, '-');
    const members = Array.isArray(c.members)
      ? c.members.map((m) => String(m).toLowerCase().trim()).filter(Boolean)
      : [canonical];
    const total = members.reduce((sum, m) => sum + (freqMap.get(m) ?? 0), 0);
    return { canonical, members, total };
  });
}

export async function runDtagPromotion(): Promise<PromotionSummary> {
  const minCount = envInt('DTAG_PROMOTE_MIN_COUNT', 10);
  const windowDays = envInt('DTAG_PROMOTE_WINDOW_DAYS', 30);
  const userId = await getDefaultUserId();

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

  if (freqResult.rows.length === 0) return { promoted: [], retrotagged: 0 };

  const tags: DTagFreq[] = freqResult.rows.map((r: any) => ({
    tag: String(r.tag).toLowerCase().trim(),
    cnt: Number(r.cnt),
  })).filter((t) => t.tag.length > 0);

  // 2. LLM으로 클러스터링
  const clusters = await clusterDTags(tags);

  // 3. 임계값 미달 클러스터 필터
  const toPromote = clusters.filter((c) => c.total >= minCount);
  if (toPromote.length === 0) return { promoted: [], retrotagged: 0 };

  const summary: PromotionSummary = { promoted: [], retrotagged: 0 };

  for (const cluster of toPromote) {
    if (!cluster.canonical) continue;

    // 4. project_tags upsert
    const upsert = await db.query(
      `INSERT INTO project_tags (name)
         VALUES ($1)
         ON CONFLICT (name) DO NOTHING
         RETURNING id`,
      [cluster.canonical]
    );

    let pTagId: number;
    if (upsert.rows.length > 0) {
      pTagId = Number(upsert.rows[0].id);
      summary.promoted.push(cluster.canonical);
      console.error(`🏷️ [DTagPromoter] promoted "${cluster.canonical}" (total=${cluster.total}, members=${cluster.members.join(', ')})`);
      invalidateCandidateCache();
    } else {
      const existing = await db.query(
        `SELECT id FROM project_tags WHERE name = $1 LIMIT 1`,
        [cluster.canonical]
      );
      if (existing.rows.length === 0) continue;
      pTagId = Number(existing.rows[0].id);
    }

    // 5. 클러스터 멤버 d_tag를 가진 미태깅 row 소급 업데이트
    for (const memberTag of cluster.members) {
      const updated = await db.query(
        `UPDATE memory
            SET p_tag_id = $1, updated_at = NOW()
          WHERE user_id = $2
            AND tag_processed = TRUE
            AND p_tag_id IS NULL
            AND $3 = ANY(d_tag)
         RETURNING id`,
        [pTagId, userId, memberTag]
      );
      summary.retrotagged += updated.rows.length;
    }

    if (summary.retrotagged > 0) {
      console.error(`🏷️ [DTagPromoter] retrotagged ${summary.retrotagged} rows with "${cluster.canonical}"`);
    }
  }

  return summary;
}
