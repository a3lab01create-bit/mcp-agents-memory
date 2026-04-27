import { db } from "../db.js";

const MIGRATION_NAME = "015_agent_provenance";

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

      // Curator (the agent that called memory_add) — distinct from Producer
      // (author_model/platform). Two columns because some platforms (e.g.
      // OpenClaw) don't have a default model and must declare both at runtime.
      await client.query(`
        ALTER TABLE memories ADD COLUMN IF NOT EXISTS agent_platform VARCHAR(100);
        ALTER TABLE memories ADD COLUMN IF NOT EXISTS agent_model VARCHAR(100);
        UPDATE memories SET agent_platform = platform WHERE agent_platform IS NULL AND platform IS NOT NULL;
        UPDATE memories SET agent_model = author_model WHERE agent_model IS NULL AND author_model IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_memories_agent_platform ON memories(agent_platform);
        CREATE INDEX IF NOT EXISTS idx_memories_agent_model ON memories(agent_model);
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
