/**
 * Cold-path 공통 — 로컬 모델 ctx(기본 8192) 안에 user 메시지를 맞추는 토큰 예산 헬퍼.
 *
 * 문제: librarian / ProjectAliasPromoter 처럼 "user 메시지 N개를 프롬프트에 모아
 * 넣는" 역할이, 사용자가 붙여넣은 거대 터미널 덤프(base64/JSON 등) 한두 개 때문에
 * ctx를 초과해 `400 ... exceeds context size` 로 실패해 왔다. count cap만으론 못 막음
 * (긴 메시지 하나가 슬롯 전체를 잡아먹음). → 토큰 예산으로 근본 해결.
 *
 * 전략:
 *   1. 메시지별 head-clip (perMsgCharCap) — 거대 outlier만 자르고 일반 대화는 보존.
 *      잘린 메시지엔 마커를 붙여 모델이 "잘렸음"을 인지하게 함.
 *   2. /tokenize 로 정확 측정 (char 추정 X — 덤프는 토큰 밀도가 높아 char비율이 안 맞음).
 *      엔드포인트 없으면 보수적 char≈token (1:1) 폴백 → 과하게 자를지언정 초과는 안 함.
 *   3. 메시지 예산 = ctxSize − outputReserve − margin − tokens(고정부=system+profile+scaffold).
 *   4. 초과 시 historical(정체성 앵커) 부터 oldest 순으로 drop → 그래도 넘으면 recent를
 *      더 강하게 clip. recent(현재 활동)는 최대한 보존.
 */

const DEFAULT_CTX = 8192;
const DEFAULT_OUTPUT_RESERVE = 2048;
const DEFAULT_MARGIN = 256;
const DEFAULT_PER_MSG_CHAR_CAP = 1500;
/** formatRows 등 메시지당 래핑(인덱스/타임스탬프/구분자) 토큰 보수 추정. */
const PER_MSG_FORMAT_TOKENS = 24;

export interface BudgetRow {
  message: string;
  [k: string]: unknown;
}

export interface BudgetOptions {
  recent: BudgetRow[];
  historical: BudgetRow[];
  /** 메시지 외 고정 입력 전체 (system prompt + 기존 profile + scaffold 텍스트). 토큰 계산용. */
  overheadText: string;
  ctxSize?: number;
  outputReserve?: number;
  margin?: number;
  perMsgCharCap?: number;
}

export interface BudgetResult {
  recent: BudgetRow[];
  historical: BudgetRow[];
  stats: {
    clippedMessages: number;
    droppedHistorical: number;
    droppedRecent: number;
    estMessageTokens: number;
    messageBudget: number;
    usedTokenizer: boolean;
    /** 모든 단계 후에도 예산 초과면 true (요청이 ctx 초과로 실패할 수 있음). */
    overBudget: boolean;
  };
}

/** llama.cpp /tokenize URL (LOCAL_LLM_BASE_URL 에서 /v1 떼고 /tokenize). */
function tokenizeUrl(): string {
  const base = process.env.LOCAL_LLM_BASE_URL ?? "http://localhost:11434/v1";
  return base.replace(/\/v1\/?$/, "") + "/tokenize";
}

/**
 * /tokenize 로 토큰 수. 실패(엔드포인트 없음/타임아웃/ollama 등) 시 null.
 * 호출자는 null이면 보수적 char-기반 폴백 사용.
 */
export async function tokenizeCount(text: string): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(tokenizeUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const j: any = await res.json();
    return Array.isArray(j?.tokens) ? j.tokens.length : null;
  } catch {
    return null;
  }
}

/** 토큰 수 측정 — /tokenize 우선, 실패 시 보수적 char≈token(1:1) 폴백. */
async function countTokens(
  text: string
): Promise<{ tokens: number; usedTokenizer: boolean }> {
  const t = await tokenizeCount(text);
  if (t !== null) return { tokens: t, usedTokenizer: true };
  // 폴백: UTF-8 바이트 수를 토큰 상한으로 간주. char 수(UTF-16 code unit)는 한글에서
  // 토큰을 과소평가함(한글 1자 ≈ 3바이트 → BPE 토큰 여러 개 가능). byte 기준이라야
  // 진짜 보수적 상한 → 과대추정될지언정 ctx 초과는 안 함.
  return { tokens: Buffer.byteLength(text, "utf8"), usedTokenizer: false };
}

/** head-clip: cap 초과 시 앞부분만 남기고 마커 부착. */
function clipMessage(message: string, cap: number): { text: string; clipped: boolean } {
  if (message.length <= cap) return { text: message, clipped: false };
  const head = message.slice(0, cap);
  const removed = message.length - cap;
  return { text: `${head}\n…[${removed} chars clipped]`, clipped: true };
}

function joinBodies(rows: BudgetRow[]): string {
  return rows.map((r) => r.message).join("\n\n");
}

/**
 * 메시지를 ctx 예산에 맞게 clip/drop. recent(현재 활동) 우선 보존, historical(앵커) 먼저 희생.
 * tokenize 호출 수는 historical.length + cap 반감 횟수 + recent drop 수로 자연 제한
 * (2h 주기 작업이라 호출 수보다 정확성 우선).
 *
 * 단계: 1) 메시지별 head-clip → 2) historical drop(oldest) → 3) recent 재clip(cap 반감)
 *       → 4) recent drop(oldest, 최후수단). 4 후에도 초과면 stats.overBudget=true + 경고.
 */
export async function budgetMessages(opts: BudgetOptions): Promise<BudgetResult> {
  const ctxSize = opts.ctxSize ?? DEFAULT_CTX;
  const outputReserve = opts.outputReserve ?? DEFAULT_OUTPUT_RESERVE;
  const margin = opts.margin ?? DEFAULT_MARGIN;
  let perMsgCharCap = opts.perMsgCharCap ?? DEFAULT_PER_MSG_CHAR_CAP;

  const overhead = await countTokens(opts.overheadText);
  const usedTokenizer = overhead.usedTokenizer;

  // 메시지 섹션이 쓸 수 있는 토큰 예산.
  const messageBudget = Math.max(
    0,
    ctxSize - outputReserve - margin - overhead.tokens
  );

  let clippedMessages = 0;
  const clipRows = (rows: BudgetRow[], cap: number): BudgetRow[] =>
    rows.map((r) => {
      const c = clipMessage(r.message, cap);
      if (c.clipped) clippedMessages++;
      return { ...r, message: c.text };
    });

  // 1차: 모두 perMsgCharCap 으로 clip.
  let recent = clipRows(opts.recent, perMsgCharCap);
  let historical = clipRows(opts.historical, perMsgCharCap);
  let droppedHistorical = 0;

  const estTokens = async (): Promise<number> => {
    const formatOverhead =
      (recent.length + historical.length) * PER_MSG_FORMAT_TOKENS;
    const { tokens } = await countTokens(
      joinBodies(historical) + "\n\n" + joinBodies(recent)
    );
    return tokens + formatOverhead;
  };

  let est = await estTokens();

  // 2차: 초과하면 historical(앵커) 을 oldest(앞) 부터 한 개씩 drop. historical 소진까지.
  // (phase 독립 — 카운터 공유 금지: historical drop 이 phase3 안전망을 굶기면 안 됨)
  while (est > messageBudget && historical.length > 0) {
    historical = historical.slice(1); // ASC 정렬 → 앞이 oldest
    droppedHistorical++;
    est = await estTokens();
  }

  // 3차: historical 다 버려도 초과 → recent 를 더 강하게 clip (cap 반감, 하한 200자).
  while (est > messageBudget && perMsgCharCap > 200) {
    perMsgCharCap = Math.floor(perMsgCharCap / 2);
    clippedMessages = 0;
    recent = clipRows(opts.recent, perMsgCharCap);
    historical = []; // 이미 다 버린 상태 유지
    est = await estTokens();
  }

  // 4차 안전망: recent 를 floor 까지 clip 했는데도 초과 → oldest recent 부터 drop.
  // 현재 활동 손실이라 최후수단이지만, 그래도 ctx 초과로 400 나는 것보단 낫다.
  // (예: overheadText 가 비정상적으로 크거나, 단일 recent 가 floor 에서도 거대한 경우)
  let droppedRecent = 0;
  while (est > messageBudget && recent.length > 1) {
    recent = recent.slice(1); // ASC → 앞이 oldest
    droppedRecent++;
    est = await estTokens();
  }

  const overBudget = est > messageBudget;
  if (overBudget) {
    // 모든 단계 후에도 안 맞음 — silent re-400 방지 위해 크게 경고 (관측 가능하게).
    console.error(
      `⚠️ [context_budget] 예산 초과 잔존: est=${est} > budget=${messageBudget} ` +
        `(recent=${recent.length}, perMsgCharCap=${perMsgCharCap}). ` +
        `overheadText 과대 또는 단일 recent 거대 가능. 요청이 ctx 초과로 실패할 수 있음.`
    );
  }

  return {
    recent,
    historical,
    stats: {
      clippedMessages,
      droppedHistorical,
      droppedRecent,
      estMessageTokens: est,
      messageBudget,
      usedTokenizer,
      overBudget,
    },
  };
}
