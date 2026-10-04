/**
 * D-Tag Frequency Promoter — 자주 쓰인 d_tag를 새 프로젝트 태그 후보로 제안.
 *
 * 배경: §6 p_tag 미등록 문제. Grok tagger는 explosion 방어를 위해 보수적.
 * 결과적으로 새 프로젝트 초기엔 d_tag만 박히고 p_tag=null 인 row가 쌓임.
 *
 * 흐름 (0.9.25):
 *   1. 최근 N일 d_tag 빈도 집계 (exact count). 사람이 반려한 이름은 빼고 상위 50개 (0.9.26 — 반려한
 *      이름이 자리를 차지하면 반려할 때마다 새 이름이 들어올 자리가 한 칸씩 줄었다)
 *   2. 자기 횟수 ≥ DTAG_PROMOTE_MIN_COUNT 인 d_tag마다
 *      - 이미 project_tags에 있는 이름 → 그 이름의 d_tag를 가진 미태깅 row 소급 UPDATE
 *      - 새 이름 → project_tags에 넣지 않고 project_tag_new_suggestions에 제안만 남김.
 *        LLM(clusterer role)에게 "프로젝트 이름인가, 일반어인가"를 물어 추천을 같이 적는다.
 *        분류가 실패하면 그 실행에선 넣지 않는다(다음 실행에 다시).
 *        사람이 manage_project_tags로 승인하면 그때 태그를 만들고 소급 태깅한다.
 *        한 번 끝난(반려·승인·대체) 이름은 다시 제안하지 않는다.
 *
 * 명부 모드(0.9.27, DEVLOG §24 L1 — 형 결정 c "빈도 승격기 은퇴"): 명부에 한 줄이라도 있으면 새 이름을 제안하지
 * 않고, 명부 이름(또는 그 별칭)과 같은 d_tag만 소급한다. 명부 밖 옛 태그(verification 등)로는 더 이상 소급하지 않는다.
 *
 * 0.9.24까지는 LLM이 비슷한 d_tag를 클러스터로 묶어 합산하고 멤버 d_tag까지 소급했다. 묶음이 헛짚는 일이
 * 많았고(지어낸 이름 66건, 소급 0행) 사람은 이름만 보고 승인하므로, 클러스터링을 빼고 이름 하나씩 본다.
 *
 * 환경변수:
 *   DTAG_PROMOTE_MIN_COUNT    (default 10) — 제안 임계 횟수 (그 d_tag 자기 횟수)
 *   DTAG_PROMOTE_WINDOW_DAYS  (default 30) — 빈도 계산 기간 (일)
 *   DTAG_PROMOTE_ENABLED      'false' 로 disable
 *
 * AI 호출: clusterer role(설정 이름은 그대로 — 지금은 분류기). 새 후보가 생길 때만 후보당 1회.
 */

import { db } from "../db.js";
import { getDefaultUserId } from "../users.js";
import { callRole, ROLE_REGISTRY } from "../model_registry.js";
import { invalidateCandidateCache } from "./tagger.js";
import { normalizeTag, parseRecommendation, type Recommendation } from "./dtag_suggest_gate.js";
import { REGISTRY_MEMBER_SQL, isUndefinedColumn } from "./project_registry.js";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

export interface SuggestionPreview {
  name: string;
  /** 기간 안 그 d_tag 자기 횟수 — 승인하면 이 이름의 d_tag 글에 태그가 붙는다 */
  uses: number;
  recommendation: Recommendation;
  rationale: string;
}

export interface PromotionSummary {
  /** 새로 제안한 후보 */
  suggested: SuggestionPreview[];
  /** 이미 대기 중인 제안의 횟수 갱신 */
  refreshed: number;
  /** 끝난 이름(승인·대체 뒤 태그가 사라진 것, 또는 집계 뒤 바로 반려된 것)이라 건너뜀. 반려된 이름은 집계에서 미리 빠진다 */
  blocked: number;
  /** 분류가 실패해 다음 실행으로 미룬 새 이름 */
  deferred: number;
  /** 이름이 이미 project_tags에 생겨서 닫은 대기 제안 */
  superseded: number;
  /** 기존 태그로 소급 업데이트된 row 수 합계 */
  retrotagged: number;
  /** 명부 모드였는지 (새 제안 없음, 명부 이름만 소급) */
  registry: boolean;
}

/** 명부 모드인가: 명부 항목이 하나라도 있으면. kind 칼럼이 없으면(마이그레이션 031 전) false, 다른 오류는 던진다. */
export async function isRegistryMode(): Promise<boolean> {
  try {
    const r = await db.query(`SELECT EXISTS (SELECT 1 FROM project_tags WHERE ${REGISTRY_MEMBER_SQL}) AS on`);
    return r.rows[0]?.on === true;
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    return false;
  }
}

/**
 * 명부 모드의 소급: 명부 이름과 그 별칭마다, 같은 이름의 d_tag를 가진 미태깅 행에 붙인다.
 * 빈도 상위 50·임계값을 거치지 않는다 — 사람이 이미 고른 이름이고, 명부 이름은 대개 일반어보다 드물어
 * 빈도 창 안에 못 들어온다(0.9.26이 반려 이름에서 본 것과 같은 자리 부족).
 */
async function retrotagRegistry(userId: number, dryRun: boolean): Promise<number> {
  const names = await db.query(
    `SELECT pt.id, pt.name
       FROM project_tags pt
       JOIN project_tags c ON c.id = canonical_project_tag_id(pt.id)
      WHERE c.kind IS NOT NULL AND c.alias_of IS NULL`
  );
  if (dryRun) return 0;
  let total = 0;
  for (const r of names.rows) {
    const n = await retrotag(db, userId, Number(r.id), String(r.name));
    if (n > 0) {
      total += n;
      console.error(`🏷️ [DTagPromoter] retrotagged ${n} rows with "${r.name}" (registry)`);
    }
  }
  return total;
}

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

/** 후보 이름이 프로젝트 이름인지 일반어인지 판단. 실패하거나 엉뚱한 값이면 null — 호출자가 그 실행에선 제안하지 않는다. */
async function classifyCandidate(
  userId: number,
  name: string,
  uses: number,
  windowDays: number
): Promise<{ recommendation: Recommendation; rationale: string } | null> {
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
    const recommendation = parseRecommendation(obj?.verdict);
    if (!recommendation) throw new Error(`unexpected verdict: ${String(obj?.verdict).slice(0, 40)}`);
    return { recommendation, rationale: String(obj?.reason ?? "").slice(0, 300) };
  } catch (err) {
    console.error(`⚠️ [DTagPromoter] classify "${name}" failed, will retry next run:`, err);
    return null;
  }
}

/** 대기 중인데 이름이 이미 project_tags에 생긴 제안(사람이 만들었거나 다른 길로 생김)을 닫는다. */
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
 * 사람의 결정을 기다리거나(대기) 사람이 반려한 새 태그 이름인가 — 태거가 `NEW:<이름>`으로 먼저 만들어
 * 사람의 승인을 건너뛰지 않게 쓴다. 마이그레이션 030 전이거나 조회가 실패하면 false (태깅을 막지 않는다).
 */
export async function isBlockedNewTagName(name: string): Promise<boolean> {
  try {
    const r = await db.query(
      `SELECT 1 FROM project_tag_new_suggestions WHERE name = $1 AND status IN ('pending', 'rejected') LIMIT 1`,
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
  const registry = await isRegistryMode();
  const summary: PromotionSummary = { suggested: [], refreshed: 0, blocked: 0, deferred: 0, superseded: 0, retrotagged: 0, registry };

  if (!dryRun) summary.superseded = await supersedeExisting(userId);

  // 명부 모드(형 결정 c: 빈도 승격기 은퇴): 새 제안 없이 명부 이름만 소급하고 끝
  if (registry) {
    summary.retrotagged = await retrotagRegistry(userId, dryRun);
    return summary;
  }

  // 1. 최근 N일 d_tag 빈도 집계 (tag_processed=TRUE인 row만). 반려된 이름은 상위 50개를 자르기 전에 뺀다 —
  //    그대로 두면 아무 일도 안 하면서 자리만 차지해, 반려가 쌓일수록 새 이름이 못 올라온다
  //    (10-04 실측: 50자리 = 기존 태그 42 + 반려 8, 새 이름 자리 0). 기존 태그는 소급에 쓰여서 남긴다.
  const freqResult = await db.query(
    `SELECT f.tag, f.cnt
       FROM (SELECT unnest(d_tag) AS tag, COUNT(*)::int AS cnt
               FROM memory
              WHERE user_id = $1
                AND tag_processed = TRUE
                AND is_active = TRUE
                AND created_at >= NOW() - ($2 || ' days')::INTERVAL
              GROUP BY tag
             HAVING COUNT(*) >= 2) f
      WHERE NOT EXISTS (
              SELECT 1 FROM project_tag_new_suggestions s
               WHERE s.user_id = $1 AND s.status = 'rejected' AND s.name = lower(btrim(f.tag)))
      ORDER BY f.cnt DESC
      LIMIT 50`,
    [userId, String(windowDays)]
  );

  const candidates = freqResult.rows
    .map((r: any) => ({ tag: normalizeTag(r.tag), cnt: Number(r.cnt) }))
    .filter((t) => t.tag.length > 0 && t.cnt >= minCount);
  if (candidates.length === 0) return summary;

  // 2. 이름마다: 기존 태그 / 끝난 제안 / 대기 제안을 한 번에 조회
  const names = candidates.map((c) => c.tag);
  const existing = new Map<string, number>((await db.query(
    `SELECT name, id FROM project_tags WHERE name = ANY($1::text[])`, [names]
  )).rows.map((r: any) => [String(r.name), Number(r.id)]));
  const prior = new Map<string, { id: number; status: string }>((await db.query(
    `SELECT name, id, status FROM project_tag_new_suggestions WHERE user_id = $1 AND name = ANY($2::text[])`,
    [userId, names]
  )).rows.map((r: any) => [String(r.name), { id: Number(r.id), status: String(r.status) }]));

  for (const { tag, cnt } of candidates) {
    const row = prior.get(tag);
    // 반려된 이름은 태그가 다른 길로 생겼어도 소급하지 않는다 (위 쿼리에서 이미 빠지지만, 그 사이 반려된 것까지 막는다)
    if (row?.status === 'rejected') {
      summary.blocked++;
      continue;
    }

    // 3a. 이미 있는 태그 → 같은 이름의 d_tag만 소급 (0.9.24까지는 클러스터 멤버까지 붙였다)
    const pTagId = existing.get(tag);
    if (pTagId != null) {
      if (dryRun) continue;
      const n = await retrotag(db, userId, pTagId, tag);
      if (n > 0) {
        summary.retrotagged += n;
        console.error(`🏷️ [DTagPromoter] retrotagged ${n} rows with "${tag}"`);
      }
      continue;
    }

    // 3b. 새 이름 → 제안. 대기 중이면 횟수만 갱신, 끝난 이름(승인·대체)이면 건너뜀.
    if (row) {
      if (row.status !== 'pending') {
        summary.blocked++;
        continue;
      }
      if (dryRun) continue;
      const touched = await db.query(
        `UPDATE project_tag_new_suggestions
            SET uses = $2, last_seen_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'pending'
         RETURNING id`,
        [row.id, cnt]
      );
      if (touched.rows.length > 0) summary.refreshed++;
      continue;
    }

    const verdict = await classifyCandidate(userId, tag, cnt, windowDays);
    if (!verdict) {
      summary.deferred++;
      continue;
    }
    const preview: SuggestionPreview = { name: tag, uses: cnt, ...verdict };
    if (!dryRun) {
      const spec = ROLE_REGISTRY.clusterer;
      const inserted = await db.query(
        `INSERT INTO project_tag_new_suggestions
           (user_id, name, uses, recommendation, rationale, model_provider, model_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, name) DO NOTHING
         RETURNING id`,
        [userId, preview.name, preview.uses, preview.recommendation, preview.rationale, spec.provider, spec.model_name]
      );
      if (inserted.rows.length === 0) continue;
      console.error(`🏷️ [DTagPromoter] suggested "${preview.name}" (uses=${preview.uses}, recommendation=${preview.recommendation})`);
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
    // 명부 모드면 승인한 이름을 명부(project)에 올린다 — 안 그러면 태거 후보에 안 들어가 바로 묻힌다.
    // 명부가 비어 있으면 건드리지 않는다(승인 하나로 명부 모드가 켜지면 후보가 1개로 줄어든다).
    // kind 칼럼이 없으면(마이그레이션 031 전) 건너뛴다.
    await client.query("SAVEPOINT registry_kind");
    try {
      await client.query(
        `UPDATE project_tags SET kind = 'project', updated_at = NOW()
          WHERE id = $1 AND kind IS NULL AND alias_of IS NULL
            AND EXISTS (SELECT 1 FROM project_tags WHERE ${REGISTRY_MEMBER_SQL})`,
        [pTagId]
      );
      await client.query("RELEASE SAVEPOINT registry_kind");
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT registry_kind");
      if (!isUndefinedColumn(err)) throw err;  // 칼럼 없음만 건너뛰고 나머지(잠금 등)는 승인 자체를 실패시킨다
    }
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
