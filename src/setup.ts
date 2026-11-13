/**
 * Interactive setup wizard (RESPEC v1).
 *
 *   mcp-agents-memory setup
 *
 * 1. Asks how to reach PostgreSQL (DATABASE_URL, or host/port/user/password/db)
 *    and checks the connection + pgvector before anything is written.
 * 2. Asks for OPENAI_API_KEY (optional — semantic search) and USER_NAME.
 * 3. Writes ~/.config/mcp-agents-memory/.env (dir 700, file 600). If the file
 *    already exists it asks first, and keeps any lines the wizard doesn't manage.
 * 4. Runs the migrations, creates the user row, and prints a short health check.
 *
 * Secrets (password, DATABASE_URL, API key) are never echoed: typing shows `*`.
 * Non-TTY stdin (piped answers) is supported for scripted installs and tests.
 */

import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import pg from "pg";
import OpenAI from "openai";
import { buildPoolConfig, configSearchPaths, db } from "./db.js";
import { PACKAGE_VERSION } from "./version.js";

const CONFIG_DIR = path.join(os.homedir(), ".config", "mcp-agents-memory");
const CONFIG_PATH = path.join(CONFIG_DIR, ".env");

/** Keys the wizard owns. Everything else in an existing .env is kept as-is. */
const MANAGED_KEYS = [
  "DATABASE_URL",
  "DB_HOST",
  "DB_PORT",
  "DB_USER",
  "DB_PASS",
  "DB_NAME",
  "DB_SSL",
  "SSH_ENABLED",
  "OPENAI_API_KEY",
  "USER_NAME",
] as const;
type ManagedKey = (typeof MANAGED_KEYS)[number];
type Settings = Partial<Record<ManagedKey, string>>;

// ─────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────

const out = process.stdout;
let pipedAnswers: string[] | null = null;

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function initPrompts(): Promise<void> {
  if (!process.stdin.isTTY) {
    pipedAnswers = (await readAllStdin()).split(/\r?\n/);
  }
}

function nextPiped(): string {
  if (!pipedAnswers || pipedAnswers.length === 0) {
    throw new Error("setup: ran out of piped answers");
  }
  return pipedAnswers.shift() as string;
}

function abort(): never {
  out.write("\nSetup cancelled. Nothing was written.\n");
  process.exit(130);
}

async function ask(question: string, def?: string): Promise<string> {
  const label = def ? `${question} [${def}]: ` : `${question}: `;
  let answer: string;
  if (pipedAnswers) {
    answer = nextPiped();
    out.write(label + answer + "\n");
  } else {
    answer = await new Promise<string>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: out });
      rl.on("SIGINT", abort);
      rl.question(label, (a) => {
        rl.close();
        resolve(a);
      });
    });
  }
  answer = answer.trim();
  return answer === "" && def !== undefined ? def : answer;
}

const MASK_ECHO_MAX = 24;

/** Like ask(), but typed characters are shown as `*` (at most MASK_ECHO_MAX of them). */
async function askSecret(question: string, opts: { keepHint?: boolean } = {}): Promise<string> {
  const label = opts.keepHint ? `${question} (Enter = keep current): ` : `${question}: `;
  out.write(label);
  if (pipedAnswers) {
    const answer = nextPiped();
    out.write("*".repeat(Math.min(answer.length, MASK_ECHO_MAX)) + "\n");
    return answer.trim();
  }
  const stdin = process.stdin;
  return new Promise<string>((resolve) => {
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    const finish = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      out.write("\n");
      resolve(buf.trim());
    };
    const onData = (data: Buffer) => {
      for (const ch of data.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          abort();
        }
        if (ch === "\u007f" || ch === "\b") {
          if (buf.length > 0) {
            if (buf.length <= MASK_ECHO_MAX) out.write("\b \b");
            buf = buf.slice(0, -1);
          }
          continue;
        }
        if (ch < " ") continue; // ignore other control keys (arrows etc.)
        buf += ch;
        if (buf.length <= MASK_ECHO_MAX) out.write("*"); // long keys don't wrap the line
      }
    };
    stdin.on("data", onData);
  });
}

async function confirm(question: string, defYes: boolean): Promise<boolean> {
  const a = (await ask(`${question} ${defYes ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
  if (a === "") return defYes;
  return a === "y" || a === "yes";
}

// ─────────────────────────────────────────────────────────────
// Config file
// ─────────────────────────────────────────────────────────────

function readEnvLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/);
}

function envKeyOf(line: string): string | null {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return m ? m[1] : null;
}

function readExistingValue(lines: string[], key: string): string | undefined {
  for (const line of lines) {
    if (envKeyOf(line) !== key) continue;
    let v = line.slice(line.indexOf("=") + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v;
  }
  return undefined;
}

function quoteEnv(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,=-]*$/.test(value)) return value;
  // single quotes keep $, #, spaces literal for dotenv
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Writes managed keys, keeps unmanaged lines from an existing file. Atomic, mode 600. */
function writeConfig(file: string, settings: Settings): void {
  const kept = readEnvLines(file).filter((line) => {
    const key = envKeyOf(line);
    if (key && (MANAGED_KEYS as readonly string[]).includes(key)) return false;
    return !line.startsWith("# mcp-agents-memory setup");
  });
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();

  const lines: string[] = [`# mcp-agents-memory setup — written ${new Date().toISOString()}`];
  for (const key of MANAGED_KEYS) {
    const v = settings[key];
    if (v !== undefined && v !== "") lines.push(`${key}=${quoteEnv(v)}`);
  }
  if (kept.length > 0) {
    lines.push("", "# (kept from the previous file)", ...kept);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

/** Make this process (and the migration subprocesses) use exactly these settings. */
function applyToProcessEnv(settings: Settings): void {
  for (const key of MANAGED_KEYS) {
    process.env[key] = settings[key] ?? ""; // "" (not unset) so dotenv in children can't refill it
  }
  process.env.MEMORY_CONFIG_PATH = CONFIG_PATH;
}

// ─────────────────────────────────────────────────────────────
// Checks
// ─────────────────────────────────────────────────────────────

function scrub(msg: string): string {
  return msg
    .replace(/postgres(ql)?:\/\/[^\s'"]+/gi, "postgres://…")
    .replace(/sk-[A-Za-z0-9_*\-]+/g, "sk-…")
    .slice(0, 200);
}

function describeTarget(s: Settings): string {
  if (s.DATABASE_URL) {
    try {
      const u = new URL(s.DATABASE_URL);
      return `${u.hostname}:${u.port || 5432}${u.pathname}`;
    } catch {
      return "DATABASE_URL";
    }
  }
  return `${s.DB_HOST}:${s.DB_PORT || 5432}/${s.DB_NAME}`;
}

async function checkDatabase(settings: Settings): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  applyToProcessEnv(settings);
  const client = new pg.Client(buildPoolConfig().config);
  try {
    await client.connect();
    const v = await client.query("SHOW server_version");
    const ext = await client.query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'");
    if (ext.rows.length === 0) {
      return { ok: false, error: "connected, but the pgvector extension is not installed on this server" };
    }
    return { ok: true, version: String(v.rows[0].server_version).split(" ")[0] };
  } catch (err) {
    return { ok: false, error: scrub((err as Error).message || String(err)) };
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkEmbeddingKey(key: string): Promise<{ ok: true; dims: number; model: string } | { ok: false; error: string }> {
  const model = process.env.EMBEDDING_MODEL || "text-embedding-3-large";
  try {
    const r = await new OpenAI({ apiKey: key, timeout: 20_000, maxRetries: 0 }).embeddings.create({
      model,
      input: "mcp-agents-memory setup check",
    });
    return { ok: true, dims: r.data[0].embedding.length, model };
  } catch (err: any) {
    if (err?.status === 401) return { ok: false, error: "the key was rejected (401)" };
    return { ok: false, error: scrub(`${err?.status ?? ""} ${err?.message ?? String(err)}`.trim()) };
  }
}

// ─────────────────────────────────────────────────────────────
// Wizard
// ─────────────────────────────────────────────────────────────

async function askDatabase(existing: string[]): Promise<Settings> {
  const hadUrl = readExistingValue(existing, "DATABASE_URL");
  out.write("\nStep 1/3  Database (PostgreSQL with pgvector)\n");
  out.write("  1) Host, port, user, password, database name\n");
  out.write("  2) One connection URL (DATABASE_URL, e.g. from Supabase or Neon)\n");
  const mode = await ask("Choose", hadUrl ? "2" : "1");

  if (mode === "2") {
    const url = await askSecret("DATABASE_URL", { keepHint: !!hadUrl });
    const finalUrl = url || hadUrl || "";
    if (!finalUrl) throw new Error("DATABASE_URL is required");
    return { DATABASE_URL: finalUrl };
  }

  const prev = (k: ManagedKey) => readExistingValue(existing, k);
  const host = await ask("Host", prev("DB_HOST") || "localhost");
  const port = await ask("Port", prev("DB_PORT") || "5432");
  const user = await ask("User", prev("DB_USER") || "postgres");
  const hadPass = !!prev("DB_PASS");
  const pass = (await askSecret("Password", { keepHint: hadPass })) || prev("DB_PASS") || "";
  const name = await ask("Database name", prev("DB_NAME") || "mcp_memory");
  const ssl = await confirm("Use SSL?", prev("DB_SSL") === "true");
  return { DB_HOST: host, DB_PORT: port, DB_USER: user, DB_PASS: pass, DB_NAME: name, DB_SSL: ssl ? "true" : undefined };
}

export async function runSetupWizard(): Promise<void> {
  await initPrompts();

  out.write(`\nmcp-agents-memory setup  (v${PACKAGE_VERSION})\n`);
  out.write(`Config file: ${CONFIG_PATH}\n`);

  const existing = readEnvLines(CONFIG_PATH);
  if (existing.length > 0) {
    out.write("A config file already exists here.\n");
    if (!(await confirm("Overwrite its database, key and user settings? (other lines are kept)", false))) {
      out.write("Kept the existing config. Nothing changed.\n");
      return;
    }
  }

  // Step 1 — database, checked before anything is written
  let settings: Settings = {};
  let dbVersion = "";
  for (let attempt = 1; ; attempt++) {
    settings = await askDatabase(existing);
    out.write(`Checking ${describeTarget(settings)} … `);
    const r = await checkDatabase(settings);
    if (r.ok) {
      dbVersion = r.version;
      out.write(`OK (PostgreSQL ${r.version}, pgvector available)\n`);
      break;
    }
    out.write(`failed\n  ${r.error}\n`);
    if (attempt >= 3 || !(await confirm("Try again?", true))) {
      out.write("Setup stopped. Nothing was written.\n");
      process.exitCode = 1;
      return;
    }
  }

  // Step 2 — embedding key (optional)
  out.write("\nStep 2/3  OpenAI API key (for meaning-based search; Enter to skip)\n");
  const hadKey = readExistingValue(existing, "OPENAI_API_KEY");
  let key = await askSecret("OPENAI_API_KEY", { keepHint: !!hadKey });
  if (!key && hadKey) key = hadKey;
  let keyStatus = "skipped — keyword search only";
  if (key) {
    out.write("Checking key … ");
    const r = await checkEmbeddingKey(key);
    if (r.ok) {
      keyStatus = `OK (${r.model}, ${r.dims} dims)`;
      out.write(`${keyStatus}\n`);
    } else {
      out.write(`failed\n  ${r.error}\n`);
      if (!(await confirm("Save it anyway?", false))) {
        key = "";
        keyStatus = "skipped — keyword search only";
      } else {
        keyStatus = "saved, but the check failed";
      }
    }
  }
  if (key) settings.OPENAI_API_KEY = key;

  // Step 3 — user
  out.write("\nStep 3/3  Your name in the memory\n");
  const defaultUser = readExistingValue(existing, "USER_NAME") || os.userInfo().username || "me";
  settings.USER_NAME = await ask("USER_NAME", defaultUser);

  // Write
  writeConfig(CONFIG_PATH, settings);
  applyToProcessEnv(settings);
  out.write(`\nSaved ${CONFIG_PATH} (permissions 600)\n`);

  // Migrate
  out.write("\nCreating tables …\n");
  const { runAllMigrations } = await import("./migrations/runner.js");
  await runAllMigrations();

  // User row + health check
  const { getOrCreateUser } = await import("./users.js");
  const userId = await getOrCreateUser(settings.USER_NAME!);
  const applied = await db.query("SELECT count(*)::int AS n FROM migration_history");
  const tables = await db.query(
    "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('memory','users','project_tags')"
  );
  await db.close();

  const shadow = configSearchPaths()
    .slice(0, configSearchPaths().indexOf(CONFIG_PATH))
    .filter((p) => p !== CONFIG_PATH && fs.existsSync(p) && /^(\s*export\s+)?(DATABASE_URL|DB_HOST)\s*=/m.test(fs.readFileSync(p, "utf8")));

  out.write("\nAll set.\n");
  out.write(`  ✔ Database   ${describeTarget(settings)} — PostgreSQL ${dbVersion}\n`);
  out.write(`  ✔ Schema     ${tables.rows[0].n}/3 core tables, ${applied.rows[0].n} migrations recorded\n`);
  out.write(`  ✔ User       ${settings.USER_NAME} (id ${userId})\n`);
  out.write(`  ${key && keyStatus.startsWith("OK") ? "✔" : "•"} Embeddings ${keyStatus}\n`);
  if (shadow.length > 0) {
    out.write(`\n  ⚠ ${shadow.join(", ")} also has database settings and is read first.\n`);
  }
  out.write("\nNext: connect your AI tools to the memory server, for example\n");
  out.write("  claude mcp add --scope user mcp-agents-memory -- mcp-agents-memory\n");
  out.write("  codex mcp add mcp-agents-memory -- mcp-agents-memory\n");
  out.write("More clients: README → Client setup\n\n");
}
