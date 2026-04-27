import { db } from "../db.js";
const MIGRATION_NAME = "007_seed_real_models";
async function migrate() {
    console.log(`💾 Running Migration: ${MIGRATION_NAME}...`);
    try {
        // Ensure migration_history exists (defensive)
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
            await client.query('BEGIN');
            // 1. Demote unused/unverified entries (never DELETE — preserves provenance per "구버전 보존" policy)
            console.log("📌 Demoting unused model entries (preserve row for provenance)...");
            const demoted = await client.query(`
        UPDATE models
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{status}',
          '"deprecated"'::jsonb
        )
        WHERE model_name IN (
          'gpt-5.5',
          'grok-4.20-0309-reasoning',
          'grok-4-1-fast-reasoning'
        )
        RETURNING model_name
      `);
            console.log(`   Demoted: ${demoted.rows.map((r) => r.model_name).join(', ') || 'none'}`);
            // 2. Upsert real models (current as of project knowledge cutoff)
            console.log("🌱 Upserting real models...");
            await client.query(`
        INSERT INTO models (provider, model_name, trust_weight, metadata) VALUES
          ('anthropic', 'claude-sonnet-4-6',          0.95, '{"alias": "sonnet"}'),
          ('anthropic', 'claude-haiku-4-5',           0.88, '{"alias": "haiku"}'),
          ('anthropic', 'claude-opus-4-7',            0.98, '{"alias": "opus"}'),
          ('openai',    'gpt-4o',                      0.95, '{"alias": "gpt-4o"}'),
          ('openai',    'gpt-4o-mini',                 0.85, '{"alias": "gpt-4o-mini"}'),
          ('openai',    'gpt-5.4',                     0.97, '{"alias": "gpt-5.4"}'),
          ('openai',    'text-embedding-3-small',      0.90, '{"alias": "embedding"}'),
          ('openai',    'o1',                          0.97, '{"alias": "o1"}'),
          ('openai',    'o3-mini',                     0.93, '{"alias": "o3-mini"}'),
          ('google',    'gemini-2.0-flash-exp',        0.88, '{"alias": "gemini-flash"}'),
          ('google',    'gemini-2.5-pro',              0.95, '{"alias": "gemini-pro"}'),
          ('xai',       'grok-2-latest',               0.92, '{"alias": "grok-2"}'),
          ('xai',       'grok-4-latest',               0.96, '{"alias": "grok-4"}')
        ON CONFLICT (model_name) DO UPDATE SET
          trust_weight = EXCLUDED.trust_weight,
          metadata     = EXCLUDED.metadata;
      `);
            await client.query("INSERT INTO migration_history (name) VALUES ($1)", [MIGRATION_NAME]);
            await client.query('COMMIT');
            console.log(`✅ Migration ${MIGRATION_NAME} completed successfully!`);
        }
        catch (txErr) {
            await client.query('ROLLBACK');
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
