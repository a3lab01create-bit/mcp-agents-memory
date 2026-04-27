import { db } from "../db.js";
const MIGRATION_NAME = "009_skills_tables";
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
            console.log("🛠️  Creating skills tables...");
            await client.query(`
        CREATE TABLE IF NOT EXISTS skills (
          id SERIAL PRIMARY KEY,
          title VARCHAR(200) NOT NULL,
          content TEXT NOT NULL,
          embedding vector(1536),
          status VARCHAR(20) NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'inactive', 'deprecated')),
          validation_tier VARCHAR(30) NOT NULL DEFAULT 'unvalidated'
            CHECK (validation_tier IN ('validated_external', 'validated_internal',
                                        'unvalidated', 'contested', 'pending_revalidation')),
          parent_skill_id INTEGER REFERENCES skills(id),
          origin_model_ids INTEGER[] DEFAULT '{}',
          origin_platform_ids INTEGER[] DEFAULT '{}',
          sources JSONB NOT NULL DEFAULT '[]'::jsonb,
          applicable_to JSONB NOT NULL DEFAULT '{}'::jsonb,
          use_count INTEGER NOT NULL DEFAULT 0,
          last_used_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS skill_changelog (
          id SERIAL PRIMARY KEY,
          skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
          change_type VARCHAR(20) NOT NULL
            CHECK (change_type IN ('append', 'correction', 'annotation', 'created', 'branched')),
          content_diff TEXT,
          source_memory_ids INTEGER[] DEFAULT '{}',
          author_model_id INTEGER REFERENCES models(id),
          platform_id INTEGER REFERENCES platforms(id),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
            console.log("🔍 Creating skills indexes...");
            await client.query(`
        CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
        CREATE INDEX IF NOT EXISTS idx_skills_validation_tier ON skills(validation_tier);
        CREATE INDEX IF NOT EXISTS idx_skills_parent ON skills(parent_skill_id);
        CREATE INDEX IF NOT EXISTS idx_skills_embedding ON skills USING hnsw (embedding vector_cosine_ops);
        CREATE INDEX IF NOT EXISTS idx_skill_changelog_skill ON skill_changelog(skill_id);
      `);
            console.log("⚙️  Creating skills updated_at trigger...");
            await client.query(`
        DROP TRIGGER IF EXISTS trg_updated_at_skills ON skills;
        CREATE TRIGGER trg_updated_at_skills
        BEFORE UPDATE ON skills
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
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
