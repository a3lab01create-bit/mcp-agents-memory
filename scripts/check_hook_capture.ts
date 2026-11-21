/**
 * 훅 수집 확인(hook_capture_check.ts) 검사.
 *
 * 1) 순수 함수: 대화 파일에서 볼 줄 고르기 · 판정 · 경고 글 · 세션 표시 파일 · 꼬리 읽기.
 * 2) 프로세스(DB 없이): 빌드된 서버로 훅을 띄워 exit 0 · 판정 못 하면 DB 에 안 붙음 · 표시가 있으면
 *    파일만 보고 끝 · 클로드가 아니면 안 함 · 로그에 말이 안 남음. → 먼저 `npm run build`.
 * 3) 프로세스(DB 있음, 선택): CHECK_CAPTURE_DATABASE_URL 이 있으면 그 DB 를 마이그레이션하고
 *    행을 넣는다 — **버려도 되는 시험 DB 만.** 이름으로 판별하지 않는다(check_ingest_stuck_ids ①:
 *    부분일치는 운영 이름도 통과했다). 센티널 표 `__disposable_test_db__` 가 없으면 멈춘다.
 *    준비: psql <일회용DB> -c 'CREATE TABLE IF NOT EXISTS __disposable_test_db__ ()'
 *    실제 수집기 형식과 맞는지 보려고 `backfill-claude` 로 넣은 행으로 "됨" 을 확인한다(양성대조).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {
  captureCandidates,
  captureMarkerPath,
  decideCapture,
  formatCaptureCheckWarning,
  hasCaptureMarker,
  readTranscriptTail,
  transcriptSessionId,
  writeCaptureMarker,
  type CaptureCheckSettings,
} from "../src/hook_capture_check.js";

const S: CaptureCheckSettings = { graceMs: 60_000, windowMs: 30 * 60_000, tailBytes: 2 * 1024 * 1024, minMissing: 2 };
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const SECRET = "시험용 비밀 문장 9876 — 로그에 남으면 안 된다";

const user = (uuid: string, text: string, msAgo: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "user", uuid, timestamp: iso(msAgo), message: { role: "user", content: text }, ...extra });
const assistant = (uuid: string, text: string, msAgo: number) =>
  JSON.stringify({ type: "assistant", uuid, timestamp: iso(msAgo), message: { role: "assistant", model: "claude-test", content: [{ type: "text", text }] } });
const toolResult = (uuid: string, msAgo: number) =>
  JSON.stringify({ type: "user", uuid, timestamp: iso(msAgo), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "out" }] } });
const attachment = (uuid: string, msAgo: number) =>
  JSON.stringify({ type: "attachment", uuid, timestamp: iso(msAgo), attachment: { type: "hook_additional_context", content: ["x"] } });

// ── 1. 세션 id ──
assert.equal(transcriptSessionId("/h/.claude/projects/-p/9f1c2d3e-aaaa-bbbb.jsonl"), "9f1c2d3e-aaaa-bbbb");
assert.equal(transcriptSessionId("/h/x/session.txt"), null, ".jsonl 이 아니면 안 본다");
assert.equal(transcriptSessionId("/h/x/.hidden.jsonl"), null, "점으로 시작하는 이름은 표시 파일로 못 쓴다");
assert.equal(transcriptSessionId("/h/x/a b.jsonl"), null, "공백 등은 거부");

// ── 2. 볼 줄 고르기 ──
const body = [
  user("u0", "두 시간 전 말 — 창 밖", 2 * 60 * 60_000),
  user("u1", `첫 질문 ${SECRET}`, 5 * 60_000),
  attachment("att1", 5 * 60_000 - 100),
  assistant("a1", "첫 답입니다", 4.9 * 60_000),
  toolResult("t1", 4.8 * 60_000),
  user("m1", "메타 줄", 4.7 * 60_000, { isMeta: true }),
  JSON.stringify({ type: "user", timestamp: iso(4.6 * 60_000), message: { role: "user", content: "uuid 없는 줄" } }),
  user("int", "[Request interrupted by user]", 4.5 * 60_000),
  user("u2", "방금 한 말 — 유예 안", 10_000),
  "{\"type\":\"user\",\"uuid\":\"partial-at-end",
].join("\n");
const cands = captureCandidates(body, "sid", NOW, S, true);
assert.deepEqual(cands.map((c) => c.externalUuid), ["claude-code:sid:u1", "claude-code:sid:a1"],
  "유예~창 사이의, 수집기가 넣을 줄만 (도구 결과·첨부·메타·uuid 없음·중단 표시·너무 새것·너무 옛것 제외)");
assert.deepEqual(captureCandidates(body, "sid", NOW, S, false).map((c) => c.externalUuid),
  ["claude-code:sid:u1", "claude-code:sid:a1"], "fromStart=false 면 첫 줄(여기선 창 밖 u0)을 버린다");
assert.deepEqual(captureCandidates(user("u1", "말", 5 * 60_000) + "\n" + assistant("a1", "답", 4 * 60_000), "sid", NOW, S, false)
  .map((c) => c.externalUuid), ["claude-code:sid:a1"], "잘린 첫 줄은 버린다");
const many = Array.from({ length: 80 }, (_, i) => user(`m${i}`, `말 ${i}`, 20 * 60_000 - i * 1000)).join("\n");
const manyC = captureCandidates(many, "sid", NOW, S, true);
assert.equal(manyC.length, 50, "최근 50줄까지만");
assert.equal(manyC[49].externalUuid, "claude-code:sid:m79");

// ── 3. 판정 ──
assert.deepEqual(decideCapture([], new Set(), S), { verdict: "undecided", eligible: 0, found: 0, reason: "no-eligible" });
assert.deepEqual(decideCapture(cands, new Set(["claude-code:sid:a1"]), S), { verdict: "ok", eligible: 2, found: 1 },
  "하나라도 있으면 됨 (수집기는 같은 내용을 한 번만 넣는다)");
const dup = captureCandidates([user("d1", "응", 5 * 60_000), user("d2", "응", 4 * 60_000)].join("\n"), "sid", NOW, S, true);
assert.deepEqual(decideCapture(dup, new Set(), S), { verdict: "undecided", eligible: 2, found: 0, dedup: 0, reason: "too-few" },
  "내용이 같은 줄뿐이면 판정하지 않는다");
assert.deepEqual(decideCapture(cands, new Set(), S), { verdict: "missing", eligible: 2, found: 0, dedup: 0, missing: 2 });
assert.deepEqual(decideCapture(cands, new Set(), S, new Set(cands.map((c) => c.key))),
  { verdict: "undecided", eligible: 2, found: 0, dedup: 2, reason: "dedup" },
  "같은 세션에 같은 내용이 이미 있으면 정상 중복 제거 — 경고 안 함 (코디 리뷰 #45-1)");
assert.deepEqual(decideCapture(cands, new Set(), S, new Set([cands[0].key])),
  { verdict: "undecided", eligible: 2, found: 0, dedup: 1, reason: "dedup" }, "남은 줄이 1개면 판정 안 함");

// ── 4. 경고 글 ──
const warn = formatCaptureCheckWarning({ verdict: "missing", eligible: 3, found: 0, dedup: 1, missing: 2 }, S, "/h/.claude/projects/-p/sid.jsonl");
assert.ok(warn.includes("2줄") && warn.includes("60초") && warn.includes("backfill-claude \"/h/.claude/projects/-p/sid.jsonl\""), warn);
assert.ok(warn.includes("사용자에게") && warn.includes("한 번"), "모델이 사용자에게 한 번 알리게");

// ── 5. 표시 파일 · 꼬리 읽기 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mam-capcheck-"));
const mdir = path.join(tmp, "markers");
assert.equal(hasCaptureMarker(mdir, "s1"), false);
writeCaptureMarker(mdir, "s1", "ok", NOW);
assert.equal(hasCaptureMarker(mdir, "s1"), true);
assert.equal(fs.statSync(captureMarkerPath(mdir, "s1")).mode & 0o777, 0o600);
assert.equal(fs.statSync(mdir).mode & 0o777, 0o700);
assert.equal(JSON.parse(fs.readFileSync(captureMarkerPath(mdir, "s1"), "utf8")).verdict, "ok");
const old = (NOW - 15 * 24 * 60 * 60_000) / 1000;
const oldOurs = captureMarkerPath(mdir, "old-session");
writeCaptureMarker(mdir, "old-session", "ok", NOW - 15 * 24 * 60 * 60_000);
fs.utimesSync(oldOurs, old, old);
// 우리 것이 아닌 오래된 파일들 — 절대 지우면 안 된다 (코디 리뷰 #45-4)
const foreign = [
  ["operator-note.txt", "사람이 둔 메모\n"],
  ["lookalike.capture-check.json", "{\"verdict\":\"ok\"}\n"],          // 이름은 같은 꼴, 우리 tag 없음
  ["old-session", "{}\n"],                                                  // 0.9.40 이전 꼴 이름
].map(([name, body]) => {
  const p = path.join(mdir, name);
  fs.writeFileSync(p, body);
  fs.utimesSync(p, old, old);
  return p;
});
writeCaptureMarker(mdir, "s2", "warned", NOW);
assert.equal(fs.existsSync(oldOurs), false, "2주 넘은 우리 표시는 지운다");
for (const p of foreign) assert.equal(fs.existsSync(p), true, `우리 것이 아닌 파일은 남긴다: ${path.basename(p)}`);
assert.equal(hasCaptureMarker(mdir, "s1"), true, "최근 표시는 남긴다");

const tf = path.join(tmp, "t.jsonl");
fs.writeFileSync(tf, "0123456789\nabcdefghij\n");
assert.deepEqual(readTranscriptTail(tf, 1000), { text: "0123456789\nabcdefghij\n", fromStart: true });
assert.deepEqual(readTranscriptTail(tf, 5), { text: "ghij\n", fromStart: false });
assert.equal(readTranscriptTail(path.join(tmp, "none.jsonl"), 10), null);
assert.equal(readTranscriptTail(tmp, 10), null, "폴더는 null");
const fifo = path.join(tmp, "fifo-session.jsonl");
const mk = spawnSync("mkfifo", [fifo]);
const haveFifo = mk.status === 0;
if (haveFifo) {
  const t0 = Date.now();
  assert.equal(readTranscriptTail(fifo, 10), null, "FIFO 는 null");
  assert.ok(Date.now() - t0 < 500, "FIFO 에서 막히지 않는다 (코디 리뷰 #45-3)");
} else {
  console.log("(mkfifo 없음 — FIFO 검사 건너뜀)");
}

// 표시 쓰기는 새로 만들 때만 — 그 자리에 이미 있는 것(심링크·FIFO·파일)은 열지도 덮지도 않는다 (코디 리뷰 #45-5)
const xdir = path.join(tmp, "excl-markers");
fs.mkdirSync(xdir, { mode: 0o700 });
const note = path.join(tmp, "operator-note-target.txt");
fs.writeFileSync(note, "건드리면 안 되는 메모\n");
fs.symlinkSync(note, captureMarkerPath(xdir, "sym"));
assert.throws(() => writeCaptureMarker(xdir, "sym", "warned"), /EEXIST|ELOOP/, "심링크 자리엔 쓰지 않는다");
assert.equal(fs.readFileSync(note, "utf8"), "건드리면 안 되는 메모\n", "심링크 너머 파일은 그대로");
fs.writeFileSync(captureMarkerPath(xdir, "plain"), "남의 내용\n");
assert.throws(() => writeCaptureMarker(xdir, "plain", "ok"), /EEXIST/);
assert.equal(fs.readFileSync(captureMarkerPath(xdir, "plain"), "utf8"), "남의 내용\n", "있는 파일은 덮지 않는다");
if (haveFifo) {
  assert.equal(spawnSync("mkfifo", [captureMarkerPath(xdir, "fifo")]).status, 0);
  const t0 = Date.now();
  assert.throws(() => writeCaptureMarker(xdir, "fifo", "ok"), /EEXIST/);
  assert.ok(Date.now() - t0 < 500, "FIFO 자리에서 막히지 않는다");
}

// ── 6. 프로세스 (DB 없이) ──
const entry = path.resolve("build/index.js");
assert.ok(fs.existsSync(entry), "build/index.js 가 없다 — 먼저 `npm run build`");
const deadEnv = path.join(tmp, "dead.env");
fs.writeFileSync(deadEnv, "DATABASE_URL=postgres://x:y@127.0.0.1:1/none\n");
const logFile = path.join(tmp, "hooks.log");
const pdir = path.join(tmp, "proc-markers");
const projDir = path.join(tmp, ".claude", "projects", "-tmp-proj");
fs.mkdirSync(projDir, { recursive: true });

function writeTranscript(sid: string, lines: string[]): string {
  const p = path.join(projDir, `${sid}.jsonl`);
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
}
function lastLog(file = logFile): any {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}
function runHook(client: string, input: object, env: Record<string, string>) {
  const r = spawnSync(process.execPath, [entry, "hook", "prompt", "--client", client], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 20_000, cwd: tmp,
    env: { PATH: process.env.PATH ?? "", HOME: tmp, MEMORY_HOOK_LOG: logFile, MEMORY_CAPTURE_CHECK_DIR: pdir, ...env },
  });
  return { status: r.status, stdout: r.stdout };
}
const SHORT = "응"; // recall 은 건너뛴다(짧은 말) → DB 에 붙는다면 수집 확인 때문이다
const eligible = (p: string) => [user(`${p}-u1`, `첫 질문 ${SECRET}`, 5 * 60_000), assistant(`${p}-a1`, "첫 답입니다", 4.9 * 60_000)];

{ // 볼 줄이 있고 DB 가 죽음 → exit 0 · 출력 없음 · 표시 없음 (다음 말에서 다시)
  const t = writeTranscript("p-dead", eligible("pd"));
  const r = runHook("claude", { prompt: SHORT, transcript_path: t }, { MEMORY_CONFIG_PATH: deadEnv });
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
  const l = lastLog();
  assert.equal(l.capture, "error", JSON.stringify(l));
  assert.equal(hasCaptureMarker(pdir, "p-dead"), false, "판정 못 했으면 표시를 안 남긴다");
}
{ // 볼 줄이 아직 없음(전부 유예 안) → DB 에 안 붙는다: 죽은 DB 인데 오류가 아니다
  const t = writeTranscript("p-fresh", [user("pf-u1", "방금", 5_000), assistant("pf-a1", "답", 3_000)]);
  const r = runHook("claude", { prompt: SHORT, transcript_path: t }, { MEMORY_CONFIG_PATH: deadEnv });
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
  const l = lastLog();
  assert.equal(l.outcome, "none", JSON.stringify(l));
  assert.equal(l.capture, "undecided"); assert.equal(l.reason, "no-eligible");
}
{ // 이미 판정한 세션 → 파일만 보고 끝 (죽은 DB 인데 오류가 아니다)
  const t = writeTranscript("p-done", eligible("pdn"));
  writeCaptureMarker(pdir, "p-done", "ok");
  const r = runHook("claude", { prompt: SHORT, transcript_path: t }, { MEMORY_CONFIG_PATH: deadEnv });
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
  const l = lastLog();
  assert.equal(l.outcome, "none", JSON.stringify(l)); assert.equal(l.capture, "done");
}
{ // 꺼짐 스위치
  const t = writeTranscript("p-off", eligible("po"));
  runHook("claude", { prompt: SHORT, transcript_path: t }, { MEMORY_CONFIG_PATH: deadEnv, MEMORY_CAPTURE_CHECK: "0" });
  const l = lastLog();
  assert.equal(l.capture, "off"); assert.equal(l.outcome, "none");
}
{ // 코덱스·agy 는 하지 않는다 (코덱스도 transcript_path 를 준다)
  const t = writeTranscript("p-codex", eligible("pc"));
  const r = runHook("codex", { prompt: SHORT, transcript_path: t }, { MEMORY_CONFIG_PATH: deadEnv });
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
  const l = lastLog();
  assert.equal(l.client, "codex"); assert.equal("capture" in l, false, JSON.stringify(l));
  const ra = runHook("agy", { lastUserInput: SHORT, invocationNum: 0, transcript_path: t }, { MEMORY_CONFIG_PATH: deadEnv });
  assert.equal(ra.stdout, "{}");
  assert.equal("capture" in lastLog(), false);
}
{ // transcript_path 없음 / 상대경로
  runHook("claude", { prompt: SHORT }, { MEMORY_CONFIG_PATH: deadEnv });
  assert.equal(lastLog().capture, "no-transcript");
  runHook("claude", { prompt: SHORT, transcript_path: "rel/x.jsonl" }, { MEMORY_CONFIG_PATH: deadEnv });
  assert.equal(lastLog().capture, "no-transcript");
}
if (haveFifo) { // FIFO 를 transcript_path 로 줘도 막히지 않고 바로 끝난다
  const t0 = Date.now();
  const r = runHook("claude", { prompt: SHORT, transcript_path: fifo }, { MEMORY_CONFIG_PATH: deadEnv, MEMORY_HOOK_PROMPT_DEADLINE_MS: "1500" });
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
  assert.ok(Date.now() - t0 < 1400, `FIFO 로 막히면 안 된다 (${Date.now() - t0}ms)`);
  assert.equal(lastLog().capture, "unreadable");
}
assert.ok(!fs.readFileSync(logFile, "utf8").includes("비밀"), "로그에 대화 내용이 남으면 안 된다");

// ── 7. 프로세스 (DB 있음, 선택) ──
const dbUrl = process.env.CHECK_CAPTURE_DATABASE_URL;
if (!dbUrl) {
  console.log("(CHECK_CAPTURE_DATABASE_URL 없음 — DB 검사는 건너뜀)");
} else {
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  const sentinel = (await client.query(`SELECT to_regclass('public.__disposable_test_db__') IS NOT NULL AS ok`)).rows[0].ok;
  if (!sentinel) {
    await client.end();
    throw new Error("센티널 표 __disposable_test_db__ 가 없다 — 일회용 DB 가 아니면 쓰지 않는다. 일회용 DB 에서 CREATE TABLE IF NOT EXISTS __disposable_test_db__ () 뒤 실행.");
  }
  const envFile = path.join(tmp, "db.env");
  fs.writeFileSync(envFile, `DATABASE_URL=${dbUrl}\n`); // OPENAI 키 없음 → recall 은 바로 실패한다
  const baseEnv = { PATH: process.env.PATH ?? "", HOME: tmp, MEMORY_CONFIG_PATH: envFile };
  const mig = spawnSync(process.execPath, [entry, "migrate"], { encoding: "utf8", timeout: 60_000, cwd: tmp, env: baseEnv });
  assert.equal(mig.status, 0, `migrate: ${mig.stderr.slice(-400)}`);
  await client.query(`INSERT INTO users (user_name) SELECT 'capcheck' WHERE NOT EXISTS (SELECT 1 FROM users)`);
  const sfx = `${process.pid}-${NOW}`;
  const ctx = (stdout: string) => (stdout ? JSON.parse(stdout).hookSpecificOutput.additionalContext as string : "");

  // 안 들어간 세션 → 경고 · "warned" 표시
  const sA = `db-miss-${sfx}`;
  const tA = writeTranscript(sA, eligible(`A${sfx}`));
  const rA = runHook("claude", { prompt: SHORT, transcript_path: tA }, { MEMORY_CONFIG_PATH: envFile });
  assert.equal(rA.status, 0);
  assert.ok(ctx(rA.stdout).startsWith("⚠️ mcp-agents-memory 수집 확인") && ctx(rA.stdout).includes("2줄"), rA.stdout);
  assert.equal(lastLog().capture, "missing");
  assert.equal(JSON.parse(fs.readFileSync(captureMarkerPath(pdir, sA), "utf8")).verdict, "warned");
  // 같은 세션 다음 말 → 다시 경고하지 않는다
  const rA2 = runHook("claude", { prompt: SHORT, transcript_path: tA }, { MEMORY_CONFIG_PATH: envFile });
  assert.equal(rA2.stdout, ""); assert.equal(lastLog().capture, "done");

  // 양성대조: 실제 수집 코드(backfill-claude)로 넣은 세션 → 됨 · "ok" 표시
  const sB = `db-ok-${sfx}`;
  const tB = writeTranscript(sB, eligible(`B${sfx}`));
  const bf = spawnSync(process.execPath, [entry, "backfill-claude", tB], { encoding: "utf8", timeout: 60_000, cwd: tmp, env: baseEnv });
  assert.equal(bf.status, 0, `backfill-claude: ${bf.stderr.slice(-400)}`);
  const nB = await client.query(`SELECT count(*)::int AS n FROM memory WHERE external_uuid LIKE $1`, [`claude-code:${sB}:%`]);
  assert.equal(nB.rows[0].n, 2, "backfill 이 두 줄을 넣었다");
  const rB = runHook("claude", { prompt: SHORT, transcript_path: tB }, { MEMORY_CONFIG_PATH: envFile });
  assert.equal(rB.stdout, "", "들어간 세션은 경고하지 않는다");
  const lB = lastLog();
  assert.equal(lB.capture, "ok", JSON.stringify(lB)); assert.equal(lB.found, 2);
  assert.equal(JSON.parse(fs.readFileSync(captureMarkerPath(pdir, sB), "utf8")).verdict, "ok");

  // 내용이 같은 줄뿐 → 판정 안 함 · 표시 없음
  const sC = `db-dup-${sfx}`;
  const tC = writeTranscript(sC, [user(`C1${sfx}`, "응", 5 * 60_000), user(`C2${sfx}`, "응", 4 * 60_000)]);
  const rC = runHook("claude", { prompt: SHORT, transcript_path: tC }, { MEMORY_CONFIG_PATH: envFile });
  assert.equal(rC.stdout, "");
  assert.equal(lastLog().reason, "too-few");
  assert.equal(hasCaptureMarker(pdir, sC), false);

  // 정상 중복 제거 (코디 리뷰 #45-1 재현): 40분 전 질문·답이 저장돼 있고, 3분 전에 같은 내용이
  // 다른 uuid 로 다시 쓰였다 → 수집기는 뒤의 두 줄을 넣지 않는 게 정상 → 경고하면 안 된다
  const sE = `db-dedup-${sfx}`;
  const tE = writeTranscript(sE, [
    user(`E1${sfx}`, `같은 질문 ${sfx}`, 40 * 60_000), assistant(`E2${sfx}`, `같은 답 ${sfx}`, 39.9 * 60_000),
    user(`E3${sfx}`, `같은 질문 ${sfx}`, 3 * 60_000), assistant(`E4${sfx}`, `같은 답 ${sfx}`, 2.9 * 60_000),
  ]);
  const bfE = spawnSync(process.execPath, [entry, "backfill-claude", tE], { encoding: "utf8", timeout: 60_000, cwd: tmp, env: baseEnv });
  assert.equal(bfE.status, 0, `backfill-claude: ${bfE.stderr.slice(-400)}`);
  const nE = await client.query(`SELECT count(*)::int AS n FROM memory WHERE external_uuid LIKE $1`, [`claude-code:${sE}:%`]);
  assert.equal(nE.rows[0].n, 2, "실제 수집 코드는 같은 내용을 한 번만 넣는다 (양성대조)");
  const rE = runHook("claude", { prompt: SHORT, transcript_path: tE }, { MEMORY_CONFIG_PATH: envFile });
  assert.equal(rE.stdout, "", "정상 중복 제거를 누락으로 보면 안 된다");
  const lE = lastLog();
  assert.equal(lE.capture, "undecided", JSON.stringify(lE)); assert.equal(lE.reason, "dedup"); assert.equal(lE.dedup, 2);
  assert.equal(hasCaptureMarker(pdir, sE), false);

  // 느린 recall (코디 리뷰 #45-2 재현): 응답 없는 임베딩 서버 → 끝난 수집 경고는 deadline 안에 나가야 한다
  const hang = net.createServer(() => { /* 받고 대답 안 함 */ });
  await new Promise<void>((res) => hang.listen(0, "127.0.0.1", () => res()));
  const hangPort = (hang.address() as net.AddressInfo).port;
  const slowEnv = path.join(tmp, "slow.env");
  fs.writeFileSync(slowEnv, `DATABASE_URL=${dbUrl}\nOPENAI_API_KEY=sk-test-not-real\nOPENAI_BASE_URL=http://127.0.0.1:${hangPort}/v1\n`);
  const sF = `db-slowrecall-${sfx}`;
  const tF = writeTranscript(sF, eligible(`F${sfx}`));
  const t0 = Date.now();
  const rF = runHook("claude", { prompt: "지난번 배송비 바꾼 거 기억나? 그때 얼마로 했지", transcript_path: tF },
    { MEMORY_CONFIG_PATH: slowEnv, MEMORY_HOOK_PROMPT_DEADLINE_MS: "1200" });
  const msF = Date.now() - t0;
  hang.close();
  assert.ok(ctx(rF.stdout).startsWith("⚠️ mcp-agents-memory 수집 확인"), `느린 recall 에도 경고는 나간다: ${JSON.stringify(rF.stdout)} (${msF}ms)`);
  const lF = lastLog();
  assert.equal(lF.capture, "missing"); assert.equal(lF.recallError, "recall timeout", JSON.stringify(lF));
  assert.equal(JSON.parse(fs.readFileSync(captureMarkerPath(pdir, sF), "utf8")).verdict, "warned");

  // 표시 자리에 심링크·FIFO 가 있어도: 경고는 나가고, 심링크 너머는 그대로, 막히지 않는다 (코디 리뷰 #45-5)
  const sG = `db-symmarker-${sfx}`;
  const tG = writeTranscript(sG, eligible(`G${sfx}`));
  const noteG = path.join(tmp, `note-${sfx}.txt`);
  fs.writeFileSync(noteG, "메모 원본\n");
  fs.mkdirSync(pdir, { recursive: true });
  fs.symlinkSync(noteG, captureMarkerPath(pdir, sG));
  const rG = runHook("claude", { prompt: SHORT, transcript_path: tG }, { MEMORY_CONFIG_PATH: envFile });
  assert.ok(ctx(rG.stdout).startsWith("⚠️ mcp-agents-memory 수집 확인"), rG.stdout);
  assert.equal(fs.readFileSync(noteG, "utf8"), "메모 원본\n", "심링크 너머 파일을 덮으면 안 된다");
  const lG = lastLog();
  assert.equal(lG.capture, "missing"); assert.ok(/EEXIST|ELOOP/.test(lG.markerError ?? ""), JSON.stringify(lG));
  if (haveFifo) {
    const sH = `db-fifomarker-${sfx}`;
    const tH = writeTranscript(sH, eligible(`H${sfx}`));
    assert.equal(spawnSync("mkfifo", [captureMarkerPath(pdir, sH)]).status, 0);
    const t0H = Date.now();
    const rH = runHook("claude", { prompt: SHORT, transcript_path: tH }, { MEMORY_CONFIG_PATH: envFile, MEMORY_HOOK_PROMPT_DEADLINE_MS: "1500" });
    const msH = Date.now() - t0H;
    assert.equal(rH.status, 0);
    assert.ok(ctx(rH.stdout).startsWith("⚠️ mcp-agents-memory 수집 확인"), `FIFO 표시 자리에도 경고는 나간다: ${JSON.stringify(rH.stdout)} (${msH}ms)`);
    assert.ok(msH < 1400, `FIFO 표시 자리에서 막히면 안 된다 (${msH}ms)`);
  }

  // recall 이 실패해도(임베딩 키 없음) 경고는 나간다
  const sD = `db-recallfail-${sfx}`;
  const tD = writeTranscript(sD, eligible(`D${sfx}`));
  const rD = runHook("claude", { prompt: "지난번 배송비 바꾼 거 기억나? 그때 얼마로 했지", transcript_path: tD }, { MEMORY_CONFIG_PATH: envFile });
  assert.ok(ctx(rD.stdout).startsWith("⚠️ mcp-agents-memory 수집 확인"), rD.stdout);
  const lD = lastLog();
  assert.equal(lD.capture, "missing"); assert.ok(typeof lD.recallError === "string", JSON.stringify(lD));

  await client.query(`DELETE FROM memory WHERE external_uuid LIKE $1`, [`claude-code:db-%-${sfx}:%`]);
  await client.end();
  assert.ok(!fs.readFileSync(logFile, "utf8").includes("비밀"), "로그에 대화 내용이 남으면 안 된다");
  console.log("(DB 검사 통과)");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("hook capture checks passed");
