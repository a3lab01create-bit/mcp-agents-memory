/**
 * project_registry 자체 검사 (합성 입력만).
 *
 *   npm run check:registry        # esbuild로 묶어서 실행
 */
import assert from "node:assert/strict";
import { HINT_CHANNELS_MAX, isUndefinedColumn, parsePTagAnswer, registryCandidateLines, registryHintLine, registryVerdict, validateHintChannels } from "../src/cold_path/project_registry.ts";

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

check("채널 힌트: 버즈 채널만, 공용 자리는 거절, 중복은 하나로", () => {
  assert.deepEqual(validateHintChannels(["buzz:MarketDev", " buzz:MDs_copy_db ", "buzz:MarketDev"]), { ok: ["buzz:MarketDev", "buzz:MDs_copy_db"] });
  assert.deepEqual(validateHintChannels([]), { ok: [] }, "빈 목록 = 지우기");
  for (const bad of ["buzz:general", "buzz:dm", "buzz:welcome-everyone"]) assert.ok("error" in validateHintChannels([bad]), bad);
  for (const bad of ["terminal", "slack", "buzz:", "buzz:has space", "MarketDev", 42]) assert.ok("error" in validateHintChannels([bad]), String(bad));
  assert.ok("error" in validateHintChannels("buzz:MarketDev"), "목록이 아님");
  assert.ok("error" in validateHintChannels(Array.from({ length: HINT_CHANNELS_MAX + 1 }, (_, i) => `buzz:c${i}`)), "너무 많음");
});

check("채널 힌트 줄: 채널·프로젝트 이름이 들어가고, 다른 프로젝트·무관한 글은 예외로 둔다", () => {
  const line = registryHintLine("buzz:MDs_copy_db", { name: "md-copy-db" });
  assert.ok(line.includes("buzz:MDs_copy_db") && line.includes('"md-copy-db"'));
  assert.ok(/unless the message is clearly about a different listed project/.test(line));
  assert.ok(!line.includes("\n"), "한 줄");
});

console.log("\n모든 검사 통과");
