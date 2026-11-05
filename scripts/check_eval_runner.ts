/**
 * 평가 runner 회귀 검사 — 코디 리뷰 3건을 고정한다.
 *   ① 후보가 없어도 **모든 팔의 분모가 유지**된다 (행이 사라지지 않는다)
 *   ② **명부 밖 정본**에 세 팔이 같은 적격 조건을 쓴다 (C 만 넓게 받지 않는다)
 *   ③ **live 설정 누락**이면 모델을 부르기 **전에** 멈춘다
 * 모델 호출 0 · DB 접근 0.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = process.cwd();
const RUNNER = path.join(REPO, "node_modules/.cache/mcp-agents-memory/eval_tagging_runner.mjs");
if (!fs.existsSync(RUNNER)) {
  execFileSync(path.join(REPO, "node_modules/.bin/esbuild"),
    [path.join(REPO, "scripts/eval_tagging_runner.ts"), "--bundle", "--platform=node", "--format=esm",
     "--packages=external", `--outfile=${RUNNER}`, "--log-level=warning"], { stdio: "pipe" });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evalchk-"));
const w = (name: string, o: unknown) => {
  const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify(o)); return p;
};
const mk = (id: number) => ({ id, message: `메시지 ${id}`, role: "user", agent_platform: "p",
                              agent_model: "m", venue: "buzz:x" });
const casesPath = w("cases.json", { cases: [mk(1), mk(2), mk(3)] });
// 명부: alpha=1 만 적격. 전체 이름 맵에는 명부 밖 정본 legacy=99 가 있다 (코디 반례)
const regPath = w("registry.json", {
  registry_mode: true,
  candidates: [{ id: 1, name: "alpha", description: "A" }],
  name_to_canonical_id: { alpha: 1, legacy: 99 },
  allowed_canonical_ids: [1],
  hints: {},
});
const run = (args: string[]) => {
  try {
    const stdout = execFileSync(process.execPath, [RUNNER, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { rc: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { rc: e.status ?? -1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
};
const rows = (p: string) => fs.readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
let fail = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "✅" : "❌"} ${msg}`); if (!cond) fail++; };

// ── ① 후보 없음 — 세 팔 모두 3행
{
  const out = path.join(tmp, "no_cand.jsonl");
  const r = run(["--cases", casesPath, "--registry", regPath, "--arms", "A,B,C",
                 "--canned", '{"p_tag":"alpha","d_tag":[]}', "--out", out]);
  const res = rows(out).filter((x) => x.kind === "result");
  const per = (a: string) => res.filter((x) => x.arm === a).length;
  ok(r.rc === 0, `후보 없음 실행 rc=0 (실제 ${r.rc})`);
  ok(per("A") === 3 && per("B") === 3 && per("C") === 3,
     `후보 없어도 분모 유지 — A=${per("A")} B=${per("B")} C=${per("C")} (각 3이어야 한다)`);
  const bRan = res.filter((x) => x.arm === "B" && x.status === "ok" && x.p_tag_id === 1).length;
  ok(bRan === 3, `후보 없는 B 도 태거를 호출해 A 와 같은 결과 — ${bRan}/3`);
  const cNo = res.filter((x) => x.arm === "C" && x.trace?.decision_reason === "no_candidate").length;
  ok(cNo === 3, `C 는 '후보 없음' 을 명시적 행으로 남긴다 — ${cNo}/3`);
}

// ── ② 명부 밖 정본 — 세 팔이 같은 적격 조건
{
  const candPath = w("cand.json", { 1: { project_name: "legacy" }, 2: { project_name: "legacy" }, 3: { project_name: "legacy" } });
  const out = path.join(tmp, "outside.jsonl");
  const r = run(["--cases", casesPath, "--registry", regPath, "--arms", "A,B,C", "--candidates", candPath,
                 "--canned", '{"p_tag":"legacy","d_tag":[]}', "--out", out]);
  const res = rows(out).filter((x) => x.kind === "result");
  const ids = (a: string) => new Set(res.filter((x) => x.arm === a).map((x) => x.p_tag_id));
  ok(r.rc === 0, `명부 밖 정본 실행 rc=0 (실제 ${r.rc})`);
  // 🔴 빈 집합에 every() 는 **공허하게 참**이다 — 집합 크기도 같이 못 박는다
  const onlyNull = (a: string) => { const v = [...ids(a)]; return v.length > 0 && v.every((x) => x === null); };
  ok(onlyNull("A"), `A: 명부 밖 정본 거부 → p_tag_id ${JSON.stringify([...ids("A")])}`);
  ok(onlyNull("B"), `B: 명부 밖 정본 거부 → p_tag_id ${JSON.stringify([...ids("B")])}`);
  ok(onlyNull("C"), `C: 명부 밖 정본 거부 → p_tag_id ${JSON.stringify([...ids("C")])}  ← 전엔 [99] 였다`);
  const c0 = res.find((x) => x.arm === "C");
  ok(c0?.canonical_id === 99 && c0?.registry_eligible === false,
     `C 는 '식별됨(canonical_id=99)' 과 '허용 정본 연결 아님(eligible=false)' 을 분리해 남긴다`);
}

// ── ③ live 설정 누락 — 호출 전에 멈춘다
{
  const out = path.join(tmp, "live.jsonl");
  const r = run(["--cases", casesPath, "--registry", regPath, "--arms", "A", "--live-model", "--out", out]);
  ok(r.rc !== 0, `live 설정 누락 → 0 이 아닌 종료코드 (실제 ${r.rc})`);
  ok(!fs.existsSync(out), `결과 파일을 쓰지 않았다 (호출 전에 멈췄다)`);
  const said = /설정 누락|not found|required core prompt/.test(r.stderr + r.stdout);
  ok(said, `왜 멈췄는지 기록된다`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail === 0 ? "\n✅ 평가 runner 회귀 검사 통과" : `\n❌ ${fail}건 실패`);
if (fail) process.exit(1);
