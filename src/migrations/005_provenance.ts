/**
 * v0.5 Provenance & Identity Layer.
 *
 * Renamed from v0.5_provenance.ts so the migration runner (which matches
 * `^\d{3}_.+\.js$`) actually picks it up — and so it sorts BEFORE 006/007
 * which depend on the `models` and `platforms` tables this migration creates.
 *
 * MIGRATION_NAME is kept as 'v0.5_provenance' so existing dev databases
 * (which had this name backfilled by migration 006) continue to skip cleanly
 * via the migration_history check.
 *
 * Fresh-install fixes vs the original file:
 *   - Detects whether `facts` or `memories` is the active table and
 *     ALTERs / FKs against whichever exists. Original assumed `facts`.
 *   - Wraps body in an explicit transaction.
 *   - Adds proper migration_history check + insert (the original re-ran
 *     every invocation and exited 0 even on error).
 */

import { db } from "../db.js";

const MIGRATION_NAME = "v0.5_provenance";

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

      // Detect target table for facts-related ALTERs and FKs.
      // Fresh installs have only `memories` (created by setup.ts applyBaseSchema).
      // Legacy DBs may still have `facts` (renamed to memories by migration 008).
      const tablesRes = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('facts', 'memories')
      `);
      const tables = new Set(tablesRes.rows.map((r: any) => r.table_name));
      const target = tables.has("memories")
        ? "memories"
        : tables.has("facts")
        ? "facts"
        : null;
      if (!target) {
        throw new Error(
          "Neither 'facts' nor 'memories' exists. Run `mcp-agents-memory setup` so the base schema is created before applying migrations."
        );
      }
      console.log(`   Target table for provenance columns: ${target}`);

      console.log("🛠️ Creating models and platforms tables...");
      await client.query(`
        CREATE TABLE IF NOT EXISTS models (
          id SERIAL PRIMARY KEY,
          provider VARCHAR(50) NOT NULL,
          model_name VARCHAR(100) NOT NULL UNIQUE,
          trust_weight NUMERIC(3, 2) NOT NULL DEFAULT 0.80,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS platforms (
          id SERIAL PRIMARY KEY,
          name VARCHAR(50) NOT NULL UNIQUE,
          trust_weight NUMERIC(3, 2) NOT NULL DEFAULT 1.00,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      console.log(`🛠️ Creating fact_provenances table (FK → ${target})...`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS fact_provenances (
          id SERIAL PRIMARY KEY,
          fact_id INTEGER NOT NULL REFERENCES ${target}(id) ON DELETE CASCADE,
          author_model_id INTEGER REFERENCES models(id),
          platform_id INTEGER REFERENCES platforms(id),
          session_id VARCHAR(100),
          raw_input TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      console.log(`🛠️ Adding provenance columns to ${target}...`);
      await client.query(`
        ALTER TABLE ${target}
        ADD COLUMN IF NOT EXISTS author_model_id INTEGER REFERENCES models(id),
        ADD COLUMN IF NOT EXISTS effective_confidence NUMERIC(4, 2);
      `);

      console.log("🌱 Seeding default trust data...");
      await client.query(`
        INSERT INTO models (provider, model_name, trust_weight, metadata) VALUES
          ('anthropic', 'claude-3-5-sonnet-20240620', 0.95, '{"alias": "sonnet"}'),
          ('anthropic', 'claude-3-opus-20240229',     0.98, '{"alias": "opus"}'),
          ('openai',    'gpt-4o',                      0.95, '{"alias": "gpt-4o"}'),
          ('openai',    'gpt-4o-mini',                 0.85, '{"alias": "gpt-4o-mini"}'),
          ('google',    'gemini-1.5-pro',              0.95, '{"alias": "gemini"}')
        ON CONFLICT (model_name) DO NOTHING;

        INSERT INTO platforms (name, trust_weight) VALUES
          ('claude-code', 1.00),
          ('antigravity', 1.00),
          ('terminal',    0.90),
          ('vscode',      1.00)
        ON CONFLICT (name) DO NOTHING;
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
