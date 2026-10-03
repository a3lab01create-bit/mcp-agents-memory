/**
 * alias_reject_gate 자체 검사 (합성 행만).
 *
 *   npm run check:alias        # esbuild로 묶어서 실행
 */
import assert from "node:assert/strict";
import {
  groupPairHistory,
  pairKey,
  repeatsToSweep,
  skipBeforeJudge,
  userRejectedDirection,
  type PairHistoryRow,
} from "../src/cold_path/alias_reject_gate.ts";

const S = 10;
const T = 20;
const day = (d: number) => new Date(Date.UTC(2026, 9, d));
let nextId = 1;
const row = (over: Partial<PairHistoryRow>): PairHistoryRow => ({
  id: nextId++,
  sourceId: S,
  targetId: T,
  status: "pending",
  decidedBy: null,
  decidedAt: day(1),
  createdAt: day(1),
  manual: false,
  ...over,
});
const userRejected = (over: Partial<PairHistoryRow> = {}) => row({ status: "rejected", decidedBy: "user", decidedAt: day(3), ...over });

function check(name: string, fn: () => void) {
  fn();
  console.log(`✅ ${name}`);
}

check("이력 없음: 막지 않음", () => {
  assert.equal(skipBeforeJudge(undefined), false);
  assert.equal(userRejectedDirection(undefined, S, T), null);
  assert.deepEqual(repeatsToSweep(undefined), []);
});

check("사람이 반려: 같은 방향만 막고, 반대 방향은 판정 기회 한 번", () => {
  const r = userRejected();
  const rows = [r];
  assert.equal(userRejectedDirection(rows, S, T), r.id);
  assert.equal(userRejectedDirection(rows, T, S), null, "반대 방향은 막지 않음");
  assert.equal(skipBeforeJudge(rows), false, "반려 뒤 아직 판정 안 함 → 한 번은 판정");
});

check("반려 뒤 한 번 기회를 쓰면(행이 생기면) 판정 전에 뺌", () => {
  const r = userRejected();
  assert.equal(skipBeforeJudge([r, row({ status: "rejected", decidedBy: "system", createdAt: day(4), decidedAt: day(4) })]), true, "반복 기록");
  assert.equal(skipBeforeJudge([r, row({ sourceId: T, targetId: S, createdAt: day(4) })]), true, "반대 방향이 대기 중");
  assert.equal(skipBeforeJudge([r, row({ status: "superseded", decidedBy: "system", createdAt: day(2), decidedAt: day(3) })]), false, "반려 전에 생긴 행은 기회로 안 침");
});

check("반대 방향 기회를 쓴 뒤 사람이 다시 반려하면 기회가 다시 생김 (가장 최근 반려 기준)", () => {
  const first = userRejected({ decidedAt: day(3) });
  const used = row({ status: "rejected", decidedBy: "system", createdAt: day(4), decidedAt: day(4) });
  assert.equal(skipBeforeJudge([first, used]), true);
  assert.equal(skipBeforeJudge([first, used, userRejected({ decidedAt: day(6) })]), false);
});

check("양방향 다 사람이 반려: 판정 전에 뺌", () => {
  assert.equal(skipBeforeJudge([userRejected(), userRejected({ sourceId: T, targetId: S })]), true);
});

check("시스템이 스스로 반려(순환 등): 막지 않음", () => {
  const rows = [row({ status: "rejected", decidedBy: "system", decidedAt: day(3) })];
  assert.equal(userRejectedDirection(rows, S, T), null);
  assert.equal(skipBeforeJudge(rows), false);
});

check("반려 방향을 되풀이하는 대기 제안만 닫음 (반대 방향 대기는 그대로)", () => {
  const r = userRejected();
  const same = row({ createdAt: day(4) });
  const reverse = row({ sourceId: T, targetId: S, createdAt: day(4) });
  assert.deepEqual(repeatsToSweep([r, same]), [{ pendingId: same.id, rejectedId: r.id }]);
  assert.deepEqual(repeatsToSweep([r, reverse]), []);
  assert.deepEqual(repeatsToSweep([r, row({ createdAt: day(4), decidedBy: "user", manual: true })]), [], "사람이 set_alias로 건 행은 안 닫음");
});

check("같은 방향을 여러 번 반려했으면 가장 최근 반려를 가리킴", () => {
  const older = userRejected({ decidedAt: day(2) });
  const newer = userRejected({ decidedAt: day(5) });
  assert.equal(userRejectedDirection([newer, older], S, T), newer.id);
});

check("실례 재현: pacefy→pacefy-e2503 반려 뒤 반대 방향 제안은 올라올 수 있음", () => {
  const PACEFY = 1;
  const E2503 = 2;
  const rows = [userRejected({ sourceId: PACEFY, targetId: E2503 })];
  assert.equal(skipBeforeJudge(rows), false);
  assert.equal(userRejectedDirection(rows, E2503, PACEFY), null);
});

check("쌍 묶기: 방향 무관하게 한 쌍, 정본이 같아진 행은 버림", () => {
  const a = row({});
  const b = row({ sourceId: T, targetId: S });
  const merged = row({ sourceId: S, targetId: S });
  const g = groupPairHistory([a, b, merged]);
  assert.equal(g.size, 1);
  assert.deepEqual(g.get(pairKey(S, T))?.map((r) => r.id), [a.id, b.id]);
  assert.equal(pairKey(S, T), pairKey(T, S));
});

console.log("all checks passed");
