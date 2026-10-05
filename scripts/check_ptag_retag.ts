/**
 * retag-ptag 판단부 자체 검사 (합성 입력만 — DB·모델 없음).
 *
 *   npm run check:retag        # esbuild로 묶어서 실행
 */
import assert from "node:assert/strict";
import {
  decidedIds,
  formatDuration,
  isContextOverflow,
  parseRetagArgs,
  percentile,
  replayLog,
  rollbackPlan,
  transitionCounts,
  type LogEntry,
} from "../src/cold_path/ptag_retag_plan.ts";
import { getPrompt, promptSource } from "../src/prompts/index.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function check(name: string, fn: () => void) {
  fn();
  console.log(`✅ ${name}`);
}

const at = "2026-10-11T00:00:00.000Z";
const line = (e: Partial<LogEntry> & { id: number; result: LogEntry["result"] }) =>
  JSON.stringify({ mode: "stale", old: 20, new: 1, at, ...e });

check("옵션: 기본은 두 대상 모두·30일·한 칸·쓰기", () => {
  const o = parseRetagArgs([]);
  assert.equal(o.stale, true);
  assert.equal(o.untaggedDays, 30);
  assert.equal(o.concurrency, 1);
  assert.equal(o.dryRun || o.count || o.rollback || o.sample || o.allowFallback, false);
  assert.equal(o.before, null, "상한은 명부 생긴 시각을 DB에서 읽는다");
});

check("옵션: 대상 하나만 고르기·숫자·시각", () => {
  assert.equal(parseRetagArgs(["--only", "stale"]).untaggedDays, null);
  assert.equal(parseRetagArgs(["--only", "untagged"]).stale, false);
  const o = parseRetagArgs(["--dry-run", "--max", "100", "--sample", "--concurrency", "2", "--untagged-days", "7", "--before", "2026-10-04T15:28:12+09:00"]);
  assert.equal(o.max, 100);
  assert.equal(o.concurrency, 2);
  assert.equal(o.untaggedDays, 7);
  assert.equal(o.before, "2026-10-04T06:28:12.000Z");
});

check("옵션: 잘못된 입력은 거절", () => {
  assert.throws(() => parseRetagArgs(["--bogus"]), /모르는 옵션/);
  assert.throws(() => parseRetagArgs(["--max", "0"]), /1 이상/);
  assert.throws(() => parseRetagArgs(["--max", "-3"]), /1 이상/);
  assert.throws(() => parseRetagArgs(["--max"]), /1 이상/);
  assert.throws(() => parseRetagArgs(["--concurrency", "5"]), /1~4/);
  assert.throws(() => parseRetagArgs(["--only", "both"]), /stale 또는 untagged/);
  assert.throws(() => parseRetagArgs(["--before", "어제"]), /ISO/);
  assert.throws(() => parseRetagArgs(["--count", "--rollback"]), /같이 못 씀/);
  assert.throws(() => parseRetagArgs(["--rollback", "--sample"]), /전체를 되돌린다/);
  assert.throws(() => parseRetagArgs(["--rollback", "--max", "5"]), /전체를 되돌린다/);
});

check("옵션: --venue는 그 채널만 (a)(b) 끄고, --only와는 같이 못 씀", () => {
  const o = parseRetagArgs(["--venue", "buzz:MDs_copy_db", "--dry-run"]);
  assert.equal(o.venue, "buzz:MDs_copy_db");
  assert.equal(o.stale, false);
  assert.equal(o.untaggedDays, null);
  assert.throws(() => parseRetagArgs(["--venue", "buzz:X", "--only", "stale"]), /같이 못 씀/);
  assert.throws(() => parseRetagArgs(["--venue"]), /글이 온 자리/);
  assert.throws(() => parseRetagArgs(["--venue", "has space"]), /글이 온 자리/);
  assert.equal(parseRetagArgs([]).venue, null);
});

check("옵션: --hold-new는 여러 번·쉼표 둘 다, 소문자로, 빈 값·--rollback과는 거절", () => {
  assert.deepEqual(parseRetagArgs([]).holdNew, []);
  assert.deepEqual(parseRetagArgs(["--hold-new", "MCP-Agents-Memory", "--hold-new", "buzz,pacefy", "--hold-new", "buzz"]).holdNew, ["mcp-agents-memory", "buzz", "pacefy"]);
  assert.throws(() => parseRetagArgs(["--hold-new"]), /명부 태그 이름/);
  assert.throws(() => parseRetagArgs(["--hold-new", " , "]), /명부 태그 이름/);
  assert.throws(() => parseRetagArgs(["--rollback", "--hold-new", "buzz"]), /같이 못 씀/);
});

check("보류(held)는 결정이 아니다 — 다음 실행 때 다시 판정하고, 되돌리기 대상도 아니다", () => {
  const { latest } = replayLog([
    line({ id: 21, result: "held", old: 20, new: 1 }),
    line({ id: 22, result: "updated", old: 20, new: 3 }),
    line({ id: 23, result: "held", old: null, new: 1 }),
    line({ id: 23, result: "same", old: null, new: null }),
  ]);
  assert.deepEqual([...decidedIds(latest)].sort(), [22, 23]);
  assert.deepEqual(rollbackPlan(latest), [{ id: 22, from: 3, to: 20 }]);
  assert.deepEqual(transitionCounts([...latest.values()]).map(([k]) => k).sort(), ["#20 → #3", "(none) → (none)"]);
});

check("되돌리기 범위 --since: 그 시각 이후에 쓴 것만, --rollback 없이는 거절", () => {
  const { latest } = replayLog([
    line({ id: 31, result: "updated", old: 20, new: 1, at: "2026-10-06T10:00:00.000Z" }),
    line({ id: 32, result: "updated", old: 20, new: 2, at: "2026-10-11T13:00:00.000Z" }),
    line({ id: 33, result: "updated", old: null, new: 3, at: "2026-10-11T14:00:00.000Z" }),
  ]);
  assert.deepEqual(rollbackPlan(latest, "2026-10-11T22:00:00+09:00").map((p) => p.id), [32, 33]);
  assert.deepEqual(rollbackPlan(latest).map((p) => p.id), [31, 32, 33], "범위 없으면 전부");
  assert.equal(parseRetagArgs(["--rollback", "--since", "2026-10-11T22:00:00+09:00"]).since, "2026-10-11T13:00:00.000Z");
  assert.throws(() => parseRetagArgs(["--since", "2026-10-11T22:00:00+09:00"]), /--rollback 범위/);
  assert.throws(() => parseRetagArgs(["--rollback", "--since", "어제"]), /ISO/);
});

check("기록 다시 읽기: 같은 행은 마지막 줄이 이김, 깨진 줄은 세고 넘어감", () => {
  const { latest, malformed } = replayLog([
    line({ id: 1, result: "error" }),
    line({ id: 1, result: "updated" }),
    "",
    "{not json",
    JSON.stringify({ result: "updated" }),
    line({ id: 2, result: "same", old: null, new: null }),
  ]);
  assert.equal(latest.get(1)?.result, "updated");
  assert.equal(latest.size, 2);
  assert.equal(malformed, 2);
});

check("재개: 결정된 행만 건너뛰고 오류·되돌린 행은 다시 시도", () => {
  const { latest } = replayLog([
    line({ id: 1, result: "updated" }),
    line({ id: 2, result: "same" }),
    line({ id: 3, result: "conflict" }),
    line({ id: 4, result: "error" }),
    line({ id: 5, result: "updated" }),
    line({ id: 5, result: "rolledback", mode: "rollback" }),
    line({ id: 6, result: "rollback_conflict", mode: "rollback" }),
  ]);
  assert.deepEqual([...decidedIds(latest)].sort(), [1, 2, 3, 6]);
});

check("되돌리기 계획: 마지막이 updated인 행만 새 값 → 옛 값", () => {
  const { latest } = replayLog([
    line({ id: 7, result: "updated", old: 20, new: 1 }),
    line({ id: 8, result: "updated", old: null, new: 3 }),
    line({ id: 9, result: "updated", old: 20, new: null }),
    line({ id: 9, result: "rolledback", mode: "rollback", old: null, new: 20 }),
    line({ id: 10, result: "same", old: null, new: null }),
  ]);
  assert.deepEqual(rollbackPlan(latest), [
    { id: 7, from: 1, to: 20 },
    { id: 8, from: 3, to: null },
  ]);
});

check("바뀐 모양 집계: 이름으로, 무태그는 (none), 오류·충돌은 안 셈", () => {
  const e = (id: number, result: LogEntry["result"], oldName: string | null, newName: string | null, oldId: number | null, newId: number | null): LogEntry =>
    ({ id, mode: "stale", old: oldId, new: newId, result, at, oldName, newName });
  const t = transitionCounts([
    e(1, "updated", "fresh-neon-db", "mcp-agents-memory", 20, 1),
    e(2, "updated", "fresh-neon-db", "mcp-agents-memory", 20, 1),
    e(3, "updated", "fresh-neon-db", null, 20, null),
    e(4, "same", null, null, null, null),
    e(5, "error", "fresh-neon-db", null, 20, null),
    e(6, "conflict", "verification", "buzz", 30, 9),
  ]);
  assert.deepEqual(t, [
    ["fresh-neon-db → mcp-agents-memory", 2],
    ["(none) → (none)", 1],
    ["fresh-neon-db → (none)", 1],
  ]);
});

check("시간 계산", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5, 1, 3], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(formatDuration(37 * 3600 + 10 * 60), "37h 10m");
  assert.equal(formatDuration(90), "2m");
  assert.equal(formatDuration(NaN), "?");
});

check("입력이 문맥 크기를 넘은 오류만 따로 센다 (서버 고장은 연속 오류)", () => {
  assert.ok(isContextOverflow("400 the request exceeds the available context size, try increasing it"));
  assert.ok(isContextOverflow("This model's maximum context length is 8192 tokens"));
  assert.ok(!isContextOverflow("connect ECONNREFUSED 127.0.0.1:8080"));
  assert.ok(!isContextOverflow("Tagger returned invalid JSON: {"));
});

check("안내문 출처: MEMORY_PROMPTS_DIR이면 env, 없으면 generic, 빈 파일은 없는 것", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retag-prompt-"));
  const prev = process.env.MEMORY_PROMPTS_DIR;
  try {
    fs.writeFileSync(path.join(dir, "zz_check_present.md"), "TUNED\n");
    fs.writeFileSync(path.join(dir, "zz_check_blank.md"), "  \n");
    process.env.MEMORY_PROMPTS_DIR = dir;
    assert.equal(promptSource("zz_check_present"), "env");
    assert.equal(getPrompt("zz_check_present", "GENERIC"), "TUNED", "getPrompt도 같은 파일을 쓴다");
    assert.equal(promptSource("zz_check_blank"), "generic");
    assert.equal(getPrompt("zz_check_blank", "GENERIC"), "GENERIC");
    assert.equal(promptSource("zz_check_absent"), "generic");
  } finally {
    if (prev === undefined) delete process.env.MEMORY_PROMPTS_DIR;
    else process.env.MEMORY_PROMPTS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log("all checks passed");
