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
  agent_model: string;             // 'opus-4-7' / 'gemini-3-pro' / ...
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
}

export interface HotPathInsertResult {
  id: number;
  created_at: Date;
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
  } = params;

  const embeddingSql = embedding && embedding.length > 0
    ? `[${embedding.join(",")}]`
    : null;

  const result = await db.query(
    `INSERT INTO memory (
       user_id, agent_platform, agent_model,
       subagent, subagent_model, subagent_role,
       role, message,
       p_tag_id, d_tag, embedding,
       is_pinned
     ) VALUES (
       $1, $2, $3,
       $4, $5, $6,
       $7, $8,
       $9, $10::text[], $11::halfvec,
       $12
     )
     RETURNING id, created_at`,
    [
      user_id, agent_platform, agent_model,
      subagent, subagent_model, subagent_role,
      role, message,
      p_tag_id, d_tag, embeddingSql,
      is_pinned,
    ]
  );

  const row = result.rows[0];
  return { id: Number(row.id), created_at: row.created_at };
}
