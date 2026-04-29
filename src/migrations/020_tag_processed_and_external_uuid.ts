/**
 * Migration 020 — RESPEC PROBLEMS.md §4 follow-up (codex+gemini review fix).
 *
 * P1 fix:
 *   1. tag_processed BOOLEAN — "tagger 정상 실행됨" 표식. p_tag_id IS NULL은
 *      "정상적으로 p_tag 없음" 또는 "미처리"를 동시에 표현해서 worker가
 *      매 cycle 재시도하던 root cause 분리.
 *   2. external_uuid TEXT — JSONL 캡처 dedup 키. save_message + JSONL
 *      병행 시 같은 메시지 2회 INSERT 위험 차단.
 *
 * 기존 row 처리:
 *   - p_tag_id IS NOT NULL 이면 tag_processed = TRUE (이미 처리된 row)
 *   - 나머지 (NULL p_tag) → tag_processed = FALSE (다음 Cold Path가 시도)
 *   - external_uuid는 모두 NULL (legacy 데이터엔 uuid 없음)
 */

import { db } from "../db.js";

const MIGRATION_NAME = "020_tag_processed_and_external_uuid";

async function migrate() {
  console.log(`💾 Running Migration: ${MIGRATION_NAME}...`);

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS migration_history (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    const check = await db.query(
      "SELECT 1 FROM migration_history WHERE name = $1",
      [MIGRATION_NAME]
    );
    if (check.rows.length > 0) {
      console.log(`⏩ Migration ${MIGRATION_NAME} already applied. Skipping.`);
      return;
    }

    const client = await db.getClient();
    try {
      await client.query("BEGIN");

      // ── tag_processed 컬럼 ──
      await client.query(`
        ALTER TABLE memory
          ADD COLUMN IF NOT EXISTS tag_processed BOOLEAN NOT NULL DEFAULT FALSE
      `);

      // 기존 row 정합화: p_tag 있으면 처리된 것으로 마크
      await client.query(`
        UPDATE memory
           SET tag_processed = TRUE
         WHERE p_tag_id IS NOT NULL
      `);

      // ── external_uuid 컬럼 + UNIQUE INDEX (NULL 허용 partial) ──
      await client.query(`
        ALTER TABLE memory
          ADD COLUMN IF NOT EXISTS external_uuid TEXT
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS memory_external_uuid_idx
          ON memory (external_uuid)
          WHERE external_uuid IS NOT NULL
      `);

      // ── Cold Path queue partial index 갱신 ──
      // 새 정합 query: needs_tag = (NOT tag_processed). embedding NULL 도 처리 대상.
      // 기존 cold_queue idx는 (created_at) WHERE embedding IS NULL OR p_tag_id IS NULL.
      // 이건 그대로 유지 — embedding NULL은 명확한 "미처리" 신호이고, p_tag_id IS NULL
      // 분리는 worker.ts SQL 레벨에서 처리. 인덱스 자체는 false-positive를 좀 더
      // 잡지만 결과 정합엔 영향 없음.

      await client.query("INSERT INTO migration_history (name) VALUES ($1)", [
        MIGRATION_NAME,
      ]);
      await client.query("COMMIT");
      console.log(`✅ Migration ${MIGRATION_NAME} completed successfully!`);
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`❌ Migration ${MIGRATION_NAME} FAILED:`, err);
    process.exit(1);
  } finally {
    await db.close();
  }
}

migrate();
