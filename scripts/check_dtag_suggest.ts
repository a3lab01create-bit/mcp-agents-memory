/**
 * dtag_suggest_gate 자체 검사 (합성 입력만).
 *
 *   npm run check:dtag        # esbuild로 묶어서 실행
 */
import assert from "node:assert/strict";
import {
  normalizeClusters,
  parseRecommendation,
  planApplyRecommendations,
  type PendingForApply,
} from "../src/cold_path/dtag_suggest_gate.ts";

function check(name: string, fn: () => void) {
  fn();
  console.log(`✅ ${name}`);
}

const freq = new Map<string, number>([
  ["bug", 18],
  ["fix", 21],
  ["code-review", 155],
  ["cafe24", 24],
  ["cafe24-api", 61],
  ["yt-viral-signal", 6],
  ["yt-signal-finder", 5],
]);
const byName = (clusters: ReturnType<typeof normalizeClusters>) =>
  Object.fromEntries(clusters.map((c) => [c.canonical, { members: [...c.members].sort(), total: c.total }]));

check("지어낸 대표 이름은 버리고, 그 멤버는 각자 단독 클러스터로 남김", () => {
  const out = byName(normalizeClusters([{ canonical: "bug-fix-code-review", members: ["bug", "fix", "code-review"] }], freq));
  assert.equal(out["bug-fix-code-review"], undefined, "실측 합성어(565회로 승격됐던 이름)");
  assert.deepEqual(out["bug"], { members: ["bug"], total: 18 });
  assert.deepEqual(out["code-review"], { members: ["code-review"], total: 155 });
});

check("실제 d_tag를 대표로 고른 클러스터는 합산 (원래 목적: 같은 프로젝트의 갈래 이름)", () => {
  const out = byName(normalizeClusters([{ canonical: "yt-signal-finder", members: ["yt-viral-signal"] }], freq));
  assert.deepEqual(out["yt-signal-finder"], { members: ["yt-signal-finder", "yt-viral-signal"], total: 11 }, "대표 이름은 멤버에 빠져 있어도 넣음");
  assert.equal(out["yt-viral-signal"], undefined);
});

check("입력에 없는 멤버는 버리고, 대소문자·앞뒤 공백은 정규화 (가운데 공백은 그대로 — 저장된 d_tag와 같게)", () => {
  const out = byName(normalizeClusters([{ canonical: " Cafe24 ", members: ["CAFE24-API", "made-up-tag"] }], freq));
  assert.deepEqual(out["cafe24"], { members: ["cafe24", "cafe24-api"], total: 85 });
});

check("한 d_tag는 한 클러스터에만 (먼저 나온 쪽) — 합산이 부풀지 않음", () => {
  const out = byName(normalizeClusters([
    { canonical: "cafe24-api", members: ["cafe24"] },
    { canonical: "cafe24", members: ["fix"] },
  ], freq));
  assert.deepEqual(out["cafe24-api"], { members: ["cafe24", "cafe24-api"], total: 85 });
  assert.equal(out["cafe24"], undefined, "이미 앞 클러스터 멤버인 이름은 대표가 못 됨");
  assert.deepEqual(out["fix"], { members: ["fix"], total: 21 }, "버려진 클러스터의 멤버는 단독으로");
  const totalUses = Object.values(out).reduce((sum, c) => sum + c.total, 0);
  assert.equal(totalUses, [...freq.values()].reduce((a, b) => a + b, 0), "모든 사용 횟수를 정확히 한 번씩");
});

check("같은 대표가 두 번 나오면 합침", () => {
  const out = byName(normalizeClusters([
    { canonical: "cafe24", members: ["cafe24"] },
    { canonical: "cafe24", members: ["cafe24-api"] },
  ], freq));
  assert.deepEqual(out["cafe24"], { members: ["cafe24", "cafe24-api"], total: 85 });
});

check("이미 있는 프로젝트 태그는 남의 멤버가 못 되고 자기 대표로 남음", () => {
  const out = byName(normalizeClusters([{ canonical: "cafe24-api", members: ["cafe24", "fix"] }], freq, { reserved: new Set(["cafe24"]) }));
  assert.deepEqual(out["cafe24-api"], { members: ["cafe24-api", "fix"], total: 82 });
  assert.deepEqual(out["cafe24"], { members: ["cafe24"], total: 24 }, "기존 태그는 자기 클러스터로 → 소급 경로");
  const own = byName(normalizeClusters([{ canonical: "cafe24", members: ["cafe24-api"] }], freq, { reserved: new Set(["cafe24"]) }));
  assert.deepEqual(own["cafe24"], { members: ["cafe24", "cafe24-api"], total: 85 }, "기존 태그가 대표인 건 그대로");
});

check("반려된 이름: 대표면 클러스터를 풀어 멤버를 살리고, 자기는 어디에도 안 들어감", () => {
  const rejected = new Set(["cafe24-api"]);
  const out = byName(normalizeClusters([{ canonical: "cafe24-api", members: ["cafe24"] }], freq, { rejected }));
  assert.equal(out["cafe24-api"], undefined, "반려된 이름은 단독으로도 안 남음 (다른 길로 태그가 됐어도 소급 안 돌게)");
  assert.deepEqual(out["cafe24"], { members: ["cafe24"], total: 24 }, "반려한 cafe24-api가 cafe24를 가리지 않음");
  const asMember = byName(normalizeClusters([{ canonical: "cafe24", members: ["cafe24-api"] }], freq, { rejected }));
  assert.deepEqual(asMember["cafe24"], { members: ["cafe24"], total: 24 }, "멤버로도 안 들어감");
});

check("클러스터러가 이상한 값을 줘도 터지지 않음", () => {
  const out = normalizeClusters([null as any, 3 as any, { canonical: "bug", members: null as any }], freq);
  assert.equal(out.length, freq.size);
  assert.deepEqual(byName(normalizeClusters("x" as any, freq))["bug"], { members: ["bug"], total: 18 });
});

check("클러스터러 실패(빈 출력): 모든 입력이 단독 클러스터", () => {
  const out = normalizeClusters([], freq);
  assert.equal(out.length, freq.size);
  assert.ok(out.every((c) => c.members.length === 1 && c.members[0] === c.canonical));
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
