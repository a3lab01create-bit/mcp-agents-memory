/**
 * Claude Code 훅(`hook session-start | prompt | print-config`) 검사. DB·OpenAI 없이 돈다.
 *
 * 1) 순수 함수: 말 정리·건너뛰기·유사도 하한·중복 제거·길이 상한·설정 조각.
 * 2) 프로세스 계약: 빌드된 서버(build/index.js)를 실제로 띄워서, 실패해도 exit 0 이고
 *    stdout 이 비어 있는지(= 사용자의 말을 막거나 대화를 더럽히지 않는지), 시간 안에 끝나는지,
 *    로그에 말 내용이 안 남는지 본다. → 먼저 `npm run build`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOOK_CONTEXT_MAX_CHARS,
  capContext,
  cleanPromptForRecall,
  formatRecall,
  hookCommand,
  hookConfigSnippet,
  stableNodePath,
  pickRecallRows,
  recallSkipReason,
  type RecallRow,
  type RecallSettings,
} from "../src/hooks.js";

const S: RecallSettings = {
  minSimilarity: 0.5, limit: 3, minPromptChars: 8, minMemoryChars: 40, recentMinutes: 30, snippetChars: 50,
};

// ── 1. 말 정리 · 건너뛰기 ──
assert.equal(cleanPromptForRecall("  메타   수집기\n요청 제한 "), "메타 수집기 요청 제한");
assert.equal(
  cleanPromptForRecall("<system-reminder>숨은 글</system-reminder>배송비 바꾼 거 기억나?"),
  "배송비 바꾼 거 기억나?",
  "감싸개 안 글은 검색에 안 쓴다",
);
assert.equal(recallSkipReason("", S), "empty");
assert.equal(recallSkipReason(cleanPromptForRecall("<task-notification>작업 끝</task-notification>"), S), "empty",
  "작업 알림만 있는 말은 비어서 건너뛴다");
assert.equal(recallSkipReason("/deploy staging", S), "slash-command");
assert.equal(recallSkipReason("<new-message-arrived-while-you-were-working>", S), "wrapper");
assert.equal(recallSkipReason("ㅇㅋ", S), "short", "짧은 맞장구는 넣지 않는다 (실측: 'ㅇㅋ' 가 엉뚱한 줄과 0.886)");
assert.equal(recallSkipReason("메타 수집기 요청 제한 어떻게 됐어?", S), null);

// ── 2. 유사도 하한 · 중복 · 개수 ──
const row = (id: number, sim: number, message = `기록 ${id} — 충분히 긴 본문이 여기 들어간다고 치자`): RecallRow => ({
  id, role: id % 2 ? "user" : "assistant", message, created_at: new Date("2026-11-11T05:00:00Z"),
  p_tag_name: id === 2 ? "mcp-agents-memory" : null, similarity: sim,
});
const picked = pickRecallRows([row(1, 0.7), row(2, 0.65, "같은 글"), row(3, 0.6, "같은 글"), row(4, 0.55), row(5, 0.52), row(6, 0.4)], S);
assert.deepEqual(picked.map((r) => r.id), [1, 2, 4], "같은 글은 한 번만, 상위 3개까지");
assert.deepEqual(pickRecallRows([row(1, 0.49), row(2, 0.3)], S), [], "하한 아래면 아무것도 안 넣는다 (실측: 무관한 말 최고 0.42~0.47)");
assert.deepEqual(pickRecallRows([row(1, Number.NaN)], S), [], "유사도가 숫자가 아니면 버린다");

// ── 3. 넣는 글 모양 · 길이 ──
assert.equal(formatRecall([], S), "", "넣을 줄이 없으면 빈 글 → 훅 출력 없음");
const text = formatRecall([row(1, 0.7, "가".repeat(500)), row(2, 0.61)], S);
assert.match(text, /^mcp-agents-memory: 방금 말과 비슷한 지난 대화 기록이다\. 자동 검색 결과라/);
assert.match(text, /- #1 · \d{4}-\d{2}-\d{2} · 사용자 · 유사도 0\.70: 가{50}…$/m, "긴 본문은 snippetChars 에서 자른다");
assert.match(text, /- #2 · \d{4}-\d{2}-\d{2} · 에이전트 · mcp-agents-memory · 유사도 0\.61: /);
assert.ok(capContext("x".repeat(50_000)).length <= HOOK_CONTEXT_MAX_CHARS, "Claude Code 상한(10,000자) 아래로 자른다");
assert.ok(HOOK_CONTEXT_MAX_CHARS < 10_000);
assert.equal(capContext("짧은 글"), "짧은 글");

// ── 4. print-config 조각 ──
const snippet = JSON.parse(hookConfigSnippet("/opt/my tools/it's/index.js", "/home/u/.config/mcp-agents-memory/.env", "/usr/bin/node"));
const ss = snippet.hooks.SessionStart[0].hooks[0];
const ups = snippet.hooks.UserPromptSubmit[0].hooks[0];
assert.equal(ss.type, "command");
assert.match(ss.command, /hook session-start --client claude \|\| true$/, "훅 코드 밖 실패(모듈 불러오기)도 exit 0 으로");
assert.match(ups.command, /hook prompt --client claude \|\| true$/);
assert.ok(ups.command.startsWith("MEMORY_CONFIG_PATH='/home/u/.config/mcp-agents-memory/.env' "),
  "프로젝트 .env 가 다른 DB 를 가리켜도 같은 설정을 쓰게 경로를 박는다");
assert.ok(ups.command.includes(`'/opt/my tools/it'\\''s/index.js'`), "공백·작은따옴표 경로도 셸에서 안 깨진다");
assert.ok(ups.timeout >= 5 && ss.timeout >= 5);
assert.ok(!JSON.parse(hookConfigSnippet("/x/index.js", null)).hooks.UserPromptSubmit[0].hooks[0].command.includes("MEMORY_CONFIG_PATH"));
const relCmd = JSON.parse(hookConfigSnippet("rel/index.js", "./c.env")).hooks.UserPromptSubmit[0].hooks[0].command;
assert.ok(relCmd.includes(`MEMORY_CONFIG_PATH='${path.resolve("c.env")}'`) && relCmd.includes(`'${path.resolve("rel/index.js")}'`),
  "상대경로는 print-config 시점 기준 절대경로로 박는다 (코디 리뷰 #41-1)");

// ── 4b. 안 바뀌는 node 경로 (맥북 쿠우 지적: brew 버전 경로는 node 를 올리면 사라진다) ──
{
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), "mam-node-"));
  const cellarNode = path.join(fake, "Cellar", "node", "26.0.0", "bin", "node");
  fs.mkdirSync(path.dirname(cellarNode), { recursive: true });
  fs.writeFileSync(cellarNode, "");
  fs.mkdirSync(path.join(fake, "opt"), { recursive: true });
  fs.symlinkSync(path.join(fake, "Cellar", "node", "26.0.0"), path.join(fake, "opt", "node"));
  assert.equal(stableNodePath(cellarNode), path.join(fake, "opt", "node", "bin", "node"),
    "brew Cellar 경로는 같은 파일을 가리키는 opt 링크로 바꾼다");
  fs.rmSync(path.join(fake, "opt", "node"));
  fs.mkdirSync(path.join(fake, "Cellar", "node", "27.0.0", "bin"), { recursive: true });
  fs.writeFileSync(path.join(fake, "Cellar", "node", "27.0.0", "bin", "node"), "");
  fs.symlinkSync(path.join(fake, "Cellar", "node", "27.0.0"), path.join(fake, "opt", "node"));
  assert.equal(stableNodePath(cellarNode), cellarNode, "링크가 다른 파일을 가리키면 바꾸지 않는다");
  assert.equal(stableNodePath("/home/u/.nvm/versions/node/v24.15.0/bin/node"), "/home/u/.nvm/versions/node/v24.15.0/bin/node",
    "brew 가 아니면 그대로");
  fs.rmSync(fake, { recursive: true, force: true });
  const codexCmd = hookCommand("codex", "prompt", { entry: "/x/index.js", configPath: "/c/.env", node: "/usr/bin/node" });
  assert.equal(codexCmd, "MEMORY_CONFIG_PATH='/c/.env' '/usr/bin/node' '/x/index.js' hook prompt --client codex || true");
}

// ── 5. 프로세스 계약 (빌드된 서버로) ──
const entry = path.resolve("build/index.js");
assert.ok(fs.existsSync(entry), "build/index.js 가 없다 — 먼저 `npm run build`");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mam-hooks-"));
const deadEnv = path.join(tmp, "dead.env");
fs.writeFileSync(deadEnv, "DATABASE_URL=postgres://x:y@127.0.0.1:1/none\nOPENAI_API_KEY=sk-invalid\n");
const hangEnv = path.join(tmp, "hang.env");
fs.writeFileSync(hangEnv, "DATABASE_URL=postgres://x:y@10.255.255.1:5432/none\n");
const logFile = path.join(tmp, "hooks.log");
const SECRET_PROMPT = "비밀스러운 사용자 말 1234 — 로그에 남으면 안 된다";

function runHook(sub: string, stdin: string, env: Record<string, string>) {
  const t0 = Date.now();
  // 최소 환경으로 띄운다: 이 검사 프로세스가 읽어 둔 DATABASE_URL 등을 물려주면
  // (dotenv 는 이미 있는 값을 덮지 않으므로) 아래 MEMORY_CONFIG_PATH 가 무시된다.
  const r = spawnSync(process.execPath, [entry, "hook", sub], {
    input: stdin, encoding: "utf8", timeout: 20_000, cwd: tmp,
    env: { PATH: process.env.PATH ?? "", HOME: tmp, MEMORY_HOOK_LOG: logFile, ...env },
  });
  return { status: r.status, stdout: r.stdout, ms: Date.now() - t0 };
}
const promptIn = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: SECRET_PROMPT });

for (const [label, sub, stdin, env] of [
  ["DB 죽음 + 보통 말", "prompt", promptIn, { MEMORY_CONFIG_PATH: deadEnv }],
  ["DB 죽음 + 세션 시작", "session-start", JSON.stringify({ source: "startup" }), { MEMORY_CONFIG_PATH: deadEnv }],
  ["입력이 JSON 아님", "prompt", "not json", { MEMORY_CONFIG_PATH: deadEnv }],
  ["입력 없음", "prompt", "", { MEMORY_CONFIG_PATH: deadEnv }],
  ["꺼짐 스위치", "prompt", promptIn, { MEMORY_CONFIG_PATH: deadEnv, MEMORY_HOOKS_OFF: "1" }],
  ["모르는 하위 명령", "bogus", promptIn, { MEMORY_CONFIG_PATH: deadEnv }],
] as const) {
  const r = runHook(sub, stdin, env);
  assert.equal(r.status, 0, `${label}: exit 0 이어야 한다 (2 는 사용자의 말을 막는다)`);
  assert.equal(r.stdout, "", `${label}: stdout 은 비어야 한다`);
}

const hang = runHook("prompt", promptIn, { MEMORY_CONFIG_PATH: hangEnv, MEMORY_HOOK_PROMPT_DEADLINE_MS: "400" });
assert.equal(hang.status, 0, "DB 가 대답을 안 해도 exit 0");
assert.equal(hang.stdout, "");
assert.ok(hang.ms < 5_000, `deadline 에 끊겨야 한다 (실제 ${hang.ms}ms)`);

// 코디 리뷰 #41-1: 상대경로 설정으로 print-config → 다른 폴더에서 그 명령을 돌려도 처음 설정을 쓴다
const dirA = path.join(tmp, "A"), dirB = path.join(tmp, "B");
fs.mkdirSync(dirA); fs.mkdirSync(dirB);
fs.writeFileSync(path.join(dirA, "c.env"), "DATABASE_URL=postgres://x:y@127.0.0.1:1/a\nOPENAI_API_KEY=sk-invalid\n");
fs.writeFileSync(path.join(dirB, "c.env"), "DATABASE_URL=postgres://x:y@127.0.0.1:2/b\nOPENAI_API_KEY=sk-invalid\n");
const minimalEnv = (extraEnv: Record<string, string>) => ({ PATH: process.env.PATH ?? "", HOME: tmp, ...extraEnv });
const pc = spawnSync(process.execPath, [entry, "hook", "print-config"], {
  encoding: "utf8", cwd: dirA, env: minimalEnv({ MEMORY_CONFIG_PATH: "./c.env" }),
});
assert.equal(pc.status, 0);
const genCmd: string = JSON.parse(pc.stdout).hooks.UserPromptSubmit[0].hooks[0].command;
const relLog = path.join(tmp, "rel.log");
const gen = spawnSync("sh", ["-c", genCmd], {
  input: promptIn, encoding: "utf8", cwd: dirB, env: minimalEnv({ MEMORY_HOOK_LOG: relLog }),
});
assert.equal(gen.status, 0);
assert.equal(gen.stdout, "");
const relText = fs.readFileSync(relLog, "utf8");
assert.ok(relText.includes("127.0.0.1:1") && !relText.includes("127.0.0.1:2"),
  `다른 폴더에서도 print-config 때의 설정(A, port 1)을 써야 한다 (log: ${relText.trim()})`);

// 코디 리뷰 #41-2: 설정 파일을 못 읽으면 db.ts import 에서 죽어 exit 1 이던 것
if (process.getuid?.() !== 0) {
  const locked = path.join(tmp, "locked.env");
  fs.writeFileSync(locked, "DATABASE_URL=postgres://x:y@127.0.0.1:1/none\n");
  fs.chmodSync(locked, 0o000);
  for (const [sub, extraEnv] of [
    ["prompt", {}], ["session-start", {}], ["prompt", { MEMORY_HOOKS_OFF: "1" }],
  ] as const) {
    const r = runHook(sub, promptIn, { MEMORY_CONFIG_PATH: locked, ...extraEnv });
    assert.equal(r.status, 0, `읽을 수 없는 설정 + ${sub} ${JSON.stringify(extraEnv)}: exit 0`);
    assert.equal(r.stdout, "");
  }
  // 코디 재검토: 읽을 수 없는 설정 + 환경변수에 남은 DATABASE_URL → 훅은 그 DB 에 붙지 않고 끝난다
  const inherited = "postgres://x:y@127.0.0.1:3/inherited";
  const inhLog = path.join(tmp, "inherited.log");
  const inh = runHook("prompt", promptIn, { MEMORY_CONFIG_PATH: locked, DATABASE_URL: inherited, MEMORY_HOOK_LOG: inhLog });
  assert.equal(inh.status, 0);
  assert.equal(inh.stdout, "");
  const inhText = fs.readFileSync(inhLog, "utf8");
  assert.ok(/"outcome":"error"/.test(inhText) && /config: /.test(inhText) && !inhText.includes("127.0.0.1:3"),
    `설정 오류로 DB 연결 전에 끝나야 한다 (log: ${inhText.trim()})`);
  // 훅이 아닌 명령(migrate)은 예전처럼 import 에서 멈춘다 — 상속 DATABASE_URL 로 마이그레이션하면 안 된다
  const mig = spawnSync(process.execPath, [entry, "migrate"], {
    encoding: "utf8", timeout: 20_000, cwd: tmp,
    env: { PATH: process.env.PATH ?? "", HOME: tmp, MEMORY_CONFIG_PATH: locked, DATABASE_URL: inherited },
  });
  assert.notEqual(mig.status, 0, "migrate 는 실패로 끝나야 한다");
  assert.ok(/EACCES|permission denied/i.test(mig.stderr) && !mig.stderr.includes("127.0.0.1:3"),
    `migrate 는 DB 에 붙기 전에(설정 읽기에서) 멈춰야 한다 (stderr 끝: ${mig.stderr.slice(-300)})`);
  // print-config 는 사람이 치는 명령 — 실패를 그대로 알린다
  const pcLocked = spawnSync(process.execPath, [entry, "hook", "print-config"], {
    encoding: "utf8", cwd: tmp, env: { PATH: process.env.PATH ?? "", HOME: tmp, MEMORY_CONFIG_PATH: locked },
  });
  assert.equal(pcLocked.status, 1);
  assert.equal(pcLocked.stdout, "", "읽을 수 없는 설정으로는 조각을 만들지 않는다");
  fs.chmodSync(locked, 0o600);
} else {
  console.log("(root 로 돌아서 읽기 권한 검사는 건너뜀)");
}

// 마지막 방어선: 서버 파일 자체가 없어 node 가 죽어도 생성 명령은 exit 0 · stdout 비어 있음
const missingCmd: string = JSON.parse(hookConfigSnippet(path.join(tmp, "missing", "index.js"), null))
  .hooks.UserPromptSubmit[0].hooks[0].command;
const guarded = spawnSync("sh", ["-c", missingCmd], { input: promptIn, encoding: "utf8", cwd: tmp, env: minimalEnv({}) });
assert.equal(guarded.status, 0, "`|| true` 가 있으면 exit 0");
assert.equal(guarded.stdout, "");
const unguarded = spawnSync("sh", ["-c", missingCmd.replace(/ \|\| true$/, "")], { input: promptIn, encoding: "utf8", cwd: tmp, env: minimalEnv({}) });
assert.notEqual(unguarded.status, 0, "음성대조: `|| true` 를 빼면 실패가 그대로 드러난다");

const log = fs.readFileSync(logFile, "utf8");
const outcomes = log.trim().split("\n").map((l) => JSON.parse(l).outcome);
assert.ok(outcomes.includes("error") && outcomes.includes("timeout") && outcomes.includes("off"),
  `호출마다 결과가 한 줄씩 남는다 (got ${JSON.stringify(outcomes)})`);
assert.ok(!log.includes("비밀스러운"), "로그에 사용자의 말이 남으면 안 된다");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("hook checks passed");
