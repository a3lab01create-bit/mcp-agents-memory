/**
 * Librarian v2 — periodic user profile promotion.
 *
 * Gate: LIBRARIAN_ENABLED=true + 30 새 메시지 + 24h 쿨다운.
 * Model: local/qwen3.6:35b-a3b (thinking 허용, maxTokens=8192).
 *
 * responseFormat 생략 — qwen3.x + response_format:json_object → content 빈 버그.
 * callSpec 'local' case가 ```json fence를 이미 strip하므로 JSON.parse 가능.
 */

import { db } from "./db.js";
import { callRole } from "./model_registry.js";
import { getDefaultUserId } from "./users.js";

const LIBRARIAN_MSG_THRESHOLD = 30;
const LIBRARIAN_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const LIBRARIAN_RECENT_LIMIT = 50;
// qwen3.6:35b-a3b: 50-msg 프롬프트에서 reasoning이 8k token을 소진하는 케이스 확인.
// 32k로 올려 reasoning + 실제 JSON 응답 모두 수용.
const LIBRARIAN_MAX_TOKENS = 32768;

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

FORMAT RULES FOR THE VALUES:
- Both fields must be PLAIN PROSE TEXT — no nested JSON, no {}, [], key-value blobs.
  Write in sentences or short bullet lines, not serialized objects.
- If you're tempted to write {"key": "value"} inside the string, write prose instead.

OUTPUT JSON STRICTLY:
{
  "core_profile": "<concise high-signal prose or null>",
  "sub_profile":  "<longer secondary prose or null>"
}`;

let librarianRunning = false;

interface GateState {
  userId: number;
  shouldRun: boolean;
  currentMsgCount: number;
  lastRunAt: Date | null;
}

async function checkGate(): Promise<GateState> {
  const userId = await getDefaultUserId();

  const r = await db.query(
    `SELECT
       u.librarian_last_run_at,
       u.librarian_msg_count_at_run,
       (SELECT COUNT(*)::bigint
          FROM memory
         WHERE user_id = u.user_id
           AND role = 'user'
           AND is_active = TRUE) AS current_msg_count
     FROM users u
     WHERE u.user_id = $1`,
    [userId]
  );

  const row = r.rows[0];
  const lastRunAt: Date | null = row?.librarian_last_run_at ?? null;
  const msgCountAtRun = Number(row?.librarian_msg_count_at_run ?? 0);
  const currentMsgCount = Number(row?.current_msg_count ?? 0);

  const neverRan = lastRunAt === null;
  const cooldownPassed =
    lastRunAt !== null &&
    Date.now() - new Date(lastRunAt).getTime() >= LIBRARIAN_COOLDOWN_MS;
  const enoughNewMessages = currentMsgCount - msgCountAtRun >= LIBRARIAN_MSG_THRESHOLD;

  const shouldRun = enoughNewMessages && (neverRan || cooldownPassed);

  return { userId, shouldRun, currentMsgCount, lastRunAt };
}

export async function runLibrarian(): Promise<void> {
  if (librarianRunning) return;

  const gate = await checkGate();
  if (!gate.shouldRun) return;

  librarianRunning = true;

  // 시도 시 즉시 last_run_at 업데이트 — 실패해도 24h 쿨다운으로 hammer 방지.
  // msg_count_at_run은 성공 시에만 업데이트 (다음 24h 후 재시도 시 delta 재계산).
  await db.query(
    `UPDATE users SET librarian_last_run_at = NOW() WHERE user_id = $1`,
    [gate.userId]
  );

  try {
    const beforeR = await db.query(
      `SELECT core_profile, sub_profile FROM users WHERE user_id = $1`,
      [gate.userId]
    );
    const before = beforeR.rows[0] ?? { core_profile: null, sub_profile: null };

    const recentR = await db.query(
      `SELECT message, created_at
         FROM memory
        WHERE user_id = $1
          AND role = 'user'
          AND is_active = TRUE
        ORDER BY created_at DESC
        LIMIT $2`,
      [gate.userId, LIBRARIAN_RECENT_LIMIT]
    );

    if (recentR.rows.length === 0) return;

    const messagesText = recentR.rows
      .reverse()
      .map(
        (r: any, i: number) =>
          `[#${i + 1} @ ${r.created_at?.toISOString().slice(0, 19) ?? ''}] ${r.message}`
      )
      .join("\n\n");

    const userPrompt = `EXISTING PROFILE (subject to update):
core_profile:
${before.core_profile ?? '(empty)'}

sub_profile:
${before.sub_profile ?? '(empty)'}

RECENT USER MESSAGES (most recent ${recentR.rows.length}, role='user'):
${messagesText}

Task: produce updated core_profile and sub_profile JSON per the system prompt.`;

    // responseFormat 생략 — qwen3.x + json_object → content 빈 버그.
    // callSpec local case가 <think>...</think> + ```json fence 모두 strip.
    // max_tokens=32768: 50-msg 프롬프트에서 reasoning이 8k token 소진 사례 확인.
    const raw = await callRole('librarian', {
      system: SYSTEM_PROMPT,
      user: userPrompt,
      maxTokens: LIBRARIAN_MAX_TOKENS,
    });

    if (!raw) {
      throw new Error('Librarian returned empty content (reasoning token budget exceeded?)');
    }

    let parsed: { core_profile: string | null; sub_profile: string | null };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Librarian returned unparseable content: ${raw.slice(0, 300)}`);
    }

    // JSON-in-string guard: 모델이 prose 대신 serialized JSON을 반환하면 reject.
    // prompt fix만으론 불충분 — qwen3.x가 가끔 {"key":"val"} blob을 field value로 씀.
    for (const [field, val] of [['core_profile', parsed.core_profile], ['sub_profile', parsed.sub_profile]] as const) {
      if (typeof val === 'string') {
        const t = val.trim();
        if (t.startsWith('{') || t.startsWith('[')) {
          throw new Error(`Librarian returned JSON-stuffed ${field} (prose required): ${t.slice(0, 120)}`);
        }
      }
    }

    // null 보호: 모델이 null 반환 시 기존 값 보존.
    // "null = 삭제" 아닌 "null = 변경 없음" 으로 해석 — 실수 덮어쓰기 방지.
    const newCore = parsed.core_profile ?? before.core_profile;
    const newSub = parsed.sub_profile ?? before.sub_profile;
    const changed =
      (newCore ?? '') !== (before.core_profile ?? '') ||
      (newSub ?? '') !== (before.sub_profile ?? '');

    if (changed) {
      await db.query(
        `UPDATE users
            SET core_profile = $1,
                sub_profile  = $2,
                updated_at   = NOW()
          WHERE user_id = $3`,
        [newCore, newSub, gate.userId]
      );
    }

    // 성공 시 msg_count_at_run 업데이트 (last_run_at은 시도 시 이미 업데이트됨)
    await db.query(
      `UPDATE users SET librarian_msg_count_at_run = $1 WHERE user_id = $2`,
      [gate.currentMsgCount, gate.userId]
    );

    console.error(
      `📚 [Librarian] done — ${recentR.rows.length} msgs, profile ${changed ? 'updated' : 'unchanged'}`
    );
  } catch (err) {
    // last_run_at는 이미 업데이트됨 → 24h 쿨다운 후 재시도.
    // msg_count_at_run은 업데이트 안 됨 → 24h 후 delta 충분하면 다시 실행.
    console.error("⚠️ [Librarian] run failed (retries in 24h):", err);
  } finally {
    librarianRunning = false;
  }
}
