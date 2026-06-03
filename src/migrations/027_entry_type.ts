import { db } from "../db.js";

const MIGRATION_NAME = "027_entry_type";

/**
 * §task-pin (2026-06-03): memory 테이블에 entry_type discriminator 추가.
 *
 * 배경: 멀티에이전트 오피스 task-pin을 메모리 테이블에 재활용(별도 테이블 신설 X).
 * task-pin은 일반 대화 메모리와 성격이 반대 — status가 변하고(append-only 이력),
 * 회상에 뜨면 브리핑 도배. d_tag 마커는 Cold Path(tagger/dtag_promoter)가
 * 건드려 불안정 → Cold Path가 절대 손대지 않는 전용 칸으로 분리.
 *
 *   entry_type = 'memory' (기본, 기존 모든 행)  → 회상 대상
 *   entry_type = 'task'                          → task-pin, 회상에서 거름망 제외
 *
 * 부분 인덱스: task 조회는 entry_type='task'만 빠르게, 일반 회상은 'memory'만.
 */
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

      await client.query(`
        ALTER TABLE memory
          ADD COLUMN IF NOT EXISTS entry_type TEXT NOT NULL DEFAULT 'memory';
      `);

      // task-pin 조회용 부분 인덱스 (user별 시간순)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_memory_task
          ON memory (user_id, created_at DESC)
          WHERE entry_type = 'task';
      `);

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
