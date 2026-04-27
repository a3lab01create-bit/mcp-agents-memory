import { db } from "../db.js";

const MIGRATION_NAME = "012_memory_sources";

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

      console.log("🔧 Extending memories.source CHECK with 'connector' value...");
      // Postgres has no "ADD VALUE TO CHECK" — drop + add is the canonical pattern.
      // The constraint name follows Postgres' default for table_column_check.
      await client.query(`
        ALTER TABLE memories
          DROP CONSTRAINT IF EXISTS memories_source_check;
        ALTER TABLE memories
          ADD CONSTRAINT memories_source_check
          CHECK (source IN ('librarian', 'user', 'agent', 'system', 'migration', 'connector'));
      `);

      console.log("🛠️  Creating memory_sources table...");
      await client.query(`
        CREATE TABLE IF NOT EXISTS memory_sources (
          id SERIAL PRIMARY KEY,
          provider VARCHAR(20) NOT NULL
            CHECK (provider IN ('notion', 'github', 'drive')),
          external_id VARCHAR(200) NOT NULL,
          resource_type VARCHAR(20) NOT NULL
            CHECK (resource_type IN ('page', 'database', 'file', 'commit', 'pr')),
          title VARCHAR(500),
          last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          content_hash CHAR(64) NOT NULL,
          facts_added INTEGER NOT NULL DEFAULT 0,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_provider_external UNIQUE (provider, external_id)
        );
      `);

      console.log("🔍 Creating memory_sources indexes...");
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_memory_sources_provider ON memory_sources(provider);
        CREATE INDEX IF NOT EXISTS idx_memory_sources_last_synced ON memory_sources(last_synced_at DESC);
      `);

      console.log("⚙️  Creating updated_at trigger for memory_sources...");
      await client.query(`
        DROP TRIGGER IF EXISTS trg_updated_at ON memory_sources;
        CREATE TRIGGER trg_updated_at
        BEFORE UPDATE ON memory_sources
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      `);

      console.log("🌱 Seeding system_connector_notion subject...");
      await client.query(`
        INSERT INTO subjects (subject_type, subject_key, display_name, metadata)
        VALUES ('system', 'system_connector_notion', 'Notion Connector', '{"provider": "notion"}'::jsonb)
        ON CONFLICT (subject_key) DO NOTHING;
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
