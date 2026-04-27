import { db } from "../db.js";

const MIGRATION_NAME = "006_canonical_validation";

async function migrate() {
  console.log(`💾 Running Migration: ${MIGRATION_NAME}...`);
  
  try {
    // 1. migration_history 보장 (트랜잭션 밖에서 수행)
    await db.query(`
      CREATE TABLE IF NOT EXISTS migration_history (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 2. 이미 적용됐는지 체크
    const check = await db.query("SELECT 1 FROM migration_history WHERE name = $1", [MIGRATION_NAME]);
    if (check.rows.length > 0) {
      console.log(`⏩ Migration ${MIGRATION_NAME} already applied. Skipping.`);
      return;
    }

    // 3. 본문은 트랜잭션으로 보호
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      console.log("🛠️  Applying schema changes within transaction...");

      // Detect target table — fresh installs have only `memories`,
      // legacy upgrades may still carry `facts` (renamed by migration 008).
      const tablesRes = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('facts', 'memories')
      `);
      const tables = new Set(tablesRes.rows.map((r: any) => r.table_name));
      const target = tables.has('memories')
        ? 'memories'
        : tables.has('facts')
        ? 'facts'
        : null;
      if (!target) {
        throw new Error(
          "Neither 'facts' nor 'memories' exists. Run setup so the base schema is created before applying migrations."
        );
      }
      console.log(`   Target table: ${target}`);

      // A. Add provenance columns to the active table.
      await client.query(`
        ALTER TABLE ${target}
          ADD COLUMN IF NOT EXISTS author_model       VARCHAR(100),
          ADD COLUMN IF NOT EXISTS platform           VARCHAR(100),
          ADD COLUMN IF NOT EXISTS session_id         VARCHAR(100),
          ADD COLUMN IF NOT EXISTS validation_status  VARCHAR(20) DEFAULT 'pending',
          ADD COLUMN IF NOT EXISTS last_validated_at  TIMESTAMPTZ;
      `);

      // SAFE TO DROP: prior fact_validations versions were inconsistent
      // (v0.6_schema/v0.6_validation conflict). Recreated with the canonical
      // schema and an FK to whichever table currently holds memories.
      await client.query(`DROP TABLE IF EXISTS fact_validations CASCADE;`);
      await client.query(`
        CREATE TABLE fact_validations (
            id SERIAL PRIMARY KEY,
            fact_id INTEGER NOT NULL REFERENCES ${target}(id) ON DELETE CASCADE,
            status VARCHAR(20) NOT NULL,
            confidence_score FLOAT NOT NULL,
            research_report TEXT,
            metadata JSONB DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // B. Backfill v0.5_provenance: applied before migration_history existed
      await client.query(
        `INSERT INTO migration_history (name) VALUES ('v0.5_provenance')
         ON CONFLICT (name) DO NOTHING`
      );

      // C. 현재 마이그레이션 기록
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
