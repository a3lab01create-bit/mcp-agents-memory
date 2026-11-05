/**
 * 태깅 방식 비교 평가 runner — **파일 기반. DB 를 import 하지 않는다.**
 *
 *   A  현재 태거 단독 (에이전트 후보 없음)
 *   B  같은 태거 + 에이전트 후보·근거
 *   C  에이전트 후보만 (모델 호출 없음)
 *
 * 사용:
 *   node … eval_tagging_runner.mjs --cases cases.json --registry registry_fixture.json \
 *        [--candidates agent_candidates.json] [--arms A,B,C] --out run.jsonl [--live-model]
 *
 * 🔴 **기본은 모델을 부르지 않는다**(canned 응답). 실제 호출은 `--live-model` 을 명시해야 한다.
 * 🔴 케이스마다 **새 trace 객체**를 만들고, 모델·파싱 예외는 **실패 상태로 기록**한다(코디 요구).
 * 🔴 쓰기 포트(`getOrCreateTag`)를 **주지 않는다** → 새 이름은 제안으로만 남는다(타입 단계에서 닫힘).
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { GENERIC_TAGGER_PROMPT, runTagger, type AgentCandidate, type CandidateList, type ChannelHint,
  type EvalPorts, type TagInput, type TaggerTrace } from "../src/cold_path/tagger_core.js";
import { getPrompt } from "../src/prompts/index.js";

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);

const casesPath = arg("cases"), regPath = arg("registry"), outPath = arg("out");
if (!casesPath || !regPath || !outPath) {
  console.error("필수: --cases <json> --registry <json> --out <jsonl>");
  process.exit(2);
}
const casesRaw = fs.readFileSync(casesPath);
const regRaw = fs.readFileSync(regPath);
const cases = JSON.parse(casesRaw.toString()).cases as Array<TagInput & { id: number }>;
const fixture = JSON.parse(regRaw.toString()) as {
  registry_mode: boolean;
  candidates: Array<{ id: number; name: string; description: string }>;
  name_to_canonical_id: Record<string, number>;
  /** 세 팔이 **같이** 쓰는 허용 정본 집합. C 가 전체 이름 맵으로 넓게 받던 결함을 막는다. */
  allowed_canonical_ids: number[];
  hints?: Record<string, ChannelHint>;
};
const candPath = arg("candidates");
const candidates: Record<string, AgentCandidate> = candPath
  ? JSON.parse(fs.readFileSync(candPath, "utf8"))
  : {};
const arms = (arg("arms", "A") as string).split(",").map((a) => a.trim().toUpperCase());
const live = has("live-model");

const idByName = new Map(fixture.candidates.map((c) => [c.name, c.id]));
const candList: CandidateList = {
  registry: fixture.registry_mode,
  rows: fixture.candidates.map((c) => ({ id: c.id, name: c.name, description: c.description || null })),
};

// ── 실제 태거 설정을 연결한다. 평가 전용 더미를 live 에 쓰면 arm A 가 "현재 태거" 가 아니다(코디 지적).
const SYSTEM_PROMPT = getPrompt("tagger", GENERIC_TAGGER_PROMPT);
const promptIsGeneric = SYSTEM_PROMPT === GENERIC_TAGGER_PROMPT;

let modelAdapter: ((o: any) => Promise<string>) | null = null;
let providerName = arg("provider") ?? null;
let modelName = arg("model") ?? null;
if (live) {
  // 동적 import — 기본 경로에서는 모델 SDK 조차 로드하지 않는다
  const mr: any = await import("../src/model_registry.js");
  providerName = mr.ROLE_REGISTRY.tagger.provider;
  modelName = mr.ROLE_REGISTRY.tagger.model_name;
  // 🔴 설정이 없으면 **호출 전에** 멈춘다
  const missing: string[] = [];
  if (!providerName || !modelName) missing.push("ROLE_REGISTRY.tagger");
  if (promptIsGeneric) missing.push("실제 tagger 시스템 프롬프트(prompts.local/tagger.md 또는 MEMORY_PROMPTS_DIR)");
  if (!fixture.registry_mode && fixture.candidates.length === 0) missing.push("후보 목록");
  if (missing.length) {
    console.error(`❌ live 실행 전 설정 누락 — 호출하지 않았다: ${missing.join(" · ")}`);
    process.exit(3);
  }
  modelAdapter = (o) => mr.callRole("tagger", o);
}
/** 실험 차이 — A 를 "현재 태거" 라고 부를 때 같이 적어야 하는 항목들. */
const EXPERIMENT_DELTAS = [
  "fallback 비활성 (callFallback 호출 시 실패) — 운영은 LOCAL_GROK_FALLBACK 기본 on",
  "Jev 비활성 (judgeJev=null) — 운영도 JEV_ENABLED 미설정으로 현재 꺼져 있다",
  "후보 목록·힌트·이름→정본 매핑을 DB 대신 고정 fixture 에서 읽는다",
  ...(live ? [] as string[] : ["모델 미호출 (canned 응답)"]),
];
/** 기계 검증용 고정 응답. `--canned '<json>'` 로 바꿀 수 있다(모델 호출 없이 경로를 흔든다). */
const CANNED = arg("canned", '{"p_tag":null,"d_tag":[]}') as string;

const hintMap = new Map<string, ChannelHint>(Object.entries(fixture.hints ?? {}));

function ports(): EvalPorts {
  return {
    systemPrompt: SYSTEM_PROMPT,             // 실제 태거 시스템 프롬프트(고정해 기록한다)
    isLocalProvider: () => providerName === "local",   // 실제 provider 를 따른다 → schema·thinking 경로 보존
    fallbackEnabled: () => false,            // 실험 차이로 명시 (EXPERIMENT_DELTAS)
    callPrimary: async (o) => (modelAdapter ? modelAdapter(o) : CANNED),
    callFallback: async () => { throw new Error("eval: fallback 미사용"); },
    judgeJev: async () => null,              // Jev 는 현재 운영에서도 꺼져 있다
    applyJev: () => false,
    listCandidates: async () => candList,
    listHints: async () => hintMap,
    resolveCanonical: async (n) => fixture.name_to_canonical_id[n] ?? null,
    isBlockedNewName: async () => false,
    // getOrCreateTag 없음 — 생성 경로가 타입 단계에서 닫힌다
  };
}

const out: string[] = [];
const meta = {
  kind: "run_meta", at: new Date().toISOString(),
  cases_sha: sha(casesRaw), registry_sha: sha(regRaw),
  cases_n: cases.length, registry_n: fixture.candidates.length,
  registry_mode: fixture.registry_mode, arms, live_model: live,
  candidates_file: candPath ?? null, candidates_n: Object.keys(candidates).length,
  candidates_sha: candPath ? sha(fs.readFileSync(candPath)) : null,
  system_prompt_sha: sha(SYSTEM_PROMPT), system_prompt_len: SYSTEM_PROMPT.length,
  system_prompt_source: promptIsGeneric ? "GENERIC_FALLBACK(실제 튜닝본 아님)" : "core overlay(실제)",
  provider: providerName, model: modelName,
  registry_allowed_canonical_ids: fixture.allowed_canonical_ids.length,
  hints_n: Object.keys(fixture.hints ?? {}).length,
  experiment_deltas: EXPERIMENT_DELTAS,
  canned: live ? null : CANNED,
  note: live ? "실제 모델 호출" : "모델 호출 없음(canned) — 기계 검증용",
};
out.push(JSON.stringify(meta));
console.log(`run_meta cases=${meta.cases_n} registry=${meta.registry_n} arms=${arms.join(",")} live=${live}`);

const summary: Record<string, Record<string, number>> = {};
const bump = (arm: string, k: string) => {
  summary[arm] ??= {}; summary[arm][k] = (summary[arm][k] ?? 0) + 1;
};

const allowed = new Set(fixture.allowed_canonical_ids);
/**
 * 세 팔에 **같은** 명부 적격 조건을 쓴다(코디 지적 — C 만 전체 이름 맵으로 넓게 받았다).
 * "의미 후보를 식별함"(identified_name)과 "허용 정본에 연결됨"(linked_canonical_id)을 분리해 돌려준다.
 */
function linkName(name: string): { identified_name: string; canonical_id: number | null; eligible: boolean } {
  const canon = fixture.name_to_canonical_id[name] ?? null;
  const eligible = canon != null && (!fixture.registry_mode || allowed.has(canon));
  return { identified_name: name, canonical_id: canon, eligible };
}

for (const arm of arms) {
  for (const c of cases) {
    const cand = candidates[String(c.id)];

    if (arm === "C") {
      // 🔴 후보가 없어도 **행을 남긴다** — 팔마다 분모가 달라지면 비교가 깨진다
      if (!cand) {
        out.push(JSON.stringify({ kind: "result", case_id: c.id, arm, status: "ok",
          candidate_present: false, p_tag_id: null, d_tag: [],
          trace: { decision_reason: "no_candidate", persistence_action: "none" } }));
        bump(arm, "no_candidate");
        continue;
      }
      const L = linkName(cand.project_name);
      out.push(JSON.stringify({ kind: "result", case_id: c.id, arm, status: "ok",
        candidate_present: true,
        p_tag_id: L.eligible ? L.canonical_id : null,
        identified_name: L.identified_name, canonical_id: L.canonical_id, registry_eligible: L.eligible,
        d_tag: [],
        trace: { decision_reason: L.eligible ? "agent_candidate_resolved"
                   : (L.canonical_id != null ? "agent_candidate_not_eligible" : "agent_candidate_unmapped"),
                 proposed_name: cand.project_name, persistence_action: "none" } }));
      bump(arm, L.eligible ? "resolved" : (L.canonical_id != null ? "not_eligible" : "unmapped"));
      continue;
    }

    // 🔴 첫 B 는 **후보가 없어도** A 와 같은 입력으로 태거를 호출한다(효과 비교의 분모 유지)
    const trace: TaggerTrace = {};                 // 케이스마다 새 객체
    const input: TagInput = {
      message: c.message, role: c.role, agent_platform: c.agent_platform,
      agent_model: c.agent_model, venue: c.venue,
      ...(arm === "B" && cand ? { agentCandidate: cand } : {}),
    };
    const t0 = Date.now();
    try {
      const r = await runTagger(input, ports(), trace);
      out.push(JSON.stringify({ kind: "result", case_id: c.id, arm, status: "ok",
        candidate_present: arm === "B" ? !!cand : undefined,
        p_tag_id: r.p_tag_id, d_tag: r.d_tag,
        newly_created_p_tag_name: r.newly_created_p_tag_name ?? null,
        ms: Date.now() - t0, trace }));
      bump(arm, trace.decision_reason ?? "unknown");
      if (arm === "B" && !cand) bump(arm, "_no_candidate_but_ran");
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const status = /invalid JSON/.test(msg) ? "parse_error" : "model_error";
      out.push(JSON.stringify({ kind: "result", case_id: c.id, arm, status, error: msg.slice(0, 300),
        candidate_present: arm === "B" ? !!cand : undefined,
        ms: Date.now() - t0, trace }));
      bump(arm, status);
    }
  }
}
out.push(JSON.stringify({ kind: "summary", summary }));
fs.writeFileSync(outPath, out.join("\n") + "\n");
for (const [arm, s] of Object.entries(summary)) {
  console.log(`arm ${arm}: ` + Object.entries(s).map(([k, v]) => `${k}=${v}`).join(" · "));
}
console.log(`→ ${outPath} (${out.length} 줄)`);
