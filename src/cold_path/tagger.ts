/**
 * Cold Path Tagger — predefined p_tag + dynamic d_tag 추출.
 *
 * Model: gemini-2.5-flash (RESPEC §결정 5)
 * Prompt 핵심:
 *   - 기존 project_tags 후보 보고 매칭 우선 (§(1-A) explosion 방어)
 *   - role='assistant'면 "user 사실로 단정 X" 명시 (§(1-A) hallucination 방어)
 *   - 신규 p_tag 필요시 INSERT INTO project_tags ... RETURNING id
 *
 * 실패 시 throw — 호출자가 retry / cold_error 기록 처리.
 */

import { db } from "../db.js";
import { callRole } from "../model_registry.js";

export interface TagInput {
  message: string;
  role: 'user' | 'assistant';
  agent_platform: string;
  agent_model: string;
}

export interface TagResult {
  p_tag_id: number | null;
  d_tag: string[];
  /** 신규 p_tag 생성한 경우 이름 (디버깅/로그용). */
  newly_created_p_tag_name?: string;
}

/**
 * 기존 project_tags 후보 가져오기 (alias_of 그룹 대표 = alias_of IS NULL row).
 * Tagger prompt에 후보 list로 주입해 explosion 방어.
 */
async function listProjectTagCandidates(limit = 50): Promise<Array<{ id: number; name: string; description: string | null }>> {
  const r = await db.query(
    `SELECT id, name, description
       FROM project_tags
      WHERE alias_of IS NULL
      ORDER BY id ASC
      LIMIT $1`,
    [limit]
  );
  return r.rows.map((row: any) => ({
    id: Number(row.id),
    name: row.name,
    description: row.description,
  }));
}

const SYSTEM_PROMPT = `You are the Tagger for a personal long-term memory system.

YOUR JOB
For each input message, output:
1. ONE predefined project tag (p_tag) — pick from the existing candidate list,
   OR propose a NEW one ONLY when the message clearly belongs to a brand-new
   project topic that none of the candidates fit.
2. UP TO 3 dynamic tags (d_tag) — short keywords/phrases describing the
   message content (e.g. ["bug-fix", "memory_add", "schema"]).

CONTEXT
- The user is one person managing personal memory across AI agents
  (Claude Code, Codex, Gemini, etc.).
- Existing project_tag CANDIDATES are listed below — STRONGLY prefer matching
  one of these to avoid tag explosion. Synonyms or near-matches MUST map to
  the existing candidate (e.g. "Centrazen project" → "centragens" if it
  exists).
- A new p_tag should only be proposed when the message is clearly about a
  NEW, distinct project topic absent from candidates.

ROLE-AWARENESS
- The message is tagged with role='user' or role='assistant'. When
  role='assistant', remember: this is the AI's own reply, NOT a fact about
  the user. Tag the TOPIC, not as if the user said it.

OUTPUT JSON STRICTLY:
{
  "p_tag": "<existing-name>" | "NEW:<proposed-name>" | null,
  "d_tag": ["<keyword1>", "<keyword2>", ...]
}

Examples:
- Input: "memory_add silent fail 진단 중. fba498c dedup이 의심" + candidates ["mcp-agents-memory", "centragens"]
  → {"p_tag": "mcp-agents-memory", "d_tag": ["memory_add", "silent-fail", "diagnosis"]}

- Input: "Centrazen 브랜드 패키지 디자인 시안 검토" + candidates ["centragens"]
  → {"p_tag": "centragens", "d_tag": ["package-design", "review", "branding"]}

- Input: "OpenClaw 새 페르소나 설정해야 함" + candidates does NOT contain anything OpenClaw-related
  → {"p_tag": "NEW:openclaw", "d_tag": ["persona-config", "setup"]}

- Input: "응 ㅋㅋ" (정보 거의 없음)
  → {"p_tag": null, "d_tag": []}`;

function buildUserPrompt(input: TagInput, candidates: Array<{ name: string; description: string | null }>): string {
  const candList = candidates.length > 0
    ? candidates.map((c) => `- ${c.name}${c.description ? ` (${c.description})` : ''}`).join("\n")
    : "(no existing project_tags yet)";
  return `EXISTING project_tag CANDIDATES:
${candList}

MESSAGE (role=${input.role}, agent_platform=${input.agent_platform}, agent_model=${input.agent_model}):
${input.message}`;
}

/**
 * project_tags에 새 row INSERT (또는 이미 있으면 가져옴).
 */
async function getOrCreateProjectTag(name: string): Promise<number> {
  const slug = name.toLowerCase().trim();
  if (!slug) throw new Error("Empty p_tag name");

  // 이미 있나 확인 (alias_of 따라가서 대표 id 반환)
  const existing = await db.query(
    `WITH RECURSIVE chain AS (
       SELECT id, alias_of FROM project_tags WHERE name = $1
       UNION ALL
       SELECT pt.id, pt.alias_of FROM project_tags pt
         JOIN chain c ON pt.id = c.alias_of
     )
     SELECT id FROM chain WHERE alias_of IS NULL LIMIT 1`,
    [slug]
  );
  if (existing.rows.length > 0) return Number(existing.rows[0].id);

  const inserted = await db.query(
    `INSERT INTO project_tags (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET updated_at = project_tags.updated_at
       RETURNING id`,
    [slug]
  );
  return Number(inserted.rows[0].id);
}

/**
 * Cold Path Tagger 본체. message → {p_tag_id, d_tag}.
 */
export async function tagMessage(input: TagInput): Promise<TagResult> {
  const candidates = await listProjectTagCandidates();
  const userPrompt = buildUserPrompt(input, candidates);

  const raw = await callRole('tagger', {
    system: SYSTEM_PROMPT,
    user: userPrompt,
    responseFormat: 'json',
  });

  let parsed: { p_tag: string | null; d_tag: string[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Tagger returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  let p_tag_id: number | null = null;
  let newly_created_p_tag_name: string | undefined;

  if (parsed.p_tag && typeof parsed.p_tag === 'string') {
    if (parsed.p_tag.startsWith('NEW:')) {
      const newName = parsed.p_tag.slice(4).trim();
      if (newName) {
        p_tag_id = await getOrCreateProjectTag(newName);
        newly_created_p_tag_name = newName;
      }
    } else {
      p_tag_id = await getOrCreateProjectTag(parsed.p_tag);
    }
  }

  const d_tag = Array.isArray(parsed.d_tag)
    ? parsed.d_tag
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.toLowerCase().trim())
        .filter((t) => t.length > 0 && t.length <= 50)
        .slice(0, 5)
    : [];

  return {
    p_tag_id,
    d_tag,
    newly_created_p_tag_name,
  };
}
