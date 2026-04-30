/**
 * Migration 021 — agent_model NULL 허용 (form 4-30 catch).
 *
 * 배경: user role 메시지엔 모델 정보가 N/A — 사람이 친 거니까. 현 schema는
 * agent_model TEXT NOT NULL이라 'unknown' sentinel이 user row + assistant model
 * 누락 케이스 둘 다에 같이 박히는 의미 모호 상태.
 *
 * 수정: NOT NULL 제약 drop. 이후 jsonl_capture / save_message 가 user role 시
 * agent_model = NULL 인서트. assistant 시 모델 명시 (없으면 'unknown' 폴백 유지).
 *
 * 기존 row: 변경 없음. retroactive cleanup 안 함 (의미적으로 'unknown'이 user인지
 * model 누락인지 식별 불가 — 그냥 둠).
 */

import { db } from "../db.js";

const MIGRATION_NAME = "021_agent_model_nullable";

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
          ALTER COLUMN agent_model DROP NOT NULL
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
