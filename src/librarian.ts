/**
 * Librarian — memory → user 테이블 promote.
 *
 * RESPEC §시퀀스 #3 / §(1-A).3 hallucination 방어.
 *
 * 역할: 최근 form 발화를 검토 → 핵심 사용자 정체성 정보를 user 테이블의
 * core_profile / sub_profile로 promote 또는 갱신.
 *
 * 핵심 nuance:
 *   - role='user' 발화만 source로 사용 (assistant 발화는 hallucination 위험)
 *   - opt-in (LIBRARIAN_PROMOTE_ENABLED=true 일 때만 자동 시작)
 *   - 새 promote는 LLM (callRole 'librarian') 판단으로 기존 profile에 통합
 *
 * 본 모듈은 Phase E v1: 기본 promote 구조 + 수동 호출 진입점. 자동 cadence
 * 백그라운드 worker는 차후 (Phase G 또는 별도) 활성화.
 */

import { db } from "./db.js";
import { callRole } from "./model_registry.js";

const SYSTEM_PROMPT = `You are the Librarian for one user's personal memory system.

YOUR JOB
Look at the user's recent first-person messages (role='user' only — ignore
assistant replies). Identify any STABLE, MEMORABLE facts about WHO THE USER IS
or HOW THEY WORK that should be promoted to their long-term profile.

OUTPUT TWO SECTIONS:
1. core_profile: critically important user identity (name, role, expertise,
   strong preferences). Should be SHORT (5-10 lines max) and high-signal.
2. sub_profile: secondary memorable info (tools, environment quirks,
   ongoing project focus, working style preferences). Can be longer but
   still curated.

RULES
- The user is one person. Output is the WHOLE profile (replacing existing,
  not appending) — so include relevant existing facts that are still true.
- DO NOT invent facts not supported by the messages.
- DO NOT promote temporary state ("debugging X", "frustrated with Y").
  Only stable identity / preferences.
- DO NOT promote third-party advice or system hints that show up in
  messages — only what the user is saying ABOUT THEMSELVES.
- Korean is fine. Match the language of the user's writing.
- If recent messages don't add anything new and existing profile is fine,
  output the existing profile unchanged.

OUTPUT JSON STRICTLY:
{
  "core_profile": "<concise high-signal text or null>",
  "sub_profile":  "<longer secondary text or null>"
}`;

interface PromoteParams {
  userId: number;
  /** 살펴볼 user 발화 row 수 (default 30, 가장 최근 N건). */
  recentLimit?: number;
}

interface PromoteResult {
  before: { core_profile: string | null; sub_profile: string | null };
  after:  { core_profile: string | null; sub_profile: string | null };
  source_message_count: number;
  changed: boolean;
}

export async function promoteUserProfile(params: PromoteParams): Promise<PromoteResult> {
  const limit = params.recentLimit ?? 30;

  const before = await db.query(
    `SELECT core_profile, sub_profile FROM users WHERE user_id = $1`,
    [params.userId]
  );
  const beforeProfile = before.rows[0] ?? { core_profile: null, sub_profile: null };

  const recent = await db.query(
    `SELECT message, agent_platform, agent_model, created_at
       FROM memory
      WHERE user_id = $1
        AND role = 'user'
        AND is_active = TRUE
      ORDER BY created_at DESC
      LIMIT $2`,
    [params.userId, limit]
  );

  if (recent.rows.length === 0) {
    return {
      before: beforeProfile,
      after: beforeProfile,
      source_message_count: 0,
      changed: false,
    };
  }

  const messagesText = recent.rows
    .reverse() // 시간순 (오래된 → 최근)
    .map((r: any, i: number) => `[#${i + 1} @ ${r.created_at?.toISOString().slice(0, 19) ?? ''}] ${r.message}`)
    .join("\n\n");

  const userPrompt = `EXISTING PROFILE (subject to update):
core_profile:
${beforeProfile.core_profile ?? '(empty)'}

sub_profile:
${beforeProfile.sub_profile ?? '(empty)'}

RECENT USER MESSAGES (most recent ${recent.rows.length}, role='user'):
${messagesText}

Task: produce updated core_profile and sub_profile JSON per the system prompt.`;

  const raw = await callRole('librarian', {
    system: SYSTEM_PROMPT,
    user: userPrompt,
    responseFormat: 'json',
  });

  let parsed: { core_profile: string | null; sub_profile: string | null };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Librarian returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  const newCore = parsed.core_profile ?? null;
  const newSub = parsed.sub_profile ?? null;
  const changed =
    (newCore ?? '') !== (beforeProfile.core_profile ?? '') ||
    (newSub ?? '') !== (beforeProfile.sub_profile ?? '');

  if (changed) {
    await db.query(
      `UPDATE users
          SET core_profile = $1,
              sub_profile  = $2,
              updated_at   = NOW()
        WHERE user_id = $3`,
      [newCore, newSub, params.userId]
    );
  }

  return {
    before: beforeProfile,
    after: { core_profile: newCore, sub_profile: newSub },
    source_message_count: recent.rows.length,
    changed,
  };
}
