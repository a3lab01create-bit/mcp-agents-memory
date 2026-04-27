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

      // A. facts 테이블 컬럼 추가
      await client.query(`
        DO $$ 
        BEGIN 
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='facts' AND column_name='author_model') THEN
            ALTER TABLE facts ADD COLUMN author_model VARCHAR(100);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='facts' AND column_name='platform') THEN
            ALTER TABLE facts ADD COLUMN platform VARCHAR(100);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='facts' AND column_name='session_id') THEN
            ALTER TABLE facts ADD COLUMN session_id VARCHAR(100);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='facts' AND column_name='validation_status') THEN
            ALTER TABLE facts ADD COLUMN validation_status VARCHAR(20) DEFAULT 'pending';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='facts' AND column_name='last_validated_at') THEN
            ALTER TABLE facts ADD COLUMN last_validated_at TIMESTAMPTZ;
          END IF;
        END $$;
      `);

      // SAFE TO DROP: 이전 fact_validations는 v0.6_schema/v0.6_validation 충돌로
      // 일관성 없는 상태였으므로 데이터 손실 없음. 향후 마이그레이션은 ALTER 우선.
      await client.query(`DROP TABLE IF EXISTS fact_validations CASCADE;`);
      
      await client.query(`
        CREATE TABLE fact_validations (
            id SERIAL PRIMARY KEY,
            fact_id INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
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
