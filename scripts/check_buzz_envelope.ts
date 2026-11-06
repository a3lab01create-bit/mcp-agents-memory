/**
 * cleanBuzzEnvelope 자체 검사 (합성 예시만 — 실제 대화 넣지 말 것).
 *
 *   npm run check:envelope        # esbuild로 묶어서 실행
 */
import assert from "node:assert/strict";
import { buzzDisplayText, buzzEmbeddingText, buzzQuotedMessages, cleanBuzzEnvelope, venueFromBuzzContext, venueFromBuzzMessage } from "../src/auto_save/buzz_envelope.ts";
import { buzzTurnVenue, classifySessionVenue, lastBuzzVenueInFile } from "../src/auto_save/venue.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  `Event ID: ${HEX}`,
  "From: Owner",
  "Content: NEW-MESSAGE-SENTINEL please check the deploy",
  `Tags: [["e","${HEX}","","reply"],["p","${HEX}"]]`,
  `Parsed: root=${HEX}, mentions=[Agent (${HEX})]`,
  "</buzz-event>",
].join("\n");

const clean = (...parts: string[]) => cleanBuzzEnvelope(parts.join("\n"));
/** 설명서 없는 봉투 정리 — buzz-ingest가 인용 확인 뒤에만 켠다 */
const cleanB = (...parts: string[]) => cleanBuzzEnvelope(parts.join("\n"), { baseless: true });
const B = { baseless: true };

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
  // 이력 안에 닫는 태그가 인용된 경우는 더 이상 "애매"가 아니다 — 아래 (나) 블록으로 옮겼다.
  // 인용된 닫는 태그는 뒤에 사람 말이 이어지므로 경계 후보가 아니다.
});

/** 실제 이력처럼 `[n] 이름 (hex) (시각): 본문` 머리를 단 인용 글 */
const Q = (n: number, text: string) => `[${n}] Agent (${HEX}) (2026-10-04T13:00:0${n}Z): ${text}`;

/**
 * 보존 불변식: **이번 턴 본문은 모든 소비 경로에 남는다.** 정리는 거절할 수 있어도(원문 저장) 잘라선 안 된다.
 * 경계를 뒤로 옮기는 변경은 정리 경로만 보면 안전해 보인다 — 가드가 없는 경로(임베딩)가 따로 자른다.
 */
function assertTurnPreserved(msg: string, mark: string, label: string, opts?: { baseless?: boolean }) {
  const c = cleanBuzzEnvelope(msg, opts ?? {});
  if (c !== null) assert.ok(c.includes(mark), `${label}: 정리본에 이번 턴 '${mark}'`);
  assert.ok(buzzEmbeddingText(msg).includes(mark), `${label}: 임베딩에 이번 턴 '${mark}'`);
  assert.ok(buzzDisplayText(msg).includes(mark), `${label}: 표시에 이번 턴 '${mark}'`);
}

check("이력 안에 닫는 태그가 인용돼도 진짜 경계를 찾는다 (나) — 판별자는 '바로 뒤에 이번 턴'", () => {
  // 실측 2026-11-01: 이력 있는 봉투 1,945행에서 이 조건만으로 후보가 전 행 정확히 1개.
  // 경계가 기존(첫 닫는 태그)과 갈린 행은 4행 — 전부 봉투 태그를 본문에 인용해 보류됐던 행이다.
  const H = (...body: string[]) => ['<thread-context included="1" total="1" truncated="false">', ...body, "</thread-context>"].join("\n");

  // ⓐ 인용된 닫는 태그가 줄 중간 (관측 id 121273 모양)
  const quotedMid = [BASE, CONTEXT, H("[1] Agent 가 `</thread-context>` 를 인용했다"), EVENT].join("\n");
  let out = cleanBuzzEnvelope(quotedMid);
  assert.ok(out !== null, "ⓐ 정리된다");
  assert.ok(!out!.includes("인용했다"), "ⓐ 이력은 빠진다");
  assertTurnPreserved(quotedMid, "NEW-MESSAGE-SENTINEL please check the deploy", "ⓐ");

  // ⓑ 인용된 닫는 태그가 줄 머리에 있고 뒤에 사람 말이 이어짐
  out = clean(BASE, CONTEXT, H("[1] Agent:", "</thread-context> 이 줄이 경계로 잡히면 안 된다"), EVENT);
  assert.ok(out !== null && !out.includes("경계로 잡히면") && out.includes("NEW-MESSAGE-SENTINEL"), "ⓑ 건너뛴다");

  // ⓒ 코드펜스 안에 인용돼 있어도 같다 (펜스 짝으로 거르지 않는다 — 그러면 32행이 순손실).
  //    판정 기준은 "진짜 경계를 찾았나" 가 아니라 **"실제 턴 전체가 남았나"** 다.
  const fenced = [BASE, CONTEXT, H("[1] Agent:", "```", "</thread-context>", "```", "펜스 끝"), EVENT].join("\n");
  out = cleanBuzzEnvelope(fenced);
  assert.ok(out !== null && !out.includes("펜스 끝"), "ⓒ 정리되고 이력은 빠진다");
  assertTurnPreserved(fenced, "NEW-MESSAGE-SENTINEL please check the deploy", "ⓒ");

  // ⓓ 후보가 여럿이면 가장 이른 것 — 진짜 경계가 줄 중간이고 인용된 쪽이 줄 머리인 grok 형식(검사 L)이
  //    바로 그 모양이라, '줄 머리' 를 조건으로 넣으면 엉뚱한 경계를 고른다. 더 남기는 쪽으로 간다.
  const twoCands = BASE + " " + CONTEXT + ' <thread-context included="1">\nold</thread-context> <buzz-event type="m">\n' +
    "Content: REAL-HEAD\n</thread-context>\n<buzz-event>\nQUOTED-TAIL\n</buzz-event>";
  out = cleanBuzzEnvelope(twoCands);
  assert.ok(out !== null && out.includes("REAL-HEAD") && out.includes("QUOTED-TAIL") && !out.includes("old"),
    "ⓓ 가장 이른 후보 = 진짜 경계");

  // ⓔ CRLF 에서도 같다
  out = cleanBuzzEnvelope([BASE, CONTEXT, H("[1] `</thread-context>` 인용"), EVENT].join("\n").replace(/\n/g, "\r\n"));
  assert.ok(out !== null && !out.includes("인용") && out.includes("NEW-MESSAGE-SENTINEL"), "ⓔ CRLF");

  // ⓕ 인용 확인과 정리가 **같은 경계**를 쓴다 (한쪽만 읽으면 '정리는 거절, 인용은 읽음' 비대칭이 생긴다)
  const msg = [BASE, CONTEXT, H(Q(1, "`</thread-context>` 를 인용한 글")), EVENT].join("\n");
  const quotes = buzzQuotedMessages(msg);
  assert.ok(quotes !== null && quotes.length === 1, "ⓕ 인용 1건으로 읽힌다");
  assert.ok(quotes![0].content.includes("</thread-context>"), "ⓕ 인용 본문에 그 태그가 그대로 있다");
  assert.ok(cleanBuzzEnvelope(msg) !== null, "ⓕ 같은 입력을 정리도 받아들인다");

  // ⓖ 여전히 거절해야 하는 것들 — 경계를 바꿨다고 이쪽이 뚫려선 안 된다
  // ⓖ-1 인용 속에 줄 전체가 턴 태그 (관측 id 107008·107120) — 정리는 **쓰기라서** 거절한다.
  //      다만 경계를 건너뛴 게 아니므로(후보가 첫 닫는 태그) 임베딩·표시는 **main 과 같게** 걷는다.
  //      이 가드를 건너뛰지 않은 행에까지 걸면 그 2행의 임베딩이 봉투째가 된다(실측 4,820B → 53,191B).
  const hidesTurn = [BASE, CONTEXT, H("[1] Agent:", '<buzz-event type="m">', "HISTORY-SENTINEL"), EVENT].join("\n");
  assert.equal(cleanBuzzEnvelope(hidesTurn), null, "ⓖ-1 정리는 거절");
  const he = buzzEmbeddingText(hidesTurn);
  assert.ok(he.includes("NEW-MESSAGE-SENTINEL"), "ⓖ-1 임베딩은 이번 턴을 담는다");
  assert.ok(!he.includes("HISTORY-SENTINEL"), "ⓖ-1 임베딩은 이력을 걷는다 (경계가 안 옮겨졌으니 main 과 같다)");
  assert.equal(clean(BASE, CONTEXT, '<thread-context included="1">', "old", "</thread-context>", "Note: x", EVENT), null,
    "ⓖ 이력과 이번 턴 사이에 모르는 글 (M)");
  assert.equal(clean(BASE, CONTEXT, '<thread-context included="1">', "never closed", EVENT), null, "ⓖ 이력이 안 닫힘");
});

check("경계를 뒤로 옮길 때 — 정리가 거절한 입력에서 임베딩·표시도 본문을 지킨다 (코디 반례)", () => {
  // 검사 M(닫는 이력 뒤 Note) + L(이번 턴 안에 닫기·턴 태그 인용) 합성.
  // 첫 닫기 뒤가 Note 라 건너뛰고 **이번 턴 본문에 인용된 두 번째 닫기**가 후보가 된다.
  // 정리는 historyHidesTurn 으로 거절했는데 turnAfterContext 엔 그 가드가 없어서 임베딩만 잘랐다
  // (재현: REAL-HEAD 를 잃고 임베딩 입력이 350자 → 11자 "QUOTED-TAIL"). 그래서 가드를 경계 판정 안으로 옮겼다.
  const msg = [
    CONTEXT, '<thread-context included="1">', Q(1, "old"), "</thread-context>", "Note: x",
    '<buzz-event type="m">', "Content: REAL-HEAD", "</thread-context>", "<buzz-event>", "QUOTED-TAIL", "</buzz-event>",
  ].join("\n");
  assert.equal(cleanBuzzEnvelope(msg, B), null, "정리는 거절한다");
  assertTurnPreserved(msg, "REAL-HEAD", "반례", B);
  assertTurnPreserved(msg, "QUOTED-TAIL", "반례", B);
  assert.equal(buzzQuotedMessages(msg), null, "인용 읽기도 같은 결정(= 경계 모름)");

  // 설명서(<base>) 봉투에서도 같다
  const withB = [BASE, PREAMBLE, msg].join("\n");
  assert.equal(cleanBuzzEnvelope(withB), null, "설명서 봉투에서도 거절");
  assertTurnPreserved(withB, "REAL-HEAD", "반례+설명서");
});

check("망가진 봉투 + 새 말이 닫는 태그를 인용 → 자르지 않고 null (P1·P2·P6)", () => {
  const quoted = "Content: REAL-HEAD sample:\n</thread-context>\n<buzz-event>\nQUOTED-TAIL\n</buzz-event>";
  assert.equal(clean(BASE, CONTEXT, '<thread-context included="1">', "old", '<buzz-event type="m">', quoted), null, "이력이 안 닫힘");
  assert.equal(clean(BASE, CONTEXT, '<thread-context included="1">', "old", "</conversation-context>", '<buzz-event type="m">', quoted), null, "다른 이름으로 닫힘");
  assert.equal(clean(BASE, "<agent-instructions>", "cfg", '<buzz-event type="m">', "Content: REAL-HEAD", "</agent-instructions>",
    CONTEXT, EVENT), null, "설정 블록이 안 닫혀 이번 턴을 삼킴");
});

const withBase = (...p: string[]) => clean(BASE, PREAMBLE, ...p);

check("인용 글이 봉투 태그를 언급해도 정리 — 진짜 블록 모양이 아니면 언급 (Q1)", () => {
  const hist = [
    '<thread-context included="2" total="2">',
    Q(1, "HISTORY-SENTINEL 임베딩 입력 실측:"),
    "```",
    '  <buzz-event type="@mention">',
    "<new-message-arrived-while-you-were-working> 로 시작   219행",
    "```",
    Q(2, "원문 그대로:"),
    ' <buzz-event type=\\"all-channel-mentions\\">\\nEvent ID: ' + HEX,
    "</thread-context>",
  ].join("\n");
  for (const [mode, out] of [["설명서", withBase(CONTEXT, hist, EVENT)], ["설명서 없음", cleanB(CONTEXT, hist, EVENT)]] as const) {
    assert.ok(out !== null, mode);
    assert.ok(!out.includes("HISTORY-SENTINEL") && out.includes("NEW-MESSAGE-SENTINEL"), mode);
    assert.ok(out.startsWith("<context>\n") && out.endsWith("</buzz-event>"), mode);
  }
});

check("인용 글에 진짜 블록 모양(줄 전체가 턴 태그)이 있거나 인용 글로 안 읽히면 그대로 거절 (Q2)", () => {
  const real = ['<thread-context included="1">', Q(1, "예시:"), "```", '<buzz-events count="4">', "--- Event 1 (@mention) ---", "```", "</thread-context>"].join("\n");
  assert.equal(withBase(CONTEXT, real, EVENT), null, "줄 전체가 턴 태그");
  assert.equal(cleanB(CONTEXT, real, EVENT), null, "줄 전체가 턴 태그 (설명서 없음)");
  const grok = ['<thread-context included="1">', Q(1, 'x</buzz-event> <buzz-event type="m">'), "</thread-context>"].join("\n");
  assert.equal(withBase(CONTEXT, grok, EVENT), null, "grok 이음 모양: 앞 블록 > 뒤에서 줄 끝까지");
  const loose = ['<thread-context included="1">', "머리 없는 줄", '  <buzz-event type="m"> 언급', "</thread-context>"].join("\n");
  assert.equal(withBase(CONTEXT, loose, EVENT), null, "인용 글로 안 읽힘");
});

check("망가진 봉투(인용 머리 있는 실형식 이력) + 새 말이 닫는 태그를 인용 → 여전히 null (P1·P2)", () => {
  const quoted = "Content: REAL-HEAD sample:\n</thread-context>\n<buzz-event>\nQUOTED-TAIL\n</buzz-event>";
  for (const [mode, c] of [["설명서", withBase], ["설명서 없음", cleanB]] as const) {
    assert.equal(c(CONTEXT, '<thread-context included="1">', Q(1, "old"), '<buzz-event type="m">', quoted), null, `${mode}: 이력이 안 닫힘`);
    assert.equal(c(CONTEXT, '<thread-context included="1">', Q(1, "old"), "</conversation-context>", '<buzz-event type="m">', quoted),
      null, `${mode}: 다른 이름으로 닫힘`);
    assert.equal(c(CONTEXT, '<thread-context included="1">', Q(1, "old"), "<new-message-arrived-while-you-were-working>", quoted),
      null, `${mode}: 이력이 안 닫힘 (작업 중 새 메시지)`);
  }
});

check("병적 입력도 빠르게 끝남", () => {
  const t0 = performance.now();
  cleanBuzzEnvelope(BASE + "\n" + "<context>\n".repeat(60000));
  cleanBuzzEnvelope(BASE + "\n" + CONTEXT + '\n<thread-context x>\n' + "</x> ".repeat(200000));
  // 닫는 태그 자체가 20만 개 — 경계 루프가 자리마다 문자열을 복사하면 여기서 O(n²) 로 터진다
  cleanBuzzEnvelope(BASE + "\n" + CONTEXT + '\n<thread-context x>\n' + "</thread-context> ".repeat(200000));
  cleanBuzzEnvelope(BASE + "\n<context>\n" + "q\n".repeat(2_000_000) + "</context>\n<buzz-event>\nREAL");
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `${ms.toFixed(0)}ms`);
});

check("설명서 없는 봉투(<context>부터 시작): 이력 제거, 방 정보·새 말 보존", () => {
  const out = cleanB(CONTEXT, HISTORY, EVENT);
  assert.ok(out !== null && !out.includes("HISTORY-SENTINEL") && out.includes("NEW-MESSAGE-SENTINEL"));
  assert.ok(out.includes("Project slug: demo-project") && !out.includes("Tags: [["));
  assert.equal(cleanBuzzEnvelope(out, B), null, "정리본은 다시 정리하지 않음");
});

check("설명서 없는 봉투: 버즈 표식(Scope·Channel)이 없으면 손대지 않음", () => {
  const noScope = CONTEXT.replace("Scope: thread\n", "");
  assert.equal(cleanB(noScope, HISTORY, EVENT), null, "Scope 줄 없음");
  assert.equal(cleanB(CONTEXT.replace("Scope: thread", "Scope: something-new"), HISTORY, EVENT), null, "모르는 Scope");
  assert.equal(cleanB(CONTEXT.replace(/Channel: .*\n/, ""), HISTORY, EVENT), null, "Channel 줄 없음");
  assert.equal(cleanB("<context>\nUser prefers dark mode\n</context>", "그냥 메모"), null, "버즈가 아닌 <context> 글");
  assert.equal(cleanB(CONTEXT.replace("Scope: thread", "Scope: thread\rjunk"), HISTORY, EVENT), null, "Scope 줄 뒤 잡문");
  assert.equal(cleanB(CONTEXT.replace(/Channel: .*/, "Channel: DevRoom"), HISTORY, EVENT), null, "Channel 줄에 채널 uuid 없음");
});

check("설명서 없는 봉투: 이력 없는 DM 모양·CRLF·망가진 모양·속도", () => {
  const dm = cleanB(CONTEXT, EVENT);
  assert.ok(dm !== null && dm.includes("NEW-MESSAGE-SENTINEL") && !dm.includes("Tags: [["), "이력 없는 DM 모양");
  const crlf = cleanBuzzEnvelope([CONTEXT, HISTORY, EVENT].join("\r\n"), B);
  assert.ok(crlf !== null && crlf.includes("NEW-MESSAGE-SENTINEL") && !crlf.includes("HISTORY-SENTINEL"), "CRLF");
  const q = "Content: REAL-HEAD\n</thread-context>\n<buzz-event>\nQUOTED";
  assert.equal(cleanB(CONTEXT, '<thread-context included="1">', "old", '<buzz-event type="m">', q), null, "이력이 안 닫힘");
  assert.equal(cleanB(CONTEXT, '<thread-context included="1">', "old", "</conversation-context>", '<buzz-event type="m">', q), null, "다른 이름으로 닫힘");
  assert.equal(cleanB(CONTEXT, '<thread-context included="1">', "old", "</thread-context>", "Note: x", EVENT), null, "이력과 턴 사이 모르는 글");
  const rr = cleanBuzzEnvelope(CONTEXT.replace("\n</context>", "\r\r\n</context>") + "\n" + EVENT, B);
  assert.ok(rr !== null && cleanBuzzEnvelope(rr, B) === null, "context 끝 CR 두 개도 다시 정리 안 함");
  const t0 = performance.now();
  cleanBuzzEnvelope(CONTEXT + "\n<thread-context x>\n" + "</x> ".repeat(200000), B);
  cleanBuzzEnvelope("<context>\nScope: thread\nChannel: " + "a".repeat(2_000_000) + "\n</context>\n" + EVENT, B);
  assert.ok(performance.now() - t0 < 500);
});

check("설명서 없는 봉투: 저장 순간(기본값)엔 정리하지 않음 — 인용이 답글의 유일한 사본일 수 있어서", () => {
  assert.equal(clean(CONTEXT, HISTORY, EVENT), null);
  assert.equal(cleanBuzzEnvelope([CONTEXT, EVENT].join("\n")), null);
  assert.ok(clean(BASE, PREAMBLE, CONTEXT, HISTORY, EVENT) !== null, "설명서 봉투는 그대로 정리");
});

const QHEX = "b".repeat(64);
const QUOTES = [
  '<thread-context included="2" total="2" truncated="false">',
  `[1] Owner (${HEX}) (2026-09-30T11:24:02+00:00): 첫 줄`,
  "둘째 줄 [2] 아님",
  `[2] Agent at Box (${QHEX}) (2026-09-30T11:25:00+00:00): 답글`,
  "</thread-context>",
].join("\n");

check("인용 읽기: 정리기가 걷어낼 이력 속 글만, 여러 줄 본문 포함", () => {
  const q = buzzQuotedMessages([CONTEXT, QUOTES, EVENT].join("\n"));
  assert.deepEqual(q, [
    { pubkey: HEX, time: "2026-09-30T11:24:02+00:00", content: "첫 줄\n둘째 줄 [2] 아님" },
    { pubkey: QHEX, time: "2026-09-30T11:25:00+00:00", content: "답글" },
  ]);
  assert.deepEqual(buzzQuotedMessages([BASE, PREAMBLE, CONTEXT, QUOTES, EVENT].join("\n")), q, "설명서 봉투도 같은 자리");
  const dm = QUOTES.replace(/thread-context/g, "conversation-context");
  assert.equal(buzzQuotedMessages([CONTEXT, dm, EVENT].join("\n"))?.length, 2, "DM 이력");
  assert.deepEqual(buzzQuotedMessages([CONTEXT, EVENT].join("\n")), [], "이력 없음");
  assert.deepEqual(buzzQuotedMessages([CONTEXT, '<thread-context included="0">', "</thread-context>", EVENT].join("\n")), [], "빈 이력");
  const turnQuote = EVENT.replace("Content: NEW", `Content: [1] X (${HEX}) (2026-09-30T00:00:00Z): 인용처럼 생긴 새 말 NEW`);
  assert.deepEqual(buzzQuotedMessages([CONTEXT, turnQuote].join("\n")), [], "이번 턴 안의 인용 모양은 안 읽음");
});

check("인용 읽기: 이름 없는 머리(`[n] pubkey (시각): 본문`)도, 이름 있는 머리와 섞여도", () => {
  const nameless = QUOTES.replace(`[1] Owner (${HEX})`, `[1] ${HEX}`);
  assert.deepEqual(buzzQuotedMessages([CONTEXT, nameless, EVENT].join("\n")), [
    { pubkey: HEX, time: "2026-09-30T11:24:02+00:00", content: "첫 줄\n둘째 줄 [2] 아님" },
    { pubkey: QHEX, time: "2026-09-30T11:25:00+00:00", content: "답글" },
  ]);
  const one = (head: string) =>
    buzzQuotedMessages([CONTEXT, '<thread-context included="1">', `${head} (2026-09-30T11:24:02Z): x`, "</thread-context>", EVENT].join("\n"));
  assert.equal(one(`[1] ${HEX})`), null, "닫는 괄호만");
  assert.equal(one(`[1] O (${HEX}`), null, "여는 괄호만");
  assert.equal(one(`[1] ${HEX.slice(1)}`), null, "63자리");
  // 본문에 이름 있는 머리 모양이 들어 있어도 이름 없는 머리 자신의 pubkey·시각을 집는다
  const inner = `see Bob (${QHEX}) (2026-09-01T00:00:00Z): tail`;
  assert.deepEqual(
    buzzQuotedMessages([CONTEXT, '<thread-context included="1">', `[1] ${HEX} (2026-09-30T11:24:02Z): ${inner}`, "</thread-context>", EVENT].join("\n")),
    [{ pubkey: HEX, time: "2026-09-30T11:24:02Z", content: inner }]
  );
});

check("인용 읽기: 모양을 모르면 null (→ 정리 안 함)", () => {
  assert.equal(buzzQuotedMessages([CONTEXT, HISTORY, EVENT].join("\n")), null, "번호 줄이 아닌 이력");
  assert.equal(buzzQuotedMessages([CONTEXT, '<thread-context included="1">', `[1] O (${HEX}) (2026-09-30T11:24:02Z): x`, EVENT].join("\n")), null, "이력이 안 닫힘");
  assert.equal(buzzQuotedMessages([CONTEXT, '<thread-context included="1">', `[2] O (${HEX}) (2026-09-30T11:24:02Z): x`, "</thread-context>", EVENT].join("\n")), null, "1번이 아닌 첫 항목");
  assert.equal(buzzQuotedMessages("평범한 메시지"), null);
  assert.equal(buzzQuotedMessages([CONTEXT, QUOTES.replace("(2026-09-30T11:24:02+00:00)", "(어제)"), EVENT].join("\n")), null, "시각 모양이 다름");
});

check("임베딩 입력: 방 정보·이벤트 머리글·래퍼 태그·반복 라벨을 걷고 사람 말만", () => {
  const cleaned = clean(BASE, PREAMBLE, CONTEXT, HISTORY, EVENT)!;
  const out = buzzEmbeddingText(cleaned);
  assert.ok(!out.includes("<context>") && !out.includes("Project slug") && !out.includes("Event ID:"));
  // 래퍼 태그 한 줄과 반복 라벨은 빠지고, 값은 남는다
  assert.ok(!out.includes("<buzz-event"), "래퍼 여는 태그");
  assert.ok(!out.includes("</buzz-event"), "래퍼 닫는 태그");
  assert.ok(!out.includes("Content: ") && !out.includes("From: "), "반복 라벨");
  assert.ok(out.includes("NEW-MESSAGE-SENTINEL please check the deploy"), "본문은 남는다");
  assert.ok(out.includes("Owner"), "보낸 사람 값은 남는다");
  assert.ok(!out.includes("HISTORY-SENTINEL"), "이력은 임베딩에 안 들어간다");
  assert.equal(buzzEmbeddingText(out), out, "두 번 적용해도 같음");
});

check("임베딩 입력: 이력이 끼어 있어도 그 뒤 턴을 찾는다 / 턴이 없으면 그대로", () => {
  assert.equal(buzzEmbeddingText("평범한 메시지"), "평범한 메시지");
  // 정리기가 거절한 봉투(이력 그대로 남은 행)도 이력을 건너뛰고 이번 턴만 임베딩한다.
  // 전에는 원문을 그대로 돌려줘서 이력까지 벡터에 들어갔다 (실측 미정리 31행 전부 ratio 1.000).
  const withHistory = [CONTEXT, HISTORY, EVENT].join("\n");
  const out = buzzEmbeddingText(withHistory);
  assert.notEqual(out, withHistory, "이제는 손댄다");
  assert.ok(!out.includes("HISTORY-SENTINEL"), "이력은 빠진다");
  assert.ok(!out.includes("<context>"), "방 정보도 빠진다");
  assert.ok(out.includes("NEW-MESSAGE-SENTINEL please check the deploy"), "이번 턴은 남는다");
  // 이력 뒤에 턴 블록이 없으면 경계를 모르는 것 → 손대지 않는다
  const historyNoTurn = [CONTEXT, HISTORY].join("\n");
  assert.equal(buzzEmbeddingText(historyNoTurn), historyNoTurn, "이력 뒤에 턴 블록이 없음");
  const contextOnly = CONTEXT + "\n그냥 글";
  assert.equal(buzzEmbeddingText(contextOnly), contextOnly, "context 뒤가 이번 턴 블록이 아님");
});

check("임베딩 입력: 사람이 쓴 비슷한 줄은 남기고, 병적인 줄도 빠르게", () => {
  const turn = [CONTEXT, '<buzz-event type="m">', `Event ID: ${HEX}`, "Kind: 9", "Time: 2026-09-16T09:48:34+00:00",
    "Content: 회의 잡자", "Time: 3pm Thursday", "Kind: urgent", `Tags: [["p","${HEX}"]]`, "</buzz-event>"].join("\n");
  const out = buzzEmbeddingText(turn);
  assert.ok(!out.includes("Event ID:") && !out.includes("Kind: 9") && !out.includes("2026-09-16T") && !out.includes("Tags:"));
  assert.ok(out.includes("Time: 3pm Thursday") && out.includes("Kind: urgent"));
  assert.ok(out.includes("회의 잡자") && !out.includes("Content: 회의 잡자"), "라벨만 떼고 값은 남긴다");
  const t0 = performance.now();
  buzzEmbeddingText(CONTEXT + "\n<buzz-event>\nFrom: x" + " (npub:".repeat(150000) + "\u2028");
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `${ms.toFixed(0)}ms`);
});

check("venue: 버즈 턴의 방 정보에서 자리 읽기", () => {
  const cleaned = clean(BASE, PREAMBLE, CONTEXT, HISTORY, EVENT)!;
  assert.equal(venueFromBuzzContext(cleaned), "buzz:DevRoom");
  assert.equal(venueFromBuzzMessage([BASE, PREAMBLE, CONTEXT, HISTORY, EVENT].join("\n")), "buzz:DevRoom", "원문 봉투도");
  assert.equal(venueFromBuzzMessage([CONTEXT, HISTORY, EVENT].join("\n")), "buzz:DevRoom", "설명서 없는 봉투도");
  const dm = CONTEXT.replace("Scope: thread", "Scope: dm").replace(/Channel: .*/, "Channel: DM (#00000000-0000-0000-0000-000000000001)");
  assert.equal(venueFromBuzzContext(dm + "\n" + EVENT), "buzz:dm");
  assert.equal(venueFromBuzzContext(CONTEXT.replace(/Channel: .*\n/, "") + "\n" + EVENT), "buzz", "채널 줄 없음");
  assert.equal(venueFromBuzzContext("<context>\nUser prefers dark mode\n</context>\n메모"), null, "버즈 아닌 <context>");
  assert.equal(venueFromBuzzContext("평범한 메시지"), null);
});

check("venue: 세션 첫 user 턴으로 자리 가르기", () => {
  assert.equal(classifySessionVenue([CONTEXT, EVENT].join("\n"), "sdk-ts"), "buzz");
  assert.equal(classifySessionVenue("이거 좀 봐줘", "cli"), "terminal");
  assert.equal(classifySessionVenue("너는 팀장 봇이야, Slack #general 채널의 요청을 처리해", "sdk-cli"), "slack");
  assert.equal(classifySessionVenue("매일 점검 스크립트 결과 요약해", "sdk-cli"), "auto");
  assert.equal(classifySessionVenue("옛 기록", undefined), null, "실행 방식 정보 없는 옛 파일");
});

check("venue: 정리가 거절한 봉투도 자기 채널을 읽고, 못 읽으면 앞 턴을 물려받지 않음", () => {
  const other = CONTEXT.replace("DevRoom", "OtherRoom");
  // 거절되는 봉투를 하나 만들어 쓴다 — 이 검사의 주제는 '거절' 이 아니라 '거절돼도 채널은 읽힌다' 다.
  // 옛 재료(인용된 닫는 태그)는 이제 정리된다((나) 블록) → 아직 거절되는 (M) 모양으로 바꿨다.
  const rejected = [BASE, PREAMBLE, other, '<thread-context included="1">', "old", "</thread-context>", "Note: x", EVENT].join("\n");
  assert.equal(cleanBuzzEnvelope(rejected), null, "정리기는 거절");
  assert.equal(buzzTurnVenue(rejected), "buzz:OtherRoom", "채널은 읽음");
  assert.equal(buzzTurnVenue(BASE + "\n<unknown-block>\nZ\n</unknown-block>\n" + EVENT), "buzz", "봉투인데 방 정보를 못 찾음 → buzz");
  assert.equal(buzzTurnVenue("평범한 메시지"), null);
  assert.equal(buzzTurnVenue(CONTEXT.replace("Scope: thread", "Scope?? broken") + "\n" + EVENT), "buzz", "context 뒤 턴 블록인데 Scope 못 읽음 → buzz");
  assert.equal(buzzTurnVenue("<context>\nUser prefers dark mode\n</context>\n그냥 메모"), null, "버즈 턴 모양 아님");
  assert.equal(venueFromBuzzContext(CONTEXT.replace("0000)", "0000)  ") + "\n" + EVENT), "buzz:DevRoom", "채널 줄 끝 공백");
  assert.equal(classifySessionVenue("리팩터 해줘", "claude-vscode"), "terminal");
});

check("venue: <context> 없이 <buzz-event> 로 시작하는 봉투도 자기 채널을 읽는다", () => {
  // 관측된 모양(39행): 블록 바로 뒤 Event ID → Channel → Kind → From → Time → Content
  const solo = (channel: string, ...extra: string[]) =>
    [
      '<buzz-event type="@mention">',
      `Event ID: ${HEX}`,
      `Channel: ${channel}`,
      "Kind: 9",
      `From: Owner (npub: npub1owner, hex: ${HEX})`,
      "Time: 2026-10-31T09:58:25+00:00",
      "Content: SOLO-SENTINEL 이것 좀 봐줘",
      ...extra,
      "</buzz-event>",
    ].join("\n");

  const UUID = "#761cc7a8-e552-475f-a247-352e60a77363";
  assert.equal(venueFromBuzzMessage(solo(`Analyze_Dashboard (${UUID})`)), "buzz:Analyze_Dashboard");
  assert.equal(buzzTurnVenue(solo(`Analyze_Dashboard (${UUID})`)), "buzz:Analyze_Dashboard", "캡처기가 쓰는 자리");

  // (코디 조건 1) 사람 말 안에 다른 채널의 봉투가 인용돼 있어도 **대상 이벤트의 채널**을 쓴다
  const quoted = solo(`Analyze_Dashboard (${UUID})`,
    "인용: <buzz-event type=\"@mention\">", `Channel: OtherRoom (#00000000-0000-0000-0000-000000000000)`, "</buzz-event>");
  assert.equal(venueFromBuzzMessage(quoted), "buzz:Analyze_Dashboard", "인용된 채널을 읽지 않는다");

  // 복수 이벤트 봉투 — `--- Event 1 … ---` 머리가 한 줄 더 붙는다 (관측 7행, 전부 채널 1종)
  const plural = [
    '<buzz-events count="2">',
    "--- Event 1 (@mention) ---",
    `Event ID: ${HEX}`,
    `Channel: DevRoom (#00000000-0000-0000-0000-000000000000)`,
    "Kind: 9",
    "Content: PLURAL-SENTINEL 첫 번째",
    "--- Event 2 (@mention) ---",
    `Event ID: ${HEX}`,
    `Channel: DevRoom (#00000000-0000-0000-0000-000000000000)`,
    "Content: PLURAL-SENTINEL 두 번째",
    "</buzz-events>",
  ].join("\n");
  assert.equal(venueFromBuzzMessage(plural), "buzz:DevRoom", "복수 봉투는 첫 이벤트의 채널");

  // DM — <context> 경로가 `Scope: dm` 으로 내는 값과 같아야 한다 (실측 382행 전부 buzz:dm)
  assert.equal(venueFromBuzzMessage(solo("DM (#50669db7-8637-4739-89e2-67ce1523cd55)")), "buzz:dm");

  // 채널을 uuid 로만 적은 봉투 → null. "buzz" 를 돌려주면 앞 턴 채널을 덮어쓴다
  assert.equal(venueFromBuzzMessage(solo("761cc7a8-e552-475f-a247-352e60a77363")), null, "이름 없는 채널 줄");
  // 🔴 회귀 방지: <new-message-arrived-…> 봉투는 채널을 uuid 로만 적는다 (관측 532행 전부).
  //    여기서 "buzz" 가 나오면 jsonl_capture 의 `own ?? 앞턴` 이 buzz:<채널> 을 덮어쓴다.
  const arrived = [
    "<new-message-arrived-while-you-were-working>",
    "</new-message-arrived-while-you-were-working>",
    "",
    '<buzz-event type="@mention">',
    `Event ID: ${HEX}`,
    "Channel: 34a89613-108d-4693-8599-af1aad3b7fc2",
    "Content: ARRIVED-SENTINEL",
    "</buzz-event>",
  ].join("\n");
  assert.equal(buzzTurnVenue(arrived), null, "새 메시지 봉투는 자리를 만들지 않는다");

  // 머리글이 안 닫힌 봉투(Content 줄 없음) → null. 인용된 채널 줄을 읽을 위험을 피한다
  const noContent = ['<buzz-event type="@mention">', `Event ID: ${HEX}`,
    `Channel: DevRoom (#00000000-0000-0000-0000-000000000000)`, "</buzz-event>"].join("\n");
  assert.equal(venueFromBuzzMessage(noContent), null, "Content 줄 없음");
  // 머리글보다 한참 뒤에 Content 가 오는 봉투도 (상한 12줄)
  const far = solo(`DevRoom (#00000000-0000-0000-0000-000000000000)`)
    .replace("Kind: 9", Array(12).fill("Kind: 9").join("\n"));
  assert.equal(venueFromBuzzMessage(far), null, "머리글 상한 밖");

  // 🔴 <context> 경로는 그대로 — 자리를 못 읽으면 기존처럼 "buzz" (단독 경로로 안 내려간다)
  assert.equal(buzzTurnVenue(CONTEXT.replace("Scope: thread", "Scope?? broken") + "\n" + EVENT), "buzz",
    "<context> 는 찾았지만 Scope 를 못 읽음 → 기존 동작 유지");
  assert.equal(venueFromBuzzMessage([CONTEXT, HISTORY, EVENT].join("\n")), "buzz:DevRoom", "<context> 경로 회귀 없음");

  // 버즈 봉투가 아닌 글은 손대지 않는다
  assert.equal(venueFromBuzzMessage("Channel: DevRoom (#00000000-0000-0000-0000-000000000000)\nContent: 메모"), null,
    "이벤트 블록 없이 채널 줄만 있는 글");
});

check("venue: 큰 기록 파일을 뒤에서 거꾸로 읽어 직전 턴 채널 찾기 (청크 경계·한글)", () => {
  const f = path.join(os.tmpdir(), `venue-tail-${process.pid}.jsonl`);
  const userLine = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
  const filler = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "가나다라마바사".repeat(300) }] } });
  const lines = [userLine([CONTEXT, EVENT].join("\n"))];
  while (lines.join("\n").length < 9 * 1024 * 1024) lines.push(filler);
  fs.writeFileSync(f, lines.join("\n") + "\n");
  const size = fs.statSync(f).size;
  const userText = (l: string) => { try { const d = JSON.parse(l); return d.type === "user" ? String(d.message.content) : null; } catch { return null; } };
  try {
    assert.ok(size > 8 * 1024 * 1024);
    assert.equal(lastBuzzVenueInFile(f, size, userText), "buzz:DevRoom", "청크 여러 개 건너 첫 턴까지");
    assert.equal(lastBuzzVenueInFile(f, 10, userText), null, "범위 안에 턴 없음");
  } finally { fs.unlinkSync(f); }
});

check("반환 본문: <context> 블록만 접고 나머지는 글자 그대로 (행 수정 0)", () => {
  const cleaned = clean(BASE, PREAMBLE, CONTEXT, HISTORY, EVENT)!;
  const out = buzzDisplayText(cleaned);
  assert.ok(!out.includes("<context>") && !out.includes("Project slug"), "방 정보는 접는다");
  // 임베딩용과 달리 전문을 보존한다 — 래퍼·라벨·이벤트 머리글 전부 그대로
  assert.ok(out.startsWith('<buzz-event type="@mention">'), "래퍼로 시작");
  assert.ok(out.includes(`Event ID: ${HEX}`), "이벤트 머리글 보존");
  assert.ok(out.includes("Content: NEW-MESSAGE-SENTINEL please check the deploy"), "라벨째 보존");
  assert.ok(cleaned.endsWith(out), "접은 뒤는 원문의 꼬리와 글자 그대로 같다");
  assert.equal(buzzDisplayText(out), out, "두 번 적용해도 같음");
});

check("반환 본문: 이력은 남기고(유일 사본일 수 있다) 버즈 턴 아니면 손대지 않음", () => {
  const withHistory = [CONTEXT, HISTORY, EVENT].join("\n");
  const out = buzzDisplayText(withHistory);
  assert.ok(out.includes("HISTORY-SENTINEL"), "이력은 반환에 남긴다 — 임베딩과 반대");
  assert.ok(!out.includes("<context>"), "방 정보는 접는다");
  assert.equal(buzzDisplayText("평범한 메시지"), "평범한 메시지");
  const contextOnly = CONTEXT + "\n그냥 글";
  assert.equal(buzzDisplayText(contextOnly), contextOnly, "사람이 <context> 로 시작하는 글을 쓴 경우");
  const historyNoTurn = [CONTEXT, HISTORY].join("\n");
  assert.equal(buzzDisplayText(historyNoTurn), historyNoTurn, "이력 뒤에 턴 블록이 없음");
});

check("임베딩 입력: <context> 없이 턴 블록부터 시작하는 봉투도 걷는다 (관측 217행)", () => {
  // 실데이터 모양: <new-message-arrived-…> 가 첫 블록이고 <context> 가 아예 없다.
  const turnFirst = [
    "<new-message-arrived-while-you-were-working>",
    "</new-message-arrived-while-you-were-working>",
    "",
    '<buzz-event type="@mention">',
    `Event ID: ${HEX}`,
    "Kind: 9",
    // 구버전 봉투 실제 모양: 채널은 이름 없이 uuid, From 은 npub 먼저 (관측 id 93787)
    "Channel: 8d8bbfa3-929c-5a12-b82b-36792a3cae54",
    "From: npub10kemeetk5anw5ye72hefa0rn5j0l5vg9lkhy5mxpx8jvmyjvnw2qs4rglt (hex: " + HEX + ")",
    "Content: TURN-FIRST-SENTINEL colo=LAX 확인했어",
    `Tags: [["p","${HEX}"]]`,
    "</buzz-event>",
  ].join("\n");
  const out = buzzEmbeddingText(turnFirst);
  assert.notEqual(out, turnFirst, "전에는 원문을 그대로 돌려줬다 (봉투째 임베딩)");
  assert.ok(out.includes("TURN-FIRST-SENTINEL colo=LAX 확인했어"), "사람 말은 남는다");
  assert.ok(!out.includes("Event ID:") && !out.includes("Kind: 9") && !out.includes("Tags:"), "머리글 제거");
  assert.ok(!out.includes("<buzz-event") && !out.includes("<new-message-arrived"), "래퍼 태그 줄 제거");
  assert.ok(!out.includes("npub"), "npub 제거");
  assert.ok(!out.includes("8d8bbfa3-929c"), "이름 없는 채널 uuid 도 제거 — 라벨만 떼면 uuid 가 남는다");
  assert.ok(!out.includes(HEX), "hex 공개키 제거");
  assert.ok(!out.includes("Content: ") && !out.includes("From: "), "반복 라벨 제거");
  assert.equal(buzzEmbeddingText(out), out, "두 번 적용해도 같음");
  // 반환 본문은 접을 <context> 가 없으므로 손대지 않는다
  assert.equal(buzzDisplayText(turnFirst), turnFirst, "반환 본문은 <context> 가 없으면 그대로");
  // 턴 블록도 <context> 도 아니면 손대지 않는다
  assert.equal(buzzEmbeddingText("<unknown-block>\nZ\n</unknown-block>"), "<unknown-block>\nZ\n</unknown-block>");
});

check("임베딩 입력: 이름 없는 Parsed 꼬리표와 설명서(<base>) 봉투도 걷는다", () => {
  // Parsed: mentions=[hex]  — 이름·괄호 없는 구버전 (관측 59건). 전에는 hex 가 벡터에 남았다.
  const bare = [CONTEXT, '<buzz-event type="@mention">', "Content: BARE-PARSED-SENTINEL",
    `Parsed: mentions=[${HEX}]`, "</buzz-event>"].join("\n");
  const out = buzzEmbeddingText(bare);
  assert.ok(out.includes("BARE-PARSED-SENTINEL"), "사람 말은 남는다");
  assert.ok(!out.includes(HEX), "이름 없는 mentions 의 hex 도 제거");
  // 이름 있는 변종도 계속 걷힌다 (회귀 방지)
  const named = bare.replace(`mentions=[${HEX}]`, `mentions=[Owner (${HEX})]`);
  assert.ok(!buzzEmbeddingText(named).includes(HEX), "이름 있는 변종 회귀 없음");
  // 사람이 쓴 비슷한 줄은 보존 (hex 가 없으면 꼬리표가 아니다)
  const humanish = bare.replace(`Parsed: mentions=[${HEX}]`, "Parsed: mentions=[나랑 형]");
  assert.ok(buzzEmbeddingText(humanish).includes("나랑 형"), "hex 없는 비슷한 줄은 남긴다");
  // 키 종류·순서가 섞인 변종도 (관측: 스레드 답글의 `parent=…, root=…`, 4건 / 3행)
  for (const tail of [`parent=${HEX}, root=${HEX}`, `root=${HEX}`, `mentions=[Owner (${HEX})]`, `e=${HEX}`]) {
    const v = bare.replace(`Parsed: mentions=[${HEX}]`, `Parsed: ${tail}`);
    assert.ok(!buzzEmbeddingText(v).includes(HEX), `Parsed 변종 '${tail.slice(0, 14)}…' 제거`);
    assert.ok(buzzEmbeddingText(v).includes("BARE-PARSED-SENTINEL"), "사람 말은 남는다");
  }

  // 설명서(<base>) 봉투 (관측 2행) — 전에는 가드에 걸려 설명서째 임베딩됐다
  const withBase = [BASE, PREAMBLE, CONTEXT, EVENT].join("\n");
  const b = buzzEmbeddingText(withBase);
  assert.ok(!b.includes("MANUAL-SENTINEL"), "설명서 본문 제거");
  assert.ok(!b.includes("AGENT-CONFIG") && !b.includes("CORE"), "설정 블록 제거");
  assert.ok(!b.includes("<context>") && !b.includes("Project slug"), "방 정보 제거");
  assert.ok(b.includes("NEW-MESSAGE-SENTINEL please check the deploy"), "이번 턴은 남는다");
  assert.equal(buzzEmbeddingText(b), b, "두 번 적용해도 같음");
});

console.log("all checks passed");
