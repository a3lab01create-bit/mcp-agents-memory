/**
 * alias_candidate_gates 자체 검사 (합성 예시만 — 실제 대화 넣지 말 것).
 *
 *   npm run check:alias-evidence        # esbuild로 묶어서 실행
 *
 * 핵심은 **양성 대조**다: 봉투를 벗기면 죽어야 하는 글과, 벗겨도 살아야 하는 진짜 발언을
 * 같은 모양으로 둘 다 심어서, 검사기가 그 차이를 실제로 본다는 걸 먼저 확인한다.
 * 봉투 예시는 cleanBuzzEnvelope 를 실제로 돌려서 만든다 — 손으로 쓴 모양이 DB 저장 모양과
 * 어긋나면 "안 걸렸다"가 통과로 보이기 때문이다.
 */
import assert from "node:assert/strict";
import {
  bothInRegistry,
  containsExplicitPhrase,
  explicitEvidence,
  isRegistryTag,
  messageMentionsTag,
  EXPLICIT_LIKE_PATTERNS,
  EXPLICIT_PHRASES,
} from "../src/cold_path/alias_candidate_gates.ts";
import { cleanBuzzEnvelope } from "../src/auto_save/buzz_envelope.ts";

const HEX = "a".repeat(64);
const TAGS = [
  { id: 1, name: "mcp-agents-memory" },
  { id: 2, name: "marketadmin" },
  { id: 3, name: "smartstore" },
];

function check(name: string, fn: () => void) {
  fn();
  console.log(`✅ ${name}`);
}

/** MarketDev 채널에서 온 버즈 턴 한 줄 — 저장 본문은 cleanBuzzEnvelope 를 거친 모양이다. */
function buzzTurn(body: string): string {
  const raw = [
    "<base>",
    "You are an agent operating inside Buzz.",
    "</base>",
    "<context>",
    "Scope: thread",
    "Channel: MarketDev (#00000000-0000-0000-0000-000000000000)",
    "Project: Market Admin",
    "Project slug: marketadmin",
    "</context>",
    '<buzz-event type="@mention">',
    `Event ID: ${HEX}`,
    "From: Owner",
    `Content: ${body}`,
    `Parsed: mentions=[Agent (${HEX})]`,
    "</buzz-event>",
  ].join("\n");
  const stored = cleanBuzzEnvelope(raw);
  assert.ok(stored !== null, "예시가 봉투로 인식돼야 한다 — 아니면 아래 검사가 헛돈다");
  assert.ok(stored.includes("Project slug: marketadmin"), "저장 본문에는 봉투가 남아 있다");
  return stored;
}

check("패턴 목록: 모두 양끝만 와일드카드인 구 (가운데 %가 있으면 문서 전체를 긁는다)", () => {
  assert.equal(EXPLICIT_LIKE_PATTERNS.length, EXPLICIT_PHRASES.length);
  for (const pattern of EXPLICIT_LIKE_PATTERNS) {
    assert.match(pattern, /^%[^%]+%$/, `가운데 와일드카드: ${pattern}`);
  }
  // 2026-10-12 에 뺀 `%이제%로%` 가 되살아나지 않게
  assert.ok(!EXPLICIT_PHRASES.some((p) => p.includes("이제")), "이제…로 류는 구가 아니다");
});

check("명부 가드: kind 가 있으면 명부, 둘 다 명부면 후보에서 뺀다", () => {
  assert.equal(isRegistryTag({ id: 1, kind: "project" }), true);
  assert.equal(isRegistryTag({ id: 2, kind: "category" }), true);
  assert.equal(isRegistryTag({ id: 3, kind: null }), false);
  assert.equal(isRegistryTag({ id: 4 }), false);
  assert.equal(isRegistryTag(undefined), false);

  const reg = { id: 1, kind: "project" };
  const cat = { id: 2, kind: "category" };
  const plain = { id: 3, kind: null };
  assert.equal(bothInRegistry(reg, cat), true, "project ↔ category 도 둘 다 명부다");
  assert.equal(bothInRegistry(reg, plain), false, "한쪽만 명부면 방향으로 갈린다 — 여기서 막지 않는다");
  assert.equal(bothInRegistry(plain, plain), false);
  assert.equal(bothInRegistry(reg, undefined), false);
});

check("양성 대조 ①: 봉투 없는 진짜 발언은 두 태그 증거가 된다", () => {
  const ev = explicitEvidence("marketadmin 이랑 smartstore 는 같은 프로젝트야. 합쳐줘.", TAGS);
  assert.deepEqual(ev.tagIds, [2, 3]);
});

check("양성 대조 ②: 같은 말을 봉투 안 채널 메타로만 쓰면 증거가 아니다", () => {
  // 본문의 '동일'은 "바이트 동일" — 프로젝트 얘기가 아니다. marketadmin 은 봉투에만 있다.
  const stored = buzzTurn("mcp-agents-memory 설치 트리가 HEAD 와 바이트 동일이야.");
  const ev = explicitEvidence(stored, TAGS);
  assert.ok(!ev.text.includes("marketadmin"), "봉투가 벗겨져야 한다");
  assert.deepEqual(ev.tagIds, [1], "봉투의 Project slug 는 사람이 말한 게 아니다");
});

check("누락 대조: 봉투 턴이어도 사람이 본문에서 말했으면 증거로 남는다", () => {
  const stored = buzzTurn("smartstore 는 이제 marketadmin 의 별칭으로 합쳐줘.");
  const ev = explicitEvidence(stored, TAGS);
  assert.deepEqual(ev.tagIds, [2, 3], "봉투를 벗겨도 사람 말은 살아야 한다");
});

check("증거는 글에서만 나온다: 이름 하나만 쓴 글은 쌍을 만들지 못한다", () => {
  // 옛 코드는 이 글에 붙은 p_tag 를 '언급 1개'로 더해 두 개로 셌다(태거 분류 → 별칭 근거 순환).
  // 이 함수에는 p_tag 를 넘길 자리가 아예 없다 — 그 자리가 다시 생기면 타입이 먼저 막는다.
  const ev = explicitEvidence("mcp-agents-memory 쪽 태그를 합치는 게 맞아 보여.", TAGS);
  assert.deepEqual(ev.tagIds, [1]);
});

check("구가 없으면 아무 증거도 아니다 (이름이 둘 다 나와도)", () => {
  const ev = explicitEvidence("mcp-agents-memory 와 marketadmin 둘 다 어제 배포했어.", TAGS);
  assert.deepEqual(ev.tagIds, []);
  assert.equal(containsExplicitPhrase("둘 다 어제 배포했어"), false);
  assert.equal(containsExplicitPhrase("같은 프로젝트야"), true);
  assert.equal(containsExplicitPhrase("ALIAS of that tag"), true, "대소문자 무관");
});

check("이름 찾기: 하이픈·공백 차이는 흡수하고, 2글자 이하 이름은 안 쓴다", () => {
  assert.equal(messageMentionsTag("mcp agents memory 얘기", "mcp-agents-memory"), true);
  assert.equal(messageMentionsTag("mcpagentsmemory 얘기", "mcp-agents-memory"), true);
  assert.equal(messageMentionsTag("marketadmin", "marketadmin"), true);
  assert.equal(messageMentionsTag("완전히 다른 글", "marketadmin"), false);
  assert.equal(messageMentionsTag("ab 가 들어간 글", "ab"), false, "3글자 미만은 안 센다");
});

check("실제로 올라온 A559 모양: 증거 14건 중 봉투 12건이 쌍을 못 만든다", () => {
  const envelopeRows = [
    "mcp-agents-memory 설치 트리가 바이트 동일.",
    "7/7 동일 — 해시로 독립 재측정했어.",
    "death supervisor 가 한 숫자로 합쳐져 있어.",
  ].map(buzzTurn);
  for (const row of envelopeRows) {
    assert.ok(explicitEvidence(row, TAGS).tagIds.length < 2, "봉투 행은 쌍을 못 만든다");
  }
});

console.log("all checks passed");
