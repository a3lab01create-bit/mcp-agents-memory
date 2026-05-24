import { db } from "../db.js";

const MIGRATION_NAME = "024_canonical_project_tag_projection";

type Queryable = {
  query: (...args: any[]) => Promise<any>;
};

export async function up(client: Queryable): Promise<void> {
  await client.query(`
    CREATE OR REPLACE FUNCTION canonical_project_tag_id(p_id BIGINT)
    RETURNS BIGINT
    LANGUAGE sql
    STABLE
    AS $$
      WITH RECURSIVE chain(id, alias_of, path) AS (
        SELECT id, alias_of, ARRAY[id]::BIGINT[]
          FROM project_tags
         WHERE id = p_id
        UNION ALL
        SELECT pt.id, pt.alias_of, c.path || pt.id
          FROM project_tags pt
          JOIN chain c ON pt.id = c.alias_of
         WHERE NOT pt.id = ANY(c.path)
      )
      SELECT CASE
        WHEN p_id IS NULL THEN NULL
        ELSE COALESCE(
          (SELECT id FROM chain WHERE alias_of IS NULL LIMIT 1),
          p_id
        )
      END;
    $$;
  `);
}

export async function down(client: Queryable): Promise<void> {
  await client.query(`
    DROP FUNCTION IF EXISTS canonical_project_tag_id(BIGINT);
  `);
}

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

    const check = await db.query(
      "SELECT 1 FROM migration_history WHERE name = $1",
      [MIGRATION_NAME]
    );
    if (check.rows.length > 0) {
      console.log(`⏩ Migration ${MIGRATION_NAME} already applied. Skipping.`);
      return;
    }

    const client = await db.getClient();
    try {
      await client.query("BEGIN");

      await up(client);

      await client.query("INSERT INTO migration_history (name) VALUES ($1)", [
        MIGRATION_NAME,
      ]);
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
