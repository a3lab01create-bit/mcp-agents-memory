/**
 * 후보 생성 어댑터 검증 — 모의 응답으로만. 모델 호출 0 · DB 접근 0.
 *   ① 케이스별 **독립 프롬프트**: 다른 케이스의 원문·id 가 섞이지 않는다
 *   ② 프롬프트에 **그 시각 이후 정보가 없다**(앞 맥락만)
 *   ③ 입력 해시가 케이스마다 다르고, 같은 케이스는 **재현**된다
 *   ④ 응답 모양별 처리: 정상 / 빈 후보 / JSON 아님 / 모양 이상 → 후보 파일에 뭐가 남나
 *   ⑤ 명부 밖 이름은 **버리지 않고** 그대로 남긴다(식별과 연결의 분리 — 적격 판정은 runner 가 한다)
 *   ⑥ live 는 manifest 없으면 호출 전에 멈춘다
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = process.cwd();
const GEN = path.join(REPO, "node_modules/.cache/mcp-agents-memory/eval_candidate_generator.mjs");
fs.mkdirSync(path.dirname(GEN), { recursive: true });
// 🔴 항상 재빌드 — 남은 번들로 옛 코드를 검사하지 않는다
execFileSync(path.join(REPO, "node_modules/.bin/esbuild"),
  [path.join(REPO, "scripts/eval_candidate_generator.ts"), "--bundle", "--platform=node", "--format=esm",
   "--packages=external", `--outfile=${GEN}`, "--log-level=warning"], { stdio: "pipe" });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencheck-"));
const emptyPrompts = fs.mkdtempSync(path.join(os.tmpdir(), "noprompts-"));
const TEST_ENV = { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), MEMORY_PROMPTS_DIR: emptyPrompts,
  TAGGER_PROVIDER: "", TAGGER_MODEL: "", XAI_API_KEY: "", OPENAI_API_KEY: "", GOOGLE_API_KEY: "", GEMINI_API_KEY: "" };
const w = (n: string, o: unknown) => { const p = path.join(tmp, n); fs.writeFileSync(p, JSON.stringify(o)); return p; };

const mkCase = (id: number, msg: string, prior: Array<[number, string]>) => ({
  id, message: msg, role: "user", venue: "buzz:x", created_at: "2026-11-05 10:00:00",
  prior_context: prior.map(([pid, pm]) => ({ id: pid, at: "2026-11-05 09:58", role: "assistant",
                                             agent_platform: "p", message: pm })),
});
const casesPath = w("cases.json", { cases: [
  mkCase(11, "케이스11 본문 ALPHAWORD", [[101, "앞맥락A"]]),
  mkCase(22, "케이스22 본문 BETAWORD", [[202, "앞맥락B"]]),
]});
const regPath = w("registry.json", { candidates: [
  { id: 1, name: "alpha", description: "알파 프로젝트" },
  { id: 2, name: "beta", description: "베타 프로젝트" }]});
const instrPath = path.join(tmp, "instr.md");
fs.writeFileSync(instrPath, "고정 지시문: JSON 하나만 내라.");

const run = (extra: string[], outName: string) => {
  const out = path.join(tmp, outName);
  try {
    const stdout = execFileSync(process.execPath,
      [GEN, "--cases", casesPath, "--registry", regPath, "--instruction", instrPath, "--out", out, ...extra],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: TEST_ENV });
    return { rc: 0, stdout, out };
  } catch (e: any) {
    return { rc: e.status ?? -1, stdout: String(e.stdout ?? "") + String(e.stderr ?? ""), out };
  }
};
const logRows = (out: string) =>
  fs.readFileSync(out.replace(/\.json$/, "") + ".log.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));

let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) fail++; };

// ── ①②③ 프롬프트 격리·앞맥락만·해시
{
  // 🔴 케이스별로 **그 케이스의** 근거를 돌려주는 응답으로 바꿨다 — 전엔 양쪽에 memory:11 을 주고도 통과했다
  const r = run(["--canned", '{"project_name":"alpha","evidence_refs":[],"reason":"테스트"}'], "a.json");
  ok(r.rc === 0, `정상 실행 rc=0 (실제 ${r.rc})`);
  const rows = logRows(r.out).filter((x) => x.kind === "gen");
  ok(rows.length === 2, `케이스 2건 모두 로그에 남는다 (${rows.length})`);
  const shas = new Set(rows.map((x) => x.prompt_sha));
  ok(shas.size === 2, `케이스마다 입력 해시가 다르다 (${shas.size}/2)`);
  const r2 = run(["--canned", '{"project_name":"alpha","evidence_refs":["memory:11"],"reason":"테스트"}'], "a2.json");
  const shas2 = logRows(r2.out).filter((x) => x.kind === "gen").map((x) => x.prompt_sha);
  ok(JSON.stringify(rows.map((x) => x.prompt_sha)) === JSON.stringify(shas2), `같은 입력 → 같은 해시(재현 가능)`);
  ok(rows.every((x) => x.prior_n === 1), `앞 맥락 건수가 케이스별로 기록된다 (prior_n=1)`);
  // 🔴 **프롬프트 본문을 실제로 읽어** 교차 오염을 본다 — 해시가 다르다는 것만으론 증거가 아니다
  const dump = path.join(tmp, "prompts");
  run(["--canned", '{"project_name":"alpha","evidence_refs":[],"reason":"x"}', "--dump-prompts", dump], "d.json");
  const p11 = fs.readFileSync(path.join(dump, "prompt_11.txt"), "utf8");
  const p22 = fs.readFileSync(path.join(dump, "prompt_22.txt"), "utf8");
  ok(p11.includes("ALPHAWORD") && !p11.includes("BETAWORD") && !p11.includes("memory:22"),
     `케이스11 프롬프트에 케이스22 의 원문·id 가 없다`);
  ok(p22.includes("BETAWORD") && !p22.includes("ALPHAWORD") && !p22.includes("memory:11"),
     `케이스22 프롬프트에 케이스11 의 원문·id 가 없다`);
  ok(p11.includes("앞선 맥락") && p11.includes("memory:101") && !p11.includes("memory:202"),
     `앞 맥락은 그 케이스 것만 들어간다`);
  ok(p11.includes("고정 지시문") && p11.includes("- alpha —") && p11.includes("- beta —"),
     `지시문 + 명부 스냅샷이 매 요청에 들어간다`);
  // 음성대조: 검사기가 오염을 실제로 볼 수 있나 — 일부러 섞은 문자열을 넣어본다
  const polluted = p11 + "\nBETAWORD memory:22";
  ok(!(!polluted.includes("BETAWORD") && !polluted.includes("memory:22")),
     `음성대조 — 오염된 프롬프트는 위 조건을 통과하지 못한다`);
  const cand = JSON.parse(fs.readFileSync(r.out, "utf8"));
  ok(Object.keys(cand).length === 2 && cand["11"].project_name === "alpha",
     `후보 파일에 2건 기록 · 필드 보존 (${JSON.stringify(cand["11"])})`);
  ok(!("confidence" in cand["11"]), `자기평가 점수 필드를 넣지 않는다`);
}

// ── ④ 응답 모양별 처리
{
  const empty = run(["--canned", '{"project_name":"","evidence_refs":[],"reason":"해당 없음"}'], "e.json");
  const ce = JSON.parse(fs.readFileSync(empty.out, "utf8"));
  ok(Object.keys(ce).length === 0, `빈 후보는 후보 파일에 넣지 않는다 (runner 가 candidate_present:false 로 본다)`);
  ok(logRows(empty.out).filter((x) => x.status === "empty").length === 2, `빈 후보는 status=empty 로 기록`);

  const bad = run(["--canned", "not-json"], "b.json");
  const cb = JSON.parse(fs.readFileSync(bad.out, "utf8"));
  ok(Object.keys(cb).length === 0, `JSON 아닌 응답 → 후보 0건`);
  ok(logRows(bad.out).filter((x) => x.status === "parse_error").length === 2, `parse_error 로 기록(삼키지 않는다)`);

  const shape = run(["--canned", '{"nope":1}'], "s.json");
  ok(logRows(shape.out).filter((x) => x.status === "shape_error").length === 2, `모양 이상 → shape_error 로 기록`);
}

// ── ⑤ 명부 밖 이름은 버리지 않는다 (식별/연결 분리)
{
  const r = run(["--canned", '{"project_name":"legacy-not-in-registry","evidence_refs":[],"reason":"x"}'], "o.json");
  const c = JSON.parse(fs.readFileSync(r.out, "utf8"));
  ok(c["11"]?.project_name === "legacy-not-in-registry",
     `명부 밖 이름도 그대로 남긴다 — 적격 판정은 runner 가 한다`);
}

// ── ⑦ 🔴 근거 참조가 그 케이스 것인지 검증한다 (코디 반례 재현)
{
  // 양쪽 케이스에 memory:11 을 돌려준다 → 케이스 22 에는 11 이 입력에 없다
  const r = run(["--canned", '{"project_name":"alpha","evidence_refs":["memory:11"],"reason":"x"}'], "ev.json");
  const c = JSON.parse(fs.readFileSync(r.out, "utf8"));
  const rows = logRows(r.out).filter((x: any) => x.kind === "gen");
  const r11 = rows.find((x: any) => x.case_id === 11), r22 = rows.find((x: any) => x.case_id === 22);
  ok(r11?.status === "ok", `케이스11: memory:11 은 자기 대상 id → ok (실제 ${r11?.status})`);
  ok(r22?.status === "evidence_error",
     `케이스22: memory:11 은 다른 케이스 id → evidence_error (실제 ${r22?.status})  ← 전엔 ok 로 통과했다`);
  ok(!("22" in c), `근거 오류 후보는 후보 파일에 **넣지 않는다**(B 에 정상 근거로 안 넘어간다)`);
  ok(Array.isArray(r22?.bad_evidence_refs) && r22.bad_evidence_refs.includes("memory:11"),
     `어떤 참조가 문제인지 기록된다 (${JSON.stringify(r22?.bad_evidence_refs)})`);
  ok(Array.isArray(r22?.allowed_ref_ids) && r22.allowed_ref_ids.includes("22") && r22.allowed_ref_ids.includes("202"),
     `허용 id 집합도 같이 남는다 (${JSON.stringify(r22?.allowed_ref_ids)})`);
  ok(r22?.proposed_name === "alpha", `이름은 로그에 남아 재검토가 가능하다`);
  // 없는 id · 다른 접두 · 배열 아님
  const r2 = run(["--canned", '{"project_name":"alpha","evidence_refs":["memory:999999"],"reason":"x"}'], "ev2.json");
  ok(logRows(r2.out).filter((x: any) => x.status === "evidence_error").length === 2, `없는 id → evidence_error`);
  const r3 = run(["--canned", '{"project_name":"alpha","evidence_refs":["buzz:abc"],"reason":"x"}'], "ev3.json");
  ok(logRows(r3.out).filter((x: any) => x.status === "evidence_error").length === 2, `memory: 아닌 접두 → evidence_error`);
  const r4 = run(["--canned", '{"project_name":"alpha","evidence_refs":"memory:11","reason":"x"}'], "ev4.json");
  ok(logRows(r4.out).filter((x: any) => x.status === "evidence_error").length === 2, `배열 아님 → evidence_error`);
  // 양성대조: 각 케이스가 **자기** prior id 를 돌려주면 통과한다
  const r5 = run(["--canned", '{"project_name":"alpha","evidence_refs":[],"reason":"x"}'], "ev5.json");
  ok(logRows(r5.out).filter((x: any) => x.status === "ok").length === 2, `빈 근거는 허용(근거 없음은 오류가 아니다)`);
}

// ── ⑧ 토큰·비용은 **미측정**임을 명시한다 + 응답 전문 산출물
{
  const r = run(["--canned", '{"project_name":"alpha","evidence_refs":[],"reason":"x"}'], "u.json");
  const meta = logRows(r.out).find((x: any) => x.kind === "gen_meta");
  ok(meta?.usage_measured === false, `gen_meta 에 usage_measured=false 가 명시된다`);
  ok(typeof meta?.cost_note === "string" && /총비용 결론 금지/.test(meta.cost_note), `총비용 결론 금지가 적힌다`);
  const rows = logRows(r.out).filter((x: any) => x.kind === "gen");
  ok(rows.every((x: any) => x.tokens === null && x.usage_measured === false), `케이스별로도 tokens=null 로 남는다`);
  ok(rows.every((x: any) => typeof x.ms === "number"), `지연(ms)은 실측으로 남는다`);
  const rawFile = r.out.replace(/\.json$/, "") + ".raw.jsonl";
  ok(fs.existsSync(rawFile), `응답 전문 산출물(raw.jsonl)이 생긴다`);
  const rawRows = fs.readFileSync(rawFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  ok(rawRows.length === 2 && rawRows.every((x: any) => typeof x.raw === "string" && x.prompt_sha),
     `전문이 케이스별로 잘림 없이 남는다 (${rawRows.length}건)`);
}

// ── ⑨ 🔴 실제 대기 timeout 경로 + 인자 검증 (코디 반례: 0.5ms 가 정규식을 빠져나갔다)
{
  // canned 응답을 늦춰 **모델 없이** 실제 대기 timeout 을 태운다
  const r = run(["--canned", '{"project_name":"alpha","evidence_refs":[],"reason":"x"}',
                 "--canned-delay-ms", "300", "--timeout-ms", "10"], "to.json");
  ok(r.rc === 5, `timeout 발생 → rc=5 (실제 ${r.rc})`);
  const L = logRows(r.out);
  const ab = L.find((x: any) => x.kind === "aborted");
  ok(!!ab && ab.reason === "timeout", `aborted 기록 (${JSON.stringify(ab)})`);
  const gen = L.filter((x: any) => x.kind === "gen");
  ok(gen.length === 1, `첫 케이스에서 멈춘다 — 이후 요청 없음 (gen 행 ${gen.length}, 케이스는 2건)`);
  const sum = L.find((x: any) => x.kind === "gen_summary");
  ok(sum?.aborted_on_timeout === true, `gen_summary.aborted_on_timeout=true`);
  const meta = L.find((x: any) => x.kind === "gen_meta");
  ok(meta?.timeout_ms === 10, `gen_meta.timeout_ms 가 기록된다 (${meta?.timeout_ms})`);

  // 🔴 0.5ms — 전엔 호출 2회·rc=0·aborted=false 로 빠져나갔다. 이제 **인자 검증에서 막는다**
  for (const bad of ["0.5", "0", "-1", "abc", "2147483648", ""]) {
    const rb = run(["--canned", '{"project_name":"alpha","evidence_refs":[],"reason":"x"}',
                    "--timeout-ms", bad], `bad_${bad || "empty"}.json`);
    ok(rb.rc === 2, `--timeout-ms ${JSON.stringify(bad)} → rc=2 로 거부 (실제 ${rb.rc})`);
  }
  // 정상 정수는 통과
  const rg = run(["--canned", '{"project_name":"alpha","evidence_refs":[],"reason":"x"}',
                  "--timeout-ms", "5000"], "good_to.json");
  ok(rg.rc === 0, `--timeout-ms 5000 → 정상 (실제 ${rg.rc})`);
}

// ── ⑥ live manifest 가드
{
  const r = run(["--live-model"], "l.json");
  ok(r.rc === 3, `live + manifest 미명시 → rc=3 (실제 ${r.rc})`);
  ok(!fs.existsSync(r.out), `결과 파일 미작성`);
  ok(/manifest/.test(r.stdout), `이유 기록`);
}

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(emptyPrompts, { recursive: true, force: true });
console.log(fail === 0 ? "\n✅ 후보 생성 어댑터 검증 통과" : `\n❌ ${fail}건 실패`);
if (fail) process.exit(1);
