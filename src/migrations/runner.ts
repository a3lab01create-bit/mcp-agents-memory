/**
 * Migration runner — discovers numbered migration scripts in this directory
 * and executes each in its own subprocess. Idempotent: each migration checks
 * `migration_history` and skips if already applied.
 *
 * We spawn instead of importing because the existing migrations call
 * `migrate()` at the top level and `db.close()` in their finally block —
 * importing would auto-run them and closing the singleton pool would corrupt
 * subsequent calls within the same process. Subprocesses give clean isolation
 * with no migration-file refactor.
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILE_RE = /^\d{3}_.+\.js$/;

export function listMigrationFiles(): string[] {
  if (!fs.existsSync(__dirname)) return [];
  return fs
    .readdirSync(__dirname)
    .filter((f) => MIGRATION_FILE_RE.test(f))
    .sort(); // 3-digit zero-padded prefix → lex sort == numeric sort
}

function runOne(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`Migration ${path.basename(file)} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

export async function runAllMigrations(): Promise<{ ran: number; files: string[] }> {
  const files = listMigrationFiles();
  if (files.length === 0) {
    console.log("ℹ️  No migration files found in", __dirname);
    return { ran: 0, files: [] };
  }
  console.log(`📦 Running ${files.length} migration(s) from ${__dirname}`);
  for (const f of files) {
    await runOne(path.join(__dirname, f));
  }
  console.log(`✅ Migration runner complete — ${files.length} file(s) processed.`);
  return { ran: files.length, files };
}
