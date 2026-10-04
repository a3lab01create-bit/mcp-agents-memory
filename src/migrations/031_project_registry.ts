import { db } from "../db.js";

const MIGRATION_NAME = "031_project_registry";

/**
 * 프로젝트 명부(registry) — DEVLOG §24 L1.
 *
 * 왜: 태거 후보가 "가장 오래된 태그 20개"로 고정이라(기본 oldest·20) 04-29 이후 생긴 프로젝트를 태거가 한 번도
 * 선택지로 보지 못했고, 그 20개에 일반어·버전명이 섞여 있었다. 사람이 고른 짧은 명부를 태거 후보로 쓴다.
 *
 *   kind    'project'  = 프로젝트 / 'category' = 프로젝트는 아니지만 늘 쓰는 칸(형에 대한 기억 등)
 *           NULL       = 명부 밖(옛 일반어 태그 포함). 지우지 않는다 — 옛 글의 태그는 그대로 남는다.
 *   paused  멈춘 프로젝트. 태거 후보에는 남기고(다시 얘기하면 붙도록) 브리핑 "활성 프로젝트"에서만 뺀다.
 *
 * 명부에 한 줄이라도 있으면 명부 모드: 태거는 명부에서만 고르고 새 이름을 만들지 않는다.
 * 명부가 비어 있으면(공개 사용자 기본) 지금 동작 그대로.
 * nullable·기본값 없는 칼럼 추가라 기존 행 재작성 없음.
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
      await client.query("SET LOCAL lock_timeout = '5s'");

      await client.query(`
        ALTER TABLE project_tags
          ADD COLUMN IF NOT EXISTS kind TEXT CHECK (kind IN ('project','category')),
          ADD COLUMN IF NOT EXISTS paused BOOLEAN NOT NULL DEFAULT FALSE;
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS project_tags_registry_idx
          ON project_tags (kind) WHERE kind IS NOT NULL;
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
