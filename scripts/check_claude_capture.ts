/**
 * 클로드 대화 수집 — 세션 폴더가 늦게 생겨도 들어오는지 검사 (2026-11-14).
 *
 * 배경(#129343, 맥북 실측): Claude Code 는 ~/.claude/projects/<slug>/ 와 jsonl 을 **첫 메시지를 보낼 때**
 * 만든다. 세션 메모리 서버는 세션을 열 때 떠서 예전엔 10초만 찾고 포기했다 → 세션을 열고 10초 넘게
 * 있다가 첫 메시지를 보내면(맥북: 12.7초·23초) 그 세션 대화가 통째로 빠졌다. 고친 뒤 동작:
 *   - 10초 빠른 재시도 뒤에도 포기하지 않고 slug 폴더가 생길 때까지 기다린다
 *   - 서버 시작 직전(기본 60초 안) 이후에 생긴 파일은 처음부터 읽는다 (기다리다 찾은 첫 턴 포함)
 *   - 오래된 파일은 끝부터, 하위 폴더(<sid>/subagents)·다른 slug 는 안 읽는다
 *   - 읽을 수 없는 파일 하나가 나머지를 막지 않는다
 *   - memory_startup: 클로드 클라이언트인데 못 붙었으면 맨 위 경고 ("/" 앱 연결·다른 클라이언트는 조용히)
 *   - backfill: 처음부터 다시 읽고, created_at 은 줄의 timestamp, 두 번 돌려도 중복 없음
 *
 * 🔴 실제 DB 에 쓴다 → **버리는 시험용 DB 에서만** 돈다. DB 이름에 "test" 가 없으면 멈춘다.
 * 🔴 HOME 을 임시 폴더로 바꾼 뒤 import 한다 (PROJECTS_ROOT 가 import 시점에 정해진다).
 *
 *   MEMORY_CONFIG_PATH=<시험용 .env> npm run check:claude-capture     (약 30초)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

if (!process.env.MEMORY_CONFIG_PATH) {
  console.error("MEMORY_CONFIG_PATH 로 시험용 DB 설정 파일을 지정해야 한다 (운영 DB 보호).");
  process.exit(2);
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-capture-"));
process.env.HOME = tmpHome; // 🔴 import 보다 먼저
const PROJECTS = path.join(tmpHome, ".claude", "projects");
fs.mkdirSync(PROJECTS, { recursive: true });

const { db } = await import("../src/db.ts");
const cap = await import("../src/auto_save/jsonl_capture.ts");

const dbName: string = (await db.query(`SELECT current_database() AS name`)).rows[0].name;
if (!/test/i.test(dbName)) {
  console.error(`시험용 DB 가 아니다: ${dbName} — 멈춘다.`);
  await db.close();
  process.exit(2);
}
assert.equal(path.join(os.homedir(), ".claude", "projects"), PROJECTS, "HOME 바꾸기가 import 전에 먹어야 한다");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slugOf = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

function line(type: "user" | "assistant", uuid: string, text: string, ts = new Date().toISOString()): string {
  return JSON.stringify({
    type, uuid, timestamp: ts, entrypoint: "claude-desktop", cwd: "/somewhere",
    message: type === "user"
      ? { role: "user", content: text }
      : { role: "assistant", model: "claude-check", content: [{ type: "text", text }] },
  }) + "\n";
}
function write(rel: string, content: string, append = false): string {
  const p = path.join(PROJECTS, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  (append ? fs.appendFileSync : fs.writeFileSync)(p, content);
  return p;
}
async function stored(): Promise<Map<string, { created_at: Date; venue: string | null }>> {
  const r = await db.query(
    `SELECT external_uuid, created_at, venue FROM memory WHERE agent_platform = 'claude-code' AND external_uuid LIKE 'claude-code:%'`,
  );
  return new Map(r.rows.map((x: any) => [String(x.external_uuid).split(":").pop()!, { created_at: x.created_at, venue: x.venue }]));
}
async function waitFor(uuids: string[], timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await stored();
    if (uuids.every((u) => s.has(u)) || Date.now() > end) return s;
    await sleep(300);
  }
}

// memory_startup 핸들러 (가짜 서버 — clientInfo 만 흉내)
const { registerMemoryStartup } = await import("../src/tools/memory_startup.ts");
async function startupText(clientName: string): Promise<string> {
  let fn: ((args: any) => Promise<any>) | null = null;
  registerMemoryStartup({
    registerTool(name: string, _s: unknown, f: (args: any) => Promise<any>) { if (name === "memory_startup") fn = f; },
    server: { getClientVersion: () => ({ name: clientName, version: "check" }) },
  } as any);
  return (await fn!({})).content[0].text;
}

await db.query(`DELETE FROM memory WHERE agent_platform = 'claude-code'`);

try {
  // ── 1. 진짜 원인: 세션 폴더가 서버 시작 10초 뒤에 생긴다 → 기다렸다가 첫 턴부터 ──
  const late = path.join(tmpHome, "scratch-2026-11-14-late");
  fs.mkdirSync(late);
  cap.captureSessionStart(late);
  assert.equal(cap.getCaptureStatus().mode, "pending");
  await sleep(10_800); // 빠른 재시도(10초)가 끝날 때까지 — 예전 코드는 여기서 포기했다
  let st = cap.getCaptureStatus();
  assert.equal(st.mode, "pending", "10초 뒤에도 포기하지 않고 기다린다");
  assert.match(st.reason ?? "", /waiting for .*first message/);
  assert.match(cap.formatCaptureWarning("local-agent-mode-mcp-agents-memory", st) ?? "", /자동 수집되지 않고/,
    "클로드 클라이언트가 이 상태로 memory_startup 을 부르면 경고 (첫 메시지 뒤인데도 폴더가 없다는 뜻)");

  write(`${slugOf(late)}/sess-late.jsonl`, line("user", "u-late-1", "열고 23초 뒤 보낸 첫 메시지") + line("assistant", "u-late-2", "답"));
  let s = await waitFor(["u-late-1", "u-late-2"], 8000);
  assert.ok(s.has("u-late-1"), "늦게 생긴 세션 폴더의 첫 user 줄이 들어와야 한다");
  assert.ok(s.has("u-late-2"));
  assert.equal(s.get("u-late-1")?.venue, "terminal", "entrypoint claude-desktop = 사람과 1:1");
  assert.equal(cap.getCaptureStatus().mode, "dir");
  assert.equal(cap.formatCaptureWarning("local-agent-mode-mcp-agents-memory", cap.getCaptureStatus()), null, "붙은 뒤엔 경고 없음");
  await cap.captureSessionEnd();
  cap.resetCaptureState();

  // ── 2. 폴더가 이미 있는 세션: 옛 파일은 끝부터, 새 줄·새 파일은 들어오고, 하위·다른 slug·잠긴 파일 처리 ──
  const work = path.join(tmpHome, "work");
  fs.mkdirSync(work);
  const ws = slugOf(work);
  const oldTs = "2026-11-09T00:00:00.000Z";
  const oldFile = write(`${ws}/sess-old.jsonl`, line("user", "u-old-1", "옛 세션 첫 줄", oldTs));
  process.env.MEMORY_JSONL_FRESH_MS = "0"; // 방금 만든 파일도 "옛 파일"로 취급
  await sleep(20); // 🔴 birthtimeMs 는 소수 ms, Date.now() 는 정수 → 같은 ms 안이면 "갓 생긴" 쪽으로 기운다
  cap.captureSessionStart(work);
  assert.equal(cap.getCaptureStatus().mode, "dir");

  // 잠긴 파일을 먼저 만든다 (읽기 오류 하나가 뒤 파일을 막으면 안 된다)
  const locked = write(`${ws}/sess-0-locked.jsonl`, line("user", "u-locked-1", "권한 없는 파일"));
  fs.chmodSync(locked, 0o000);
  write(`${ws}/sess-old.jsonl`, line("user", "u-old-2", "옛 세션에 새로 붙은 줄"), true);
  write(`${ws}/sess-new.jsonl`, line("user", "u-new-1", "같은 폴더 새 세션"));
  write(`${ws}/sess-new/subagents/agent-x.jsonl`, line("user", "u-sub-1", "하위 에이전트 줄"));
  write("-other-proj/sess-other.jsonl", line("user", "u-other-1", "다른 폴더 새 세션"));

  s = await waitFor(["u-old-2", "u-new-1"], 8000);
  await sleep(1500);
  s = await stored();
  assert.ok(s.has("u-old-2"), "옛 세션에 새로 붙은 줄은 들어와야 한다");
  assert.ok(s.has("u-new-1"), "같은 폴더 새 세션은 처음부터 들어와야 한다");
  assert.ok(!s.has("u-old-1"), "서버 시작 전에 이미 있던 옛 줄은 다시 넣지 않는다");
  assert.ok(!s.has("u-sub-1"), "<sid>/subagents/*.jsonl 은 읽지 않는다");
  assert.ok(!s.has("u-other-1"), "다른 slug 폴더는 줍지 않는다 (범위 그대로)");
  assert.ok(!s.has("u-locked-1"));
  fs.chmodSync(locked, 0o600);
  fs.rmSync(locked);
  await cap.captureSessionEnd();
  cap.resetCaptureState();

  // ── 3. backfill: 처음부터, created_at = 줄 timestamp, 두 번째는 전부 중복 ──
  const b1 = await cap.backfillJsonlFile(oldFile);
  assert.equal(b1.inserted, 1, `옛 줄 하나만 새로 들어가야 한다: ${JSON.stringify(b1)}`);
  assert.equal(b1.dedup, 1, "이미 들어간 u-old-2 는 중복으로 건너뛴다");
  assert.equal(b1.failed, 0);
  s = await stored();
  assert.equal(s.get("u-old-1")?.created_at.toISOString(), oldTs, "created_at 은 줄의 timestamp");
  const b2 = await cap.backfillJsonlFile(oldFile);
  assert.equal(b2.inserted, 0, "두 번 돌려도 새로 들어가는 건 없다");
  const dry = await cap.backfillJsonlFile(oldFile, { dryRun: true });
  assert.equal(dry.inserted, 2, "dry-run 은 읽을 수 있는 줄 수만 센다");

  // ── 4. 서버 시작 직전에 생긴 파일은 처음부터 (기본 60초 창) ──
  delete process.env.MEMORY_JSONL_FRESH_MS;
  const fresh = path.join(tmpHome, "fresh");
  fs.mkdirSync(fresh);
  write(`${slugOf(fresh)}/sess-fresh.jsonl`, line("user", "u-fresh-1", "서버보다 먼저 쓰인 첫 턴"));
  cap.captureSessionStart(fresh);
  s = await waitFor(["u-fresh-1"], 5000);
  assert.ok(s.has("u-fresh-1"), "서버보다 먼저 생긴 세션 파일의 첫 턴이 빠지면 안 된다");
  await cap.captureSessionEnd();
  cap.resetCaptureState();

  // ── 5. memory_startup 경고 ──
  const nowhere = path.join(tmpHome, "no-session-yet");
  cap.captureSessionStart(nowhere);
  assert.match(await startupText("claude-code"), /^> ⚠️ \*\*이 세션의 Claude 대화는 자동 수집되지 않고/,
    "클로드 클라이언트 + 세션 폴더 없음 → memory_startup 응답 맨 위에 경고");
  assert.doesNotMatch(await startupText("codex-mcp-client"), /자동 수집되지 않고/, "다른 클라이언트 서버는 조용히");
  // memory_startup 직전 다시 확인: 그사이 폴더가 생겼으면 붙고 경고 없음
  write(`${slugOf(nowhere)}/sess-now.jsonl`, line("user", "u-now-1", "막 보낸 첫 메시지"));
  assert.doesNotMatch(await startupText("claude-code"), /자동 수집되지 않고/, "재확인으로 붙었으면 경고 없음");
  assert.equal(cap.getCaptureStatus().mode, "dir");
  await cap.captureSessionEnd();
  cap.resetCaptureState();
  // "/" = 클로드 데스크톱 앱의 앱 전체용 연결 — 세션 대화는 세션 서버가 수집하므로 경고하지 않는다
  assert.equal(cap.formatCaptureWarning("local-agent-mode-mcp-agents-memory",
    { mode: "pending", cwd: "/", projectDir: null, files: 0, reason: "waiting" }), null);
  assert.equal(cap.formatCaptureWarning(null, { mode: "pending", cwd: nowhere, projectDir: null, files: 0 }), null);

  console.log(`✅ check:claude-capture — 늦게 생긴 세션 폴더·갓 생긴 파일·범위·잠긴 파일·backfill·startup 경고 (db=${dbName})`);
} finally {
  cap.resetCaptureState();
  await db.query(`DELETE FROM memory WHERE agent_platform = 'claude-code'`);
  await db.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
