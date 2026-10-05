import { db } from "../db.js";

const MIGRATION_NAME = "032_project_hint_venues";

/**
 * 명부 항목의 채널 힌트 — DEVLOG §24 L3.
 *
 * 왜: 태거는 글 하나만 보고 판정한다. "Committing"·".env 추가해줄까" 같은 한 줄에는 프로젝트 단서가 없어서
 * 프로젝트 채널에서 나온 글도 엉뚱한 곳으로 갔다(2026-10-05 실측: MDs_copy_db 채널 글 276행 중 정답 0).
 * 명부 항목에 그 프로젝트의 버즈 채널(venue, 예: buzz:MarketDev)을 적어 두면 그 채널 글에 힌트 한 줄을 준다.
 *
 * nullable·기본값 없는 칼럼 추가라 기존 행 재작성 없음. 코드는 이 칼럼이 없어도(이 마이그레이션 전) 명부 모드 그대로 돈다.
 */
const LOCK_RETRIES = 24;
const LOCK_RETRY_WAIT_MS = 5000;

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

    // project_tags는 콜드패스 배치가 memory.p_tag_id FK로 잡고 있을 수 있다 — 031처럼 5초 잠금 대기 + 재시도
    for (let attempt = 1; ; attempt++) {
      const client = await db.getClient();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '5s'");

        await client.query(`ALTER TABLE project_tags ADD COLUMN IF NOT EXISTS hint_venues TEXT[];`);

        await client.query("INSERT INTO migration_history (name) VALUES ($1)", [
          MIGRATION_NAME,
        ]);
        await client.query("COMMIT");
        console.log(`✅ Migration ${MIGRATION_NAME} completed successfully!`);
        break;
      } catch (txErr) {
        await client.query("ROLLBACK");
        if ((txErr as { code?: string }).code !== "55P03" || attempt >= LOCK_RETRIES) throw txErr;
        console.log(`⏳ project_tags 잠금 대기 중 (${attempt}/${LOCK_RETRIES}) — ${LOCK_RETRY_WAIT_MS / 1000}초 뒤 재시도`);
        await new Promise((r) => setTimeout(r, LOCK_RETRY_WAIT_MS));
      } finally {
        client.release();
      }
    }
  } catch (err) {
    console.error(`❌ Migration ${MIGRATION_NAME} FAILED:`, err);
    process.exit(1);
  } finally {
    await db.close();
  }
}

migrate();
