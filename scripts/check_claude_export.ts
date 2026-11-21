/**
 * 클로드 앱 내보내기 넣기(import-claude-export) 검사. → 먼저 `npm run build`.
 *
 * 1) 파서(DB 없이): 본문은 text 조각만 · 생각/도구 제외 · `text` 칸 자리표시 무시 · 보낸 사람·uuid·시각 검사.
 * 2) 프로세스(DB 없이): --dry-run 은 DB 를 안 연다 · .zip/없는 파일은 거절 · 넣기 전에 DB 주소를 비밀번호 없이 찍는다.
 * 3) 프로세스(DB 있음, 선택): CHECK_EXPORT_DATABASE_URL 이 있으면 그 일회용 DB(센티널 표 `__disposable_test_db__`
 *    필수)를 마이그레이션하고 두 번 넣는다 — 두 번째는 전부 중복으로 건너뛴다.
 *
 * 예시 데이터는 합성이다(실제 대화를 저장소에 넣지 않는다). 모양은 2026-11-21 실물 내보내기에서 땄다.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_EXPORT_PLATFORM, CLAUDE_EXPORT_VENUE, claudeExportMessageText, describeDbTarget, parseClaudeExport,
} from "../src/auto_save/claude_export.js";

const PLACEHOLDER = "\n```\nThis block is not supported on your current device yet.\n```\n\n";

function msg(uuid: string, sender: string, content: unknown[] | undefined, created_at: string, text?: string) {
  const joined = (content ?? []).map((p: any) => (p.type === "text" ? p.text : PLACEHOLDER)).join("");
  return {
    uuid, parent_message_uuid: "00000000-0000-4000-8000-000000000000", sender,
    text: text ?? joined, ...(content ? { content } : {}),
    created_at, updated_at: created_at, attachments: [], files: [],
  };
}
const T = (type: string, extra: object = {}) => ({ type, start_timestamp: null, stop_timestamp: null, ...extra });

const fixture = [
  {
    uuid: "conv-a", name: "합성 대화 A", summary: "", created_at: "2026-11-20T22:57:00Z", updated_at: "2026-11-20T23:00:00Z",
    account: { uuid: "acct" },
    chat_messages: [
      msg("a1", "human", [T("text", { text: "메모리 검색해 줘" })], "2026-11-20T22:57:10Z"),
      msg("a2", "assistant", [
        T("thinking", { thinking: "생각 과정은 넣으면 안 된다" }),
        T("tool_use", { name: "memory_startup", input: {} }),
        T("tool_result", { name: "memory_startup", content: [{ type: "text", text: "도구 결과도 넣으면 안 된다" }] }),
        // 실물 thinking 조각은 본문이 `thinking` 칸에 있다. text 칸이 붙어 와도 종류(type)로 거른다.
        T("thinking", { thinking: "두 번째 생각", text: "생각 과정이 text 칸에 있어도 넣으면 안 된다" }),
        T("text", { text: "찾아봤어. 첫 문단." }),
        T("text", { text: "둘째 문단." }),
      ], "2026-11-20T22:57:30Z"),
      // 도구 호출만 있는 답 → 본문이 비어 건너뜀
      msg("a3", "assistant", [T("tool_use", { name: "x" }), T("tool_result", { content: [] })], "2026-11-20T22:58:00Z"),
      // 모르는 보낸 사람 · uuid 없음 · 시각 이상 → 건너뜀
      msg("a4", "system", [T("text", { text: "시스템 줄" })], "2026-11-20T22:58:10Z"),
      { ...msg("", "human", [T("text", { text: "uuid 없음" })], "2026-11-20T22:58:20Z") },
      msg("a6", "human", [T("text", { text: "시각 이상" })], "not-a-date"),
    ],
  },
  {
    uuid: "conv-b", name: "합성 대화 B", summary: "", created_at: "2026-11-21T04:53:00Z", updated_at: "2026-11-21T05:00:00Z",
    account: { uuid: "acct" },
    chat_messages: [
      // content 가 없는 옛 모양 → text 칸에서 자리표시를 걷어 쓴다
      msg("b1", "assistant", undefined, "2026-11-21T04:53:30Z", `앞부분${PLACEHOLDER}뒷부분`),
      msg("b2", "human", [T("text", { text: "  공백은 다듬는다  " }), T("image", { file_uuid: "f" })], "2026-11-21T04:54:00Z"),
    ],
  },
];

// ── 1. 파서 ──
{
  const p = parseClaudeExport(fixture);
  assert.equal(p.conversations, 2);
  assert.equal(p.messages, 8);
  assert.equal(p.skippedEmpty, 1, "도구만 있는 답");
  assert.equal(p.skippedInvalid, 3, "system · uuid 없음 · 시각 이상");
  assert.deepEqual(p.rows.map((r) => r.externalUuid),
    ["claude-export:conv-a:a1", "claude-export:conv-a:a2", "claude-export:conv-b:b1", "claude-export:conv-b:b2"]);
  assert.deepEqual(p.rows.map((r) => r.role), ["user", "assistant", "assistant", "user"]);
  const a2 = p.rows[1].message;
  assert.equal(a2, "찾아봤어. 첫 문단.\n둘째 문단.", "text 조각만, 줄바꿈 하나로 (클로드 코드 수집과 같게)");
  for (const r of p.rows) {
    assert.ok(!/생각|도구 결과|not supported/.test(r.message), `생각·도구·자리표시가 새면 안 된다: ${r.message}`);
  }
  assert.equal(p.rows[2].message, "앞부분\n뒷부분", "content 가 없으면 text 칸에서 자리표시를 걷는다");
  assert.equal(p.rows[3].message, "공백은 다듬는다");
  assert.equal(p.rows[0].createdAt.toISOString(), "2026-11-20T22:57:10.000Z", "메시지 자신의 시각");
  assert.equal(p.first?.toISOString(), "2026-11-20T22:57:10.000Z");
  assert.equal(p.last?.toISOString(), "2026-11-21T04:54:00.000Z");

  // 실물에서 본 것: text 칸 = text 조각 + 도구 자리표시 → text 칸을 쓰면 자리표시가 들어간다
  const m = fixture[0].chat_messages[1] as any;
  assert.ok(m.text.includes("not supported"), "합성 데이터가 실물처럼 자리표시를 품고 있어야 이 검사가 뜻이 있다");
  assert.equal(claudeExportMessageText(m), "찾아봤어. 첫 문단.\n둘째 문단.");

  assert.throws(() => parseClaudeExport({ conversations: [] }), /배열/);
  assert.throws(() => parseClaudeExport([{ uuid: "x" }]), /chat_messages/);
  assert.throws(() => parseClaudeExport([{ chat_messages: [] }]), /uuid/);
  assert.deepEqual(parseClaudeExport([]).rows, []);
}

// ── describeDbTarget: 실제 연결 규칙(db.connect · pg 해석기)과 같게 · 비밀번호를 안 찍는다 ──
{
  const SECRET = "s3cr3t-pass";
  const KEYS = ["DATABASE_URL", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASS", "DB_NAME", "DB_SSL",
    "SSH_ENABLED", "SSH_HOST", "SSH_PORT", "PGHOST", "PGPORT", "PGDATABASE", "PGUSER"];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const withEnv = (vars: Record<string, string>) => {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, vars);
    try { return describeDbTarget(); } finally { for (const k of KEYS) delete process.env[k]; }
  };
  try {
    const cases: Array<[Record<string, string>, string, string]> = [
      [{ DATABASE_URL: `postgres://user:${SECRET}@db.example:6543/memdb?sslmode=require` }, "db.example:6543/memdb", "URL 기본"],
      [{ DATABASE_URL: `postgres://user:${SECRET}@localhost/memdb` }, "localhost:5432/memdb", "포트 없으면 5432"],
      // 코디 재현: URL 앞부분과 query 가 다르면 pg 는 query 쪽에 붙는다
      [{ DATABASE_URL: `postgres://user:${SECRET}@front-host:1111/frontdb?host=real-host&port=2222` }, "real-host:2222/frontdb", "query host/port 우선"],
      [{ DATABASE_URL: `postgres:///sockdb?host=/var/run/postgresql` }, "/var/run/postgresql:5432/sockdb", "유닉스 소켓"],
      [{ DATABASE_URL: "postgres:///x", PGHOST: "pg-env-host", PGPORT: "7777" }, "pg-env-host:7777/x", "빈 칸은 PG* 환경변수"],
      [{ DB_HOST: "h", DB_PASS: SECRET, DB_NAME: "n", DB_USER: "u" }, "h:5432/n", "옛 DB_* 설정"],
      // 코디 재현: SSH_ENABLED=true 면 DATABASE_URL 을 안 쓰고 DB_HOST 로 터널
      [{ SSH_ENABLED: "true", SSH_HOST: "jump", DATABASE_URL: `postgres://user:${SECRET}@url-host:1/urldb`, DB_HOST: "behind", DB_PORT: "5433", DB_NAME: "realdb", DB_PASS: SECRET },
        "behind:5433/realdb (SSH 터널: jump:22)", "SSH 는 DB_HOST 쪽"],
      [{ SSH_ENABLED: "false", SSH_HOST: "jump", DATABASE_URL: `postgres://user:${SECRET}@url-host:1/urldb` }, "url-host:1/urldb", "SSH 꺼져 있으면 URL"],
      [{}, "설정 없음", "설정 없음"],
    ];
    for (const [vars, want, why] of cases) {
      const got = withEnv(vars);
      assert.equal(got, want, why);
      assert.ok(!got.includes(SECRET), `비밀번호가 찍히면 안 된다: ${why}`);
    }
  } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

// ── 2. 프로세스 (DB 없이) ──
const entry = path.resolve("build/index.js");
assert.ok(fs.existsSync(entry), "build/index.js 가 없다 — 먼저 `npm run build`");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mam-claude-export-"));
const fixtureFile = path.join(tmp, "conversations.json");
fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
const DEAD_SECRET = "dead-db-password";
const deadEnv = path.join(tmp, "dead.env");
fs.writeFileSync(deadEnv, `DATABASE_URL=postgres://x:${DEAD_SECRET}@127.0.0.1:1/none\n`);
function run(args: string[], configPath: string) {
  const r = spawnSync(process.execPath, [entry, "import-claude-export", ...args], {
    encoding: "utf8", timeout: 30_000, cwd: tmp, env: { PATH: process.env.PATH ?? "", HOME: tmp, MEMORY_CONFIG_PATH: configPath },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
{
  const r = run(["--dry-run", fixtureFile], deadEnv);
  assert.equal(r.status, 0, `dry-run 은 죽은 DB 에서도 된다: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.dryRun, true);
  assert.equal(out.rows, 4); assert.equal(out.inserted, 0); assert.equal(out.failed, 0);
  assert.equal(out.agent_platform, CLAUDE_EXPORT_PLATFORM); assert.equal(out.venue, CLAUDE_EXPORT_VENUE);
  assert.ok(!r.stderr.includes("DB ="), "dry-run 은 DB 주소도 안 찍는다(안 연다)");
}
{
  const zip = path.join(tmp, "conversations-000.zip");
  fs.writeFileSync(zip, "PK");
  const r = run(["--dry-run", zip], deadEnv);
  assert.equal(r.status, 1); assert.match(r.stderr, /압축을 먼저 풀고/);
  const r2 = run(["--dry-run", path.join(tmp, "missing.json")], deadEnv);
  assert.equal(r2.status, 1); assert.match(r2.stderr, /없는 파일/);
  const r3 = run([], deadEnv);
  assert.equal(r3.status, 1); assert.match(r3.stderr, /하나 이상/);
  const notExport = path.join(tmp, "other.json");
  fs.writeFileSync(notExport, JSON.stringify({ hello: 1 }));
  const r4 = run(["--dry-run", notExport], deadEnv);
  assert.equal(r4.status, 1, "모양이 다른 파일은 실패로 끝난다"); assert.match(r4.stderr, /배열/);
}
{ // 넣기(죽은 DB): DB 주소를 먼저 찍고(비밀번호 없이) 실패로 끝난다
  const r = run([fixtureFile], deadEnv);
  assert.notEqual(r.status, 0, "죽은 DB 에 넣으면 성공으로 끝나면 안 된다");
  assert.match(r.stderr, /DB = 127\.0\.0\.1:1\/none/);
  assert.ok(!r.stderr.includes(DEAD_SECRET) && !r.stdout.includes(DEAD_SECRET), "비밀번호가 찍히면 안 된다");
}

// ── 3. 프로세스 (DB 있음, 선택) ──
const dbUrl = process.env.CHECK_EXPORT_DATABASE_URL;
if (!dbUrl) {
  console.log("(CHECK_EXPORT_DATABASE_URL 없음 — DB 검사는 건너뜀)");
} else {
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const sentinel = (await client.query(`SELECT to_regclass('public.__disposable_test_db__') IS NOT NULL AS ok`)).rows[0].ok;
    if (!sentinel) {
      throw new Error("센티널 표 __disposable_test_db__ 가 없다 — 일회용 DB 가 아니면 쓰지 않는다. 일회용 DB 에서 CREATE TABLE IF NOT EXISTS __disposable_test_db__ () 뒤 실행.");
    }
    const envFile = path.join(tmp, "db.env");
    fs.writeFileSync(envFile, `DATABASE_URL=${dbUrl}\n`);
    const mig = spawnSync(process.execPath, [entry, "migrate"], {
      encoding: "utf8", timeout: 120_000, cwd: tmp, env: { PATH: process.env.PATH ?? "", HOME: tmp, MEMORY_CONFIG_PATH: envFile },
    });
    assert.equal(mig.status, 0, `migrate: ${mig.stderr.slice(-400)}`);
    await client.query(`DELETE FROM memory WHERE external_uuid LIKE 'claude-export:conv-%'`);

    const r1 = run([fixtureFile], envFile);
    assert.equal(r1.status, 0, r1.stderr);
    const o1 = JSON.parse(r1.stdout.trim());
    assert.equal(o1.inserted, 4); assert.equal(o1.dedup, 0); assert.equal(o1.failed, 0);

    const r2 = run([fixtureFile], envFile);
    assert.equal(r2.status, 0, r2.stderr);
    const o2 = JSON.parse(r2.stdout.trim());
    assert.equal(o2.inserted, 0, "두 번째는 하나도 안 넣는다"); assert.equal(o2.dedup, 4);

    const rows = (await client.query(
      `SELECT external_uuid, role, message, agent_platform, agent_model, venue, device_name, created_at, tag_processed
         FROM memory WHERE external_uuid LIKE 'claude-export:conv-%' ORDER BY created_at`)).rows;
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.agent_platform, CLAUDE_EXPORT_PLATFORM);
      assert.equal(row.venue, CLAUDE_EXPORT_VENUE);
      assert.equal(row.device_name, null);
      assert.equal(row.agent_model, row.role === "user" ? null : "unknown");
      assert.equal(row.tag_processed, false, "태그·임베딩은 Cold Path 가 채운다");
    }
    assert.equal(new Date(rows[0].created_at).toISOString(), "2026-11-20T22:57:10.000Z", "메시지 시각으로 저장");
    assert.equal(rows[1].message, "찾아봤어. 첫 문단.\n둘째 문단.");

    // 코디 재현: URL 앞부분은 엉뚱한 호스트·포트, query 가 진짜 일회용 DB → 찍힌 주소가 실제로 쓴 DB 와 같아야 한다
    const real = new URL(dbUrl);
    const decoy = new URL(dbUrl);
    decoy.hostname = "decoy-host.invalid"; decoy.port = "9";
    decoy.searchParams.set("host", real.hostname); decoy.searchParams.set("port", real.port || "5432");
    const decoyEnv = path.join(tmp, "decoy.env");
    fs.writeFileSync(decoyEnv, `DATABASE_URL=${decoy.toString()}\n`);
    await client.query(`DELETE FROM memory WHERE external_uuid = 'claude-export:conv-b:b2'`);
    const r3 = run([fixtureFile], decoyEnv);
    assert.equal(r3.status, 0, r3.stderr);
    assert.match(r3.stderr, new RegExp(`DB = ${real.hostname.replace(/\./g, "\\.")}:${real.port || "5432"}${real.pathname}\\b`),
      `찍힌 주소가 실제 연결과 같아야 한다: ${r3.stderr.split("\n").find((l) => l.includes("DB =")) ?? ""}`);
    assert.ok(!r3.stderr.includes("decoy-host"), "URL 앞부분의 엉뚱한 호스트를 찍으면 안 된다");
    assert.ok(!r3.stderr.includes(decodeURIComponent(real.password)) || !real.password, "비밀번호가 찍히면 안 된다");
    const o3 = JSON.parse(r3.stdout.trim());
    assert.equal(o3.inserted, 1, "빠진 한 줄만 다시 넣는다"); assert.equal(o3.dedup, 3);
    await client.query(`DELETE FROM memory WHERE external_uuid LIKE 'claude-export:conv-%'`);
  } finally {
    await client.end();
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("claude export import checks passed");
