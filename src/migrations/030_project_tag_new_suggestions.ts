import { db } from "../db.js";

const MIGRATION_NAME = "030_project_tag_new_suggestions";

/**
 * 새 프로젝트 태그 제안 큐 — d_tag 승격기가 project_tags에 바로 넣지 않고 여기 남긴다.
 *
 * 왜: 승격기가 자주 쓰인 d_tag를 10분마다 project_tags에 자동으로 넣어서, 일반어(windows·upload·save…)와
 * 클러스터러가 지어낸 합성어(bug-fix-code-review…)가 프로젝트 태그로 쌓였다 (09-01 이후 61개). 지워도
 * d_tag가 자주 쓰이는 한 다시 생겼다 (`mcp` 삭제 1분 뒤 재생성).
 *
 * 별칭 제안 표(025)는 source/target이 project_tags FK라 아직 없는 태그를 담을 수 없어서 따로 둔다.
 * (user_id, name)은 상태와 무관하게 한 행 — 반려된 이름은 이 행이 남아 있는 한 다시 제안되지 않는다
 * (2026-10-03 형 결정: 반려는 영구). 반려는 이름 기준이다: 클러스터 멤버까지 막으면 `cafe24-api`(멤버
 * cafe24)를 반려했을 때 `cafe24`도 영영 못 올라온다. 대신 클러스터러가 대표 이름을 바꿔 고른 변형은
 * 다시 물을 수 있다 — 진짜 프로젝트를 영영 못 올리는 것보다 한 번 더 묻는 쪽이 싸다.
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
        CREATE TABLE IF NOT EXISTS project_tag_new_suggestions (
          id               BIGSERIAL PRIMARY KEY,
          user_id          BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          name             TEXT NOT NULL,
          members          TEXT[] NOT NULL DEFAULT '{}',
          uses             INTEGER NOT NULL DEFAULT 0,
          status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                             ('pending','confirmed','rejected','superseded')),
          recommendation   TEXT CHECK (recommendation IN ('project','generic','unsure')),
          rationale        TEXT NOT NULL DEFAULT '',
          model_provider   TEXT,
          model_name       TEXT,
          project_tag_id   BIGINT REFERENCES project_tags(id) ON DELETE SET NULL,
          retrotagged      INTEGER,
          decided_by       TEXT CHECK (decided_by IN ('user','system')),
          decision_reason  TEXT,
          decided_at       TIMESTAMPTZ,
          last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (user_id, name)
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS project_tag_new_suggestions_status_idx
          ON project_tag_new_suggestions (user_id, status, created_at DESC);
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
