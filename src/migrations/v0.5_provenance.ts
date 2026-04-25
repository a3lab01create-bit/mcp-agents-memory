import { db } from "../db.js";

async function migrate() {
    console.log("🚀 Starting Migration v0.5: Provenance & Identity Layer...");

    try {
        // 1. Create Models and Platforms tables for trust management
        console.log("🛠️ Creating models and platforms tables...");
        
        await db.query(`
            CREATE TABLE IF NOT EXISTS models (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(50) NOT NULL,
                model_name VARCHAR(100) NOT NULL UNIQUE,
                trust_weight NUMERIC(3, 2) NOT NULL DEFAULT 0.80,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS platforms (
                id SERIAL PRIMARY KEY,
                name VARCHAR(50) NOT NULL UNIQUE,
                trust_weight NUMERIC(3, 2) NOT NULL DEFAULT 1.00,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);

        // 2. Create Provenance table
        console.log("🛠️ Creating fact_provenances table...");
        await db.query(`
            CREATE TABLE IF NOT EXISTS fact_provenances (
                id SERIAL PRIMARY KEY,
                fact_id INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
                author_model_id INTEGER REFERENCES models(id),
                platform_id INTEGER REFERENCES platforms(id),
                session_id VARCHAR(100),
                raw_input TEXT,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);

        // 3. Update Facts table
        console.log("🛠️ Updating facts table...");
        await db.query(`
            ALTER TABLE facts 
            ADD COLUMN IF NOT EXISTS author_model_id INTEGER REFERENCES models(id),
            ADD COLUMN IF NOT EXISTS effective_confidence NUMERIC(4, 2);
        `);

        // 4. Seed default models and platforms
        console.log("🌱 Seeding default trust data...");
        await db.query(`
            INSERT INTO models (provider, model_name, trust_weight, metadata) VALUES
            ('anthropic', 'claude-3-5-sonnet-20240620', 0.95, '{"alias": "sonnet"}'),
            ('anthropic', 'claude-3-opus-20240229',   0.98, '{"alias": "opus"}'),
            ('openai',    'gpt-4o',                    0.95, '{"alias": "gpt-4o"}'),
            ('openai',    'gpt-4o-mini',               0.85, '{"alias": "gpt-4o-mini"}'),
            ('openai',    'gpt-5.5',                   0.99, '{"alias": "gpt-5.5"}'),
            ('google',    'gemini-1.5-pro',            0.95, '{"alias": "gemini"}')
            ON CONFLICT (model_name) DO NOTHING;

            INSERT INTO platforms (name, trust_weight) VALUES
            ('claude-code', 1.00),
            ('antigravity', 1.00),
            ('terminal',    0.90),
            ('vscode',      1.00)
            ON CONFLICT (name) DO NOTHING;
        `);

        console.log("✅ Migration v0.5 completed successfully!");
    } catch (err) {
        console.error("❌ Migration FAILED:", err);
    } finally {
        await db.close();
        process.exit(0);
    }
}

migrate();
