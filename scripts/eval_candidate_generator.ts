/**
 * 후보 생성 어댑터 — **케이스마다 독립 요청**. 도구·검색·장기기억·이전 응답을 연결하지 않는다.
 *
 * 왜 이렇게 하나: `search_memory` 가 결과에 `p_tag_name`(= 현재 태그)을 담아 돌려주고,
 * MCP 서버 지시문은 named entity 가 보이면 검색을 **의무**로 요구한다. 운영 에이전트 세션에서
 * 후보를 쓰게 하면 정답이 새어 들어온다. ⇒ 운영 설정을 건드리지 않고, **도구 없는 전용 호출**로
 * 후보를 만든다(코디 제안).
 *
 * 입력(케이스마다 고정): 지시문 + 명부 스냅샷 + 대상 원문 + **그 시점까지의** 앞 맥락
 * 출력: 후보 파일 하나(B/C 가 **같이** 쓴다) + 케이스별 로그(입력 해시·응답·토큰·지연)
 *
 * 🔴 결과는 "그 대화를 한 에이전트의 당시 판단" 이 **아니다** — **제공된 과거 맥락으로 재구성한 후보**다.
 */
import fs from "node:fs";
import crypto from "node:crypto";

type PriorMsg = { id: number; at: string; role: string; agent_platform: string; message: string };
type Case = { id: number; message: string; role: string; venue?: string | null;
              created_at: string; prior_context?: PriorMsg[] };

const argv = process.argv;
const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n: string) => argv.includes(`--${n}`);
const sha = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

const casesPath = arg("cases"), regPath = arg("registry"), instrPath = arg("instruction"), outPath = arg("out");
if (!casesPath || !regPath || !instrPath || !outPath) {
  console.error("필수: --cases <json> --registry <json> --instruction <md> --out <json>");
  process.exit(2);
}
const casesRaw = fs.readFileSync(casesPath), regRaw = fs.readFileSync(regPath),
      instr = fs.readFileSync(instrPath, "utf8");
const cases = JSON.parse(casesRaw.toString()).cases as Case[];
const fixture = JSON.parse(regRaw.toString()) as {
  candidates: Array<{ id: number; name: string; description: string }>;
};
const live = has("live-model");
/** 검증용 — 케이스별 프롬프트를 파일로 떨어뜨린다. 교차 오염을 **눈으로 확인**할 수 있게. */
const dumpDir = arg("dump-prompts");
if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true });
const canned = arg("canned", '{"project_name":"","evidence_refs":[],"reason":"canned"}') as string;

const registryBlock = fixture.candidates
  .map((c) => `- ${c.name}${c.description ? ` — ${c.description}` : ""}`).join("\n");

/** 케이스별 **자족 프롬프트**. 다른 케이스·이전 응답을 전혀 담지 않는다. */
function buildPrompt(c: Case): string {
  const prior = (c.prior_context ?? []).length
    ? (c.prior_context ?? []).map((p) => `- memory:${p.id} ${p.at} ${p.role}/${p.agent_platform}: ${p.message}`).join("\n")
    : "(없음)";
  return [
    instr.trim(), "",
    "## 명부", registryBlock, "",
    `## 판단 대상 — memory:${c.id}`,
    `${c.created_at} · venue=${c.venue ?? "-"} · role=${c.role}`,
    "```", c.message, "```", "",
    "## 같은 venue 의 앞선 맥락 (그 시각 이전)", prior, "",
    "## 출력", "위 형식의 JSON 한 개만.",
  ].join("\n");
}

/**
 * 🔴 `callSpec` 은 **문자열만** 돌려준다 → 토큰·비용은 이 경로에서 **수집할 수 없다**.
 *    타입에 tokens 를 선언하는 것은 수집이 아니다(코디 지적). 그래서 `usage_measured:false` 를
 *    명시하고 총비용 결론을 제한한다. 지연(ms)만 실측이다.
 */
let callModel: ((prompt: string) => Promise<{ text: string }>) | null = null;
let providerName = arg("provider") ?? null, modelName = arg("model") ?? null;
if (live) {
  // 🔴 manifest 를 **명시**받고 실제 설정과 대조한다. 기본값으로 통과시키지 않는다.
  if (!providerName || !modelName) {
    console.error("❌ live 는 --provider/--model 명시(manifest)가 필요하다 — 호출하지 않았다");
    process.exit(3);
  }
  const mr: any = await import("../src/model_registry.js");
  const spec = { provider: providerName, model_name: modelName };
  // 선언한 조합이 그 provider 에서 유효한지 먼저 확인 (오타·미설정 차단)
  try { mr.assertModelProvider(spec); } catch (e: any) {
    console.error(`❌ manifest 설정이 유효하지 않다 — 호출하지 않았다: ${e.message}`);
    process.exit(3);
  }
  callModel = async (prompt) => ({
    // 🔴 **도구를 제공하지 않는다.** system 은 지시문이 프롬프트 안에 들어 있으므로 비워 둔다.
    // `callSpec(spec)` 이라 **CLI 의 --provider/--model 이 모델을 직접 선택한다**(TAGGER_* 일치가
    // 필요한 쪽은 callRole 을 쓰는 A/B runner 다 — 코디 교정).
    text: await mr.callSpec(spec, { system: "", user: prompt, responseFormat: "json" }),
  });
}

const logPath = outPath.replace(/\.json$/, "") + ".log.jsonl";
const rawPath = outPath.replace(/\.json$/, "") + ".raw.jsonl";
const log: string[] = [];
const raws: string[] = [];
log.push(JSON.stringify({
  kind: "gen_meta", at: new Date().toISOString(),
  cases_sha: sha(casesRaw), registry_sha: sha(regRaw), instruction_sha: sha(instr),
  cases_n: cases.length, registry_n: fixture.candidates.length,
  live_model: live, provider: providerName, model: modelName,
  canned: live ? null : canned,
  usage_measured: false,
  cost_note: "callSpec 이 문자열만 반환해 토큰·비용을 수집할 수 없다 — 지연(ms)만 실측. 총비용 결론 금지.",
  model_selection: "callSpec(spec) — CLI --provider/--model 이 모델을 직접 선택한다(TAGGER_* 일치는 A/B runner 쪽)",
  raw_artifact: "<out>.raw.jsonl (응답 전문, 잘림 없음)",
  provenance: "제공된 과거 맥락으로 재구성한 후보 — '그 대화를 한 에이전트의 당시 판단' 이 아니다",
  isolation: ["케이스마다 독립 요청", "도구 미제공", "검색·장기기억 미연결", "이전 응답·대화 이어붙이기 없음"],
}));

const candidates: Record<string, { project_name: string; evidence_refs?: string[]; reason?: string }> = {};
let okN = 0, emptyN = 0, errN = 0, evN = 0;

/**
 * 🔴 근거 참조가 **그 케이스의 입력 안**을 가리키는지 검증한다.
 * 허용 = 대상 memory id ∪ 그 케이스 prior 의 memory id. 다른 케이스 id·없는 id 는 **근거 오류**다.
 * (검사 자체의 응답으로 재현된 문제였다 — 케이스 11·22 가 모두 `memory:11` 을 돌려줘도 통과했다.)
 */
function checkRefs(c: Case, refs: unknown): { ok: true; refs: string[] } | { ok: false; bad: string[] } {
  if (refs == null) return { ok: true, refs: [] };
  if (!Array.isArray(refs)) return { ok: false, bad: ["<배열 아님>"] };
  const allow = new Set<string>([String(c.id), ...(c.prior_context ?? []).map((p) => String(p.id))]);
  const bad: string[] = [];
  const good: string[] = [];
  for (const r of refs) {
    const str = String(r);
    const m = /^([a-z_]+):(\d+)$/.exec(str.trim());
    if (!m || m[1] !== "memory" || !allow.has(m[2])) bad.push(str);
    else good.push(str);
  }
  return bad.length ? { ok: false, bad } : { ok: true, refs: good };
}
for (const c of cases) {
  const prompt = buildPrompt(c);
  if (dumpDir) fs.writeFileSync(`${dumpDir}/prompt_${c.id}.txt`, prompt);
  const t0 = Date.now();
  let raw = "", err: string | null = null;
  try {
    raw = callModel ? (await callModel(prompt)).text : canned;
  } catch (e: any) { err = String(e?.message ?? e).slice(0, 300); }
  const ms = Date.now() - t0;
  let parsed: any = null, perr: string | null = null;
  if (!err) { try { parsed = JSON.parse(raw); } catch { perr = "응답이 JSON 이 아니다"; } }
  let status = err ? "model_error" : perr ? "parse_error"
    : (typeof parsed?.project_name === "string" ? (parsed.project_name ? "ok" : "empty") : "shape_error");
  let refCheck: ReturnType<typeof checkRefs> | null = null;
  if (status === "ok") {
    refCheck = checkRefs(c, parsed.evidence_refs);
    // 근거가 그 케이스 것이 아니면 **정상 후보로 넘기지 않는다**(코디). 이름은 로그에 남겨 재검토 가능.
    if (!refCheck.ok) status = "evidence_error";
  }
  if (status === "ok") {
    candidates[String(c.id)] = {
      project_name: parsed.project_name,
      ...(refCheck && refCheck.ok && refCheck.refs.length ? { evidence_refs: refCheck.refs } : {}),
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
    };
    okN++;
  } else if (status === "empty") emptyN++;
  else if (status === "evidence_error") evN++;
  else errN++;
  log.push(JSON.stringify({
    kind: "gen", case_id: c.id, status, ms,
    prompt_sha: sha(prompt), prompt_len: prompt.length,
    prior_n: (c.prior_context ?? []).length,
    tokens: null, usage_measured: false,
    proposed_name: typeof parsed?.project_name === "string" ? parsed.project_name : null,
    bad_evidence_refs: refCheck && !refCheck.ok ? refCheck.bad : null,
    allowed_ref_ids: [String(c.id), ...(c.prior_context ?? []).map((p) => String(p.id))],
    raw_preview: raw.slice(0, 500), raw_full_in: "raw.jsonl", error: err ?? perr ?? null,
  }));
  raws.push(JSON.stringify({ case_id: c.id, prompt_sha: sha(prompt), raw }));
}
log.push(JSON.stringify({ kind: "gen_summary", ok: okN, empty: emptyN,
  evidence_error: evN, error: errN, total: cases.length, usage_measured: false }));
fs.writeFileSync(outPath, JSON.stringify(candidates, null, 1) + "\n");
fs.writeFileSync(logPath, log.join("\n") + "\n");
fs.writeFileSync(rawPath, raws.join("\n") + "\n");
console.log(`후보 ok=${okN} · 빈 후보=${emptyN} · 근거오류=${evN} · 기타오류=${errN} / ${cases.length}`);
console.log(`→ ${outPath}  (로그 ${logPath} · 응답 전문 ${rawPath})  ※ 토큰·비용 미측정`);
