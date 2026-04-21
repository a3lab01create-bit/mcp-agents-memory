import inquirer from 'inquirer';
import fs from 'fs';
import { db } from './db.js';
import dotenv from 'dotenv';

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
  console.log("✅ .env file created.");

  dotenv.config();

  try {
    console.log("🛠 Creating database functions and schema...");
    
    await db.query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

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
          task_type VARCHAR(50) NOT NULL,
          title VARCHAR(200) NOT NULL,
          description TEXT,
          owner_subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
          project_subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
          started_at TIMESTAMPTZ,
          ended_at TIMESTAMPTZ,
          outcome_summary TEXT,
          success_score INTEGER CHECK (success_score BETWEEN 1 AND 10),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_task_time_order CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
      );

      CREATE TABLE IF NOT EXISTS sessions (
          id SERIAL PRIMARY KEY,
          task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
          orchestrator_subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ended_at TIMESTAMPTZ,
          final_outcome VARCHAR(20) CHECK (final_outcome IN ('success', 'failure', 'partial')),
          summary TEXT,
          model_name VARCHAR(100),
          provider VARCHAR(50),
          token_usage INTEGER,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_session_time_order CHECK (ended_at IS NULL OR ended_at >= started_at)
      );

      CREATE TABLE IF NOT EXISTS memories (
          id SERIAL PRIMARY KEY,
          subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
          project_subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
          memory_scope VARCHAR(20) NOT NULL DEFAULT 'global' CHECK (memory_scope IN ('global', 'project', 'local')),
          memory_type VARCHAR(20) NOT NULL CHECK (memory_type IN ('preference', 'profile', 'constraint', 'state', 'relationship')),
          content TEXT NOT NULL,
          summary TEXT,
          confidence_score INTEGER NOT NULL DEFAULT 5 CHECK (confidence_score BETWEEN 1 AND 10),
          importance_score INTEGER NOT NULL DEFAULT 5 CHECK (importance_score BETWEEN 1 AND 10),
          source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('user', 'agent', 'inferred', 'session', 'task', 'system')),
          source_session_id INTEGER REFERENCES sessions(id) DEFERRABLE INITIALLY DEFERRED,
          source_task_id INTEGER REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
          tags TEXT[] NOT NULL DEFAULT '{}',
          access_count INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
          last_accessed_at TIMESTAMPTZ,
          expires_at TIMESTAMPTZ,
          embedding_model VARCHAR(50),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_project_scope_requires_project CHECK (memory_scope <> 'project' OR project_subject_id IS NOT NULL)
      );

      CREATE TABLE IF NOT EXISTS task_learnings (
          id SERIAL PRIMARY KEY,
          task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
          task_type VARCHAR(50),
          learning_type VARCHAR(30) NOT NULL CHECK (learning_type IN ('success_pattern', 'failure_pattern', 'heuristic', 'routing_rule')),
          content TEXT NOT NULL,
          summary TEXT,
          applicable_when TEXT,
          avoid_when TEXT,
          preferred_owner_subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
          confidence_score INTEGER NOT NULL DEFAULT 5 CHECK (confidence_score BETWEEN 1 AND 10),
          impact_score INTEGER NOT NULL DEFAULT 5 CHECK (impact_score BETWEEN 1 AND 10),
          usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
          last_used_at TIMESTAMPTZ,
          embedding_model VARCHAR(50),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
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

      -- Project Type Validation Trigger
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
    `);

    console.log("⚙️ Setting up triggers...");
    const tables = ['subjects', 'tasks', 'sessions', 'memories', 'task_learnings'];
    for (const table of tables) {
      await db.query(`DROP TRIGGER IF EXISTS trg_${table}_updated_at ON ${table}`);
      await db.query(`CREATE TRIGGER trg_${table}_updated_at BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);
    }

    console.log("🗂 Creating indexes...");
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_subjects_type ON subjects(subject_type);
      CREATE INDEX IF NOT EXISTS idx_subjects_key ON subjects(subject_key);
      CREATE INDEX IF NOT EXISTS idx_memories_subject_id ON memories(subject_id);
      CREATE INDEX IF NOT EXISTS idx_memories_memory_type ON memories(memory_type);
    `);

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

    console.log("✨ Final Schema Setup Complete!");
  } catch (error) {
    console.error("❌ Error during setup:", error);
  } finally {
    await db.close();
  }
}

setup();
