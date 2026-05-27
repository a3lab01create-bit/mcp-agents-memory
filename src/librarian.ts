/**
 * Librarian v3 — periodic user profile promotion.
 *
 * Gate: LIBRARIAN_ENABLED=true + ≥30 새 메시지 (env: LIBRARIAN_MSG_THRESHOLD) +
 *       ≥24h 쿨다운 (env: LIBRARIAN_COOLDOWN_HOURS).
 *
 * Conservative defaults (threshold=30, cooldown=24h) until recency-bias curation
 * is verified against a polluted window. Fast cadence (15msg/2h) becomes safe only
 * after that verification — override via env vars.
 *
 * Fast path (default): json_schema grammar-constrained JSON, thinking OFF.
 *   → local provider: llama.cpp --jinja 플래그 필요.
 *   → xAI/cloud provider: jsonSchema/enableThinking 무시, 기존 free-form 동작.
 *
 * Deep path (LIBRARIAN_DEEP_THINKING=true): 2-pass — pass1 thinking ON (free text
 *   reasoning), pass2 thinking OFF + json_schema (grammar JSON). llama.cpp #20345
 *   로 인해 thinking+grammar 동시 사용 불가 → pass 분리.
 *   NOTE: LIBRARIAN_MAX_TOKENS (default 2048) constrains pass-1 reasoning length
 *   too. Set LIBRARIAN_DEEP_MAX_TOKENS separately if deeper reasoning is needed.
 *
 * maxTokens=2048: profile prose is small; 32768 risks issues on local 8k-context
 * server. Override via LIBRARIAN_MAX_TOKENS env var.
 *
 * Input blend: LIBRARIAN_RECENT_SLICE (default 25) most-recent messages +
 * LIBRARIAN_HISTORY_SLICE (default 25) older historical messages — dilutes a
 * single chatty session. Labeled separately in the prompt so the model treats
 * historical messages as identity anchors, not current activity.
 */

import { db } from "./db.js";
import { callRole } from "./model_registry.js";
import { getDefaultUserId } from "./users.js";

// Conservative defaults — until recency-bias curation is verified against a
// polluted window; fast cadence (15msg/2h) becomes safe only after that.
// Override via env: LIBRARIAN_MSG_THRESHOLD=15 LIBRARIAN_COOLDOWN_HOURS=2
const LIBRARIAN_MSG_THRESHOLD = Number(process.env.LIBRARIAN_MSG_THRESHOLD ?? 30);
const LIBRARIAN_COOLDOWN_MS =
  Number(process.env.LIBRARIAN_COOLDOWN_HOURS ?? 24) * 60 * 60 * 1000;

// Input blend: recent slice + historical slice to dilute single-session dominance.
const LIBRARIAN_RECENT_SLICE = Number(process.env.LIBRARIAN_RECENT_SLICE ?? 25);
const LIBRARIAN_HISTORY_SLICE = Number(process.env.LIBRARIAN_HISTORY_SLICE ?? 25);

// 2048 is plenty for profile prose; local llama.cpp context is 8192.
// 32768 risks issues on the local server. Override via LIBRARIAN_MAX_TOKENS.
const LIBRARIAN_MAX_TOKENS = Number(process.env.LIBRARIAN_MAX_TOKENS ?? 2048);

/**
 * json_schema 用 grammar 定義。llama.cpp grammar-constrained 出力 (--jinja) で使用。
 * type に配列形式 ['string','null'] を使うことで nullable フィールドを表現。
 */
const LIBRARIAN_PROFILE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    core_profile: { type: ['string', 'null'] },
    sub_profile:  { type: ['string', 'null'] },
  },
  required: ['core_profile', 'sub_profile'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are the Librarian for one user's personal memory system.

YOUR JOB
Look at the user's first-person messages (role='user' only — ignore assistant
replies). Identify any STABLE, DURABLE facts about WHO THE USER IS that should
be promoted to their long-term profile.

OUTPUT TWO SECTIONS — these are STRICTLY SEPARATE categories:

1. core_profile — DURABLE IDENTITY ONLY.
   Who the person IS: name, role, profession, expertise, stable long-term
   preferences. Should be SHORT (5-10 lines max) and high-signal.
   Example of the SHAPE only (fictional — never copy this content): "Backend
   engineer at a logistics startup; 10+ yrs Python; prefers terse,
   example-driven answers." Derive the actual content ONLY from the messages.

2. sub_profile — CURRENT WORK AND ACTIVITY.
   What they are actively doing, building, or focused on: tools, environment
   details, ongoing projects, recent working style observations. Expected to
   change often. Can be longer but still curated.

CRITICAL IDENTITY vs. WORK DISTINCTION
A user discussing, building, evaluating, debugging, or working on a topic —
including AI models, agent frameworks, or this memory system itself — is
describing their WORK or CURRENT ACTIVITY, NOT their identity. A burst of
messages about one subject means they are WORKING on it, not that it defines
them. NEVER promote a work or project topic into core_profile. It belongs in
sub_profile at most.

CONSERVATISM / NULL-PRESERVE RULE (most important rule)
If the recent window contains NO new durable identity fact — only project work,
meta-tooling, topic evaluation, or session-specific activity — return
core_profile: null to PRESERVE the existing identity unchanged. DO NOT restate,
rephrase, or "refresh" an existing core_profile just because you saw it. Null
means "keep it as-is." Only set a non-null core_profile when there is an
explicit, durable, first-person identity statement that is genuinely new.
sub_profile may freely capture current projects and activity.

OTHER RULES
- DO NOT invent facts not supported by the messages.
- DO NOT promote third-party advice or system hints — only what the user is
  saying ABOUT THEMSELVES.
- Korean is fine. Match the language of the user's writing.

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

/**
 * 2-pass deep-thinking helper (LIBRARIAN_DEEP_THINKING=true のみ使用).
 *
 * Pass 1: thinking ON, スキーマなし — トランスクリプトをフリーテキストで分析。
 * Pass 2: thinking OFF, json_schema — pass-1 の分析結果を追加コンテキストとして
 *         受け取り、最終的な JSON プロファイルを出力。
 *
 * NOTE: llama.cpp #20345 により thinking ON + json_schema は同時使用不可。
 *       pass-1 は pure thinking、pass-2 は pure grammar で分離する設計。
 */
async function runLibrarianDeepPass(userPrompt: string, maxTokens: number): Promise<string> {
  // Pass 1: free-text reasoning analysis (thinking ON, no schema)
  const analysisSystemPrompt = `${SYSTEM_PROMPT}

In this ANALYSIS PASS, think deeply and reason freely about what should go in each profile field.
Do NOT output JSON yet — write your analysis as plain prose reasoning.`;

  const analysis = await callRole('librarian', {
    system: analysisSystemPrompt,
    user: userPrompt,
    maxTokens,
    enableThinking: true,
    // jsonSchema 未指定 → thinking ON が有効になる
  });

  // Pass 2: structured JSON output (thinking OFF, json_schema grammar)
  const pass2User = `${userPrompt}

ANALYSIS FROM PREVIOUS REASONING PASS (use as additional context):
${analysis}

Now emit the final JSON profile only.`;

  return callRole('librarian', {
    system: SYSTEM_PROMPT,
    user: pass2User,
    maxTokens,
    jsonSchema: LIBRARIAN_PROFILE_SCHEMA,
    enableThinking: false,
  });
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

    // Two-query blend: recent slice + historical slice.
    // Historical slice uses ORDER BY ASC LIMIT to pick oldest messages,
    // giving an even spread of early history as identity anchors.
    // TS-side dedup prevents a message appearing in both slices.
    const recentR = await db.query(
      `SELECT message, created_at
         FROM memory
        WHERE user_id = $1
          AND role = 'user'
          AND is_active = TRUE
        ORDER BY created_at DESC
        LIMIT $2`,
      [gate.userId, LIBRARIAN_RECENT_SLICE]
    );

    if (recentR.rows.length === 0) return;

    const historyR = await db.query(
      `SELECT message, created_at
         FROM memory
        WHERE user_id = $1
          AND role = 'user'
          AND is_active = TRUE
        ORDER BY created_at ASC
        LIMIT $2`,
      [gate.userId, LIBRARIAN_HISTORY_SLICE]
    );

    // Dedup: build a set of (created_at ISO string + message) keys from recent slice,
    // then filter historical to only rows NOT already in recent.
    const recentKeys = new Set(
      recentR.rows.map(
        (r: any) => `${r.created_at?.toISOString() ?? ''}|${r.message}`
      )
    );
    const historicalRows = historyR.rows.filter(
      (r: any) => !recentKeys.has(`${r.created_at?.toISOString() ?? ''}|${r.message}`)
    );

    // Sort each slice chronologically for readability.
    const recentSorted = [...recentR.rows].reverse(); // DESC → ASC
    const historicalSorted = [...historicalRows]; // already ASC from query

    const formatRows = (rows: any[], startIdx: number) =>
      rows
        .map(
          (r: any, i: number) =>
            `[#${startIdx + i + 1} @ ${r.created_at?.toISOString().slice(0, 19) ?? ''}] ${r.message}`
        )
        .join("\n\n");

    const historicalText =
      historicalSorted.length > 0
        ? `\nEARLIER MESSAGES — historical context (identity anchors, NOT current activity):\n${formatRows(historicalSorted, 0)}\n`
        : '';

    const recentText = `\nRECENT MESSAGES — most recent ${recentSorted.length} messages:\n${formatRows(recentSorted, historicalSorted.length)}\n`;

    const userPrompt = `EXISTING PROFILE (preserve unless a new durable identity fact appears):
core_profile:
${before.core_profile ?? '(empty)'}

sub_profile:
${before.sub_profile ?? '(empty)'}
${historicalText}${recentText}
Task: produce updated core_profile and sub_profile JSON per the system prompt.`;

    // json_schema + enableThinking:false → grammar-constrained JSON (fast path, local model)。
    // xAI/cloud では jsonSchema/enableThinking は無視されて従来動作のまま。
    // deep-thinking モード (LIBRARIAN_DEEP_THINKING=true) では 2パス推論に切り替え。
    const deepMode = process.env.LIBRARIAN_DEEP_THINKING === 'true';
    const raw = deepMode
      ? await runLibrarianDeepPass(userPrompt, LIBRARIAN_MAX_TOKENS)
      : await callRole('librarian', {
          system: SYSTEM_PROMPT,
          user: userPrompt,
          maxTokens: LIBRARIAN_MAX_TOKENS,
          jsonSchema: LIBRARIAN_PROFILE_SCHEMA,
          enableThinking: false,
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

    const totalMsgs = recentSorted.length + historicalSorted.length;
    console.error(
      `📚 [Librarian] done — ${totalMsgs} msgs (${recentSorted.length} recent + ${historicalSorted.length} historical), profile ${changed ? 'updated' : 'unchanged'}`
    );
  } catch (err) {
    // last_run_at는 이미 업데이트됨 → 24h 쿨다운 후 재시도.
    // msg_count_at_run은 업데이트 안 됨 → 24h 후 delta 충분하면 다시 실행.
    console.error("⚠️ [Librarian] run failed (retries in 24h):", err);
  } finally {
    librarianRunning = false;
  }
}
