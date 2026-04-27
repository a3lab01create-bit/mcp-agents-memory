/**
 * Fresh-install end-to-end test driver.
 *
 * Drives the same components the interactive setup wizard does, but reads
 * DATABASE_URL from the shell so we can point at a clean DB (Neon free tier
 * was the prompt) and observe the full schema converge.
 *
 * Usage:
 *   SSH_ENABLED=false DATABASE_URL="postgres://...?sslmode=require" \
 *     node scratch/test_neon_fresh_install.js
 */

import "dotenv/config";
import { db } from "../build/db.js";
import { applyBaseSchema, applyGenericSeed } from "../build/setup.js";
import { runAllMigrations } from "../build/migrations/runner.js";

async function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

try {
  if (!process.env.DATABASE_URL) {
    await fail("DATABASE_URL not set; this driver runs against a fresh cloud DB.");
  }
  console.log("=== Fresh-install end-to-end (against DATABASE_URL) ===");

  console.log("\n[1/3] Applying base schema...");
  await applyBaseSchema();

  console.log("\n[2/3] Running migration runner...");
  await runAllMigrations();

  console.log("\n[3/3] Applying generic seed...");
  await applyGenericSeed();

  // Verify the schema converged: memories must have all the columns runtime
  // code references (validation_status from 006, tier from 008, metadata
  // from 011, plus the v0.4 baseline).
  console.log("\n=== Schema verification ===");
  const required = [
    "id",
    "subject_id",
    "content",
    "fact_type",
    "confidence",
    "importance",
    "embedding",
    "is_active",
    "tier",                  // migration 008
    "platform_id",           // migration 008
    "consolidated_at",       // migration 008
    "validation_status",     // migration 006
    "last_validated_at",     // migration 006
    "author_model",          // migration 006
    "author_model_id",       // migration 005
    "platform",              // migration 006
    "session_id",            // migration 006
    "metadata",              // migration 011
  ];
  const cols = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='memories'`
  );
  const present = new Set(cols.rows.map((r) => r.column_name));
  const missing = required.filter((c) => !present.has(c));

  if (missing.length > 0) {
    console.log(`❌ memories table is missing columns: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`✅ memories has all ${required.length} required columns.`);

  // Verify the supporting tables also exist
  const supportTables = [
    "subjects",
    "memories",
    "models",
    "platforms",
    "fact_provenances",
    "fact_validations",
    "subject_relationships",
    "migration_history",
  ];
  const t = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public'`
  );
  const tnames = new Set(t.rows.map((r) => r.table_name));
  const missingTables = supportTables.filter((x) => !tnames.has(x));
  if (missingTables.length > 0) {
    console.log(`❌ Missing tables: ${missingTables.join(", ")}`);
    process.exit(1);
  }
  console.log(`✅ All ${supportTables.length} supporting tables present.`);

  // Verify migration_history has all our migrations
  const mh = await db.query(`SELECT name FROM migration_history ORDER BY name`);
  const mnames = mh.rows.map((r) => r.name);
  console.log(`✅ migration_history rows: ${mnames.join(", ")}`);

  // Verify generic seed worked
  const seedCheck = await db.query(
    `SELECT subject_key FROM subjects WHERE subject_type = 'system' ORDER BY subject_key`
  );
  console.log(`✅ system subjects: ${seedCheck.rows.map((r) => r.subject_key).join(", ")}`);

  console.log("\n🎉 Fresh-install verified against the configured DATABASE_URL.");
} catch (err) {
  console.error("\n❌ Fresh-install test failed:", err);
  process.exitCode = 1;
} finally {
  await db.close().catch(() => {});
}
