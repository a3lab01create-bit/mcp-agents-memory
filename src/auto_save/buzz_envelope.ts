/**
 * Buzz ACP 봉투 정리 — 캡처된 user 메시지에서 매 턴 반복되는 봉투를 걷어낸다.
 *
 * Buzz(Nostr 기반 협업 앱)의 ACP 브리지는 에이전트에게 매 턴을 봉투째 넘기고,
 * 일부 어댑터(관측: hermes·grok-cli·opencode·antigravity-cli)는 그것을 user
 * 본문에 넣는다. transcript capture가 그대로 저장하면:
 *
 *   <base>플랫폼 설명서 — 매 턴 동일, ~17k자</base>
 *   <agent-instructions>…</agent-instructions>      에이전트 설정 (매 턴 동일)
 *   <core-memory>…</core-memory>                    (매 턴 동일)
 *   <context>채널·프로젝트 메타 + 응답 규칙</context>
 *   <thread-context …>이전 대화 재인용</thread-context>   (DM·구버전은 conversation-context)
 *   <what-you-were-working-on>… / <buzz-event …>… / <new-message-arrived-while-you-were-working>…
 *
 * (grok-cli 캡처는 블록 사이를 줄바꿈 대신 공백 한 칸으로 잇기도 한다.)
 *
 * 결과: Cold Path 태거가 ctx 초과로 fallback하고, 임베딩(앞 8,000자)은
 * 설명서로만 계산돼 봉투 글끼리 거의 같은 벡터가 된다.
 *
 * cleanBuzzEnvelope()는 설명서·설정·재인용 이력을 빼고 <context>(원문 그대로)
 * + 이번 턴 내용만 남긴 본문을 돌려준다. 원본 보존은 호출자 몫 (hot_path가
 * raw_message 칸에 저장).
 *
 * 설명서를 system 쪽으로 보내는 어댑터(관측: claude-code, hermes 일부)는 <base>와
 * 설정 블록 없이 <context>부터 시작하는 봉투를 남긴다. 이 형태는 `{ baseless: true }`로
 * 부를 때만, <context>에 버즈 표식(`Scope: thread|channel|dm`, `Channel:` 줄)이 있으면
 * 정리한다. 저장 순간(hot path)엔 정리하지 않는다 — 이력(인용)이 에이전트 버즈 답글의
 * 유일한 사본일 수 있어서, buzz-ingest가 인용 글이 전부 버즈 원본 행으로 있는지
 * (buzzQuotedMessages) 확인한 뒤에 정리한다.
 *
 * 봉투는 앞에서부터 순서대로 읽는다. 기대한 자리에 기대한 블록이 없거나 이력
 * 경계가 애매하면 null → 호출자는 원본을 그대로 저장한다. 이력 안에 닫는
 * 태그가 인용된 경우엔 null이거나 이력을 조금 더 남길 뿐, 이번 턴은 자르지 않는다.
 * 봉투가 망가져 버릴 구간에 이번 턴 블록이 섞여 보이면 역시 null.
 */

/** 설명서와 <context> 사이에 오는, 통째로 버리는 블록. */
const PREAMBLE_BLOCKS = ["agent-instructions", "core-memory"];

/** 이전 대화 재인용 블록 (<context> 바로 뒤에 올 때만 이력으로 본다). */
const HISTORY_OPEN = /^\s*<((?:thread|conversation)-context)(?:\s[^>]*)?>/;

/** 이번 턴 내용을 여는 블록. */
const TURN_OPEN = /^\s*<(?:what-you-were-working-on|buzz-events?|new-message-arrived-while-you-were-working)[\s>]/;

/** 버리는 구간(설정·이력)에 이번 턴 블록이 보이면 경계를 잘못 잡은 것 — 손대지 않는다. */
const TURN_IN_DROPPED = /(?:^|>)[ \t]*<(?:what-you-were-working-on|buzz-events?|new-message-arrived-while-you-were-working)[\s>]/m;

const CONTEXT_OPEN = /^<context>\r?\n/;

/**
 * 설명서 없는 봉투를 버즈 턴으로 인정하는 표식: <context> 첫 줄이 Scope이고,
 * Channel 줄이 채널 uuid로 끝난다 (실데이터 915건 전부 이 모양).
 */
const BUZZ_SCOPE = /^Scope: (?:thread|channel|dm)\r?\n/;
const BUZZ_CHANNEL = /(?:^|\n)Channel: .+ \(#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)\r?(?=\n|$)/;
const CONTEXT_CLOSE = "\n</context>";
/**
 * 이력 속 인용 한 건 — buzz-acp가 `[n] 이름 (pubkey) (시각): 본문` 으로 붙인다 (본문은 자르지 않음).
 * 이름이 없으면 `[n] pubkey (시각): 본문` (관측: hermes 2건, 09-26·09-30). 이름 없는 쪽을 먼저 본다 —
 * 반대 순서면 이름 칸의 `.*?`가 본문 속 머리 모양까지 건너가 엉뚱한 pubkey·시각을 집는다.
 */
const QUOTE_ENTRY =
  /^\[(\d+)\] (?:([0-9a-f]{64})|.*? \(([0-9a-f]{64})\)) \((\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))\): ?/;

/**
 * Nostr 이벤트 꼬리표 줄 (hex 태그 배열 / 파싱 요약) — 사람 말이 아님.
 * 사람이 비슷하게 쓴 줄과 헷갈리지 않게 64자리 hex(이벤트·공개키 id)가 있어야 지운다.
 */
function isNostrMetaLine(line: string): boolean {
  return (
    (/^Tags: \[\[".*\]\]\s*$/.test(line) && /[0-9a-f]{64}/.test(line)) ||
    /^Parsed: (?:root=[0-9a-f]{64}|mentions=\[.*\([0-9a-f]{64}\))/.test(line)
  );
}

function skipWhitespace(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/**
 * 버즈용: 봉투 안 <context>의 위치. 설명서(<base>) 봉투면 설명서와 설정 블록을 건너뛰고,
 * <context>로 시작하면 그 자리. 못 찾으면 null. 정리와 venue 읽기가 같이 쓴다
 * (그래서 정리가 거절한 턴도 채널은 읽을 수 있다).
 */
function locateBuzzContext(text: string): { rest: string; pos: number } | null {
  if (!text.startsWith("<base>")) return CONTEXT_OPEN.test(text.slice(0, 12)) ? { rest: text, pos: 0 } : null;
  const baseEnd = text.indexOf("</base>");
  if (baseEnd < 0) return null;
  // 설명서 안에 예시 <context> 등이 있으므로 설명서 뒤부터 읽는다.
  const rest = text.slice(baseEnd + "</base>".length);
  let pos = skipWhitespace(rest, 0);
  for (;;) {
    const name = PREAMBLE_BLOCKS.find((b) => rest.startsWith(`<${b}>`, pos));
    if (!name) break;
    const close = rest.indexOf(`</${name}>`, pos);
    if (close < 0) return null;
    pos = skipWhitespace(rest, close + name.length + 3);
  }
  return CONTEXT_OPEN.test(rest.slice(pos, pos + 12)) ? { rest, pos } : null;
}

export function cleanBuzzEnvelope(message: string, opts: { baseless?: boolean } = {}): string | null {
  try {
    const text = message.trimStart();
    const hasBase = text.startsWith("<base>");
    // 설명서 없는 봉투는 호출자가 이력 보존을 확인했을 때만(buzz-ingest의 인용 확인) 정리한다
    if (!hasBase && !opts.baseless) return null;
    const loc = locateBuzzContext(text);
    if (!loc) return null;
    const { rest, pos } = loc;

    const bodyStart = rest.indexOf("\n", pos) + 1;
    const contextClose = rest.indexOf(CONTEXT_CLOSE, bodyStart - 1);
    if (contextClose < 0) return null;
    const contextBody = rest.slice(bodyStart, contextClose).replace(/\r+$/, "");
    if (!hasBase && !(BUZZ_SCOPE.test(contextBody) && BUZZ_CHANNEL.test(contextBody))) return null;
    const tail = rest.slice(contextClose + CONTEXT_CLOSE.length);

    let turnStart = 0;
    const history = HISTORY_OPEN.exec(tail);
    if (history) {
      // 이력의 첫 닫는 태그가 곧 경계이고, 그 바로 뒤에 이번 턴이 와야 한다.
      // 아니면(이력 안 인용, 형식 변화) 애매하므로 손대지 않는다.
      const closeTag = `</${history[1]}>`;
      const close = tail.indexOf(closeTag, history[0].length);
      if (close < 0) return null;
      turnStart = close + closeTag.length;
    }

    if (TURN_IN_DROPPED.test(rest.slice(0, pos)) || TURN_IN_DROPPED.test(tail.slice(0, turnStart))) return null;

    const turn = tail.slice(turnStart);
    if (!TURN_OPEN.test(turn)) return null;
    const turnText = turn
      .split("\n")
      .filter((line) => !isNostrMetaLine(line))
      .join("\n")
      .trim();
    if (!turnText) return null;

    // <context>는 원문 그대로 둔다: 몇 줄로 줄이면 태거가 채널의 프로젝트를
    // 덜 따라간다 (실측: 16건 중 프로젝트 일치 14 → 11).
    const cleaned = `<context>\n${contextBody}\n</context>\n\n${turnText}`;
    if (cleaned.length >= message.length) return null;
    return cleaned;
  } catch {
    return null;
  }
}

/** 이력 속 인용 한 건 (buzzQuotedMessages가 돌려줌). */
export interface BuzzQuote {
  pubkey: string;
  /** ISO 시각 (버즈 이벤트 created_at, 초 단위) */
  time: string;
  content: string;
}

/**
 * 버즈용: cleanBuzzEnvelope가 걷어낼 이력(<thread-context>/<conversation-context>) 속 인용 글.
 * 정리기와 같은 자리(<context> 바로 뒤 첫 이력 블록, 첫 닫는 태그까지)를 읽는다.
 * 이력이 없으면 [], 모양을 모르면 null → 호출자는 정리하지 않는다.
 */
export function buzzQuotedMessages(message: string): BuzzQuote[] | null {
  try {
    const loc = locateBuzzContext(message.trimStart());
    if (!loc) return null;
    const { rest, pos } = loc;
    const contextClose = rest.indexOf(CONTEXT_CLOSE, pos);
    if (contextClose < 0) return null;
    const tail = rest.slice(contextClose + CONTEXT_CLOSE.length);
    const history = HISTORY_OPEN.exec(tail);
    if (!history) return [];
    const closeTag = `</${history[1]}>`;
    const close = tail.indexOf(closeTag, history[0].length);
    if (close < 0) return null;
    const body = tail.slice(history[0].length, close).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    if (!body.trim()) return [];
    const out: BuzzQuote[] = [];
    for (const line of body.split(/\r?\n/)) {
      const e = QUOTE_ENTRY.exec(line);
      if (e && Number(e[1]) === out.length + 1) {
        out.push({ pubkey: e[2] ?? e[3], time: e[4], content: line.slice(e[0].length) });
      } else if (out.length > 0) {
        out[out.length - 1].content += "\n" + line;
      } else {
        return null;
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 임베딩에서 빼는 이벤트 머리글 줄 (ID·종류·시각·구분선·작업 중 안내문).
 * 사람이 쓴 "Time: 3pm" 같은 줄과 헷갈리지 않게 값 모양까지 맞아야 뺀다.
 */
const EVENT_HEADER =
  /^(?:Event ID: [0-9a-f]{64}|Kind: \d+|Time: \d{4}-\d{2}-\d{2}T\S+|--- Event \d+ \(.*\) ---|Note: A new message arrived while you were working\..*)\s*$/;

/**
 * 봉투 래퍼 줄 — 한 줄이 통째로 여닫는 태그인 것 (`<buzz-event type="…">`, `</buzz-events>` 등).
 * briefing.ts 가 preview 에서 같은 모양을 걷어낸다(거기선 표시용, 여기선 임베딩용).
 */
const WRAPPER_LINE = /^<\/?[a-z-]+(\s[^>]*)?>\s*$/;

/**
 * 봉투가 매 턴 똑같이 붙이는 라벨. 값은 남기고 라벨만 뗀다 — 반복되는 라벨 낱말이
 * 짧은 글의 벡터를 지배해서 봉투 글끼리 뭉치게 만든다 (실측: 임베딩 입력 200자 미만
 * 426행에서 래퍼·라벨이 입력 字의 53.3%).
 */
const EVENT_LABEL = /^(?:Channel|From|Content): /;

/**
 * 라벨을 뗀 뒤 값만 남는 식별자 줄 — 사람 말이 아니다.
 * 구버전 봉투는 `Channel: <uuid>`(이름 없음)·`From: npub1… (hex: …)` 모양이라 아래 이름 치환이
 * 안 걸리고, 라벨만 떼면 uuid·npub·hex 가 그대로 벡터에 들어간다 (관측 218행, 임베딩 입력의 58%).
 */
const IDENTIFIER_ONLY =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|npub1[0-9a-z]{20,}(?:\s*\(hex:\s*[0-9a-f]{64}\))?|[0-9a-f]{64})$/;

/**
 * `</context>` 뒤에서 이번 턴 블록을 찾는다. 바로 오면 그대로, 이력
 * (<thread-context>/<conversation-context>)이 끼어 있으면 그 닫는 태그 뒤부터.
 * 둘 다 아니면 null → 호출자는 원문을 쓴다.
 */
function turnAfterContext(tail: string): string | null {
  if (TURN_OPEN.test(tail)) return tail;
  const history = HISTORY_OPEN.exec(tail);
  if (!history) return null;
  const closeTag = `</${history[1]}>`;
  const close = tail.indexOf(closeTag, history[0].length);
  if (close < 0) return null;
  const rest = tail.slice(close + closeTag.length);
  return TURN_OPEN.test(rest) ? rest : null;
}

/**
 * 봉투에서 `<context>` 뒤(= 이번 턴·이력이 있는 구간)를 돌려준다.
 *   <context>…</context> 로 시작  → 그 뒤
 *   <context> 없이 턴 블록부터 시작 → 받은 그대로 (관측: `<new-message-arrived-…>` 217행)
 * 봉투가 아니면 null.
 */
function envelopeTail(message: string): string | null {
  if (message.startsWith("<context>\n")) {
    const close = message.indexOf(CONTEXT_CLOSE);
    return close < 0 ? null : message.slice(close + CONTEXT_CLOSE.length);
  }
  return TURN_OPEN.test(message) ? message : null;
}

/**
 * 임베딩 입력용 텍스트. 정리된 버즈 턴(<context> 바로 뒤에 이번 턴 블록)이면 방 정보와
 * 이벤트 머리글(ID·종류·시각·npub/hex)을 빼고 사람 말만 남긴다. 저장 본문(message)은
 * 그대로다 — 방 정보는 태깅엔 도움이 되지만(프로젝트 slug) 임베딩에선 모든 행에 같은
 * 성분을 섞어 주제 차이를 흐린다 (검색 시험: 상위10 정확 29→33, nDCG 0.761→0.813).
 * 모양이 다르면(이전 대화 블록이 끼어 있는 등) 받은 그대로 돌려준다.
 *
 * <context> 가 아예 없고 이번 턴 블록부터 시작하는 봉투도 있다 — 관측: `<new-message-arrived-…>`
 * 로 시작하는 217행. 전에는 `startsWith("<context>\n")` 가드에 걸려 **봉투째 임베딩**됐다
 * (표본 200/200 이 원문 그대로 반환). 그 모양도 턴 블록으로 인정한다.
 */
export function buzzEmbeddingText(message: string): string {
  try {
    const tail = envelopeTail(message);
    if (tail === null) return message;
    const turn = turnAfterContext(tail);
    if (turn === null) return message;
    const text = turn
      .split("\n")
      .filter(
        (line) => !EVENT_HEADER.test(line) && !isNostrMetaLine(line) && !WRAPPER_LINE.test(line.trim())
      )
      .map((line) =>
        // `$` 없이: 끝까지 되짚는 역추적을 막는다 (긴 줄에서 제곱 시간)
        line
          .replace(/^From: (.*?) \(npub:.*/, "From: $1")
          .replace(/^Channel: (\S+) \(#[0-9a-f-]+\)/, "Channel: $1")
          .replace(EVENT_LABEL, "")
      )
      // 라벨을 뗀 뒤 식별자만 남은 줄은 버린다 (구버전 봉투의 uuid·npub·hex)
      .filter((line) => !IDENTIFIER_ONLY.test(line.trim()))
      .join("\n")
      .trim();
    return text || message;
  } catch {
    return message;
  }
}

/**
 * 검색 결과 반환용 본문. 정리된 버즈 턴이면 매 턴 같은 <context> 블록(방 메타데이터·답장
 * 지시문)을 떼고 그 뒤를 그대로 돌려준다 — 자리는 결과의 venue 칸이, 프로젝트는 p_tag 칸이
 * 대신한다 (briefing.ts:rowToMsg 가 같은 이유로 preview 에서 떼고 있다). 줄바꿈은 보존한다:
 * briefing 은 한 줄로 접지만 검색은 전문이 필요하다.
 *
 * 저장 본문(message)·raw_message·태깅은 건드리지 않는다 — 읽기 시점 변환이라 행 수정이 0이고,
 * 태거가 방 정보를 보고 프로젝트를 따라가는 근거와 충돌하지 않는다.
 * 실측: 대조군 두 쿼리의 top10 반환 字에서 <context> 몫이 48.0% / 59.2%.
 */
export function buzzDisplayText(message: string): string {
  try {
    if (!message.startsWith("<context>\n")) return message;
    const close = message.indexOf(CONTEXT_CLOSE);
    if (close < 0) return message;
    const tail = message.slice(close + CONTEXT_CLOSE.length).replace(/^\r?\n+/, "");
    // 버즈 턴 모양이 아니면(사람이 <context> 로 시작하는 글을 쓴 경우 등) 손대지 않는다
    if (turnAfterContext(tail) === null) return message;
    return tail || message;
  } catch {
    return message;
  }
}

/**
 * 버즈용: <context>로 시작하는 버즈 턴(정리본, 또는 설명서 없는 봉투)에서 venue를 읽는다.
 *   Scope: dm                          → "buzz:dm"
 *   Scope: thread|channel + Channel: X (#uuid) → "buzz:X"
 *   버즈 턴인데 채널 줄을 못 읽음        → "buzz"
 * 버즈 턴이 아니면 null.
 */
export function venueFromBuzzContext(message: string): string | null {
  if (!CONTEXT_OPEN.test(message.slice(0, 12))) return null;
  const end = message.indexOf(CONTEXT_CLOSE);
  if (end < 0) return null;
  const lines = message.slice(0, end).split("\n").map((l) => l.replace(/\r$/, ""));
  const scope = lines.find((l) => l.startsWith("Scope: "))?.slice("Scope: ".length).trim();
  if (scope !== "thread" && scope !== "channel" && scope !== "dm") return null;
  if (scope === "dm") return "buzz:dm";
  const channel = lines.find((l) => l.startsWith("Channel: "))?.trimEnd();
  const m = channel ? /^Channel: (.+?) \(#[0-9a-f-]{36}\)$/.exec(channel) : null;
  return m ? `buzz:${m[1]}` : "buzz";
}

/**
 * 버즈용: 버즈 턴 모양인지 — 설명서 봉투(<base>…)이거나, <context> 바로 뒤에 이번 턴
 * 블록이 오는 정리본/설명서 없는 봉투. 채널을 못 읽더라도 버즈 턴임을 알 때 쓴다.
 */
export function looksLikeBuzzTurn(message: string): boolean {
  const text = message.trimStart();
  if (text.startsWith("<base>")) return true;
  if (!CONTEXT_OPEN.test(text.slice(0, 12))) return false;
  const close = text.indexOf(CONTEXT_CLOSE);
  return close >= 0 && TURN_OPEN.test(text.slice(close + CONTEXT_CLOSE.length));
}

/** 버즈용: 원문 봉투(<base>…)든 정리본이든 venue를 읽는다 — 정리가 거절한 턴도. */
export function venueFromBuzzMessage(message: string): string | null {
  try {
    const loc = locateBuzzContext(message.trimStart());
    return loc ? venueFromBuzzContext(loc.rest.slice(loc.pos)) : null;
  } catch {
    return null;
  }
}
