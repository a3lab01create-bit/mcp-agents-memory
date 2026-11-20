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
  hookConfigSnippet,
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
const snippet = JSON.parse(hookConfigSnippet("/opt/my tools/it's/index.js", "/home/u/.config/mcp-agents-memory/.env"));
const ss = snippet.hooks.SessionStart[0].hooks[0];
const ups = snippet.hooks.UserPromptSubmit[0].hooks[0];
assert.equal(ss.type, "command");
assert.match(ss.command, /hook session-start$/);
assert.match(ups.command, /hook prompt$/);
assert.ok(ups.command.startsWith("MEMORY_CONFIG_PATH='/home/u/.config/mcp-agents-memory/.env' "),
  "프로젝트 .env 가 다른 DB 를 가리켜도 같은 설정을 쓰게 경로를 박는다");
assert.ok(ups.command.includes(`'/opt/my tools/it'\\''s/index.js'`), "공백·작은따옴표 경로도 셸에서 안 깨진다");
assert.ok(ups.timeout >= 5 && ss.timeout >= 5);
assert.ok(!JSON.parse(hookConfigSnippet("/x/index.js", null)).hooks.UserPromptSubmit[0].hooks[0].command.includes("MEMORY_CONFIG_PATH"));

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

const log = fs.readFileSync(logFile, "utf8");
const outcomes = log.trim().split("\n").map((l) => JSON.parse(l).outcome);
assert.ok(outcomes.includes("error") && outcomes.includes("timeout") && outcomes.includes("off"),
  `호출마다 결과가 한 줄씩 남는다 (got ${JSON.stringify(outcomes)})`);
assert.ok(!log.includes("비밀스러운"), "로그에 사용자의 말이 남으면 안 된다");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("hook checks passed");
