/**
 * Cold Path Worker — 백그라운드 사서.
 *
 * RESPEC §시퀀스 #2 / §2-B concurrency 결정.
 *
 * 매 tick 마다:
 *   1. memory에서 embedding IS NULL OR p_tag_id IS NULL인 row를 batch로
 *      SELECT ... FOR UPDATE SKIP LOCKED (다중 worker 안전).
 *   2. 각 row마다 tagger() + embedder() 호출.
 *   3. 성공: UPDATE memory SET embedding/p_tag_id/d_tag/cold_error=NULL.
 *   4. 실패: UPDATE memory SET cold_error = '...'. (다음 사이클 재시도)
 *
 * 환경변수:
 *   COLD_PATH_INTERVAL_SEC (default 60)
 *   COLD_PATH_BATCH_SIZE   (default 5)
 *   COLD_PATH_WARMUP_SEC   (default 30) — 서버 시작 후 첫 tick 까지 지연
 */

import { db } from "../db.js";
import { tagMessage } from "./tagger.js";
import { embedMessage, vectorToHalfvecSql } from "./embedder.js";

let intervalTimer: NodeJS.Timeout | null = null;
let warmupTimer: NodeJS.Timeout | null = null;
let running = false;

const DEFAULT_INTERVAL_SEC = 60;
const DEFAULT_BATCH = 5;
const DEFAULT_WARMUP_SEC = 30;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

interface ColdRow {
  id: number;
  message: string;
  role: 'user' | 'assistant';
  agent_platform: string;
  agent_model: string;
  needs_tag: boolean;
  needs_embed: boolean;
}

/**
 * Lock + claim a batch of rows needing tag or embed. SKIP LOCKED prevents
 * multi-worker contention. Returns the claimed rows; the lock is held until
 * the surrounding transaction COMMIT/ROLLBACK.
 *
 * Priority order (RESPEC PROBLEMS.md §4 fix — 4-30 큐 head 정합):
 *   1. is_active=TRUE row 우선 (사용자 현재 작업 중 메시지 즉시 처리)
 *   2. archived row는 cold_error 1시간 cooldown 적용 (Phase F drain quota
 *      초과 같은 사고 시 무한 retry 방지)
 *   3. 그 외엔 created_at ASC
 *
 * 효과: archived legacy + errored row가 큐 head를 막아서 새 active row가
 * 처리 안 되던 사고 (Phase F drain quota 초과 + 큐 정체) 방지. Active는
 * cooldown 무시 — 사용자 현재 작업 즉시 retry.
 */
async function claimBatch(client: any, batch: number): Promise<ColdRow[]> {
  const r = await client.query(
    `SELECT id, message, role, agent_platform, agent_model,
            (p_tag_id IS NULL) AS needs_tag,
            (embedding IS NULL) AS needs_embed
       FROM memory
      WHERE (embedding IS NULL OR p_tag_id IS NULL)
        AND (
          is_active = TRUE
          OR cold_error IS NULL
          OR updated_at < NOW() - INTERVAL '1 hour'
        )
      ORDER BY is_active DESC, created_at ASC
      LIMIT $1
        FOR UPDATE SKIP LOCKED`,
    [batch]
  );
  return r.rows.map((row: any) => ({
    id: Number(row.id),
    message: row.message,
    role: row.role,
    agent_platform: row.agent_platform,
    agent_model: row.agent_model,
    needs_tag: row.needs_tag,
    needs_embed: row.needs_embed,
  }));
}

/**
 * Tag와 Embed를 독립 처리. 한 쪽 실패해도 다른 쪽은 시도/저장.
 * Tagger fail (Gemini quota) → embedding은 정상 채움. 다음 cycle에 tagger만 재시도.
 *
 * Returns void on success. Throws if both tag AND embed failed (tick의
 * recordError가 cold_error 박음). 한 쪽만 실패면 throw 안 하고, error를
 * cold_error 컬럼에 부분 기록 (caller가 다음 cycle에 미완성 부분 재시도).
 */
async function processOne(client: any, row: ColdRow): Promise<void> {
  type TagResult = { p_tag_id: number | null; d_tag: string[] };
  let tagResult: TagResult | null = null;
  let tagError: any = null;
  let embedding: number[] | null = null;
  let embedError: any = null;

  // Tag와 Embed를 병렬 시도 — 둘 다 LLM/API 호출이라 sequential 이점 없음
  const promises: Promise<void>[] = [];
  if (row.needs_tag) {
    promises.push(
      (async () => {
        try {
          tagResult = await tagMessage({
            message: row.message,
            role: row.role,
            agent_platform: row.agent_platform,
            agent_model: row.agent_model,
          });
        } catch (err) {
          tagError = err;
        }
      })()
    );
  }
  if (row.needs_embed) {
    promises.push(
      (async () => {
        try {
          embedding = await embedMessage(row.message);
        } catch (err) {
          embedError = err;
        }
      })()
    );
  }
  await Promise.all(promises);

  // 둘 다 실패면 row 처리 실패로 간주 (caller가 cold_error 박음)
  const tagFailed = row.needs_tag && tagError;
  const embedFailed = row.needs_embed && embedError;
  if (tagFailed && embedFailed) {
    throw new Error(`tag+embed both failed: tag=${tagError?.message?.slice(0,80)} embed=${embedError?.message?.slice(0,80)}`);
  }

  // 부분 성공/실패 → 채워진 부분만 UPDATE
  const sets: string[] = [];
  const params: any[] = [];
  let i = 1;
  if (row.needs_tag && tagResult !== null) {
    const tag: TagResult = tagResult;
    sets.push(`p_tag_id = $${i++}`);
    params.push(tag.p_tag_id);
    sets.push(`d_tag = $${i++}::text[]`);
    params.push(tag.d_tag);
  }
  if (row.needs_embed && embedding) {
    sets.push(`embedding = $${i++}::halfvec`);
    params.push(vectorToHalfvecSql(embedding));
  }
  // cold_error 갱신: 일부 실패면 이유 기록, 다 성공이면 NULL
  if (tagError || embedError) {
    const parts: string[] = [];
    if (tagError) parts.push(`tag: ${String(tagError?.message ?? tagError).slice(0, 200)}`);
    if (embedError) parts.push(`embed: ${String(embedError?.message ?? embedError).slice(0, 200)}`);
    sets.push(`cold_error = $${i++}`);
    params.push(parts.join(' | '));
  } else {
    sets.push(`cold_error = NULL`);
  }
  sets.push(`updated_at = NOW()`);

  if (sets.length === 1) {
    // updated_at만 set 할 게 아무것도 없는 경우 (이미 done이었음). skip.
    return;
  }

  params.push(row.id);
  await client.query(
    `UPDATE memory SET ${sets.join(', ')} WHERE id = $${i}`,
    params
  );
}

async function recordError(client: any, rowId: number, err: any): Promise<void> {
  const msg = String(err?.message ?? err).slice(0, 1000);
  await client.query(
    `UPDATE memory SET cold_error = $1, updated_at = NOW() WHERE id = $2`,
    [msg, rowId]
  );
}

async function tick(): Promise<void> {
  if (running) return; // re-entry guard (이전 tick이 아직 진행 중)
  running = true;

  const batchSize = envInt('COLD_PATH_BATCH_SIZE', DEFAULT_BATCH);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const rows = await claimBatch(client, batchSize);
    if (rows.length === 0) {
      await client.query('COMMIT');
      return;
    }
    for (const row of rows) {
      try {
        await processOne(client, row);
      } catch (err) {
        // 개별 row 실패는 격리 — error 기록 후 다음 row 진행
        await recordError(client, row.id, err);
        console.error(`⚠️ [ColdPath] row ${row.id} failed:`, err);
      }
    }
    await client.query('COMMIT');
    if (rows.length > 0) {
      console.error(`🔵 [ColdPath] processed ${rows.length} row(s)`);
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error("❌ [ColdPath] tick failed:", err);
  } finally {
    client.release();
    running = false;
  }
}

export function startColdPathWorker(): void {
  if (process.env.COLD_PATH_ENABLED === 'false') {
    console.error("🔵 [ColdPath] disabled (COLD_PATH_ENABLED=false)");
    return;
  }

  const intervalSec = envInt('COLD_PATH_INTERVAL_SEC', DEFAULT_INTERVAL_SEC);
  const warmupSec = envInt('COLD_PATH_WARMUP_SEC', DEFAULT_WARMUP_SEC);

  console.error(`🔵 [ColdPath] starting — warmup ${warmupSec}s, interval ${intervalSec}s`);

  warmupTimer = setTimeout(() => {
    intervalTimer = setInterval(() => {
      tick().catch((err) => console.error("❌ [ColdPath] unhandled tick error:", err));
    }, intervalSec * 1000);
    // 첫 tick 즉시 한번 실행
    tick().catch((err) => console.error("❌ [ColdPath] unhandled first tick:", err));
  }, warmupSec * 1000);
}

export function stopColdPathWorker(): void {
  if (warmupTimer) clearTimeout(warmupTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  warmupTimer = null;
  intervalTimer = null;
  console.error("🔵 [ColdPath] stopped");
}

/**
 * 직접 호출용 — worker 활성 상태와 무관하게 1회 batch 처리.
 * 테스트/스크립트 용.
 */
export async function runColdPathOnce(): Promise<void> {
  await tick();
}
