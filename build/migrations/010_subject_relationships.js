import { db } from "../db.js";
const MIGRATION_NAME = "010_subject_relationships";
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
            await client.query('BEGIN');
            console.log("🛠️  Restoring subject_relationships table (v5.0 Memory Graph)...");
            await client.query(`
        CREATE TABLE IF NOT EXISTS subject_relationships (
          id SERIAL PRIMARY KEY,
          from_subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
          to_subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
          relationship_type VARCHAR(50) NOT NULL
            CHECK (relationship_type IN ('owns', 'delegates_to', 'advises', 'reports_to', 'collaborates')),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_no_self_relationship CHECK (from_subject_id <> to_subject_id),
          CONSTRAINT uq_subject_relationship UNIQUE (from_subject_id, to_subject_id, relationship_type)
        );
      `);
            console.log("🔍 Creating subject_relationships indexes...");
            await client.query(`
        CREATE INDEX IF NOT EXISTS idx_subj_rel_from ON subject_relationships(from_subject_id);
        CREATE INDEX IF NOT EXISTS idx_subj_rel_to ON subject_relationships(to_subject_id);
        CREATE INDEX IF NOT EXISTS idx_subj_rel_type ON subject_relationships(relationship_type);
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
