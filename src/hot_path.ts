/**
 * Hot Path — 즉시 raw 저장.
 *
 * RESPEC §1.3 / §시퀀스 #1: 메시지 발생 시 raw 텍스트만 시간 순서로 INSERT.
 * 태깅/임베딩은 Cold Path가 백그라운드에서 채움 (NULL로 INSERT).
 *
 * Latency 목표 <50ms (DB INSERT only, LLM 호출 0).
 */

import { db } from "./db.js";

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
  } = params;

  const embeddingSql = embedding && embedding.length > 0
    ? `[${embedding.join(",")}]`
    : null;

  // tag_processed: 사전 p_tag_id 채워졌으면 TRUE, 아니면 FALSE (Cold Path 처리 대상)
  const tagProcessed = p_tag_id !== null;

  const result = await db.query(
    `INSERT INTO memory (
       user_id, agent_platform, agent_model,
       subagent, subagent_model, subagent_role,
       role, message,
       p_tag_id, d_tag, embedding,
       is_pinned, tag_processed, external_uuid
     ) VALUES (
       $1, $2, $3,
       $4, $5, $6,
       $7, $8,
       $9, $10::text[], $11::halfvec,
       $12, $13, $14
     )
     ON CONFLICT (external_uuid) WHERE external_uuid IS NOT NULL
       DO NOTHING
     RETURNING id, created_at`,
    [
      user_id, agent_platform, agent_model,
      subagent, subagent_model, subagent_role,
      role, message,
      p_tag_id, d_tag, embeddingSql,
      is_pinned, tagProcessed, external_uuid,
    ]
  );

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
