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
const migrationsDir = fs.existsSync(path.join(__dirname, "migrations"))
  ? path.join(__dirname, "migrations")
  : __dirname;
const MIGRATION_FILE_RE = /^\d{3}_.+\.js$/;

export function listMigrationFiles(): string[] {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir)
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

/**
 * 019 creates the whole RESPEC v1 schema on its own. 005–018 only upgrade the
 * pre-RESPEC tables (`facts` / `memories`) and fail on an empty database, so
 * they run only when one of those tables is still there. Databases that already
 * went through them have each one recorded in migration_history (every file
 * checks it first and skips), so leaving them out there changes nothing.
 */
export const FRESH_SCHEMA_FIRST = "019_";

export function selectMigrationFiles(files: string[], hasLegacyTables: boolean): string[] {
  return hasLegacyTables ? files : files.filter((f) => f >= FRESH_SCHEMA_FIRST);
}

async function hasLegacyTables(): Promise<boolean> {
  const { db } = await import("../db.js");
  const r = await db.query(
    "SELECT to_regclass('public.facts') IS NOT NULL OR to_regclass('public.memories') IS NOT NULL AS legacy"
  );
  return r.rows[0]?.legacy === true;
}

export async function runAllMigrations(): Promise<{ ran: number; files: string[] }> {
  const all = listMigrationFiles();
  if (all.length === 0) {
    console.log("ℹ️  No migration files found in", migrationsDir);
    return { ran: 0, files: [] };
  }
  const legacy = await hasLegacyTables();
  const files = selectMigrationFiles(all, legacy);
  if (files.length < all.length) {
    console.log(`ℹ️  No pre-RESPEC tables — skipping ${all.length - files.length} legacy upgrade step(s).`);
  }
  console.log(`📦 Running ${files.length} migration(s) from ${migrationsDir}`);
  for (const f of files) {
    await runOne(path.join(migrationsDir, f));
  }
  console.log(`✅ Migration runner complete — ${files.length} file(s) processed.`);
  return { ran: files.length, files };
}
