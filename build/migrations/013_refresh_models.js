/**
 * Refresh `models` registry rows — current as of 2026-04-27.
 *
 * - Demotes deprecated entries (NEVER deletes — provenance preservation policy
 *   per `feedback_model_version_lifecycle` memory note).
 * - Upserts current Gemini lineup (2.5-flash-lite, 2.5-flash, 3-flash-preview,
 *   3.1-pro-preview) discovered from the live pricing page.
 * - Upserts grok-4-latest alias which is now the audit/contradiction default
 *   path when users opt for the "Premium" preset.
 */
import { db } from "../db.js";
const MIGRATION_NAME = "013_refresh_models";
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
            console.log("📌 Demoting deprecated model entries (preserve row, just stamp metadata)...");
            await client.query(`
        UPDATE models
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{status}',
          '"deprecated"'::jsonb
        )
        WHERE model_name IN (
          'gemini-2.0-flash-exp',
          'gemini-1.5-pro'
        );
      `);
            console.log("🌱 Upserting current model lineup...");
            await client.query(`
        INSERT INTO models (provider, model_name, trust_weight, metadata) VALUES
          -- Google: Gemini 2.5 GA + 3.x Preview
          ('google',    'gemini-2.5-flash-lite',         0.85, '{"alias": "gemini-flash-lite", "status": "ga"}'),
          ('google',    'gemini-2.5-flash',              0.92, '{"alias": "gemini-flash", "status": "ga"}'),
          ('google',    'gemini-3-flash-preview',        0.93, '{"alias": "gemini-3-flash", "status": "preview"}'),
          ('google',    'gemini-3.1-flash-lite-preview', 0.88, '{"alias": "gemini-3.1-flash-lite", "status": "preview"}'),
          ('google',    'gemini-3.1-pro-preview',        0.97, '{"alias": "gemini-3.1-pro", "status": "preview"}'),
          -- xAI: dated reasoning variant + alias
          ('xai',       'grok-4.20-0309-reasoning',      0.96, '{"alias": "grok-4.20-reasoning", "status": "ga"}'),
          ('xai',       'grok-4-latest',                 0.96, '{"alias": "grok-4-latest", "status": "alias"}')
        ON CONFLICT (model_name) DO UPDATE SET
          trust_weight = EXCLUDED.trust_weight,
          metadata     = EXCLUDED.metadata;
      `);
            await client.query("INSERT INTO migration_history (name) VALUES ($1)", [MIGRATION_NAME]);
            await client.query("COMMIT");
            console.log(`✅ Migration ${MIGRATION_NAME} completed successfully!`);
        }
        catch (txErr) {
            await client.query("ROLLBACK");
            throw txErr;
        }
        finally {
            client.release();
        }
    }
    catch (err) {
        console.error(`❌ Migration ${MIGRATION_NAME} FAILED:`, err);
        process.exit(1);
    }
    finally {
        await db.close();
    }
}
migrate();
