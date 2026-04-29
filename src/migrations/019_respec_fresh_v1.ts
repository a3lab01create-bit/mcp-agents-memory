/**
 * Migration 019 — RESPEC v1 fresh schema.
 *
 * Adds: users, project_tags, memory (3 tables, single-table soft-delete archive).
 * Doesn't touch legacy tables (subjects, memories, skills, etc) — those get
 * renamed to _legacy_* in Phase F migration after data migration completes.
 *
 * RESPEC.md references:
 *   §1.1 archive = is_active=FALSE + archived_at
 *   §1.3 role 컬럼 (user/assistant)
 *   §1.4 is_pinned + archive 면제 CHECK
 *   §1.5 project_tags + alias_of
 *   §1.6 subagent 1-level + consistency CHECK
 *   §2.d subagent_role normalize 트리거
 *   §2.e vector(3072) + HNSW partial index
 *   §2-B 인덱스 7종 + Cold Path queue partial idx + cold_error
 */

import { db } from "../db.js";

const MIGRATION_NAME = "019_respec_fresh_v1";

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

      // pgvector ext (already present via earlier migrations, but idempotent)
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

      // ── users ──────────────────────────────────────────────────────
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          user_id      BIGSERIAL PRIMARY KEY,
          user_name    TEXT NOT NULL UNIQUE,
          core_profile TEXT,
          sub_profile  TEXT,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      // ── project_tags ───────────────────────────────────────────────
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_tags (
          id          BIGSERIAL PRIMARY KEY,
          name        TEXT NOT NULL UNIQUE,
          description TEXT,
          alias_of    BIGINT REFERENCES project_tags(id) ON DELETE SET NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS project_tags_alias_of_idx
          ON project_tags (alias_of) WHERE alias_of IS NOT NULL;
      `);

      // ── memory ─────────────────────────────────────────────────────
      await client.query(`
        CREATE TABLE IF NOT EXISTS memory (
          id              BIGSERIAL PRIMARY KEY,
          user_id         BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,

          agent_platform  TEXT NOT NULL,
          agent_model     TEXT NOT NULL,

          subagent        BOOLEAN NOT NULL DEFAULT FALSE,
          subagent_model  TEXT,
          subagent_role   TEXT,
          CONSTRAINT subagent_consistency CHECK (
            (subagent = FALSE AND subagent_model IS NULL AND subagent_role IS NULL)
            OR
            (subagent = TRUE  AND subagent_model IS NOT NULL)
          ),

          role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          message         TEXT NOT NULL,

          p_tag_id        BIGINT REFERENCES project_tags(id) ON DELETE SET NULL,
          d_tag           TEXT[] NOT NULL DEFAULT '{}',

          -- halfvec(3072): pgvector vector type은 HNSW index가 dim ≤ 2000만 지원.
          -- halfvec(반정밀도)은 ≤ 4000까지 HNSW 가능. 3-large 3072 dim 그대로
          -- 저장하되 16-bit precision (검색 품질은 사실상 동일, 저장량 절반).
          embedding       halfvec(3072),

          is_active       BOOLEAN NOT NULL DEFAULT TRUE,
          archived_at     TIMESTAMPTZ,

          is_pinned       BOOLEAN NOT NULL DEFAULT FALSE,
          CONSTRAINT pinned_not_archived CHECK (
            NOT (is_pinned = TRUE AND archived_at IS NOT NULL)
          ),

          cold_error      TEXT,

          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      // ── 인덱스 (§2-B) ──────────────────────────────────────────────
      await client.query(`
        CREATE INDEX IF NOT EXISTS memory_user_active_created_idx
          ON memory (user_id, is_active, created_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS memory_p_tag_idx
          ON memory (p_tag_id) WHERE p_tag_id IS NOT NULL;
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS memory_d_tag_idx
          ON memory USING GIN (d_tag);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS memory_role_idx
          ON memory (role);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS memory_pinned_idx
          ON memory (user_id, created_at DESC) WHERE is_pinned = TRUE;
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS memory_cold_queue_idx
          ON memory (created_at) WHERE embedding IS NULL OR p_tag_id IS NULL;
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS memory_embedding_idx
          ON memory USING hnsw (embedding halfvec_cosine_ops)
          WHERE embedding IS NOT NULL;
      `);

      // ── 트리거: updated_at 자동 갱신 (각 테이블) ────────────────────
      await client.query(`
        CREATE OR REPLACE FUNCTION respec_touch_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await client.query(`
        DROP TRIGGER IF EXISTS users_touch ON users;
        CREATE TRIGGER users_touch BEFORE UPDATE ON users
          FOR EACH ROW EXECUTE FUNCTION respec_touch_updated_at();
      `);
      await client.query(`
        DROP TRIGGER IF EXISTS memory_touch ON memory;
        CREATE TRIGGER memory_touch BEFORE UPDATE ON memory
          FOR EACH ROW EXECUTE FUNCTION respec_touch_updated_at();
      `);
      await client.query(`
        DROP TRIGGER IF EXISTS project_tags_touch ON project_tags;
        CREATE TRIGGER project_tags_touch BEFORE UPDATE ON project_tags
          FOR EACH ROW EXECUTE FUNCTION respec_touch_updated_at();
      `);

      // ── 트리거: subagent_role lowercase + trim normalize (§2-A.d) ──
      await client.query(`
        CREATE OR REPLACE FUNCTION respec_normalize_subagent_role()
        RETURNS TRIGGER AS $$
        BEGIN
          IF NEW.subagent_role IS NOT NULL THEN
            NEW.subagent_role = lower(trim(NEW.subagent_role));
            IF NEW.subagent_role = '' THEN
              NEW.subagent_role = NULL;
            END IF;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await client.query(`
        DROP TRIGGER IF EXISTS memory_normalize_role ON memory;
        CREATE TRIGGER memory_normalize_role
          BEFORE INSERT OR UPDATE ON memory
          FOR EACH ROW EXECUTE FUNCTION respec_normalize_subagent_role();
      `);

      // ── 기록 ────────────────────────────────────────────────────────
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
