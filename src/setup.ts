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

  // Re-load dotenv to ensure db instance sees the new values
  dotenv.config();

  try {
    console.log("📡 Connecting to Database to apply schema...");
    
    // Step 1: Utility Functions
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

    // Step 2: Core Tables
    console.log("📁 Creating tables...");
    await db.query(`
      CREATE TABLE IF NOT EXISTS subjects (
          id SERIAL PRIMARY KEY,
          subject_type VARCHAR(20) NOT NULL CHECK (subject_type IN ('person', 'agent', 'project', 'team', 'system')),
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
          status VARCHAR(20) NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done', 'failed', 'canceled')),
          description TEXT,
          outcome_summary TEXT,
          success_score INTEGER CHECK (success_score BETWEEN 1 AND 10),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          started_at TIMESTAMPTZ,
          ended_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sessions (
          id SERIAL PRIMARY KEY,
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          orchestrator_subject_id INTEGER REFERENCES subjects(id),
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ended_at TIMESTAMPTZ,
          final_outcome VARCHAR(20),
          summary TEXT,
          model_name VARCHAR(100),
          provider VARCHAR(100),
          token_usage INTEGER,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS memories (
          id SERIAL PRIMARY KEY,
          subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
          project_subject_id INTEGER REFERENCES subjects(id),
          content TEXT NOT NULL,
          summary TEXT,
          memory_type VARCHAR(20) NOT NULL CHECK (memory_type IN ('preference', 'profile', 'constraint', 'state', 'relationship')),
          memory_scope VARCHAR(20) NOT NULL DEFAULT 'global' CHECK (memory_scope IN ('global', 'project', 'local')),
          source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('user', 'agent', 'inferred', 'session', 'task', 'system')),
          importance_score INTEGER NOT NULL DEFAULT 5 CHECK (importance_score BETWEEN 1 AND 10),
          access_count INTEGER NOT NULL DEFAULT 0,
          last_accessed_at TIMESTAMPTZ,
          tags TEXT[] DEFAULT '{}',
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS task_learnings (
          id SERIAL PRIMARY KEY,
          task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
          task_type VARCHAR(50) NOT NULL,
          learning_type VARCHAR(20) NOT NULL CHECK (learning_type IN ('success_pattern', 'failure_pattern', 'heuristic', 'routing_rule')),
          content TEXT NOT NULL,
          summary TEXT,
          usage_count INTEGER NOT NULL DEFAULT 0,
          last_used_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS subject_relationships (
          id SERIAL PRIMARY KEY,
          from_subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
          to_subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
          relationship_type VARCHAR(50) NOT NULL CHECK (relationship_type IN ('owns', 'delegates_to', 'advises', 'reports_to', 'collaborates')),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_no_self_relationship CHECK (from_subject_id <> to_subject_id),
          CONSTRAINT uq_subject_relationship UNIQUE (from_subject_id, to_subject_id, relationship_type)
      );
    `);

    // Step 3: Trigger Logic
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

      DROP TRIGGER IF EXISTS trg_validate_project_type ON memories;
      CREATE TRIGGER trg_validate_project_type
      BEFORE INSERT OR UPDATE ON memories
      FOR EACH ROW
      EXECUTE FUNCTION validate_project_subject_type();

      -- Auto updated_at triggers
      DO $$
      DECLARE
          t text;
      BEGIN
          FOR t IN SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('subjects', 'tasks', 'sessions', 'memories', 'task_learnings')
          LOOP
              EXECUTE format('DROP TRIGGER IF EXISTS trg_updated_at ON %I', t);
              EXECUTE format('CREATE TRIGGER trg_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
          END LOOP;
      END $$;
    `);

    // Step 4: Indices
    console.log("🔍 Creating indices...");
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_memories_subject_id ON memories(subject_id);
      CREATE INDEX IF NOT EXISTS idx_memories_memory_type ON memories(memory_type);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_task_learnings_type ON task_learnings(task_type);
    `);

    // Step 5: Seed Data
    console.log("🌱 Seeding initial data...");
    await db.query(`
      INSERT INTO subjects (subject_type, subject_key, display_name, metadata) VALUES
      ('person',  'user_hoon',             'Hoon', '{"role": "owner"}'),
      ('agent',   'agent_claude',          'Claude', '{"provider": "anthropic"}'),
      ('agent',   'agent_gemini',          'Gemini', '{"provider": "google"}'),
      ('agent',   'agent_gpt',             'GPT',    '{"provider": "openai"}'),
      ('project', 'project_centragens',    '센트라젠', '{}'),
      ('project', 'project_yoontube',      'YoonTube', '{}'),
      ('team',    'team_triplealab',       'TripleA Lab', '{}'),
      ('system',  'system_orchestrator',   'Harness-Main', '{"version": "1.0.0"}')
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
