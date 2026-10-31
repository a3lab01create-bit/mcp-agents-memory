import assert from "node:assert/strict";
import fs from "node:fs";
import { parseEntry, type CaptureParseState } from "../src/auto_save/codex_capture.js";

const response = (role: string, text: string, extra = {}) => JSON.stringify({
  type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }], ...extra },
});
const legacy = (role: string, text: string) => JSON.stringify({
  type: "event_msg", payload: { type: role === "user" ? "user_message" : "agent_message", message: text },
});
const item = (role: string, text: string) => JSON.stringify({
  type: "event_msg", payload: { type: "item_completed", item: {
    type: role === "user" ? "UserMessage" : "AgentMessage", content: [{ type: "text", text }],
  } },
});

for (const format of [response, legacy, item]) {
  for (const role of ["user", "assistant"]) {
    assert.equal(parseEntry(format(role, "안녕하세요"), 42)?.message, "안녕하세요");
    assert.equal(parseEntry(format(role, "안녕하세요"), 42)?.byteOffset, 42);
  }
}
for (const role of ["developer", "system", "tool"]) assert.equal(parseEntry(response(role, "instructions"), 0), null);
for (const text of ["<environment_context>env</environment_context>", "<recommended_plugins>plugins</recommended_plugins>", "# AGENTS.md instructions for /tmp\nrules"]) {
  assert.equal(parseEntry(response("user", text), 0), null);
}
assert.equal(parseEntry(response("user", "이 문구를 설명해줘: <environment_context>env</environment_context>"), 0)?.role, "user");
assert.equal(parseEntry(response("assistant", "private reasoning", { channel: "analysis" }), 0), null);
assert.equal(parseEntry(response("assistant", "answer", { phase: "final_answer" }), 0)?.message, "answer");
assert.equal(parseEntry("invalid", 0), null);
assert.equal(parseEntry("null", 0), null);
assert.equal(parseEntry(response("user", "", { content: [{ type: "input_image", image_url: "ignored" }] }), 0), null);
assert.equal(parseEntry(response("user", "", { content: [
  { type: "input_text", text: "<environment_context>env</environment_context>" },
  { type: "input_text", text: "first" }, { type: "input_text", text: "second" },
] }), 0)?.message, "first\nsecond");

for (const formats of [[response, item, legacy], [legacy, item, response], [item, response, legacy]]) {
  const state: CaptureParseState = { mirrors: [] };
  for (let turn = 0; turn < 2; turn++) {
    assert.ok(parseEntry(formats[0]("user", "same repeated turn"), turn * 100, state));
    assert.equal(parseEntry(formats[1]("user", "same repeated turn"), turn * 100 + 1, state), null);
    assert.equal(parseEntry(formats[2]("user", "same repeated turn"), turn * 100 + 2, state), null);
  }
  assert.ok(parseEntry(response("assistant", "same repeated turn"), 999, state));
}
const state: CaptureParseState = { mirrors: [] };
for (let i = 0; i < 1000; i++) parseEntry(response("user", String(i)), i, state);
assert.equal(state.mirrors.length, 256);

// ────────────────────────────────────────────────────────────────────────────
// 2026-10-31 추가 — 실제 Buzz 비계·사용자 XML·raw_message·도착 순서.
// 합성 짧은 문자열만으로는 조각이 여러 개인 실제 턴을 한 번도 지나가지 않았다.
// ────────────────────────────────────────────────────────────────────────────
const multi = (role: string, texts: string[], kind: "response" | "item") =>
  kind === "response"
    ? JSON.stringify({ type: "response_item", payload: { type: "message", role,
        content: texts.map((t) => ({ type: "input_text", text: t })) } })
    : JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: {
        type: role === "user" ? "UserMessage" : "AgentMessage",
        content: texts.map((t) => ({ type: "text", text: t })) } } });

// ⑥ 사람이 앞 조각에 붙인 XML 은 보존된다 — 두 경로 모두.
const xmlCase = ["<invoice><amount>100</amount></invoice>", "위 XML의 금액을 알려줘"];
for (const kind of ["response", "item"] as const) {
  const r = parseEntry(multi("user", xmlCase, kind), 0, { mirrors: [] });
  assert.equal(r?.message, xmlCase.join("\n"), `⑥ ${kind}: 사용자 XML 이 보존되어야 한다`);
}

// ⑦ 비ASCII 태그도 출처 불명이면 보존한다 (모양은 주입의 증거가 아니다).
for (const kind of ["response", "item"] as const) {
  const texts = ["<새것>본문</새것>", "실제 질문"];
  assert.equal(parseEntry(multi("user", texts, kind), 0, { mirrors: [] })?.message, texts.join("\n"),
    `⑦ ${kind}: 비ASCII 태그 조각도 보존되어야 한다`);
}

// ① 일반 다중 조각 본문 보존 — 두 경로 모두 (item 경로는 2026-10-31 까지 마지막 조각만 담았다).
for (const kind of ["response", "item"] as const) {
  assert.equal(
    parseEntry(multi("user", ["<environment_context>env</environment_context>", "first", "second"], kind), 0, { mirrors: [] })?.message,
    "first\nsecond", `① ${kind}: 주입문만 빠지고 본문 조각은 전부 남아야 한다`);
}

// ④ raw_message 는 주입문 필터·trim 이전의 조각 원문이다.
{
  const texts = ["  <recommended_plugins>p</recommended_plugins>  ", "  본문  "];
  for (const kind of ["response", "item"] as const) {
    const r = parseEntry(multi("user", texts, kind), 0, { mirrors: [] });
    assert.equal(r?.message, "본문", `④ ${kind}: message 는 주입문 제외·trim`);
    assert.equal(r?.rawMessage, texts.join("\n"), `④ ${kind}: rawMessage 는 필터·trim 이전 원문`);
  }
}

// ⑤ 도착 순서를 바꿔도 본문·venue·raw·중복제거 결과가 같다.
for (const order of [["response", "item"], ["item", "response"]] as const) {
  const state: CaptureParseState = { mirrors: [] };
  const texts = ["<invoice><amount>100</amount></invoice>", "위 XML의 금액을 알려줘"];
  const first = parseEntry(multi("user", texts, order[0]), 0, state);
  const second = parseEntry(multi("user", texts, order[1]), 1, state);
  assert.ok(first, `⑤ ${order.join("→")}: 첫 이벤트는 저장된다`);
  assert.equal(second, null, `⑤ ${order.join("→")}: 같은 본문의 두 번째 스키마는 억제된다`);
  assert.equal(first?.message, texts.join("\n"), `⑤ ${order.join("→")}: 본문 동일`);
  // rawMessage 는 message 와 다를 때만 채운다 → 보존 불변식은 "원문을 되살릴 수 있다" 이다.
  assert.equal(first?.rawMessage ?? first?.message, texts.join("\n"), `⑤ ${order.join("→")}: 원문 복원 동일`);
  assert.equal(first?.venueSource, texts.join("\n"), `⑤ ${order.join("→")}: venue 원문 동일`);
}

// 실제 Buzz 비계 모양 — 차단목록에 없는 블록이라도 봉투 정리는 hot_path 가 문법으로 한다.
// 캡처 단계는 조각을 **버리지 않는다**는 것만 확인한다 (② 는 파이프라인 검사에서 본다).
{
  const buzzish = ["<base>manual</base>", "<core-memory>mem</core-memory>",
    "<context>\nScope: thread\nChannel: x (#aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)\n</context>", "질문"];
  for (const kind of ["response", "item"] as const) {
    const r = parseEntry(multi("user", buzzish, kind), 0, { mirrors: [] });
    assert.equal(r?.message, buzzish.join("\n"), `비계 조각도 캡처 단계에서는 버리지 않는다 (${kind})`);
    assert.ok(r?.venueSource?.includes("Channel: x (#"), `venue 원문은 조각 전체 (${kind})`);
  }
}

// Optional local rollout check: counts only, never print or store conversation bodies.
if (process.argv[2]) {
  const state: CaptureParseState = { mirrors: [] };
  const counts = { user: 0, assistant: 0 };
  let offset = 0;
  for (const line of fs.readFileSync(process.argv[2], "utf8").split("\n")) {
    const parsed = parseEntry(line, offset, state);
    if (parsed) counts[parsed.role]++;
    offset += Buffer.byteLength(line) + 1;
  }
  console.log("Local rollout capture counts:", counts);
}
console.log("Codex capture regression checks passed");
