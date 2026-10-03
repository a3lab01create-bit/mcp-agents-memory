/**
 * dtag_suggest_gate 자체 검사 (합성 입력만).
 *
 *   npm run check:dtag        # esbuild로 묶어서 실행
 */
import assert from "node:assert/strict";
import {
  normalizeTag,
  parseRecommendation,
  planApplyRecommendations,
  type PendingForApply,
} from "../src/cold_path/dtag_suggest_gate.ts";

function check(name: string, fn: () => void) {
  fn();
  console.log(`✅ ${name}`);
}

check("이름 정규화는 저장된 d_tag와 같게: 소문자·앞뒤 공백만 (가운데 공백·하이픈 그대로)", () => {
  assert.equal(normalizeTag(" Cafe24 "), "cafe24");
  assert.equal(normalizeTag("Keto Booster"), "keto booster");
  assert.equal(normalizeTag("yt-signal-finder"), "yt-signal-finder");
  assert.equal(normalizeTag(undefined), "");
});

check("추천 값은 세 가지만", () => {
  assert.equal(parseRecommendation("project"), "project");
  assert.equal(parseRecommendation("unsure"), "unsure");
  assert.equal(parseRecommendation("Project"), null);
  assert.equal(parseRecommendation(undefined), null);
});

check("추천대로: project=승인, generic=반려, unsure·추천 없음=그대로, 끝났거나 없는 번호=건너뜀", () => {
  const rows: PendingForApply[] = [
    { id: 1, status: "pending", recommendation: "project" },
    { id: 2, status: "pending", recommendation: "generic" },
    { id: 3, status: "pending", recommendation: "unsure" },
    { id: 4, status: "pending", recommendation: null },
    { id: 5, status: "rejected", recommendation: "generic" },
    { id: 6, status: "pending", recommendation: "generic" },
  ];
  const plan = planApplyRecommendations([1, 2, 3, 4, 5, 9, 2], rows);
  assert.deepEqual(plan, { confirm: [1], reject: [2], keep: [3, 4], skipped: [5, 9] });
  assert.ok(!plan.reject.includes(6), "보여 주지 않은 번호(6)는 추천이 generic이어도 안 건드림");
});

console.log("\n모든 검사 통과");
