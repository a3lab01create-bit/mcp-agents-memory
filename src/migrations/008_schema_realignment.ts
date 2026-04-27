import { db } from "../db.js";

const MIGRATION_NAME = "008_schema_realignment";

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

      // 1. Detect current table state and rename facts -> memories if needed
      console.log("🔎 Detecting memory table state...");
      const tableState = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('facts', 'memories')
      `);
      const tables = new Set(tableState.rows.map((r: any) => r.table_name));

      if (tables.has('facts') && !tables.has('memories')) {
        console.log("🔁 Renaming facts table to memories...");
        await client.query(`ALTER TABLE facts RENAME TO memories`);
      } else if (tables.has('memories')) {
        console.log("   memories table already exists; skipping rename.");
      } else {
        throw new Error("Neither facts nor memories table exists; cannot realign schema.");
      }

      // 2. Add target columns idempotently
      console.log("➕ Adding memories target columns...");
      await client.query(`
        ALTER TABLE memories
          ADD COLUMN IF NOT EXISTS tier VARCHAR(20) NOT NULL DEFAULT 'short_term' CHECK (tier IN ('short_term', 'long_term')),
          ADD COLUMN IF NOT EXISTS platform_id INTEGER REFERENCES platforms(id),
          ADD COLUMN IF NOT EXISTS consolidated_at TIMESTAMPTZ;
      `);

      // 3. Backfill existing rows
      console.log("🧹 Backfilling memory tiers...");
      await client.query(`UPDATE memories SET tier = 'short_term' WHERE tier IS NULL`);

      // Re-assert desired column properties for databases where tier pre-existed.
      await client.query(`
        ALTER TABLE memories
          ALTER COLUMN tier SET DEFAULT 'short_term',
          ALTER COLUMN tier SET NOT NULL;
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'memories'::regclass
              AND conname = 'memories_tier_check'
          ) THEN
            ALTER TABLE memories
              ADD CONSTRAINT memories_tier_check CHECK (tier IN ('short_term', 'long_term'));
          END IF;
        END $$;
      `);

      // 4. Indexes
      console.log("🔍 Creating memories indexes...");
      await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_platform_id ON memories(platform_id)`);

      // 5. Record migration
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
