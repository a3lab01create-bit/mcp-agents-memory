/**
 * Interactive setup wizard. Invoked by `mcp-agents-memory setup`.
 *
 * Flow:
 *   1. Prompt user for DATABASE_URL (preferred) or individual DB_* fields.
 *   2. Prompt for OpenAI key (required) + optional Tavily/Exa for grounding.
 *   3. Write the resulting .env to ~/.config/mcp-agents-memory/.env (XDG).
 *   4. Reload env from that location.
 *   5. Apply base v0.4 schema (subjects, memories) idempotently.
 *   6. Run `runAllMigrations()` so 006-011 land too.
 *   7. Insert generic system seed subjects (system_global, system_orchestrator).
 *
 * Notes for future-me:
 * - Existing dev environments with project-root .env will still work because
 *   db.ts's loadEnv() searches `cwd/.env` BEFORE the XDG path. The wizard's
 *   XDG write only takes effect for npx-style installs that run outside the
 *   project tree.
 * - Schema-vs-migrations divergence on a TRULY fresh DB has not been
 *   verified end-to-end against a cloud Postgres yet (advisor flag from
 *   the packaging session). Migrations 006/007 target a `facts` table that
 *   never exists on a fresh install; they need a "skip-if-facts-missing"
 *   guard before this wizard works on Neon. Tracked in scratch packaging spec.
 */

import inquirer from "inquirer";
import fs from "fs";
import path from "path";
import os from "os";
import dotenv from "dotenv";
import { db } from "./db.js";
import { PACKAGE_VERSION } from "./version.js";
import { runAllMigrations } from "./migrations/runner.js";

const XDG_DIR = path.join(os.homedir(), ".config", "mcp-agents-memory");
const XDG_ENV_PATH = path.join(XDG_DIR, ".env");

function ensureXdgDir() {
  fs.mkdirSync(XDG_DIR, { recursive: true });
}

async function promptDb(): Promise<{ envBlock: string; description: string }> {
  const { mode } = await inquirer.prompt([
    {
      type: "list",
      name: "mode",
      message: "Database connection",
      choices: [
        { name: "Connection string (recommended — Neon, Supabase, Railway, etc.)", value: "url" },
        { name: "Individual fields (host/port/user/pass/db)", value: "fields" },
      ],
      default: "url",
    },
  ]);

  if (mode === "url") {
    const { url } = await inquirer.prompt([
      {
        type: "password",
        name: "url",
        mask: "*",
        message: "DATABASE_URL (postgres://user:pass@host:5432/db?sslmode=require)",
        validate: (v: string) =>
          /^postgres(ql)?:\/\//.test(v.trim()) || "Must start with postgres:// or postgresql://",
      },
    ]);
    const trimmed = url.trim();
    return { envBlock: `DATABASE_URL=${trimmed}`, description: "DATABASE_URL" };
  }

  const a = await inquirer.prompt([
    { type: "input", name: "dbHost", message: "DB Host?", default: "localhost" },
    { type: "input", name: "dbPort", message: "DB Port?", default: "5432" },
    { type: "input", name: "dbUser", message: "DB User?", default: "postgres" },
    { type: "password", name: "dbPass", message: "DB Password?", mask: "*" },
    { type: "input", name: "dbName", message: "DB Name?", default: "mcp_memory" },
    { type: "confirm", name: "ssl", message: "Connection requires SSL?", default: false },
  ]);

  const lines = [
    `DB_HOST=${a.dbHost}`,
    `DB_PORT=${a.dbPort}`,
    `DB_USER=${a.dbUser}`,
    `DB_PASS=${a.dbPass}`,
    `DB_NAME=${a.dbName}`,
  ];
  if (a.ssl) lines.push("DB_SSL=true");
  return { envBlock: lines.join("\n"), description: "individual DB_* fields" };
}

async function promptApiKeys(): Promise<string> {
  console.log("\n🧠 AI keys");
  console.log("  OpenAI is required for embeddings + Librarian fact extraction.");
  console.log("  Tavily/Exa are optional (used for v4.5 Skill Auditor + v5.0 memory grounding).");
  console.log("  Leave blank to skip a key — you can add it later by editing the config file.\n");

  const a = await inquirer.prompt([
    { type: "password", name: "openai", mask: "*", message: "OPENAI_API_KEY (sk-...)" },
    { type: "password", name: "anthropic", mask: "*", message: "ANTHROPIC_API_KEY (optional, for grounding-pipeline reconciler)" },
    { type: "password", name: "google", mask: "*", message: "GOOGLE_GENERATIVE_AI_API_KEY (optional, for Curator/Triage)" },
    { type: "password", name: "tavily", mask: "*", message: "TAVILY_API_KEY (optional, recency search)" },
    { type: "password", name: "exa", mask: "*", message: "EXA_API_KEY (optional, authority search)" },
  ]);

  const lines: string[] = [];
  if (a.openai) lines.push(`OPENAI_API_KEY=${a.openai}`);
  if (a.anthropic) lines.push(`ANTHROPIC_API_KEY=${a.anthropic}`);
  if (a.google) lines.push(`GOOGLE_GENERATIVE_AI_API_KEY=${a.google}`);
  if (a.tavily) lines.push(`TAVILY_API_KEY=${a.tavily}`);
  if (a.exa) lines.push(`EXA_API_KEY=${a.exa}`);
  lines.push("LIBRARIAN_MODEL=gpt-4o-mini");

  if (!a.openai) {
    console.log("⚠️  No OpenAI key — semantic search and Librarian extraction will fail at runtime.");
  }

  return lines.join("\n");
}

export async function applyBaseSchema() {
  console.log("\n📡 Applying base schema...");

  await db.query(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await db.query(`CREATE EXTENSION IF NOT EXISTS vector`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS subjects (
        id SERIAL PRIMARY KEY,
        subject_type VARCHAR(20) NOT NULL
            CHECK (subject_type IN ('person', 'agent', 'project', 'team', 'system', 'category')),
        subject_key VARCHAR(100) NOT NULL UNIQUE,
        display_name VARCHAR(100) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS memories (
        id SERIAL PRIMARY KEY,
        subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        project_subject_id INTEGER REFERENCES subjects(id),
        content TEXT NOT NULL,
        source_text TEXT,
        fact_type VARCHAR(20) NOT NULL
            CHECK (fact_type IN ('preference', 'profile', 'state', 'skill', 'decision', 'learning', 'relationship')),
        confidence SMALLINT NOT NULL DEFAULT 7
            CHECK (confidence BETWEEN 1 AND 10),
        importance SMALLINT NOT NULL DEFAULT 5
            CHECK (importance BETWEEN 1 AND 10),
        tags TEXT[] DEFAULT '{}',
        embedding vector(1536),
        source VARCHAR(20) NOT NULL DEFAULT 'librarian'
            CHECK (source IN ('librarian', 'user', 'agent', 'system', 'migration')),
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TIMESTAMPTZ,
        superseded_by INTEGER REFERENCES memories(id),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    DO $$
    DECLARE
        t text;
    BEGIN
        FOR t IN
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('subjects', 'memories')
        LOOP
            EXECUTE format('DROP TRIGGER IF EXISTS trg_updated_at ON %I', t);
            EXECUTE format(
                'CREATE TRIGGER trg_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                t
            );
        END LOOP;
    END $$;
  `);

  await db.query(`
    CREATE OR REPLACE FUNCTION validate_project_subject_type()
    RETURNS TRIGGER AS $$
    BEGIN
        IF NEW.project_subject_id IS NOT NULL THEN
            IF (SELECT subject_type FROM subjects WHERE id = NEW.project_subject_id) != 'project' THEN
                RAISE EXCEPTION 'project_subject_id must reference a subject with type "project"';
            END IF;
        END IF;
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_validate_project_type_memories ON memories;
    CREATE TRIGGER trg_validate_project_type_memories
    BEFORE INSERT OR UPDATE ON memories
    FOR EACH ROW
    EXECUTE FUNCTION validate_project_subject_type();
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_subjects_type ON subjects(subject_type);
    CREATE INDEX IF NOT EXISTS idx_subjects_key ON subjects(subject_key);
    CREATE INDEX IF NOT EXISTS idx_subjects_active ON subjects(is_active);
    CREATE INDEX IF NOT EXISTS idx_memories_subject_id ON memories(subject_id);
    CREATE INDEX IF NOT EXISTS idx_memories_project_subject_id ON memories(project_subject_id);
    CREATE INDEX IF NOT EXISTS idx_memories_fact_type ON memories(fact_type);
    CREATE INDEX IF NOT EXISTS idx_memories_is_active ON memories(is_active);
    CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
    CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING GIN(tags);
    CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories USING hnsw (embedding vector_cosine_ops);
    CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by);
    CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
  `);
}

export async function applyGenericSeed() {
  console.log("🌱 Seeding system subjects...");
  await db.query(
    `
    INSERT INTO subjects (subject_type, subject_key, display_name, metadata) VALUES
    ('system',   'system_global',         'Global Context', '{}'),
    ('system',   'system_orchestrator',   'Harness-Main', $1::jsonb)
    ON CONFLICT (subject_key) DO NOTHING;
  `,
    [JSON.stringify({ version: PACKAGE_VERSION })]
  );
}

export async function runSetupWizard(): Promise<void> {
  console.log(`🚀 mcp-agents-memory setup wizard (v${PACKAGE_VERSION})\n`);

  const { envBlock: dbBlock, description: dbDesc } = await promptDb();
  const apiBlock = await promptApiKeys();

  const envContent =
    [
      "# mcp-agents-memory configuration — generated by setup wizard",
      `# Generated: ${new Date().toISOString()}`,
      "",
      dbBlock,
      "",
      apiBlock,
      "",
      "# Optional v5.0 background loops — opt-in",
      "PROMOTION_ENABLED=false",
      "FORGETTING_ENABLED=false",
      "MEMORY_AUDIT_ENABLED=false",
    ].join("\n") + "\n";

  ensureXdgDir();
  fs.writeFileSync(XDG_ENV_PATH, envContent, { mode: 0o600 });
  console.log(`\n✅ Config written to ${XDG_ENV_PATH} (mode 0600)`);
  console.log(`   Database: ${dbDesc}`);

  // Reload env from the file we just wrote so the schema/migration phase can use it.
  // db.ts memoizes the first load; we force a re-read by calling dotenv.config directly.
  dotenv.config({ path: XDG_ENV_PATH, override: true });

  try {
    await applyBaseSchema();

    console.log("\n📦 Running migration runner...");
    await runAllMigrations();

    await applyGenericSeed();

    const cwdEnv = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(cwdEnv) && cwdEnv !== XDG_ENV_PATH) {
      console.log(
        `\nℹ️  A project-root ${cwdEnv} exists and takes precedence over the XDG config above.`
      );
      console.log("   Delete or rename it if you want this XDG config to be active.");
    }

    console.log(`\n✅ Setup complete. Add this to your MCP client config:`);
    console.log(`
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["mcp-agents-memory"]
    }
  }
}
`);
  } catch (err) {
    console.error("\n❌ Schema/migration phase failed:", err);
    throw err;
  } finally {
    await db.close().catch(() => {});
  }
}

// Allow `node build/setup.js` to still work (legacy `npm run setup` path).
const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith("/setup.js");
if (invokedDirectly) {
  runSetupWizard()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
