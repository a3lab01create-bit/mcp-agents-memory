/**
 * Drop legacy CHECK constraints whose names still carry the original
 * `facts_*` prefix from before migration 008 renamed the table to `memories`.
 *
 * Why this exists: Postgres does NOT auto-rename CHECK constraints when the
 * table is renamed. So a DB that went through 008 ends up with both
 * `memories_source_check` (the modern constraint added by 012) AND
 * `facts_source_check` (the original, with the old enum that rejects
 * 'connector'). Inserts have to satisfy both — and the legacy one rejects
 * 'connector', breaking the Notion connector pipeline silently.
 *
 * This migration drops the legacy `facts_*_check` constraints since their
 * modern counterparts (memories_*) are already enforcing the same rules.
 */

import { db } from "../db.js";

const MIGRATION_NAME = "014_drop_legacy_facts_constraints";

const LEGACY_CONSTRAINTS = [
  "facts_source_check",
  "facts_fact_type_check",
  "facts_confidence_check",
  "facts_importance_check",
];

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

      for (const cname of LEGACY_CONSTRAINTS) {
        const r = await client.query(
          `SELECT 1 FROM pg_constraint
             WHERE conrelid = 'memories'::regclass AND conname = $1`,
          [cname]
        );
        if (r.rows.length > 0) {
          console.log(`🗑️  Dropping legacy constraint: ${cname}`);
          await client.query(`ALTER TABLE memories DROP CONSTRAINT ${cname}`);
        } else {
          console.log(`⏩ ${cname} not present — skipping`);
        }
      }

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
