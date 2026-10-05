/**
 * Cold Path Tagger — predefined p_tag + dynamic d_tag 추출.
 *
 * Model: grok-4-1-fast-non-reasoning (default; env TAGGER_MODEL/TAGGER_PROVIDER으로 오버라이드 가능)
 * Prompt 핵심:
 *   - 기존 project_tags 후보 보고 매칭 우선 (§(1-A) explosion 방어)
 *   - role='assistant'면 "user 사실로 단정 X" 명시 (§(1-A) hallucination 방어)
 *   - 신규 p_tag 필요시 INSERT INTO project_tags ... RETURNING id
 *
 * 실패 시 throw — 호출자가 retry / cold_error 기록 처리.
 */

import { db } from "../db.js";
import { callRole, callSpec, ROLE_REGISTRY, type ModelSpec } from "../model_registry.js";
import { judgeProjectTag, shouldApplyJevJudgment } from "./jev_judge.js";
import { getPrompt } from "../prompts/index.js";
import { isBlockedNewTagName } from "./dtag_promoter.js";
import { REGISTRY_MEMBER_SQL, isUndefinedColumn, parsePTagAnswer, registryCandidateLines, registryVerdict } from "./project_registry.js";

// local 프로바이더 사용 시 실패하면 grok으로 fallback (LOCAL_GROK_FALLBACK=false 로 끄기 가능)
const GROK_FALLBACK_SPEC: ModelSpec = { provider: 'xai', model_name: 'grok-4-1-fast-non-reasoning' };
// 호출마다 읽는다 — retag-ptag는 실행 중에 끈다(대량 작업이 유료 grok으로 새지 않게)
const localFallbackEnabled = (): boolean => process.env.LOCAL_GROK_FALLBACK !== 'false';

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

type CandidateStrategy = "oldest" | "frequent";
type ProjectTagCandidate = { id: number; name: string; description: string | null };

/** registry=true면 명부 모드(DEVLOG §24 L1): 후보는 명부 전체, 명부 밖 이름·새 이름은 받지 않는다. */
type CandidateList = { rows: ProjectTagCandidate[]; registry: boolean };

// 후보 cache: 5분 TTL. 전략 또는 limit 변경은 별도 cache key로 분리한다.
let _candidateCache: { key: string; list: CandidateList; expires: number } | null = null;
// 명부가 이보다 크면 잘린다 — 명부는 사람이 고르는 짧은 목록이라 넘을 일이 없어야 한다(mem0 권고 3~5, 우리 12).
const REGISTRY_CANDIDATE_LIMIT = 60;
const CANDIDATE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Keep the deployed behavior unless an operator explicitly opts into the
 * frequency-based candidate list. Invalid configuration fails back to oldest.
 */
export function candidateSelectionConfig(): { strategy: CandidateStrategy; limit: number } {
  const configuredStrategy = process.env.TAGGER_CANDIDATE_STRATEGY?.trim().toLowerCase();
  const strategy: CandidateStrategy = configuredStrategy === "frequent"
    ? "frequent"
    : "oldest";
  const configuredLimit = Number(process.env.TAGGER_CANDIDATE_LIMIT?.trim());
  const limit = Number.isInteger(configuredLimit) && configuredLimit > 0
    ? configuredLimit
    : 20;
  return { strategy, limit };
}

/**
 * 기존 project_tags 후보 가져오기 (alias_of 그룹 대표 = alias_of IS NULL row).
 * Tagger prompt에 후보 list로 주입해 explosion 방어.
 *
 * 기본 oldest 전략은 기존 동작을 그대로 보존한다. frequent 전략은 최근 90일
 * 활성 memory 사용 빈도순으로 canonical tag를 고른다. alias tag 사용도
 * canonical_project_tag_id()로 대표 tag에 합산한다.
 */
async function listProjectTagCandidates(): Promise<CandidateList> {
  const { strategy, limit } = candidateSelectionConfig();
  const cacheKey = `${strategy}:${limit}`;
  const now = Date.now();
  if (_candidateCache && _candidateCache.key === cacheKey && _candidateCache.expires > now) {
    return _candidateCache.list;
  }

  // 명부 모드: kind가 있는 정본 태그 전부. 명부가 비었거나 kind 칼럼이 없으면(마이그레이션 031 전) 기존 방식.
  try {
    const reg = await db.query(
      `SELECT id, name, description
         FROM project_tags
        WHERE ${REGISTRY_MEMBER_SQL}
        ORDER BY name
        LIMIT $1`,
      [REGISTRY_CANDIDATE_LIMIT]
    );
    if (reg.rows.length >= REGISTRY_CANDIDATE_LIMIT) {
      console.error(`⚠️ [Tagger] 명부가 ${REGISTRY_CANDIDATE_LIMIT}개 이상 — 이름순으로 잘림. 명부를 줄이세요.`);
    }
    if (reg.rows.length > 0) {
      const list: CandidateList = {
        registry: true,
        rows: reg.rows.map((row: any) => ({ id: Number(row.id), name: row.name, description: row.description })),
      };
      _candidateCache = { key: cacheKey, list, expires: now + CANDIDATE_CACHE_TTL_MS };
      return list;
    }
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;  // kind 칼럼 없음(031 전)일 때만 기존 방식으로
  }

  const r = strategy === "frequent"
    ? await db.query(
        `SELECT pt.id, pt.name, pt.description
           FROM project_tags pt
           LEFT JOIN memory m
             ON m.is_active = TRUE
            AND m.p_tag_id IS NOT NULL
            AND m.created_at >= NOW() - INTERVAL '90 days'
            AND canonical_project_tag_id(m.p_tag_id) = pt.id
          WHERE pt.alias_of IS NULL
          GROUP BY pt.id
          ORDER BY COUNT(m.id) DESC, MAX(m.created_at) DESC NULLS LAST, pt.id ASC
          LIMIT $1`,
        [limit]
      )
    : await db.query(
        `SELECT id, name, description
           FROM project_tags
          WHERE alias_of IS NULL
          ORDER BY id ASC
          LIMIT $1`,
        [limit]
      );
  const rows: ProjectTagCandidate[] = r.rows.map((row: any) => ({
    id: Number(row.id),
    name: row.name,
    description: row.description,
  }));
  const list: CandidateList = { rows, registry: false };
  _candidateCache = { key: cacheKey, list, expires: now + CANDIDATE_CACHE_TTL_MS };
  return list;
}

/** Cache invalidate — 새 p_tag 생성 시 호출해서 즉시 후보 list 갱신. */
export function invalidateCandidateCache(): void {
  _candidateCache = null;
}

// RESPEC §3 cost fix: slim 적용. 핵심 룰 (explosion / role-awareness)은 keep.
// 토큰 ~3K → ~1.8K 목표.

/** JSON Schema for tagger output — used with local llama.cpp to enforce grammar (no <think> bleed). */
const TAGGER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    p_tag: { type: ['string', 'null'] },
    d_tag: { type: 'array', items: { type: 'string' }, maxItems: 5 },
  },
  required: ['p_tag', 'd_tag'],
  additionalProperties: false,
};

// PUBLIC GENERIC fallback. The tuned production prompt is loaded at runtime
// from prompts.local/tagger.md (private core) and is never bundled or published.
const GENERIC_TAGGER_PROMPT = `Tagger for a user's long-term memory across AI agents.

OUTPUT (strict JSON):
{ "p_tag": "<existing-name>" | "NEW:<slug>" | null, "d_tag": ["<kw>", ...] }

p_tag: ONE project tag. Prefer matching a name from the candidate list below;
  map obvious synonyms to an existing candidate. Use "NEW:<slug>" only when the
  message is clearly about a project absent from the list. null when the message
  is too short or generic to project-tag.

d_tag: 0-3 short lowercase hyphenated keywords about the topic. Skip if no signal.

ROLE: input includes role='user' or role='assistant'. For role='assistant',
  tag the topic; do not treat the reply as a fact about the user.`;
const SYSTEM_PROMPT = getPrompt("tagger", GENERIC_TAGGER_PROMPT);

function buildUserPrompt(input: TagInput, candidates: Array<{ name: string; description: string | null }>, registry = false): string {
  // 명부 모드: 짧은 명부라 설명까지 준다(태거 안내문). 시스템 프롬프트가 NEW:를 허용해도 여기서 막는다.
  if (registry) {
    return `registry (the ONLY allowed p_tag values — pick exactly one name, or null if none clearly fits; never invent a name, never use NEW:):\n${registryCandidateLines(candidates)}\nrole=${input.role}\nmessage: ${input.message}`;
  }
  // Slim user prompt — description (보통 길고 가변) 제거, 이름만 (~50% 토큰 절감)
  const candList = candidates.length > 0
    ? candidates.map((c) => c.name).join(", ")
    : "(none)";
  return `candidates: ${candList}\nrole=${input.role}\nmessage: ${input.message}`;
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
  // 새 p_tag 생성 → 다음 call이 즉시 후보 list에서 보도록 cache invalidate
  invalidateCandidateCache();
  return Number(inserted.rows[0].id);
}

/**
 * 명부 모드 출력 형식: p_tag는 명부 이름 또는 null만 (로컬 llama.cpp 문법으로 강제 — 새 이름·설명 따라 쓰기 원천 차단).
 * grok 대체 경로는 jsonSchema를 안 쓰므로 resolveRegistryAnswer의 판정이 여전히 최종 관문이다.
 */
function registrySchema(candidates: ProjectTagCandidate[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      p_tag: { anyOf: [{ type: 'string', enum: candidates.map((c) => c.name) }, { type: 'null' }] },
      d_tag: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    },
    required: ['p_tag', 'd_tag'],
    additionalProperties: false,
  };
}

/**
 * 명부 모드의 p_tag 답 → 명부 정본 id 또는 null. 별칭 이름은 별칭 사슬을 따라간 정본이 명부에 있으면 받는다.
 */
async function resolveRegistryAnswer(raw: unknown, candidates: ProjectTagCandidate[]): Promise<number | null> {
  const answer = parsePTagAnswer(raw);
  let canonicalId: number | null = null;
  if (answer.type === "name") {
    const chain = await db.query(
      `WITH RECURSIVE chain AS (
         SELECT id, alias_of, 0 AS depth FROM project_tags WHERE name = $1
         UNION ALL
         SELECT pt.id, pt.alias_of, c.depth + 1 FROM project_tags pt JOIN chain c ON pt.id = c.alias_of
          WHERE c.depth < 20
       )
       SELECT id FROM chain WHERE alias_of IS NULL LIMIT 1`,
      [answer.slug]
    );
    canonicalId = chain.rows.length > 0 ? Number(chain.rows[0].id) : null;
  }
  const verdict = registryVerdict(answer, canonicalId, new Set(candidates.map((c) => c.id)));
  if (verdict.accept == null && verdict.reason !== "no_answer") {
    console.error(`⚠️ [Tagger] 명부 모드: "${String(raw)}" 받지 않음 (${verdict.reason}). p_tag NULL.`);
  }
  return verdict.accept;
}

/**
 * Cold Path Tagger 본체. message → {p_tag_id, d_tag}.
 */
export async function tagMessage(input: TagInput): Promise<TagResult> {
  const { rows: candidates, registry } = await listProjectTagCandidates();
  const userPrompt = buildUserPrompt(input, candidates, registry);

  const isLocal = ROLE_REGISTRY.tagger.provider === 'local';
  let raw: string;

  if (isLocal) {
    try {
      raw = await callRole('tagger', {
        system: SYSTEM_PROMPT,
        user: userPrompt,
        responseFormat: 'json',
        jsonSchema: registry ? registrySchema(candidates) : TAGGER_SCHEMA,
        enableThinking: false,
        // thinking off — 태거는 단순 매핑 작업. thinking 켜면 reasoning이 모든 토큰 소비해 content 비어버림.
        // jsonSchema → llama.cpp grammar로 <think> bleed 차단 (Qwen3 bug #20345).
      });
    } catch (err) {
      if (!localFallbackEnabled()) throw err;
      console.warn(`⚠️ [Tagger] Local model 실패, grok fallback: ${(err as Error).message?.slice(0, 80)}`);
      raw = await callSpec(GROK_FALLBACK_SPEC, {
        system: SYSTEM_PROMPT,
        user: userPrompt,
        responseFormat: 'json',
      });
    }
  } else {
    raw = await callRole('tagger', {
      system: SYSTEM_PROMPT,
      user: userPrompt,
      responseFormat: 'json',
    });
  }

  let parsed: { p_tag: string | null; d_tag: string[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Tagger returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  // Jev is only an opinion over existing project-tag candidates. Preserve a
  // Qwen NEW: proposal exactly: Jev cannot create a new tag, so letting it
  // answer here would either erase the proposal or misclassify it as an old tag.
  const qwenProposedNewTag = typeof parsed.p_tag === "string" && parsed.p_tag.startsWith("NEW:");
  if (!qwenProposedNewTag) {
    const jev = await judgeProjectTag({
      message: input.message,
      role: input.role,
      agent_platform: input.agent_platform,
      agent_model: input.agent_model,
      candidates,
    });
    // A missing threshold is fail-closed in shouldApplyJevJudgment(), so merely
    // setting JEV_ENABLED=true cannot give Jev final authority accidentally.
    if (jev !== null && shouldApplyJevJudgment(jev)) {
      parsed.p_tag = jev.choice;
    }
  }

  let p_tag_id: number | null = null;
  let newly_created_p_tag_name: string | undefined;

  if (registry) {
    // 명부 모드: 명부 이름(또는 그 별칭)만 받는다. 새 이름은 만들지 않는다.
    p_tag_id = await resolveRegistryAnswer(parsed.p_tag, candidates);
  } else if (parsed.p_tag && typeof parsed.p_tag === 'string') {
    if (parsed.p_tag.startsWith('NEW:')) {
      const newName = parsed.p_tag.slice(4).trim();
      if (newName && await isBlockedNewTagName(newName)) {
        // 사람이 결정을 기다리는(대기) 이름이나 반려한 이름은 태거도 만들지 않는다 (0.9.25 — 승인은 사람이)
        console.error(`⚠️ [Tagger] "${newName}"은(는) 새 태그 제안에서 사람의 결정을 기다리거나 반려된 이름이라 만들지 않음. p_tag NULL.`);
      } else if (newName) {
        p_tag_id = await getOrCreateProjectTag(newName);
        newly_created_p_tag_name = newName;
      }
    } else {
      // P2 fix: 모델이 후보 list 외 이름 (오타/hallucination) 반환 시 새 tag
      // 자동 생성 막기. candidate 안에 정확히 매칭되거나 alias_of로 lookup 가능한
      // 이름이어야만 사용. 그 외는 NULL (no p_tag) 반환 — explosion 방어 강화.
      const slug = parsed.p_tag.toLowerCase().trim();
      const candidateSlugs = new Set(candidates.map((c) => c.name.toLowerCase()));
      if (candidateSlugs.has(slug)) {
        p_tag_id = await getOrCreateProjectTag(parsed.p_tag);
      } else {
        // alias_of chain에 있으면 OK
        const aliasCheck = await db.query(
          `WITH RECURSIVE chain AS (
             SELECT id, alias_of FROM project_tags WHERE name = $1
             UNION ALL
             SELECT pt.id, pt.alias_of FROM project_tags pt JOIN chain c ON pt.id = c.alias_of
           )
           SELECT id FROM chain WHERE alias_of IS NULL LIMIT 1`,
          [slug]
        );
        if (aliasCheck.rows.length > 0) {
          p_tag_id = Number(aliasCheck.rows[0].id);
        } else {
          // 후보에 없는 이름 — explosion 방어. NEW: prefix가 명시되지 않은 한 새로 만들지 않음.
          console.error(`⚠️ [Tagger] 후보 외 이름 "${parsed.p_tag}" 거부 (NEW: prefix 없음). p_tag NULL 반환.`);
          p_tag_id = null;
        }
      }
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
