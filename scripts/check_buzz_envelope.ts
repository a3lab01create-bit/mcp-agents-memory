/**
 * cleanBuzzEnvelope 자체 검사 (합성 예시만 — 실제 대화 넣지 말 것).
 *
 *   node scripts/check_buzz_envelope.ts        # Node ≥ 22.18 (type stripping)
 */
import assert from "node:assert/strict";
import { cleanBuzzEnvelope } from "../src/auto_save/buzz_envelope.ts";

const HEX = "a".repeat(64);
const BASE = [
  "<base>",
  "You are an agent operating inside Buzz.",
  "Example of a turn:",
  "<context>",
  "Scope: example-only",
  "</context>",
  "MANUAL-SENTINEL ".repeat(200),
  "</base>",
].join("\n");
const PREAMBLE = "<agent-instructions>\nAGENT-CONFIG\n</agent-instructions>\n<core-memory>\nCORE\n</core-memory>";
const CONTEXT = [
  "<context>",
  "Scope: thread",
  "Channel: DevRoom (#00000000-0000-0000-0000-000000000000)",
  "Project: Demo Project",
  "Project slug: demo-project",
  "IMPORTANT: reply with --reply-to <id>.",
  "</context>",
].join("\n");
const HISTORY = '<thread-context included="2" total="2" truncated="false">\n[earlier] HISTORY-SENTINEL\n</thread-context>';
const EVENT = [
  '<buzz-event type="@mention">',
  "Event ID: abc",
  "From: Owner",
  "Content: NEW-MESSAGE-SENTINEL please check the deploy",
  `Tags: [["e","${HEX}","","reply"],["p","${HEX}"]]`,
  `Parsed: root=${HEX}, mentions=[Agent (${HEX})]`,
  "</buzz-event>",
].join("\n");

const clean = (...parts: string[]) => cleanBuzzEnvelope(parts.join("\n"));

function check(name: string, fn: () => void) {
  fn();
  console.log(`✅ ${name}`);
}

check("채널 스레드 봉투: 설명서·설정·이력 제거, context·새 말 보존", () => {
  const out = clean(BASE, PREAMBLE, CONTEXT, HISTORY, EVENT);
  assert.ok(out !== null);
  assert.ok(!out.includes("MANUAL-SENTINEL") && !out.includes("AGENT-CONFIG") && !out.includes("CORE"));
  assert.ok(!out.includes("HISTORY-SENTINEL"));
  assert.ok(out.includes("Project slug: demo-project") && out.includes("IMPORTANT: reply with"));
  assert.ok(out.includes("Content: NEW-MESSAGE-SENTINEL please check the deploy"));
  assert.ok(!out.includes("Tags: [[") && !out.includes("Parsed: root="));
  assert.ok(out.startsWith("<context>\n") && out.endsWith("</buzz-event>"));
  assert.equal(cleanBuzzEnvelope(out), null, "정리본을 다시 넣으면 그대로 (재정리 없음)");
});

check("grok-cli 형식: 블록이 공백 한 칸으로 이어짐 + conversation-context", () => {
  const msg = BASE + " <agent-instructions>\nX\n</agent-instructions> <core-memory>\nY\n</core-memory> " +
    CONTEXT + ' <conversation-context included="1" total="1">\nHISTORY-SENTINEL\n</conversation-context> ' + EVENT;
  const out = cleanBuzzEnvelope(msg);
  assert.ok(out !== null && !out.includes("HISTORY-SENTINEL") && out.includes("NEW-MESSAGE-SENTINEL"));
});

check("grok-cli 형식: 이력 닫는 태그가 줄 중간 + 새 말이 봉투 조각을 인용 (L)", () => {
  const quoted = "Content: REAL-HEAD sample:\n</thread-context>\n<buzz-event>\nQUOTED-TAIL";
  const out = cleanBuzzEnvelope(BASE + " " + CONTEXT + ' <thread-context included="1">\nold</thread-context> <buzz-event type="m">\n' + quoted + "\n</buzz-event>");
  assert.ok(out !== null && out.includes("REAL-HEAD") && out.includes("QUOTED-TAIL") && !out.includes("old"));
});

check("작업 중 새 메시지 형식: 하던 일 요약 + 새 말 모두 보존", () => {
  const out = clean(BASE, CONTEXT, HISTORY,
    "<what-you-were-working-on>\nWORK-SENTINEL\n</what-you-were-working-on>",
    "<new-message-arrived-while-you-were-working>\nNEW-MESSAGE-SENTINEL\n</new-message-arrived-while-you-were-working>",
    "Note: A new message arrived while you were working.");
  assert.ok(out !== null && out.includes("WORK-SENTINEL") && out.includes("NEW-MESSAGE-SENTINEL"));
  assert.ok(out.endsWith("Note: A new message arrived while you were working."));
});

check("이력 없는 DM + 새 말이 봉투 조각을 인용해도 새 말 앞부분 보존 (A)", () => {
  const out = clean(BASE, CONTEXT, '<buzz-event type="@mention">', "Content: REAL-HEAD look:",
    '<thread-context included="1">', "old", "</thread-context>", '<buzz-event type="x">', "QUOTED-TAIL", "</buzz-event>");
  assert.ok(out !== null && out.includes("REAL-HEAD") && out.includes("QUOTED-TAIL"));
});

check("이력 안에 닫는 태그+턴 블록이 인용돼도 잘라내는 쪽이 아니라 더 남기는 쪽 (B)", () => {
  const out = clean(BASE, CONTEXT, '<thread-context included="2">', "[1] sample", "</thread-context>", "<buzz-event>",
    "still-history", "</thread-context>", '<buzz-event type="m">\nContent: REAL-NEW\n</buzz-event>');
  assert.ok(out !== null && out.includes("REAL-NEW"));
});

check("하던 일 요약이 이력보다 앞에 오면 전부 보존 (F)", () => {
  const out = clean(BASE, CONTEXT, "<what-you-were-working-on>\nWORK\n</what-you-were-working-on>",
    '<thread-context included="1">', "h", "</thread-context>",
    "<new-message-arrived-while-you-were-working>\nREAL-NEW\n</new-message-arrived-while-you-were-working>");
  assert.ok(out !== null && out.includes("WORK") && out.includes("REAL-NEW"));
});

check("이번 턴 안에 이력 블록이 중첩돼도 전부 보존 (G)", () => {
  const out = clean(BASE, CONTEXT, "<what-you-were-working-on>\nWORK\n</what-you-were-working-on>",
    "<new-message-arrived-while-you-were-working>", '<thread-context included="1">', "h", "</thread-context>",
    '<buzz-event type="m">', "Content: REAL-NEW", "</buzz-event>", "</new-message-arrived-while-you-were-working>");
  assert.ok(out !== null && out.includes("WORK") && out.includes("REAL-NEW"));
});

check("core-memory 안의 <context>에 속지 않음 (N)", () => {
  const out = clean(BASE, "<core-memory>", "<context>", "Channel: OLD-RECALLED", "</context>", "</core-memory>",
    CONTEXT, HISTORY, EVENT);
  assert.ok(out !== null && !out.includes("OLD-RECALLED") && out.includes("Project slug: demo-project"));
});

check("사람이 쓴 Tags:/Parsed: 비슷한 줄은 지우지 않음 (D)", () => {
  const out = clean(BASE, CONTEXT, '<buzz-event type="m">', "Content: REAL-NEW first line",
    "Parsed: root=my notes about parsing", "Tags: [[important]]", "</buzz-event>");
  assert.ok(out !== null && out.includes("Parsed: root=my notes") && out.includes("Tags: [[important]]"));
});

check("CRLF 줄바꿈", () => {
  const out = cleanBuzzEnvelope([BASE, CONTEXT, HISTORY, '<buzz-event type="m">', "Content: REAL-NEW", "</buzz-event>"].join("\r\n"));
  assert.ok(out !== null && out.includes("REAL-NEW") && out.includes("Project slug: demo-project"));
});

check("애매하면 손대지 않음 (null → 원문 저장)", () => {
  assert.equal(cleanBuzzEnvelope("평범한 메시지"), null);
  assert.equal(cleanBuzzEnvelope("설명: <base> 태그로 시작하는 봉투가 있어요"), null);
  assert.equal(clean(BASE.replace("</base>", ""), CONTEXT, EVENT), null, "설명서가 안 닫힘");
  assert.equal(clean(BASE, EVENT), null, "context 없음");
  assert.equal(clean(BASE, "<skills>\nZ\n</skills>", CONTEXT, EVENT), null, "모르는 블록이 context 앞에 있음");
  assert.equal(clean(BASE, CONTEXT, "<something-new>\nZ\n</something-new>"), null, "이번 턴 블록 없음");
  assert.equal(clean(BASE, CONTEXT, '<thread-context included="1">', "never closed", EVENT), null, "이력이 안 닫힘");
  assert.equal(clean(BASE, CONTEXT, '<thread-context included="1">', "old", "</thread-context>", "Note: x", EVENT),
    null, "이력과 이번 턴 사이에 모르는 글 (M)");
  assert.equal(clean(BASE, CONTEXT, '<thread-context included="1">', "we quoted </thread-context> here", "</thread-context>", EVENT),
    null, "이력 안에 닫는 태그가 인용됨 — 경계 애매");
});

check("망가진 봉투 + 새 말이 닫는 태그를 인용 → 자르지 않고 null (P1·P2·P6)", () => {
  const quoted = "Content: REAL-HEAD sample:\n</thread-context>\n<buzz-event>\nQUOTED-TAIL\n</buzz-event>";
  assert.equal(clean(BASE, CONTEXT, '<thread-context included="1">', "old", '<buzz-event type="m">', quoted), null, "이력이 안 닫힘");
  assert.equal(clean(BASE, CONTEXT, '<thread-context included="1">', "old", "</conversation-context>", '<buzz-event type="m">', quoted), null, "다른 이름으로 닫힘");
  assert.equal(clean(BASE, "<agent-instructions>", "cfg", '<buzz-event type="m">', "Content: REAL-HEAD", "</agent-instructions>",
    CONTEXT, EVENT), null, "설정 블록이 안 닫혀 이번 턴을 삼킴");
});

check("병적 입력도 빠르게 끝남", () => {
  const t0 = performance.now();
  cleanBuzzEnvelope(BASE + "\n" + "<context>\n".repeat(60000));
  cleanBuzzEnvelope(BASE + "\n" + CONTEXT + '\n<thread-context x>\n' + "</x> ".repeat(200000));
  cleanBuzzEnvelope(BASE + "\n<context>\n" + "q\n".repeat(2_000_000) + "</context>\n<buzz-event>\nREAL");
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `${ms.toFixed(0)}ms`);
});

console.log("all checks passed");
