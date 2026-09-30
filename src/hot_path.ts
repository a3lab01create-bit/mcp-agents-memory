/**
 * Hot Path — 즉시 raw 저장.
 *
 * RESPEC §1.3 / §시퀀스 #1: 메시지 발생 시 raw 텍스트만 시간 순서로 INSERT.
 * 태깅/임베딩은 Cold Path가 백그라운드에서 채움 (NULL로 INSERT).
 *
 * Latency 목표 <50ms (DB INSERT only, LLM 호출 0).
 */

import { db } from "./db.js";
import { cleanBuzzEnvelope } from "./auto_save/buzz_envelope.js";
import { buzzTurnVenue } from "./auto_save/venue.js";

type OptionalColumn = "raw_message" | "venue";

/**
 * 마이그레이션 전 DB면 새 칸(028 raw_message, 029 venue)이 없다 → 그 칸 없이 저장
 * (지금까지와 같은 동작). 한 번 확인되면 이 프로세스에선 다시 시도하지 않는다.
 */
const missingColumns = new Set<OptionalColumn>();
const MISSING_COLUMN_EFFECT: Record<OptionalColumn, string> = {
  raw_message: "Buzz 봉투 정리가 시작됩니다. 그 전까지는 원문 그대로 저장합니다.",
  venue: "대화 자리(venue) 기록이 시작됩니다. 그 전까지는 venue 없이 저장합니다.",
};

/**
 * 42703(undefined_column)이 우리 선택 칸 때문인지. 메시지는 서버 언어마다 따옴표가
 * 달라서(»venue«, « venue » …) 에러 위치(position)로 SQL에서 칸 이름을 읽는다.
 * position이 없으면 메시지에 칸 이름이 들어 있는지로 판단한다.
 */
function missingOptionalColumn(
  err: unknown,
  sql: string,
  cols: Array<[OptionalColumn, string]>
): OptionalColumn | undefined {
  const e = err as { code?: string; message?: string; position?: string };
  if (e.code !== "42703") return undefined;
  const at = Number(e.position);
  const named = at > 0 ? /^[a-z_]+/.exec(sql.slice(at - 1))?.[0] : undefined;
  return cols.find(([c]) => (named ? c === named : !!e.message?.includes(c)))?.[0];
}

export interface HotPathInsertParams {
  user_id: number;                 // users.user_id FK
  agent_platform: string;          // 'claude-code' / 'codex' / ...
  /** 'opus-4-7' / 'gemini-3-pro' / ... assistant 메시지 모델.
   *  user role 메시지는 null (사람이 친 거라 model N/A — migration 021 이후). */
  agent_model: string | null;
  subagent?: boolean;              // default false
  subagent_model?: string | null;
  subagent_role?: string | null;   // free-form, lowercase normalize 트리거가 자동 처리
  role: 'user' | 'assistant';
  message: string;
  /**
   * 강제 기억 표시. manage_knowledge target='memory' action='add'에서만
   * true 사용 (Cold Path skip + archive 면제). 일반 Hot Path는 false (default).
   */
  is_pinned?: boolean;
  /**
   * 사전 채운 p_tag_id (manage_knowledge sync path 등 cold path 통하지
   * 않는 경우). 일반 Hot Path는 NULL — Cold Path가 채움.
   */
  p_tag_id?: number | null;
  /**
   * 사전 채운 d_tag (manage_knowledge sync path). 일반 Hot Path는 [] —
   * Cold Path가 채움.
   */
  d_tag?: string[];
  /**
   * 사전 채운 embedding (manage_knowledge sync path). number[] (3072 dim).
   * 일반 Hot Path는 NULL — Cold Path가 채움.
   */
  embedding?: number[] | null;
  /**
   * 외부 식별자 (예: Claude Code JSONL entry uuid). UNIQUE INDEX 적용된 컬럼.
   * 같은 external_uuid로 INSERT 시 ON CONFLICT DO NOTHING 동작 — 중복 저장 방지.
   * save_message tool / manage_knowledge는 NULL 사용 (자동 생성 not needed).
   */
  external_uuid?: string | null;
  /** MCP 서버 시작 시 os.hostname()으로 캡처한 기기명. null이면 unknown. */
  device_name?: string | null;
  /**
   * 대화가 오간 자리 (migration 029 참고: terminal / buzz:<채널> / buzz:dm / slack /
   * auto / subagent). 캡처가 세션 정보로 아는 경우에만 넘긴다. 안 넘기면 받은 말(user)이
   * 버즈 턴일 때만 방 정보에서 읽고, 그 밖엔 NULL.
   */
  venue?: string | null;
}

export interface HotPathInsertResult {
  id: number;
  created_at: Date;
  /** true = INSERT 성공, false = external_uuid 중복으로 ON CONFLICT skip. */
  inserted: boolean;
}

/**
 * 시간 순서 raw INSERT. 빈 칸 (p_tag_id, d_tag, embedding) NULL로 들어감.
 * Cold Path가 다음 사이클에 처리.
 */
export async function insertRawMemory(
  params: HotPathInsertParams
): Promise<HotPathInsertResult> {
  const {
    user_id,
    agent_platform,
    agent_model,
    subagent = false,
    subagent_model = null,
    subagent_role = null,
    role,
    message,
    is_pinned = false,
    p_tag_id = null,
    d_tag = [],
    embedding = null,
    external_uuid = null,
    device_name = null,
  } = params;

  const embeddingSql = embedding && embedding.length > 0
    ? `[${embedding.join(",")}]`
    : null;

  // tag_processed: 사전 p_tag_id 채워졌으면 TRUE, 아니면 FALSE (Cold Path 처리 대상)
  const tagProcessed = p_tag_id !== null;

  // Buzz ACP 봉투는 걷어낸 본문을 message(검색·태깅 대상)에, 원문은 raw_message에.
  // 강제기억(is_pinned)이나 태그·임베딩을 미리 채워 온 저장은 그 본문 기준이라 손대지 않는다.
  const cleaned =
    role === "user" && !is_pinned && p_tag_id === null && embeddingSql === null
      ? cleanBuzzEnvelope(message)
      : null;

  // venue: 캡처가 알려준 값 우선. 없으면 받은 말(user)이 버즈 턴일 때만 방 정보에서 읽는다.
  const venue = params.venue ?? (role === "user" ? buzzTurnVenue(cleaned ?? message) : null);

  const optional: Array<[OptionalColumn, string]> = [];
  if (cleaned !== null) optional.push(["raw_message", message]);
  if (venue) optional.push(["venue", venue]);

  const buildInsert = (cols: Array<[OptionalColumn, string]>) => {
    // raw_message 칸을 못 쓰면 정리본 대신 원문을 message에 둔다 (원문 보존이 먼저)
    const text = cols.some(([c]) => c === "raw_message") ? cleaned! : message;
    const sql =
      `INSERT INTO memory (
         user_id, agent_platform, agent_model,
         subagent, subagent_model, subagent_role,
         role, message,
         p_tag_id, d_tag, embedding,
         is_pinned, tag_processed, external_uuid,
         device_name${cols.map(([c]) => `, ${c}`).join("")}
       ) VALUES (
         $1, $2, $3,
         $4, $5, $6,
         $7, $8,
         $9, $10::text[], $11::halfvec,
         $12, $13, $14,
         $15${cols.map((_, i) => `, $${16 + i}`).join("")}
       )
       ON CONFLICT (external_uuid) WHERE external_uuid IS NOT NULL
         DO NOTHING
       RETURNING id, created_at`;
    const values = [
      user_id, agent_platform, agent_model,
      subagent, subagent_model, subagent_role,
      role, text,
      p_tag_id, d_tag, embeddingSql,
      is_pinned, tagProcessed, external_uuid,
      device_name,
      ...cols.map(([, v]) => v),
    ];
    return { sql, values };
  };

  let cols = optional.filter(([c]) => !missingColumns.has(c));
  let result;
  for (;;) {
    const { sql, values } = buildInsert(cols);
    try {
      result = await db.query(sql, values);
      break;
    } catch (err) {
      // 42703 undefined_column — 해당 마이그레이션 미적용 DB면 그 칸만 빼고 다시 저장
      const missing = missingOptionalColumn(err, sql, cols);
      if (!missing) throw err;
      missingColumns.add(missing);
      console.error(
        `⚠️ [HotPath] memory.${missing} 칸이 없습니다 — \`mcp-agents-memory migrate\` 실행 후 ` +
          `이 프로세스를 재시작해야 ${MISSING_COLUMN_EFFECT[missing]}`
      );
      cols = cols.filter(([c]) => c !== missing);
    }
  }

  if (result.rows.length === 0) {
    // ON CONFLICT skip — 기존 row 가져오기
    const existing = await db.query(
      `SELECT id, created_at FROM memory WHERE external_uuid = $1 LIMIT 1`,
      [external_uuid]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      return { id: Number(row.id), created_at: row.created_at, inserted: false };
    }
    // theoretically unreachable: conflict should have target row. fail-loud.
    throw new Error(`insertRawMemory: ON CONFLICT triggered but no existing row found (external_uuid=${external_uuid})`);
  }

  const row = result.rows[0];
  return { id: Number(row.id), created_at: row.created_at, inserted: true };
}
