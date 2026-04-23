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

  const envContent = `
DB_HOST=${answers.dbHost}
DB_PORT=${answers.dbPort}
DB_USER=${answers.dbUser}
DB_PASS=${answers.dbPass}
DB_NAME=${answers.dbName}${sshConfig}
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
    // 2. Core Tables
    // ---------------------------------------------------------
    console.log("📁 Creating tables...");
    await db.query(`
      CREATE TABLE IF NOT EXISTS subjects (
          id SERIAL PRIMARY KEY,
          subject_type VARCHAR(20) NOT NULL
              CHECK (subject_type IN ('person', 'agent', 'project', 'team', 'system', 'category', 'heuristic')),
          subject_key VARCHAR(100) NOT NULL UNIQUE,
          display_name VARCHAR(100) NOT NULL,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tasks (
          id SERIAL PRIMARY KEY,
          title VARCHAR(200) NOT NULL,
          task_type VARCHAR(50) NOT NULL,
          owner_subject_id INTEGER NOT NULL REFERENCES subjects(id),
          project_subject_id INTEGER NOT NULL REFERENCES subjects(id),
          status VARCHAR(20) NOT NULL DEFAULT 'todo'
              CHECK (status IN ('todo', 'doing', 'done', 'failed', 'canceled')),
          description TEXT,
          outcome_summary TEXT,
          success_score INTEGER CHECK (success_score BETWEEN 1 AND 10),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          started_at TIMESTAMPTZ,
          ended_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_task_time_order
              CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
      );

      CREATE TABLE IF NOT EXISTS sessions (
          id SERIAL PRIMARY KEY,
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          orchestrator_subject_id INTEGER REFERENCES subjects(id),
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ended_at TIMESTAMPTZ,
          final_outcome VARCHAR(20)
              CHECK (final_outcome IN ('success', 'failure', 'partial')),
          summary TEXT,
          model_name VARCHAR(100),
          provider VARCHAR(100),
          token_usage INTEGER,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_session_time_order
              CHECK (ended_at IS NULL OR ended_at >= started_at)
      );

      CREATE TABLE IF NOT EXISTS memories (
          id SERIAL PRIMARY KEY,
          subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
          project_subject_id INTEGER REFERENCES subjects(id),
          content TEXT NOT NULL,
          summary TEXT,
          memory_type VARCHAR(20) NOT NULL
              CHECK (memory_type IN ('preference', 'profile', 'constraint', 'state', 'relationship')),
          memory_scope VARCHAR(20) NOT NULL DEFAULT 'global'
              CHECK (memory_scope IN ('global', 'category', 'project', 'local')),
          source_type VARCHAR(20) NOT NULL
              CHECK (source_type IN ('user', 'agent', 'inferred', 'session', 'task', 'system')),
          confidence_score INTEGER NOT NULL DEFAULT 5
              CHECK (confidence_score BETWEEN 1 AND 10),
          importance_score INTEGER NOT NULL DEFAULT 5
              CHECK (importance_score BETWEEN 1 AND 10),
          access_count INTEGER NOT NULL DEFAULT 0,
          last_accessed_at TIMESTAMPTZ,
          expires_at TIMESTAMPTZ,
          tags TEXT[] DEFAULT '{}',
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS task_learnings (
          id SERIAL PRIMARY KEY,
          task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
          task_type VARCHAR(50) NOT NULL,
          learning_type VARCHAR(20) NOT NULL
              CHECK (learning_type IN ('success_pattern', 'failure_pattern', 'heuristic', 'routing_rule')),
          content TEXT NOT NULL,
          summary TEXT,
          confidence_score INTEGER NOT NULL DEFAULT 5
              CHECK (confidence_score BETWEEN 1 AND 10),
          impact_score INTEGER NOT NULL DEFAULT 5
              CHECK (impact_score BETWEEN 1 AND 10),
          usage_count INTEGER NOT NULL DEFAULT 0,
          last_used_at TIMESTAMPTZ,
          tags TEXT[] DEFAULT '{}',
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS raw_memories (
          id SERIAL PRIMARY KEY,
          subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
          project_subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
          session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
          task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
          raw_type VARCHAR(30) NOT NULL DEFAULT 'conversation'
              CHECK (raw_type IN ('conversation', 'message', 'observation', 'draft', 'reflection', 'event')),
          content TEXT NOT NULL,
          source_type VARCHAR(20) NOT NULL DEFAULT 'agent'
              CHECK (source_type IN ('user', 'agent', 'system', 'tool')),
          processed BOOLEAN NOT NULL DEFAULT FALSE,
          processed_at TIMESTAMPTZ,
          tags TEXT[] DEFAULT '{}',
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS subject_relationships (
          id SERIAL PRIMARY KEY,
          from_subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
          to_subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
          relationship_type VARCHAR(50) NOT NULL
              CHECK (relationship_type IN ('owns', 'delegates_to', 'advises', 'reports_to', 'collaborates', 'belongs_to', 'related_to', 'derived_from')),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_no_self_relationship CHECK (from_subject_id <> to_subject_id),
          CONSTRAINT uq_subject_relationship UNIQUE (from_subject_id, to_subject_id, relationship_type)
      );
    `);

    // ---------------------------------------------------------
    // 3. Trigger Logic / Validation
    // ---------------------------------------------------------
    console.log("⚙️ Setting up triggers and validation...");
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

      DROP TRIGGER IF EXISTS trg_validate_project_type_raw_memories ON raw_memories;
      CREATE TRIGGER trg_validate_project_type_raw_memories
      BEFORE INSERT OR UPDATE ON raw_memories
      FOR EACH ROW
      EXECUTE FUNCTION validate_project_subject_type();

      DO $$
      DECLARE
          t text;
      BEGIN
          FOR t IN
              SELECT table_name
              FROM information_schema.tables
              WHERE table_schema = 'public'
                AND table_name IN ('subjects', 'tasks', 'sessions', 'memories', 'task_learnings')
          LOOP
              EXECUTE format('DROP TRIGGER IF EXISTS trg_updated_at ON %I', t);
              EXECUTE format(
                  'CREATE TRIGGER trg_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                  t
              );
          END LOOP;
      END $$;
    `);

    // ---------------------------------------------------------
    // 4. Indices
    // ---------------------------------------------------------
    console.log("🔍 Creating indices...");
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_subjects_type ON subjects(subject_type);
      CREATE INDEX IF NOT EXISTS idx_subjects_key ON subjects(subject_key);
      CREATE INDEX IF NOT EXISTS idx_subjects_active ON subjects(is_active);

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(task_type);
      CREATE INDEX IF NOT EXISTS idx_tasks_project_subject_id ON tasks(project_subject_id);

      CREATE INDEX IF NOT EXISTS idx_sessions_task_id ON sessions(task_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_model_name ON sessions(model_name);

      CREATE INDEX IF NOT EXISTS idx_memories_subject_id ON memories(subject_id);
      CREATE INDEX IF NOT EXISTS idx_memories_project_subject_id ON memories(project_subject_id);
      CREATE INDEX IF NOT EXISTS idx_memories_memory_type ON memories(memory_type);
      CREATE INDEX IF NOT EXISTS idx_memories_memory_scope ON memories(memory_scope);
      CREATE INDEX IF NOT EXISTS idx_memories_importance_score ON memories(importance_score);
      CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING GIN(tags);

      CREATE INDEX IF NOT EXISTS idx_task_learnings_type ON task_learnings(task_type);
      CREATE INDEX IF NOT EXISTS idx_task_learnings_learning_type ON task_learnings(learning_type);
      CREATE INDEX IF NOT EXISTS idx_task_learnings_tags ON task_learnings USING GIN(tags);

      CREATE INDEX IF NOT EXISTS idx_raw_memories_subject_id ON raw_memories(subject_id);
      CREATE INDEX IF NOT EXISTS idx_raw_memories_project_subject_id ON raw_memories(project_subject_id);
      CREATE INDEX IF NOT EXISTS idx_raw_memories_session_id ON raw_memories(session_id);
      CREATE INDEX IF NOT EXISTS idx_raw_memories_task_id ON raw_memories(task_id);
      CREATE INDEX IF NOT EXISTS idx_raw_memories_processed ON raw_memories(processed);
      CREATE INDEX IF NOT EXISTS idx_raw_memories_raw_type ON raw_memories(raw_type);
      CREATE INDEX IF NOT EXISTS idx_raw_memories_tags ON raw_memories USING GIN(tags);

      CREATE INDEX IF NOT EXISTS idx_subject_relationships_from_subject_id ON subject_relationships(from_subject_id);
      CREATE INDEX IF NOT EXISTS idx_subject_relationships_to_subject_id ON subject_relationships(to_subject_id);
      CREATE INDEX IF NOT EXISTS idx_subject_relationships_type ON subject_relationships(relationship_type);
    `);

    // ---------------------------------------------------------
    // 5. Seed Data
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
      ('system',   'system_orchestrator',   'Harness-Main', '{"version": "1.0.0"}'),
      ('system',   'system_global',         'Global Context', '{}'),
      ('category', 'category_marketing',    'Marketing', '{}'),
      ('category', 'category_branding',     'Branding', '{}'),
      ('category', 'category_healthcare',   'Healthcare / Wellness', '{}')
      ON CONFLICT (subject_key) DO NOTHING;
    `);

    console.log("✅ Database setup completed successfully!");
  } catch (err) {
    console.error("❌ Error during database setup:", err);
  } finally {
    await db.close();
    process.exit(0);
  }
}

setup();