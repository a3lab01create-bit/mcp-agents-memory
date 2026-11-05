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
import { runTagger, type AgentCandidate, type CandidateList, type EvalPorts, type TagInput, type TaggerTrace }
  from "../src/cold_path/tagger_core.js";

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

let modelAdapter: ((o: any) => Promise<string>) | null = null;
if (live) {
  // 동적 import — 기본 경로에서는 모델 SDK 조차 로드하지 않는다
  const mr: any = await import("../src/model_registry.js");
  modelAdapter = (o) => mr.callRole("tagger", o);
}
/** 기계 검증용 고정 응답. `--canned '<json>'` 로 바꿀 수 있다(모델 호출 없이 경로를 흔든다). */
const CANNED = arg("canned", '{"p_tag":null,"d_tag":[]}') as string;

function ports(): EvalPorts {
  return {
    systemPrompt: "EVAL-FIXED-SYSTEM-PROMPT",
    isLocalProvider: () => false,            // fallback 분기를 평가에서 타지 않는다
    fallbackEnabled: () => false,
    callPrimary: async (o) => (modelAdapter ? modelAdapter(o) : CANNED),
    callFallback: async () => { throw new Error("eval: fallback 미사용"); },
    judgeJev: async () => null,              // Jev 는 현재 운영에서도 꺼져 있다
    applyJev: () => false,
    listCandidates: async () => candList,
    listHints: async () => new Map(),
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
  canned: live ? null : CANNED,
  note: live ? "실제 모델 호출" : "모델 호출 없음(canned) — 기계 검증용",
};
out.push(JSON.stringify(meta));
console.log(`run_meta cases=${meta.cases_n} registry=${meta.registry_n} arms=${arms.join(",")} live=${live}`);

const summary: Record<string, Record<string, number>> = {};
const bump = (arm: string, k: string) => {
  summary[arm] ??= {}; summary[arm][k] = (summary[arm][k] ?? 0) + 1;
};

for (const arm of arms) {
  for (const c of cases) {
    const cand = candidates[String(c.id)];
    if ((arm === "B" || arm === "C") && !cand) { bump(arm, "no_candidate"); continue; }

    if (arm === "C") {
      const id = idByName.get(cand.project_name) ?? fixture.name_to_canonical_id[cand.project_name] ?? null;
      out.push(JSON.stringify({ kind: "result", case_id: c.id, arm, status: "ok",
        p_tag_id: id, p_tag_name: cand.project_name, d_tag: [],
        trace: { decision_reason: id != null ? "agent_candidate_resolved" : "agent_candidate_unmapped",
                 proposed_name: cand.project_name, persistence_action: "none" } }));
      bump(arm, id != null ? "resolved" : "unmapped");
      continue;
    }

    const trace: TaggerTrace = {};                 // 🔴 케이스마다 새 객체
    const input: TagInput = {
      message: c.message, role: c.role, agent_platform: c.agent_platform,
      agent_model: c.agent_model, venue: c.venue,
      ...(arm === "B" ? { agentCandidate: cand } : {}),
    };
    const t0 = Date.now();
    try {
      const r = await runTagger(input, ports(), trace);
      out.push(JSON.stringify({ kind: "result", case_id: c.id, arm, status: "ok",
        p_tag_id: r.p_tag_id, d_tag: r.d_tag,
        newly_created_p_tag_name: r.newly_created_p_tag_name ?? null,
        ms: Date.now() - t0, trace }));
      bump(arm, trace.decision_reason ?? "unknown");
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const status = /invalid JSON/.test(msg) ? "parse_error" : "model_error";
      out.push(JSON.stringify({ kind: "result", case_id: c.id, arm, status, error: msg.slice(0, 300),
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
