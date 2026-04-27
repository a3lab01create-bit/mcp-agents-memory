import dotenv from 'dotenv';
dotenv.config(); // Load environment variables BEFORE importing db

import inquirer from 'inquirer';
import fs from 'fs';
import { db } from './db.js';

async function setup() {
  console.log("🚀 mcp-agents-memory Setup Wizard starting...");

  const answers = await inquirer.prompt([
    { type: 'input', name: 'dbHost', message: 'DB Host?', default: 'localhost' },
    { type: 'input', name: 'dbPort', message: 'DB Port?', default: '5432' },
    { type: 'input', name: 'dbUser', message: 'DB User?', default: 'postgres' },
    { type: 'password', name: 'dbPass', message: 'DB Password?' },
    { type: 'input', name: 'dbName', message: 'DB Name?', default: 'mcp_memory' },
    { type: 'confirm', name: 'useSSH', message: 'Use SSH Tunnel?', default: false },
  ]);

  let sshConfig = "";
  if (answers.useSSH) {
    const sshAnswers = await inquirer.prompt([
      { type: 'input', name: 'sshHost', message: 'SSH Host?' },
      { type: 'input', name: 'sshPort', message: 'SSH Port?', default: '22' },
      { type: 'input', name: 'sshUser', message: 'SSH User?' },
      { type: 'input', name: 'sshKey', message: 'SSH Private Key Path?' },
    ]);
    sshConfig = `
SSH_ENABLED=true
SSH_HOST=${sshAnswers.sshHost}
SSH_PORT=${sshAnswers.sshPort}
SSH_USER=${sshAnswers.sshUser}
SSH_KEY_PATH=${sshAnswers.sshKey}`;
  } else {
    sshConfig = "\nSSH_ENABLED=false";
  }

  // OpenAI API Key (required for semantic search + librarian)
  console.log("\n🧠 AI Setup (Embeddings + Librarian)");
  console.log("   Used for: semantic search (embeddings) + fact extraction (librarian)");
  console.log("   Get your key at: https://platform.openai.com/api-keys\n");
  const aiAnswers = await inquirer.prompt([
    { type: 'password', name: 'openaiKey', message: 'OpenAI API Key? (sk-...)', mask: '*' },
  ]);

  const openaiConfig = aiAnswers.openaiKey ? `\nOPENAI_API_KEY=${aiAnswers.openaiKey}` : '';
  if (!aiAnswers.openaiKey) {
    console.log("⚠️  No API key provided. Semantic search & Librarian will be disabled until you add OPENAI_API_KEY to .env");
  }

  // Librarian model selection
  const librarianConfig = `\nLIBRARIAN_MODEL=gpt-4o-mini`;

  const envContent = `
DB_HOST=${answers.dbHost}
DB_PORT=${answers.dbPort}
DB_USER=${answers.dbUser}
DB_PASS=${answers.dbPass}
DB_NAME=${answers.dbName}${sshConfig}${openaiConfig}${librarianConfig}
`;

  fs.writeFileSync('.env', envContent.trim());
  console.log("✅ .env file generated successfully.");

  dotenv.config();

  try {
    console.log("📡 Connecting to Database to apply schema...");

    // ---------------------------------------------------------
    // 1. Utility Functions
    // ---------------------------------------------------------
    console.log("🛠️ Creating utility functions...");
    await db.query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // ---------------------------------------------------------
    // 2. Vector Support (pgvector) — must come before tables
    // ---------------------------------------------------------
    console.log("🧬 Setting up vector support...");
    await db.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    // ---------------------------------------------------------
    // 3. Core Tables (v0.4 — simplified schema)
    // ---------------------------------------------------------
    console.log("📁 Creating tables...");

    // subjects — 주체 관리 (유지)
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

    // memories — 통합 메모리 테이블 (신규)
    await db.query(`
      CREATE TABLE IF NOT EXISTS memories (
          id SERIAL PRIMARY KEY,

          -- 소유자 & 프로젝트
          subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
          project_subject_id INTEGER REFERENCES subjects(id),

          -- 핵심 내용
          content TEXT NOT NULL,
          source_text TEXT,

          -- 분류
          fact_type VARCHAR(20) NOT NULL
              CHECK (fact_type IN ('preference', 'profile', 'state', 'skill', 'decision', 'learning', 'relationship')),

          -- 품질 점수
          confidence SMALLINT NOT NULL DEFAULT 7
              CHECK (confidence BETWEEN 1 AND 10),
          importance SMALLINT NOT NULL DEFAULT 5
              CHECK (importance BETWEEN 1 AND 10),

          -- 검색 & 태깅
          tags TEXT[] DEFAULT '{}',
          embedding vector(1536),

          -- 추적
          source VARCHAR(20) NOT NULL DEFAULT 'librarian'
              CHECK (source IN ('librarian', 'user', 'agent', 'system', 'migration')),
          access_count INTEGER NOT NULL DEFAULT 0,
          last_accessed_at TIMESTAMPTZ,
          superseded_by INTEGER REFERENCES memories(id),
          is_active BOOLEAN NOT NULL DEFAULT TRUE,

          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ---------------------------------------------------------
    // 4. Triggers
    // ---------------------------------------------------------
    console.log("⚙️ Setting up triggers...");

    // updated_at trigger for subjects and memories
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

    // Validate project_subject_id references a 'project' type subject
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

    // ---------------------------------------------------------
    // 5. Indices
    // ---------------------------------------------------------
    console.log("🔍 Creating indices...");
    await db.query(`
      -- subjects
      CREATE INDEX IF NOT EXISTS idx_subjects_type ON subjects(subject_type);
      CREATE INDEX IF NOT EXISTS idx_subjects_key ON subjects(subject_key);
      CREATE INDEX IF NOT EXISTS idx_subjects_active ON subjects(is_active);

      -- memories
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

    // ---------------------------------------------------------
    // 6. Data Migration (v0.3 → v0.4)
    // ---------------------------------------------------------
    // Check if old tables exist and migrate data
    const oldTablesCheck = await db.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('task_learnings')
    `);

    if (oldTablesCheck.rows.length > 0) {
      console.log("📦 Migrating data from v0.3 tables...");

      // Migrate task_learnings → memories
      const learningsExists = oldTablesCheck.rows.some((r: any) => r.table_name === 'task_learnings');
      if (learningsExists) {
        const learnCount = await db.query(`
          INSERT INTO memories (subject_id, content, fact_type, confidence, importance, tags, embedding, source, created_at, updated_at)
          SELECT
            (SELECT id FROM subjects WHERE subject_key = 'system_global' LIMIT 1),
            content, 'learning', confidence_score, impact_score, tags, embedding, 'migration', created_at, updated_at
          FROM task_learnings
          WHERE NOT EXISTS (
            SELECT 1 FROM memories WHERE memories.content = task_learnings.content AND memories.source = 'migration'
          )
        `);
        console.log(`   ✅ Migrated ${learnCount.rowCount} task_learnings → memories`);
      }

      // Drop old tables
      console.log("🗑️ Removing deprecated tables...");
      await db.query(`
        DROP TABLE IF EXISTS raw_memories CASCADE;
        DROP TABLE IF EXISTS subject_relationships CASCADE;
        DROP TABLE IF EXISTS task_learnings CASCADE;
        DROP TABLE IF EXISTS sessions CASCADE;
        DROP TABLE IF EXISTS tasks CASCADE;
      `);
      console.log("   ✅ Old tables removed.");
    }

    // ---------------------------------------------------------
    // 7. Seed Data
    // ---------------------------------------------------------
    console.log("🌱 Seeding initial data...");
    await db.query(`
      INSERT INTO subjects (subject_type, subject_key, display_name, metadata) VALUES
      ('person',   'user_hoon',             'Hoon', '{"role": "owner"}'),
      ('agent',    'agent_claude',          'Claude', '{"provider": "anthropic"}'),
      ('agent',    'agent_gemini',          'Gemini', '{"provider": "google"}'),
      ('agent',    'agent_gpt',             'GPT',    '{"provider": "openai"}'),
      ('project',  'project_centragens',    '센트라젠', '{}'),
      ('project',  'project_yoontube',      'YoonTube', '{}'),
      ('team',     'team_triplealab',       'TripleA Lab', '{}'),
      ('system',   'system_orchestrator',   'Harness-Main', '{"version": "0.4.0"}'),
      ('system',   'system_global',         'Global Context', '{}'),
      ('category', 'category_marketing',    'Marketing', '{}'),
      ('category', 'category_branding',     'Branding', '{}'),
      ('category', 'category_healthcare',   'Healthcare / Wellness', '{}')
      ON CONFLICT (subject_key) DO NOTHING;
    `);

    console.log("✅ Database setup completed successfully! (v0.4 Schema)");
  } catch (err) {
    console.error("❌ Error during database setup:", err);
  } finally {
    await db.close();
    process.exit(0);
  }
}

setup();
