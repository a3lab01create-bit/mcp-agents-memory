import { db } from "../db.js";

const MIGRATION_NAME = "025_project_tag_alias_suggestions";

/**
 * Stage 2 (project_alias_promoter) — pending alias 제안 저장소 + write-side cycle guard.
 * DEVLOG §19. §18(read-time canonical projection) 위에 "누가/어떻게 alias_of를 채우나".
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

      // 제안 큐 (상태머신 + evidence). project_tags는 ground truth만 유지.
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_tag_alias_suggestions (
          id                  BIGSERIAL PRIMARY KEY,
          user_id             BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          source_tag_id       BIGINT NOT NULL REFERENCES project_tags(id) ON DELETE CASCADE,
          target_tag_id       BIGINT NOT NULL REFERENCES project_tags(id) ON DELETE CASCADE,
          relation            TEXT NOT NULL CHECK (relation IN
                                ('rename','alias','same_project','different','misfile_suspected','insufficient')),
          status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                                ('pending','confirmed','rejected','auto_applied','superseded','expired')),
          confidence          NUMERIC(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
          candidate_sources   TEXT[] NOT NULL DEFAULT '{}',
          evidence_memory_ids BIGINT[] NOT NULL DEFAULT '{}',
          conflict_memory_ids BIGINT[] NOT NULL DEFAULT '{}',
          signals             JSONB NOT NULL DEFAULT '{}'::jsonb,
          model_provider      TEXT,
          model_name          TEXT,
          rationale           TEXT NOT NULL DEFAULT '',
          auto_apply_eligible BOOLEAN NOT NULL DEFAULT FALSE,
          decided_by          TEXT CHECK (decided_by IN ('user','system')),
          decision_reason     TEXT,
          decided_at          TIMESTAMPTZ,
          applied_at          TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (source_tag_id <> target_tag_id)
        );
      `);

      // 같은 태그쌍(방향 무관)에 대해 'pending' 제안은 하나만. reject/confirm 후엔 재제안 허용.
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS project_tag_alias_suggestions_open_pair_idx
          ON project_tag_alias_suggestions
          (user_id, LEAST(source_tag_id, target_tag_id), GREATEST(source_tag_id, target_tag_id))
          WHERE status = 'pending';
      `);

      // brief/worker 조회용 (pending 목록 등)
      await client.query(`
        CREATE INDEX IF NOT EXISTS project_tag_alias_suggestions_status_idx
          ON project_tag_alias_suggestions (user_id, status, created_at DESC);
      `);

      // write-side cycle guard: 태그가 자기 자신을 alias 할 수 없음.
      // §18 canonical_project_tag_id() 함수는 read 방어일 뿐 — write 정책은 여기서.
      await client.query(`
        ALTER TABLE project_tags
          ADD CONSTRAINT project_tags_no_self_alias
          CHECK (alias_of IS NULL OR alias_of <> id);
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
