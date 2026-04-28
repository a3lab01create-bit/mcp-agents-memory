import { db } from "../db.js";

const MIGRATION_NAME = "016_agent_curator";

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
        ALTER TABLE memories ADD COLUMN IF NOT EXISTS agent_curator_id INT REFERENCES subjects(id);
        CREATE INDEX IF NOT EXISTS idx_memories_agent_curator ON memories(agent_curator_id);

        ALTER TABLE skill_changelog ADD COLUMN IF NOT EXISTS agent_curator_id INT REFERENCES subjects(id);
        CREATE INDEX IF NOT EXISTS idx_skill_changelog_agent_curator ON skill_changelog(agent_curator_id);
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
