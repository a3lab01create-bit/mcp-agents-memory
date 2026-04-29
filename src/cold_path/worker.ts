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
 */
async function claimBatch(client: any, batch: number): Promise<ColdRow[]> {
  const r = await client.query(
    `SELECT id, message, role, agent_platform, agent_model,
            (p_tag_id IS NULL) AS needs_tag,
            (embedding IS NULL) AS needs_embed
       FROM memory
      WHERE (embedding IS NULL OR p_tag_id IS NULL)
      ORDER BY created_at ASC
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

async function processOne(client: any, row: ColdRow): Promise<void> {
  let p_tag_id: number | null | undefined;
  let d_tag: string[] | undefined;
  let embedding: number[] | undefined;

  if (row.needs_tag) {
    const tag = await tagMessage({
      message: row.message,
      role: row.role,
      agent_platform: row.agent_platform,
      agent_model: row.agent_model,
    });
    p_tag_id = tag.p_tag_id;
    d_tag = tag.d_tag;
  }

  if (row.needs_embed) {
    embedding = await embedMessage(row.message);
  }

  // SET 절 동적 구성 (필요한 컬럼만)
  const sets: string[] = [];
  const params: any[] = [];
  let i = 1;
  if (row.needs_tag) {
    sets.push(`p_tag_id = $${i++}`);
    params.push(p_tag_id ?? null);
    sets.push(`d_tag = $${i++}::text[]`);
    params.push(d_tag ?? []);
  }
  if (row.needs_embed) {
    sets.push(`embedding = $${i++}::halfvec`);
    params.push(embedding ? vectorToHalfvecSql(embedding) : null);
  }
  sets.push(`cold_error = NULL`);
  sets.push(`updated_at = NOW()`);
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
