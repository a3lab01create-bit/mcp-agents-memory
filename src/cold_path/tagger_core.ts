/**
 * Tagger core — 프롬프트 조립 · 판정 흐름 · 파싱. **DB 를 import 하지 않는다.**
 *
 * 운영(`tagger.ts`)은 DB 어댑터를 조립해 `runTagger` 를 부르고, 평가 runner 는 fixture 어댑터를
 * 주입한다. 목표는 **기존 동작 보존**이며 동등성은 `scripts/check_tagger_core_equivalence.ts` 가 검증한다.
 *
 * 경계 근거 (HEAD eb49fd8f278de8d1f25e8598c68bcfa1af18ee01 기준 call site):
 *   후보 :87/:111/:125 · 힌트 :161 · get-or-create :233/:245 · 명부 별칭 :279(가드 20)
 *   · 비명부 별칭 :389(가드 없음) · 모델 :311/:323/:330 · Jev :349/:358 · 프롬프트 :204
 *
 * 🔴 별칭 사슬 SQL 은 자리마다 다르다 — `resolveCanonical(name, { maxDepth })` 로 **각 호출부의
 *    현재 값을 보존**한다(명부 20 / 비명부·get-or-create 무제한). 깊이 상한은 순환 탐지가 아니라
 *    재귀를 멈추는 상한이다.
 */

import { parsePTagAnswer, registryCandidateLines, registryHintLine, registryVerdict } from "./project_registry.js";

export interface TagInput {
  message: string;
  role: 'user' | 'assistant';
  agent_platform: string;
  agent_model: string;
  /** 글이 온 자리(memory.venue, 예: buzz:MarketDev). 명부 항목에 걸린 채널이면 힌트 한 줄이 붙는다 */
  venue?: string | null;
  /**
   * 그 대화를 한 에이전트가 **제시한 후보**(평가용). 확정이 아니라 후보다.
   * **없으면 프롬프트는 한 글자도 바뀌지 않는다** — 기존 호출부는 이 필드를 설정하지 않는다.
   */
  agentCandidate?: AgentCandidate | null;
}

/** 에이전트 후보 — 확정이 아니라 후보+근거다. 자기평가 점수는 일부러 받지 않는다. */
export interface AgentCandidate {
  project_name: string;
  /** 근거 참조. Buzz event id / memory id 처럼 **출처 종류까지** 구분해 적는다. */
  evidence_refs?: string[];
  reason?: string;
}

export interface TagResult {
  p_tag_id: number | null;
  d_tag: string[];
  /** 신규 p_tag 생성한 경우 이름 (디버깅/로그용). */
  newly_created_p_tag_name?: string;
}

export type ProjectTagCandidate = { id: number; name: string; description: string | null };

/** registry=true면 명부 모드(DEVLOG §24 L1): 후보는 명부 전체, 명부 밖 이름·새 이름은 받지 않는다. */
export type CandidateList = { rows: ProjectTagCandidate[]; registry: boolean };

export type ChannelHint = { id: number; name: string };

export interface ModelCallOptions {
  system: string;
  user: string;
  responseFormat: 'json';
  jsonSchema?: Record<string, unknown>;
  enableThinking?: boolean;
}

/** Jev 판정의 구조적 모양 — jev_judge.JevTagJudgment 와 호환(confidence 는 null 가능). */
export type JevJudgmentLike = { choice: string | null; confidence?: number | null };

/** 모델·프롬프트 포트. systemPrompt 는 **한 번 읽은 값**을 받는다(운영의 모듈 초기화 시점 보존). */
export interface TaggerModelPorts {
  systemPrompt: string;
  isLocalProvider(): boolean;
  fallbackEnabled(): boolean;
  callPrimary(opts: ModelCallOptions): Promise<string>;
  callFallback(opts: ModelCallOptions): Promise<string>;
  judgeJev(input: {
    message: string; role: 'user' | 'assistant'; agent_platform: string; agent_model: string;
    candidates: ProjectTagCandidate[];
  }): Promise<JevJudgmentLike | null>;
  applyJev(judgment: JevJudgmentLike): boolean;
}

/** 읽기 포트. 평가에서는 fixture 가 답한다. */
export interface TaggerDataPorts {
  listCandidates(): Promise<CandidateList>;
  listHints(): Promise<Map<string, ChannelHint>>;
  /** 별칭 사슬을 따라간 정본 id. maxDepth 생략 = 상한 없음(기존 비명부 경로와 같다). */
  resolveCanonical(name: string, opts?: { maxDepth?: number }): Promise<number | null>;
  isBlockedNewName(name: string): Promise<boolean>;
}

/** 쓰기 능력 — **운영에만 있다.** 평가 포트에는 이 필드가 아예 없어 타입 단계에서 갈린다. */
export interface TaggerPersistPorts {
  getOrCreateTag(name: string): Promise<number>;
}

export type OperationalPorts = TaggerModelPorts & TaggerDataPorts & TaggerPersistPorts;
export type EvalPorts = TaggerModelPorts & TaggerDataPorts & { getOrCreateTag?: undefined };
export type TaggerPorts = OperationalPorts | EvalPorts;

export type DecisionReason =
  | "resolved_existing" | "new_created_or_existing" | "new_proposal_no_persist"
  | "blocked_by_policy" | "null_no_match" | "rejected_not_candidate" | "no_answer";

/** 평가 산출물. 운영 TagResult 는 바꾸지 않고 여기에만 쌓는다. */
export interface TaggerTrace {
  assembled_prompt?: string;
  raw_model_output?: string;
  /** 모델이 **Jev 적용 전**에 고른 값. */
  model_raw_p_tag?: string | null;
  /** Jev 적용 뒤 실제로 판정에 쓰인 값. Jev 미적용이면 model_raw_p_tag 와 같다. */
  effective_p_tag?: string | null;
  parser_result?: string;
  decision_reason?: DecisionReason;
  proposed_name?: string;
  persistence_action?: "created_or_existing" | "skipped_no_port" | "none";
  jev_applied?: boolean;
  /** fallback 을 **시도**했나. 시도 전에 기록한다 — 실패해도 true 다. */
  fallback_attempted?: boolean;
  /** fallback 이 **성공**했나. */
  fallback_used?: boolean;
  fallback_error?: string;
  registry_mode?: boolean;
  candidate_count?: number;
}

/** JSON Schema for tagger output — used with local llama.cpp to enforce grammar (no <think> bleed). */
export const TAGGER_SCHEMA: Record<string, unknown> = {
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
export const GENERIC_TAGGER_PROMPT = `Tagger for a user's long-term memory across AI agents.

OUTPUT (strict JSON):
{ "p_tag": "<existing-name>" | "NEW:<slug>" | null, "d_tag": ["<kw>", ...] }

p_tag: ONE project tag. Prefer matching a name from the candidate list below;
  map obvious synonyms to an existing candidate. Use "NEW:<slug>" only when the
  message is clearly about a project absent from the list. null when the message
  is too short or generic to project-tag.

d_tag: 0-3 short lowercase hyphenated keywords about the topic. Skip if no signal.

ROLE: input includes role='user' or role='assistant'. For role='assistant',
  tag the topic; do not treat the reply as a fact about the user.`;

/** 에이전트 후보 줄. **후보가 없으면 빈 문자열** → 프롬프트가 기존과 바이트 동일하다. */
export function agentCandidateLine(c?: AgentCandidate | null): string {
  if (!c || !c.project_name) return "";
  const why = c.reason ? ` — ${c.reason}` : "";
  const refs = c.evidence_refs?.length ? ` [evidence: ${c.evidence_refs.join(", ")}]` : "";
  return `agent candidate (a proposal from the agent that had this conversation — NOT a decision; verify against the list): ${c.project_name}${why}${refs}\n`;
}

export function buildUserPrompt(
  input: TagInput,
  candidates: Array<{ name: string; description: string | null }>,
  registry = false,
  hint?: ChannelHint
): string {
  // 명부 모드: 짧은 명부라 설명까지 준다(태거 안내문). 시스템 프롬프트가 NEW:를 허용해도 여기서 막는다.
  // 힌트가 걸린 채널의 글에만 힌트 줄이 붙는다 — 다른 글의 안내문은 한 글자도 안 바뀐다.
  if (registry) {
    const hintLine = hint && input.venue ? `${registryHintLine(input.venue, hint)}\n` : "";
    return `registry (the ONLY allowed p_tag values — pick exactly one name, or null if none clearly fits; never invent a name, never use NEW:):\n${registryCandidateLines(candidates)}\n${hintLine}${agentCandidateLine(input.agentCandidate)}role=${input.role}\nmessage: ${input.message}`;
  }
  // Slim user prompt — description (보통 길고 가변) 제거, 이름만 (~50% 토큰 절감)
  const candList = candidates.length > 0
    ? candidates.map((c) => c.name).join(", ")
    : "(none)";
  return `candidates: ${candList}\n${agentCandidateLine(input.agentCandidate)}role=${input.role}\nmessage: ${input.message}`;
}

/**
 * 명부 모드 출력 형식: p_tag는 명부 이름 또는 null만 (로컬 llama.cpp 문법으로 강제 — 새 이름·설명 따라 쓰기 원천 차단).
 * grok 대체 경로는 jsonSchema를 안 쓰므로 resolveRegistryAnswer의 판정이 여전히 최종 관문이다.
 */
export function registrySchema(candidates: ProjectTagCandidate[]): Record<string, unknown> {
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

/** 명부 모드 별칭 사슬은 **깊이 상한 20** 을 쓴다(기존 :279 보존). */
export const REGISTRY_ALIAS_MAX_DEPTH = 20;

async function resolveRegistryAnswer(
  raw: unknown,
  candidates: ProjectTagCandidate[],
  ports: TaggerDataPorts,
  trace?: TaggerTrace
): Promise<number | null> {
  const answer = parsePTagAnswer(raw);
  if (trace) trace.parser_result = answer.type;
  let canonicalId: number | null = null;
  if (answer.type === "name") {
    canonicalId = await ports.resolveCanonical(answer.slug, { maxDepth: REGISTRY_ALIAS_MAX_DEPTH });
  }
  const verdict = registryVerdict(answer, canonicalId, new Set(candidates.map((c) => c.id)));
  if (verdict.accept == null && verdict.reason !== "no_answer") {
    console.error(`⚠️ [Tagger] 명부 모드: "${String(raw)}" 받지 않음 (${verdict.reason}). p_tag NULL.`);
  }
  if (trace) {
    trace.decision_reason = verdict.accept != null
      ? "resolved_existing"
      : (verdict.reason === "no_answer" ? "no_answer" : "null_no_match");
  }
  return verdict.accept;
}

/**
 * Cold Path Tagger 본체. message → {p_tag_id, d_tag}.
 * 기존 `tagMessage` 의 흐름을 그대로 옮긴 것이며 반환 모양도 동일하다.
 */
export async function runTagger(input: TagInput, ports: TaggerPorts, trace?: TaggerTrace): Promise<TagResult> {
  const { rows: candidates, registry } = await ports.listCandidates();
  const hint = registry && input.venue ? (await ports.listHints()).get(input.venue) : undefined;
  const userPrompt = buildUserPrompt(input, candidates, registry, hint);
  if (trace) {
    trace.assembled_prompt = userPrompt;
    trace.registry_mode = registry;
    trace.candidate_count = candidates.length;
    trace.fallback_attempted = false;
    trace.fallback_used = false;
    trace.jev_applied = false;
    trace.persistence_action = "none";
  }

  const isLocal = ports.isLocalProvider();
  let raw: string;

  if (isLocal) {
    try {
      raw = await ports.callPrimary({
        system: ports.systemPrompt,
        user: userPrompt,
        responseFormat: 'json',
        jsonSchema: registry ? registrySchema(candidates) : TAGGER_SCHEMA,
        enableThinking: false,
        // thinking off — 태거는 단순 매핑 작업. thinking 켜면 reasoning이 모든 토큰 소비해 content 비어버림.
        // jsonSchema → llama.cpp grammar로 <think> bleed 차단 (Qwen3 bug #20345).
      });
    } catch (err) {
      if (!ports.fallbackEnabled()) throw err;
      console.warn(`⚠️ [Tagger] Local model 실패, grok fallback: ${(err as Error).message?.slice(0, 80)}`);
      // 시도 자체를 **호출 전에** 기록한다 — fallback 이 또 실패해도 "시도 안 함" 으로 남지 않게.
      if (trace) trace.fallback_attempted = true;
      try {
        raw = await ports.callFallback({
          system: ports.systemPrompt,
          user: userPrompt,
          responseFormat: 'json',
        });
      } catch (fbErr) {
        if (trace) trace.fallback_error = (fbErr as Error).message;
        throw fbErr;  // 운영 거동 유지 — 호출자가 retry / cold_error 를 기록한다
      }
      if (trace) trace.fallback_used = true;
    }
  } else {
    raw = await ports.callPrimary({
      system: ports.systemPrompt,
      user: userPrompt,
      responseFormat: 'json',
    });
  }
  if (trace) trace.raw_model_output = raw;

  let parsed: { p_tag: string | null; d_tag: string[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Tagger returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  // Jev is only an opinion over existing project-tag candidates. Preserve a
  // Qwen NEW: proposal exactly: Jev cannot create a new tag, so letting it
  // answer here would either erase the proposal or misclassify it as an old tag.
  if (trace) trace.model_raw_p_tag = parsed.p_tag ?? null;

  const qwenProposedNewTag = typeof parsed.p_tag === "string" && parsed.p_tag.startsWith("NEW:");
  if (!qwenProposedNewTag) {
    const jev = await ports.judgeJev({
      message: input.message,
      role: input.role,
      agent_platform: input.agent_platform,
      agent_model: input.agent_model,
      candidates,
    });
    // A missing threshold is fail-closed in shouldApplyJevJudgment(), so merely
    // setting JEV_ENABLED=true cannot give Jev final authority accidentally.
    if (jev !== null && ports.applyJev(jev)) {
      parsed.p_tag = jev.choice;
      if (trace) trace.jev_applied = true;
    }
  }
  if (trace) trace.effective_p_tag = parsed.p_tag ?? null;

  let p_tag_id: number | null = null;
  let newly_created_p_tag_name: string | undefined;

  if (registry) {
    // 명부 모드: 명부 이름(또는 그 별칭)만 받는다. 새 이름은 만들지 않는다.
    p_tag_id = await resolveRegistryAnswer(parsed.p_tag, candidates, ports, trace);
  } else if (parsed.p_tag && typeof parsed.p_tag === 'string') {
    if (parsed.p_tag.startsWith('NEW:')) {
      const newName = parsed.p_tag.slice(4).trim();
      if (newName && await ports.isBlockedNewName(newName)) {
        // 사람이 결정을 기다리는(대기) 이름이나 반려한 이름은 태거도 만들지 않는다 (0.9.25 — 승인은 사람이)
        console.error(`⚠️ [Tagger] "${newName}"은(는) 새 태그 제안에서 사람의 결정을 기다리거나 반려된 이름이라 만들지 않음. p_tag NULL.`);
        if (trace) { trace.decision_reason = "blocked_by_policy"; trace.proposed_name = newName; }
      } else if (newName) {
        if (ports.getOrCreateTag) {
          p_tag_id = await ports.getOrCreateTag(newName);
          newly_created_p_tag_name = newName;
          if (trace) {
            trace.decision_reason = "new_created_or_existing";
            trace.proposed_name = newName;
            trace.persistence_action = "created_or_existing";
          }
        } else {
          // 평가 경로: 생성 포트가 없다 → 제안만 남기고 id 는 비운다.
          if (trace) {
            trace.decision_reason = "new_proposal_no_persist";
            trace.proposed_name = newName;
            trace.persistence_action = "skipped_no_port";
          }
        }
      }
    } else {
      // P2 fix: 모델이 후보 list 외 이름 (오타/hallucination) 반환 시 새 tag
      // 자동 생성 막기. candidate 안에 정확히 매칭되거나 alias_of로 lookup 가능한
      // 이름이어야만 사용. 그 외는 NULL (no p_tag) 반환 — explosion 방어 강화.
      const slug = parsed.p_tag.toLowerCase().trim();
      const candidateSlugs = new Set(candidates.map((c) => c.name.toLowerCase()));
      if (candidateSlugs.has(slug)) {
        // 기존 후보 이름이다. 운영은 get-or-create(= 조회 후 없으면 생성)로 id 를 얻고,
        // 평가는 생성 포트가 없으므로 같은 의미의 **조회**(상한 없음)로 정본 id 를 얻는다.
        p_tag_id = ports.getOrCreateTag
          ? await ports.getOrCreateTag(parsed.p_tag)
          : await ports.resolveCanonical(slug);
        if (trace) {
          trace.decision_reason = "resolved_existing";
          trace.persistence_action = ports.getOrCreateTag ? "created_or_existing" : "none";
        }
      } else {
        // alias_of chain에 있으면 OK
        const aliasId = await ports.resolveCanonical(slug);
        if (aliasId != null) {
          p_tag_id = aliasId;
          if (trace) trace.decision_reason = "resolved_existing";
        } else {
          // 후보에 없는 이름 — explosion 방어. NEW: prefix가 명시되지 않은 한 새로 만들지 않음.
          console.error(`⚠️ [Tagger] 후보 외 이름 "${parsed.p_tag}" 거부 (NEW: prefix 없음). p_tag NULL 반환.`);
          p_tag_id = null;
          if (trace) trace.decision_reason = "rejected_not_candidate";
        }
      }
    }
  } else if (trace) {
    trace.decision_reason = "no_answer";
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
