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

      // 1. Remove fictional models
      console.log("🗑️   Removing fictional model entries...");
      const removed = await client.query(`
        DELETE FROM models
        WHERE model_name IN (
          'gpt-5.5',
          'grok-4.20-0309-reasoning',
          'grok-4-1-fast-reasoning'
        )
        RETURNING model_name
      `);
      console.log(`   Removed: ${removed.rows.map((r: any) => r.model_name).join(', ') || 'none'}`);

      // 2. Upsert real models (current as of project knowledge cutoff)
      console.log("🌱 Upserting real models...");
      await client.query(`
        INSERT INTO models (provider, model_name, trust_weight, metadata) VALUES
          ('anthropic', 'claude-3-5-sonnet-20241022', 0.95, '{"alias": "sonnet"}'),
          ('anthropic', 'claude-3-5-haiku-20241022',  0.88, '{"alias": "haiku"}'),
          ('anthropic', 'claude-3-opus-20240229',     0.98, '{"alias": "opus"}'),
          ('openai',    'gpt-4o',                      0.95, '{"alias": "gpt-4o"}'),
          ('openai',    'gpt-4o-mini',                 0.85, '{"alias": "gpt-4o-mini"}'),
          ('openai',    'o1',                          0.97, '{"alias": "o1"}'),
          ('openai',    'o3-mini',                     0.93, '{"alias": "o3-mini"}'),
          ('google',    'gemini-1.5-pro',              0.95, '{"alias": "gemini-pro"}'),
          ('google',    'gemini-2.0-flash-exp',        0.88, '{"alias": "gemini-flash"}'),
          ('xai',       'grok-2-latest',               0.92, '{"alias": "grok-2"}'),
          ('xai',       'grok-beta',                   0.85, '{"alias": "grok-beta"}')
        ON CONFLICT (model_name) DO UPDATE SET
          trust_weight = EXCLUDED.trust_weight,
          metadata     = EXCLUDED.metadata;
      `);

      await client.query("INSERT INTO migration_history (name) VALUES ($1)", [MIGRATION_NAME]);
      await client.query('COMMIT');
      console.log(`✅ Migration ${MIGRATION_NAME} completed successfully!`);
    } catch (txErr) {
      await client.query('ROLLBACK');
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
