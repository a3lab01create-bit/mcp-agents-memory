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

let callModel: ((prompt: string) => Promise<{ text: string; tokens?: number }>) | null = null;
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
    text: await mr.callSpec(spec, { system: "", user: prompt, responseFormat: "json" }),
  });
}

const logPath = outPath.replace(/\.json$/, "") + ".log.jsonl";
const log: string[] = [];
log.push(JSON.stringify({
  kind: "gen_meta", at: new Date().toISOString(),
  cases_sha: sha(casesRaw), registry_sha: sha(regRaw), instruction_sha: sha(instr),
  cases_n: cases.length, registry_n: fixture.candidates.length,
  live_model: live, provider: providerName, model: modelName,
  canned: live ? null : canned,
  provenance: "제공된 과거 맥락으로 재구성한 후보 — '그 대화를 한 에이전트의 당시 판단' 이 아니다",
  isolation: ["케이스마다 독립 요청", "도구 미제공", "검색·장기기억 미연결", "이전 응답·대화 이어붙이기 없음"],
}));

const candidates: Record<string, { project_name: string; evidence_refs?: string[]; reason?: string }> = {};
let okN = 0, emptyN = 0, errN = 0;
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
  const status = err ? "model_error" : perr ? "parse_error"
    : (typeof parsed?.project_name === "string" ? (parsed.project_name ? "ok" : "empty") : "shape_error");
  if (status === "ok") {
    candidates[String(c.id)] = {
      project_name: parsed.project_name,
      ...(Array.isArray(parsed.evidence_refs) ? { evidence_refs: parsed.evidence_refs.map(String) } : {}),
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
    };
    okN++;
  } else if (status === "empty") emptyN++;
  else errN++;
  log.push(JSON.stringify({
    kind: "gen", case_id: c.id, status, ms,
    prompt_sha: sha(prompt), prompt_len: prompt.length,
    prior_n: (c.prior_context ?? []).length,
    raw: raw.slice(0, 500), error: err ?? perr ?? null,
  }));
}
log.push(JSON.stringify({ kind: "gen_summary", ok: okN, empty: emptyN, error: errN, total: cases.length }));
fs.writeFileSync(outPath, JSON.stringify(candidates, null, 1) + "\n");
fs.writeFileSync(logPath, log.join("\n") + "\n");
console.log(`후보 ok=${okN} · 빈 후보(해당 없음)=${emptyN} · 오류=${errN} / ${cases.length}`);
console.log(`→ ${outPath}  (로그: ${logPath})`);
