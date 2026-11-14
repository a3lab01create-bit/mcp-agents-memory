/**
 * 클로드 대화 수집 — 작업 폴더가 "/" 여도 들어오는지 검사 (2026-11-14).
 *
 * 배경: 클로드 데스크톱 앱이 폴더 없이("this computer") 연 세션은 메모리 서버를 "/" 에서 띄운다.
 * cwd 로 ~/.claude/projects/<slug> 를 짐작하던 수집기가 10초 재시도 뒤 조용히 포기해서
 * 그 대화가 통째로 빠졌다(맥북 c561dd53). 고친 뒤 동작:
 *   - cwd 가 루트 + 클로드 클라이언트면 ~/.claude/projects/<slug>/*.jsonl 전부를 본다 (하위 폴더·점 폴더 제외)
 *   - 루트 cwd 라도 다른 클라이언트면 off, 읽을 수 없는 파일 하나가 나머지를 막지 않는다
 *   - arm 직전(기본 60초 안)에 생긴 파일은 처음부터 읽는다
 *   - 그 밖의 cwd 는 예전대로 그 폴더 하나만
 *   - backfill-claude: 처음부터 다시 읽고, created_at 은 줄의 timestamp, 두 번 돌려도 중복 없음
 *
 * 🔴 실제 DB 에 쓴다 → **버리는 시험용 DB 에서만** 돈다. DB 이름에 "test" 가 없으면 멈춘다.
 * 🔴 HOME 을 임시 폴더로 바꾼 뒤 import 한다 (PROJECTS_ROOT 가 import 시점에 정해진다).
 *
 *   MEMORY_CONFIG_PATH=<시험용 .env> npm run check:claude-capture
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

function line(type: "user" | "assistant", uuid: string, text: string, ts = new Date().toISOString()): string {
  return JSON.stringify({
    type, uuid, timestamp: ts, entrypoint: "cli", cwd: "/somewhere",
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

async function stored(): Promise<Map<string, { created_at: Date }>> {
  const r = await db.query(
    `SELECT external_uuid, created_at FROM memory WHERE agent_platform = 'claude-code' AND external_uuid LIKE 'claude-code:%'`,
  );
  return new Map(r.rows.map((x: any) => [String(x.external_uuid).split(":").pop()!, { created_at: x.created_at }]));
}
async function waitFor(uuids: string[], timeoutMs = 10_000): Promise<Map<string, { created_at: Date }>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await stored();
    if (uuids.every((u) => s.has(u)) || Date.now() > end) return s;
    await sleep(300);
  }
}

await db.query(`DELETE FROM memory WHERE agent_platform = 'claude-code'`);

try {
  // ── 1. cwd="/" → 전체 감시. 옛 파일은 끝부터, 새 slug·새 파일은 처음부터, 하위·점 폴더는 무시 ──
  const oldTs = "2026-11-09T00:00:00.000Z";
  const oldFile = write("-old-proj/sess-old.jsonl", line("user", "u-old-1", "옛 세션 첫 줄", oldTs));
  process.env.MEMORY_JSONL_FRESH_MS = "0"; // 방금 만든 파일도 "옛 파일"로 취급
  await sleep(20); // 🔴 birthtimeMs 는 소수 ms, Date.now() 는 정수 → 같은 ms 안이면 "갓 생긴" 쪽으로 기운다 (리뷰 실측 3.4%)
  cap.captureSessionStart("/");
  assert.equal(cap.getCaptureStatus().mode, "pending", "루트 cwd 는 클라이언트를 알 때까지 기다린다");
  cap.captureClientKnown("claude-code");
  assert.equal(cap.getCaptureStatus().mode, "global", "cwd 가 루트 + 클로드 클라이언트면 전체 감시");

  write("-old-proj/sess-old.jsonl", line("user", "u-old-2", "옛 세션에 새로 붙은 줄"), true);
  write("-brand-new-proj/sess-new.jsonl", line("user", "u-new-1", "새 폴더 새 세션 첫 줄") + line("assistant", "u-new-2", "답"));
  write("-brand-new-proj/sess-new/subagents/agent-x.jsonl", line("user", "u-sub-1", "하위 에이전트 줄"));
  write(".omc/top.jsonl", line("user", "u-dot-1", "점 폴더 줄"));
  // 읽을 수 없는 파일 하나가 뒤 파일들을 막으면 안 된다 (전체 감시에선 기계 전체 수집이 선다)
  const locked = write("-0000-locked/sess-locked.jsonl", line("user", "u-locked-1", "권한 없는 파일"));
  fs.chmodSync(locked, 0o000);
  write("-zzz-after-locked/sess-after.jsonl", line("user", "u-after-1", "잠긴 파일 다음 세션"));

  let s = await waitFor(["u-old-2", "u-new-1", "u-new-2", "u-after-1"]);
  await sleep(3500); // 폴링 한 바퀴 더 — 들어오면 안 되는 줄이 늦게 들어오는지
  s = await stored();
  assert.ok(s.has("u-old-2"), "옛 세션에 새로 붙은 줄은 들어와야 한다");
  assert.ok(s.has("u-new-1"), "처음 보는 slug 폴더의 첫 user 줄이 들어와야 한다 (데스크톱 세션 첫 턴)");
  assert.ok(s.has("u-new-2"), "그 세션의 답도 들어와야 한다");
  assert.ok(!s.has("u-old-1"), "arm 전에 이미 있던 옛 줄은 다시 넣지 않는다");
  assert.ok(!s.has("u-sub-1"), "<sid>/subagents/*.jsonl 은 읽지 않는다");
  assert.ok(!s.has("u-dot-1"), "점으로 시작하는 폴더는 읽지 않는다");
  assert.ok(s.has("u-after-1"), "읽을 수 없는 파일이 있어도 다른 파일은 계속 들어와야 한다");
  assert.ok(!s.has("u-locked-1"));
  fs.chmodSync(locked, 0o600);
  fs.rmSync(path.dirname(locked), { recursive: true });
  await cap.captureSessionEnd();
  cap.resetCaptureState();

  // ── 1b. 루트 cwd 인데 클로드가 아닌 클라이언트 → 줍지 않는다 (범위) ──
  cap.captureSessionStart("/");
  cap.captureClientKnown("codex-mcp-client");
  const nc = cap.getCaptureStatus();
  assert.equal(nc.mode, "off", "다른 클라이언트가 '/' 에서 띄운 서버는 클로드 대화를 줍지 않는다");
  assert.match(nc.reason ?? "", /not Claude/);
  write("-noclaude-proj/sess-nc.jsonl", line("user", "u-nc-1", "다른 클라이언트 서버가 주우면 안 되는 줄"));
  await sleep(3500);
  assert.ok(!(await stored()).has("u-nc-1"));
  cap.resetCaptureState();

  // ── 2. backfill: 처음부터, created_at = 줄 timestamp, 두 번째는 전부 중복 ──
  const b1 = await cap.backfillJsonlFile(oldFile);
  assert.equal(b1.inserted, 1, `옛 줄 하나만 새로 들어가야 한다: ${JSON.stringify(b1)}`);
  assert.equal(b1.dedup, 1, "이미 들어간 u-old-2 는 중복으로 건너뛴다");
  s = await stored();
  assert.equal(s.get("u-old-1")?.created_at.toISOString(), oldTs, "created_at 은 줄의 timestamp");
  const b2 = await cap.backfillJsonlFile(oldFile);
  assert.equal(b2.inserted, 0, "두 번 돌려도 새로 들어가는 건 없다");
  const dry = await cap.backfillJsonlFile(oldFile, { dryRun: true });
  assert.equal(dry.inserted, 2, "dry-run 은 읽을 수 있는 줄 수만 센다");

  // ── 3. arm 직전에 생긴 파일은 처음부터 (기본 60초 창) ──
  delete process.env.MEMORY_JSONL_FRESH_MS;
  write("-fresh-proj/sess-fresh.jsonl", line("user", "u-fresh-1", "서버보다 먼저 쓰인 첫 턴"));
  cap.captureSessionStart("/");
  cap.captureClientKnown("local-agent-mode-mcp-agents-memory"); // 데스크톱 앱 clientInfo
  s = await waitFor(["u-fresh-1"], 5000);
  assert.ok(s.has("u-fresh-1"), "서버보다 먼저 생긴 세션 파일의 첫 턴이 빠지면 안 된다");
  await cap.captureSessionEnd();
  cap.resetCaptureState();

  // ── 4. 보통 cwd 는 예전대로 그 폴더 하나만 ──
  process.env.MEMORY_JSONL_FRESH_MS = "0";
  const work = path.join(tmpHome, "work");
  fs.mkdirSync(work);
  const slug = work.replace(/[^a-zA-Z0-9]/g, "-");
  write(`${slug}/sess-dir.jsonl`, line("user", "u-dir-0", "이 폴더 옛 줄"));
  await sleep(20); // 1번과 같은 이유
  cap.captureSessionStart(work);
  assert.equal(cap.getCaptureStatus().mode, "dir");
  write(`${slug}/sess-dir.jsonl`, line("user", "u-dir-1", "이 폴더 새 줄"), true);
  write("-other-proj/sess-other.jsonl", line("user", "u-other-1", "다른 폴더 새 세션"));
  s = await waitFor(["u-dir-1"], 5000);
  await sleep(1000);
  s = await stored();
  assert.ok(s.has("u-dir-1"), "자기 폴더 줄은 들어온다");
  assert.ok(!s.has("u-other-1"), "보통 cwd 서버는 다른 폴더를 줍지 않는다 (범위 그대로)");
  await cap.captureSessionEnd();
  cap.resetCaptureState();

  // ── 5. 못 찾는 cwd → 10초 뒤 off + 이유 (memory_startup 경고의 근거) ──
  cap.captureSessionStart(path.join(tmpHome, "no-such-dir"));
  assert.equal(cap.getCaptureStatus().mode, "pending");
  await sleep(10_800);
  const st = cap.getCaptureStatus();
  assert.equal(st.mode, "off", "재시도가 끝나면 off");
  assert.match(st.reason ?? "", /project dir not found/);

  // ── 6. memory_startup 경고: 클로드 클라이언트 + off 일 때만 ──
  assert.match(cap.formatCaptureWarning("claude-code", st) ?? "", /자동 수집되지 않고/, "터미널 claude + off → 경고");
  assert.match(cap.formatCaptureWarning("local-agent-mode-mcp-agents-memory", st) ?? "", /no-such-dir/, "데스크톱 앱 + off → 경고(작업 폴더 표시)");
  assert.equal(cap.formatCaptureWarning("codex-mcp-client", st), null, "다른 클라이언트가 띄운 서버는 클로드 폴더가 없는 게 정상 → 조용히");
  assert.equal(cap.formatCaptureWarning("claude-code", { ...st, mode: "global" }), null, "수집 중이면 경고 없음");
  assert.equal(cap.formatCaptureWarning("claude-code", { ...st, mode: "pending" }), null, "붙는 중(10초 안)엔 경고 없음");
  assert.equal(cap.formatCaptureWarning(null, st), null);

  // 실제 memory_startup 핸들러 응답 맨 위에 붙는지 (가짜 서버 — clientInfo 만 흉내)
  const { registerMemoryStartup } = await import("../src/tools/memory_startup.ts");
  let startup: ((args: any) => Promise<any>) | null = null;
  registerMemoryStartup({
    registerTool(name: string, _s: unknown, fn: (args: any) => Promise<any>) { if (name === "memory_startup") startup = fn; },
    server: { getClientVersion: () => ({ name: "claude-code", version: "check" }) },
  } as any);
  const res = await startup!({});
  assert.match(res.content[0].text, /^> ⚠️ \*\*이 세션의 Claude 대화는 자동 수집되지 않고/, "memory_startup 응답 맨 위에 경고");
  cap.resetCaptureState();

  console.log(`✅ check:claude-capture — 루트 cwd 전체 감시·갓 생긴 파일·범위·backfill·off 상태·startup 경고 (db=${dbName})`);
} finally {
  cap.resetCaptureState();
  await db.query(`DELETE FROM memory WHERE agent_platform = 'claude-code'`);
  await db.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
