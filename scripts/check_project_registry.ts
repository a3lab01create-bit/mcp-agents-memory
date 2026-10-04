/**
 * project_registry 자체 검사 (합성 입력만).
 *
 *   npm run check:registry        # esbuild로 묶어서 실행
 */
import assert from "node:assert/strict";
import { isUndefinedColumn, parsePTagAnswer, registryCandidateLines, registryVerdict } from "../src/cold_path/project_registry.ts";

function check(name: string, fn: () => void) {
  fn();
  console.log(`✅ ${name}`);
}

const REGISTRY = new Set([10, 20]); // 10=marketadmin, 20=pacefy

check("답 나누기: 이름 / NEW: / 빈 값", () => {
  assert.deepEqual(parsePTagAnswer("MarketAdmin "), { type: "name", slug: "marketadmin" });
  assert.deepEqual(parsePTagAnswer("NEW: Foo-Bar"), { type: "new", name: "foo-bar" });
  assert.deepEqual(parsePTagAnswer("NEW:"), { type: "none" });
  assert.deepEqual(parsePTagAnswer(null), { type: "none" });
  assert.deepEqual(parsePTagAnswer("null"), { type: "none" }, "모델이 null을 문자열로 줄 때");
  assert.deepEqual(parsePTagAnswer(""), { type: "none" });
  assert.deepEqual(parsePTagAnswer(42), { type: "none" });
});

check("명부 이름은 받음", () => {
  assert.deepEqual(registryVerdict({ type: "name", slug: "marketadmin" }, 10, REGISTRY), { accept: 10, reason: "registry" });
});

check("명부 이름의 별칭(smartstore→marketadmin)은 정본으로 받음", () => {
  assert.deepEqual(registryVerdict({ type: "name", slug: "smartstore" }, 10, REGISTRY), { accept: 10, reason: "registry" });
});

check("명부 밖 옛 태그(verification)는 아직 있어도 안 받음", () => {
  assert.deepEqual(registryVerdict({ type: "name", slug: "verification" }, 108, REGISTRY), { accept: null, reason: "not_in_registry" });
});

check("없는 이름·NEW:·빈 답은 안 받음 (새 태그를 만들지 않음)", () => {
  assert.deepEqual(registryVerdict({ type: "name", slug: "made-up" }, null, REGISTRY), { accept: null, reason: "unknown_name" });
  assert.deepEqual(registryVerdict({ type: "new", name: "brand-new" }, null, REGISTRY), { accept: null, reason: "new_not_allowed" });
  assert.deepEqual(registryVerdict({ type: "new", name: "marketadmin" }, 10, REGISTRY), { accept: null, reason: "new_not_allowed" }, "NEW:로 명부 이름을 줘도 NEW는 NEW");
  assert.deepEqual(registryVerdict({ type: "none" }, null, REGISTRY), { accept: null, reason: "no_answer" });
});

check("후보 줄: 설명 있으면 '이름: 설명', 없으면 이름만", () => {
  assert.equal(
    registryCandidateLines([{ name: "pacefy", description: " 러닝 앱 " }, { name: "buzz", description: null }, { name: "x", description: "  " }]),
    "- pacefy: 러닝 앱\n- buzz\n- x"
  );
});

check("예전 방식으로 돌아가는 건 '칸 없음(42703)'일 때만 — 연결 끊김·잠금 대기는 아님", () => {
  assert.equal(isUndefinedColumn({ code: "42703" }), true);
  assert.equal(isUndefinedColumn({ code: "55P03" }), false, "잠금 대기");
  assert.equal(isUndefinedColumn({ code: "57P01" }), false, "서버 재시작");
  assert.equal(isUndefinedColumn(new Error("Connection terminated")), false);
  assert.equal(isUndefinedColumn(null), false);
});

console.log("\n모든 검사 통과");
