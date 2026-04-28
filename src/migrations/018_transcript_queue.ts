import { db } from "../db.js";

const MIGRATION_NAME = "018_transcript_queue";

/**
 * Track 1 — Hook self-watch staging table.
 *
 * shutdown handler INSERTs jsonl path + byte range here (no LLM call,
 * keeps shutdown under db.close() 3s race). A background loop drains
 * pending rows: read jsonl → Librarian fact extraction → memories.
 *
 * UNIQUE (session_id, source_path, byte_offset_end) blocks double-save
 * across restarts; cosine dedup remains as last-resort fallback.
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

    const check = await db.query("SELECT 1 FROM migration_history WHERE name = $1", [MIGRATION_NAME]);
    if (check.rows.length > 0) {
      console.log(`⏩ Migration ${MIGRATION_NAME} already applied. Skipping.`);
      return;
    }

    const client = await db.getClient();
    try {
      await client.query("BEGIN");

      await client.query(`
        CREATE TABLE IF NOT EXISTS transcript_queue (
          id SERIAL PRIMARY KEY,
          session_id TEXT NOT NULL,
          source_path TEXT NOT NULL,
          byte_offset_start BIGINT NOT NULL DEFAULT 0,
          byte_offset_end BIGINT NOT NULL,
          cwd TEXT,
          client_name TEXT,
          caller_platform TEXT,
          caller_model TEXT,
          caller_agent_key TEXT,
          captured_at TIMESTAMPTZ DEFAULT NOW(),
          processed_at TIMESTAMPTZ,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'processing', 'done', 'failed')),
          error TEXT,
          UNIQUE (session_id, source_path, byte_offset_end)
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_transcript_queue_pending
          ON transcript_queue(status, captured_at)
          WHERE status = 'pending';
      `);

      await client.query("INSERT INTO migration_history (name) VALUES ($1)", [MIGRATION_NAME]);
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
