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
 * **이 보존 조건은 정리(cleanBuzzEnvelope)뿐 아니라 인용 읽기·임베딩·표시 전부에서 성립해야 한다**
 * — 그래서 경계와 안전성을 historyBoundary 한 곳에서 같이 판정한다.
 * 봉투가 망가져 버릴 구간에 이번 턴 블록이 섞여 보이면 역시 null. 단 이력 구간에서는
 * 인용 글 본문 속 언급(봉투 얘기를 하며 붙여 넣은 `<buzz-event …>` 등)은 블록으로 보지 않는다
 * — historyHidesTurn.
 */

/** 설명서와 <context> 사이에 오는, 통째로 버리는 블록. */
const PREAMBLE_BLOCKS = ["agent-instructions", "core-memory"];

/** 이전 대화 재인용 블록 (<context> 바로 뒤에 올 때만 이력으로 본다). */
const HISTORY_OPEN = /^\s*<((?:thread|conversation)-context)(?:\s[^>]*)?>/;

/** 이번 턴 내용을 여는 블록. */
const TURN_OPEN = /^\s*<(?:what-you-were-working-on|buzz-events?|new-message-arrived-while-you-were-working)[\s>]/;

/** 버리는 구간(설정·이력)에 이번 턴 블록이 보이면 경계를 잘못 잡은 것 — 손대지 않는다. */
const TURN_IN_DROPPED = /(?:^|>)[ \t]*<(?:what-you-were-working-on|buzz-events?|new-message-arrived-while-you-were-working)[\s>]/m;

/**
 * 진짜 이번 턴 블록이 여는 모양: 줄 전체가 턴 태그 하나 (줄 맨 앞, 또는 grok-cli처럼 앞 블록의 `>`
 * 바로 뒤에서 줄 끝까지). 실측: 이력 뒤 이번 턴 1,125건 전부 이 모양. 인용 글 속 언급은 대개
 * 들여쓰기·뒤에 붙은 글·이스케이프(`\"`, `\n`)가 있어 걸리지 않는다.
 */
const TURN_LINE = /(?:^|>[ \t]*)<(?:what-you-were-working-on|buzz-events?|new-message-arrived-while-you-were-working)(?:\s[^>\n]*)?>[ \t]*\r?$/m;

const CONTEXT_OPEN = /^<context>\r?\n/;

/**
 * 설명서 없는 봉투를 버즈 턴으로 인정하는 표식: <context> 첫 줄이 Scope이고,
 * Channel 줄이 채널 uuid로 끝난다 (실데이터 915건 전부 이 모양).
 */
const BUZZ_SCOPE = /^Scope: (?:thread|channel|dm)\r?\n/;
const BUZZ_CHANNEL = /(?:^|\n)Channel: .+ \(#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)\r?(?=\n|$)/;
const CONTEXT_CLOSE = "\n</context>";

/**
 * 방 정보·이벤트 머리글의 채널 줄. **<context> 경로와 단독 이벤트 경로가 같은 상수를 쓴다** —
 * 따로 쓰면 한쪽만 고쳐져 두 경로의 자리 값이 갈린다.
 */
const CHANNEL_LINE = /^Channel: (.+?) \(#[0-9a-f-]{36}\)$/;

/**
 * <context> 없이 이벤트 블록부터 시작하는 봉투 — `<buzz-event …>` / `<buzz-events count="n">`.
 * 다른 턴 블록(`<new-message-arrived-…>`·`<what-you-were-working-on>`)은 **일부러 제외한다**:
 * 전자는 채널을 uuid 로만 적어(관측 532행 전부) 이름을 못 읽고, 후자는 자유 서술이라
 * 사람 말 속 `Channel:` 줄을 머리글로 오독할 수 있다.
 */
const EVENT_ONLY_OPEN = /^<(buzz-events?)[\s>]/;

/** 이벤트 머리글의 끝 = 사람 말이 시작되는 줄. 여기서 멈춰야 인용된 봉투의 채널을 읽지 않는다. */
const EVENT_CONTENT_LINE = /^Content: /;

/**
 * 복수 봉투(`<buzz-events count="n">`)에서 이벤트 하나가 시작되는 줄.
 * 🔴 **단독 봉투(`<buzz-event …>`)에서는 이 줄을 보지 않는다.** 사람 말이 이 모양을 인용하면
 *    인용된 채널이 **진짜 머리글을 밀어내고** 자리가 된다(코디 반례: `RealRoom` → `buzz:QuotedRoom`).
 * 복수 봉투에서도 첫 경계가 첫 `Content:` 뒤에 있으면 그 "경계"는 사람 말 속 인용이므로 null.
 */
const EVENT_BOUNDARY = /^--- Event \d+ \(.*\) ---$/;

/**
 * 이벤트 **하나**의 머리글을 찾는 줄 수 상한. 실측(단독 이벤트 39행, 2026-11-06): 채널 줄은
 * 3행(단독)·4행(복수 — `--- Event 1 (…) ---` 머리가 한 줄 더 붙는다), `Content:` 줄은 7·8행이다.
 */
const EVENT_HEADER_LINES = 12;

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
    // `Parsed:` 꼬리표의 키는 순서·종류가 섞인다 — 관측: `root=`, `mentions=[이름 (hex)]`,
    // `mentions=[hex]`(이름 없는 구버전), `parent=…, root=…`(스레드 답글, 관측 4건 / 3행).
    // 그래서 특정 키로 앵커하지 말고 **첫 키가 hex 값을 갖는 꼬리표**인지로 본다.
    /^Parsed: (?:[a-z_]+=(?:\[(?:.*\()?)?[0-9a-f]{64})/.test(line)
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

/**
 * 이력 블록(<thread-context>/<conversation-context>) 경계 판정 — **세 자리가 같은 결정을 쓴다**
 * (cleanBuzzEnvelope · buzzQuotedMessages · turnAfterContext). 따로 구현하면 "정리는 거절했는데
 * 인용은 읽었다" 처럼 서로 다른 경계를 쓰는 비대칭이 생긴다.
 *
 *   none    이력 블록이 없다 (= `</context>` 뒤가 바로 이번 턴)
 *   span    경계를 하나로 정했다
 *   unknown 이력은 있는데 경계를 못 정했다 → 호출자는 **손대지 않는다**(원문 보존)
 */
type HistoryBoundary =
  | { kind: "none" }
  | { kind: "span"; bodyStart: number; bodyEnd: number; turnStart: number }
  | { kind: "unknown" };

function historyBoundary(tail: string): HistoryBoundary {
  const history = HISTORY_OPEN.exec(tail);
  if (!history) return { kind: "none" };
  const closeTag = `</${history[1]}>`;
  const bodyStart = history[0].length;
  // 경계 후보 = **바로 뒤에 이번 턴 블록이 오는** 닫는 태그. 봉투 얘기를 하며 인용한 닫는 태그는
  // 뒤에 사람 말이 이어지므로 걸리지 않는다 (그래서 그 자리를 건너뛴다).
  //
  // 실측(이력 있는 봉투 1,945행, 2026-11-01): 이 조건만으로 후보가 **전 행에서 정확히 1개**다.
  // 경계가 기존(첫 닫는 태그)과 갈리는 행은 4행뿐 — 전부 봉투 태그를 본문에 인용해 보류됐던 행이다.
  // 🔴 "줄 머리에 있는 닫는 태그"를 조건에 넣으면 안 된다: grok-cli 형식은 진짜 경계가 줄 중간
  //    (`old</thread-context> <buzz-event …>`)이고 인용된 쪽이 줄 머리라, **엉뚱한 경계를 고른다**(검사 L).
  // 🔴 코드펜스(```) 짝으로 거르는 것도 안 된다: 인용 본문의 펜스 짝이 안 맞는 32행에서 진짜 경계가
  //    "펜스 안"으로 계산돼 **판별력 0에 32행 순손실**이었다.
  // **적합 후보 중 가장 이른 것**을 쓴다 — 이력을 더 남기는 쪽이다. 인용된 닫는 태그를 건너뛰면
  // 경계는 기존 동작(첫 닫는 태그)보다 **뒤로 간다** → 버릴 구간이 커진다. 그 건너뛴 구간에 진짜 턴
  // 블록이 들어오면 이번 턴을 자르게 되므로, **건너뛴 경우에만** 안전성을 따로 본다(movedPast).
  // 🔴 그 판정은 **여기(경계 판정) 안에** 있어야 한다 — 소비 경로마다 따로 걸면 한 곳이 빠진다.
  //    실제로 turnAfterContext 엔 가드가 없어서, 정리는 거절하는 입력에서 **임베딩만 본문을 잘랐다**
  //    (임베딩 입력 350자 → 11자. 검사 "경계를 뒤로 옮길 때 … 임베딩·표시도 본문을 지킨다").
  // 🔴 반대로 **건너뛰지 않은 행에까지** 이 가드를 걸면 안 된다 — 경계가 main 과 같은데도 임베딩이
  //    봉투째가 된다(실측 107008·107120: 4,820B → 53,191B). 이 PR 이 만들지 않은 위험까지 떠안는 것이다.
  //    그 2행은 cleanBuzzEnvelope 가 자기 가드로 계속 거절한다(main 과 같다).
  //    🔴 이 범위 제한의 근거는 "읽기 경로는 안전하다"가 **아니다** — 읽기 경로도 자른다(위의 임베딩 사례).
  //    근거는 "이 변경이 **새로 만든** 위험(경계를 뒤로 옮기는 것)에만 가드를 건다" 하나다.
  for (let close = tail.indexOf(closeTag, bodyStart), movedPast = false;
       close >= 0;
       close = tail.indexOf(closeTag, close + 1), movedPast = true) {
    const turnStart = close + closeTag.length;
    if (!TURN_OPEN.test(tail.slice(turnStart))) continue;
    if (movedPast && historyHidesTurn(tail.slice(0, close), tail.slice(bodyStart, close))) {
      return { kind: "unknown" };
    }
    return { kind: "span", bodyStart, bodyEnd: close, turnStart };
  }
  return { kind: "unknown" };
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

    // 경계는 historyBoundary 가 정한다 (세 자리가 같은 결정을 쓴다 — 건너뛴 경우의 안전성까지 그 안에서).
    const hist = historyBoundary(tail);
    if (hist.kind === "unknown") return null;
    let turnStart = 0;
    if (hist.kind === "span") {
      // 정리는 경계를 건너뛰지 않았어도, 이력 안에 진짜 턴 블록 모양이 있으면 거절한다
      // (관측 107008·107120 — main 부터의 동작이고 이 PR 은 그대로 둔다).
      // ⚠️ 임베딩·표시가 그 2행에서 이력을 걷는 것은 **미해결 비대칭**이다. "읽기라서 안전" 하거나
      //    "닫는 태그가 하나라 항상 명확" 해서가 아니다 — 별도 검토 필요(본문 보존 + 임베딩 품질).
      if (historyHidesTurn(tail.slice(0, hist.bodyEnd), tail.slice(hist.bodyStart, hist.bodyEnd))) return null;
      turnStart = hist.turnStart;
    }

    if (TURN_IN_DROPPED.test(rest.slice(0, pos))) return null;

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
    const hist = historyBoundary(tail);
    if (hist.kind === "none") return [];
    if (hist.kind === "unknown") return null;
    return parseQuoteBody(tail.slice(hist.bodyStart, hist.bodyEnd));
  } catch {
    return null;
  }
}

/** 이력 블록 본문(여닫는 태그 사이)을 `[n] …` 인용 글로 읽는다. 비었으면 [], 모양을 모르면 null. */
function parseQuoteBody(raw: string): BuzzQuote[] | null {
  const body = raw.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
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
}

/**
 * 이력 구간(여는 태그~첫 닫는 태그 앞)에 이번 턴 블록이 숨어 있을 수 있는지.
 * 턴 태그가 보여도 본문이 `[n]` 인용 글로 다 읽히고 진짜 블록 모양(TURN_LINE)이 아니면
 * 인용 글 속 언급이다 (관측 10-05: 봉투 정리 작업을 버즈에서 얘기하며 붙여 넣은 예시 때문에
 * 거절된 12행 중 10행. 나머지 2행은 인용 속에 줄 전체가 턴 태그인 예시가 있어 계속 거절).
 * 이력이 안 닫혔는데 이번 턴 본문 속 닫는 태그를 경계로 잡은 경우엔 진짜 턴 블록이 이
 * 구간에 TURN_LINE 모양으로 들어 있으므로 여전히 거절된다.
 */
function historyHidesTurn(dropped: string, body: string): boolean {
  if (!TURN_IN_DROPPED.test(dropped)) return false;
  return TURN_LINE.test(dropped) || parseQuoteBody(body) === null;
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
  const hist = historyBoundary(tail);
  if (hist.kind !== "span") return null;
  const rest = tail.slice(hist.turnStart);
  return TURN_OPEN.test(rest) ? rest : null;
}

/**
 * 봉투에서 `<context>` 뒤(= 이번 턴·이력이 있는 구간)를 돌려준다.
 *   <context>…</context> 로 시작  → 그 뒤
 *   <context> 없이 턴 블록부터 시작 → 받은 그대로 (관측: `<new-message-arrived-…>` 217행)
 * 봉투가 아니면 null.
 */
function envelopeTail(message: string): string | null {
  // 설명서(<base>) 봉투: 설명서·설정 블록을 건너뛴 자리에서 <context> 를 찾는다 (관측 2행, 둘 다 수만 字)
  const loc = message.startsWith("<base>") ? locateBuzzContext(message) : null;
  const text = loc ? loc.rest.slice(loc.pos) : message;
  if (text.startsWith("<context>\n")) {
    const close = text.indexOf(CONTEXT_CLOSE);
    return close < 0 ? null : text.slice(close + CONTEXT_CLOSE.length);
  }
  return TURN_OPEN.test(text) ? text : null;
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
  const m = channel ? CHANNEL_LINE.exec(channel) : null;
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

/**
 * 버즈용: `<context>` 없이 `<buzz-event …>` 로 바로 시작하는 봉투에서 자리를 읽는다.
 * (관측 39행, 전부 `codex-mcp-client` = MCP `save_message` 경로 → `hot_path.ts` 가 자리를 읽는 자리.
 *  그중 2행은 세션에 앞선 버즈 턴이 없어 물려받을 값도 없이 venue 가 NULL 로 남았다.)
 *
 * 머리글의 `Channel: <이름> (#uuid)` 줄만 본다 — 이벤트마다 **`Content:` 줄 앞까지, 최대 12줄**.
 * 사람 말 안에 인용된 봉투의 채널 줄은 `Content:` 뒤에 오므로 구조적으로 닿지 않는다.
 *
 * 🔴 복수 봉투(`<buzz-events count="n">`)는 **이벤트를 하나씩 다 읽고, 각 이벤트의 채널을 하나로
 *    확정한 뒤, 그 이름들이 전부 같을 때만** 쓴다. 이벤트가 하나라도 머리글을 못 읽거나
 *    (`Content:` 없음·상한 밖) 채널을 하나로 확정하지 못하면(uuid 뿐·줄 없음·둘 이상) 통째로 null.
 *    코디 리뷰에서 이 경로로 세 번 틀렸다 — ①첫 `Content:` 앞까지만 봐서 둘째 이벤트에 못 닿음
 *    ②단독 봉투가 본문에 인용한 경계를 머리글로 읽어 **인용된 채널이 진짜 채널을 밀어냄**
 *    ③채널 이름을 전체 공용으로 모아 세서 둘째 채널을 못 읽어도 첫 이름으로 통과.
 *
 * `Channel:` 을 uuid 로만 적은 봉투는 **null** 이다 — 거기서 `"buzz"` 를 돌려주면 안 된다:
 * 캡처기들이 `venue = own ?? 앞턴` (jsonl_capture.ts:373) 또는 `if (own) 앞턴 = own`
 * (codex_capture.ts:559 · grok_capture.ts:248 · antigravity_capture.ts:245)로 쓰기 때문에, 채널 없는 `"buzz"` 가
 * 물려받은 `buzz:<채널>` 을 덮어쓴다(실측 532행이 그 모양이다).
 * 같은 이유로 `looksLikeBuzzTurn` 은 **건드리지 않는다**.
 *
 * 이름이 `DM` 이면 `buzz:dm` — `<context>` 경로가 `Scope: dm` 으로 내는 값과 맞춘다.
 * 근거: `Channel: DM (#uuid)` 인 382행의 venue 가 **전부** `buzz:dm` 이다(예외 0건, 2026-11-06).
 */
function venueFromBuzzEvent(text: string): string | null {
  const open = EVENT_ONLY_OPEN.exec(text);
  if (!open) return null;
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "").trimEnd());
  const firstContent = lines.findIndex((l) => EVENT_CONTENT_LINE.test(l));
  let events: string[][];
  if (open[1] === "buzz-event") {
    // 단독 봉투: 전체가 한 이벤트다. 경계 줄은 **보지 않는다** — 본문이 인용한 경계를 머리글로
    // 읽으면 인용된 채널이 진짜 채널을 밀어낸다.
    events = [lines];
  } else {
    const starts = lines.flatMap((l, i) => (EVENT_BOUNDARY.test(l) ? [i] : []));
    // 경계가 없으면 이벤트를 가를 수 없다. 첫 경계가 첫 `Content:` 뒤면 그건 사람 말 속 인용이다.
    if (!starts.length || (firstContent >= 0 && starts[0] > firstContent)) return null;
    events = starts.map((from, k) => lines.slice(from, starts[k + 1] ?? lines.length));
  }
  const names = new Set<string>();
  for (const event of events) {
    const head = event.slice(0, EVENT_HEADER_LINES);
    const end = head.findIndex((l) => EVENT_CONTENT_LINE.test(l));
    if (end < 0) return null; // 머리글이 안 닫힌다 → 인용된 채널 줄을 읽을 위험
    // 🔴 이벤트**마다** 채널을 하나로 확정한다. 모아놓고 한 번만 세면, 둘째 이벤트의 채널을
    //    못 읽어도(uuid 뿐·줄 없음) 첫 이벤트 이름 하나로 통과한다 — 코디 반례.
    const own = new Set<string>();
    for (const line of head.slice(0, end)) {
      const m = CHANNEL_LINE.exec(line);
      if (m) own.add(m[1]);
    }
    if (own.size !== 1) return null;
    for (const name of own) names.add(name);
  }
  if (names.size !== 1) return null; // 이벤트들이 서로 다른 채널이다
  const [name] = names;
  return name === "DM" ? "buzz:dm" : `buzz:${name}`;
}

/**
 * 버즈용: 원문 봉투(<base>…)든 정리본이든 venue를 읽는다 — 정리가 거절한 턴도.
 * `<context>` 가 아예 없으면 단독 이벤트 봉투(`<buzz-event …>`)로 한 번 더 본다.
 */
export function venueFromBuzzMessage(message: string): string | null {
  try {
    const text = message.trimStart();
    const loc = locateBuzzContext(text);
    // 🔴 `<context>` 를 찾았는데 자리를 못 읽은 경우로는 내려오지 않는다 — 그 경로의 기존 동작
    //    (Scope 를 못 읽으면 `buzz`)을 바꾸지 않기 위해서다.
    return loc ? venueFromBuzzContext(loc.rest.slice(loc.pos)) : venueFromBuzzEvent(text);
  } catch {
    return null;
  }
}
