/**
 * 평가 경로가 DB 에 닿지 않는지 검증 — 두 축으로 본다.
 *   (가) **정적 import 그래프**: tagger_core 에서 출발해 `db.ts` 나 `pg` 에 **도달하지 않는다**
 *   (나) **런타임 tripwire**: 소켓 연결을 막아두고 실패 경로까지 전부 실행해도 연결 시도가 없다
 * 두 축 모두 **대조**를 붙인다 — (가)는 tagger.ts(운영 wrapper)가 **도달한다**는 것으로,
 * (나)는 일부러 연결을 시도해 tripwire 가 실제로 걸린다는 것으로 확인한다.
 */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";
import os from "node:os";

const REPO = process.cwd();
const SRC = path.join(REPO, "src");

// ── (가) 정적 import 그래프
function graph(entryRel: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>(); const bare = new Set<string>();
  const stack = [path.join(REPO, entryRel)];
  while (stack.length) {
    const f = stack.pop()!;
    if (files.has(f)) continue;
    if (!fs.existsSync(f)) continue;
    files.add(f);
    const text = fs.readFileSync(f, "utf8");
    const specs = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])
      .concat([...text.matchAll(/import\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]));
    for (const spec of specs) {
      if (spec.startsWith(".")) {
        const abs = path.resolve(path.dirname(f), spec).replace(/\.js$/, ".ts");
        stack.push(abs);
      } else {
        bare.add(spec.replace(/^node:/, "node:"));
      }
    }
  }
  return { files, bare };
}

const coreG = graph("src/cold_path/tagger_core.ts");
const wrapG = graph("src/cold_path/tagger.ts");
const runnerG = graph("scripts/eval_tagging_runner.ts");  // 동적 import(--live-model) 포함
const hitsDb = (g: { files: Set<string>; bare: Set<string> }) =>
  [...g.files].some((f) => f.endsWith(path.join("src", "db.ts"))) || g.bare.has("pg");

console.log("── (가) 정적 import 그래프");
console.log(`core  파일 ${coreG.files.size}개 · 외부 ${[...coreG.bare].join(", ") || "(없음)"} · db/pg 도달 ${hitsDb(coreG)}`);
console.log(`wrap  파일 ${wrapG.files.size}개 · db/pg 도달 ${hitsDb(wrapG)}  ← 대조군(도달해야 정상)`);
let fail = 0;
if (hitsDb(coreG)) { console.log("❌ core 가 db/pg 에 도달한다"); fail++; }
else console.log("✅ core 는 db/pg 에 도달하지 않는다");
if (!hitsDb(wrapG)) { console.log("❌ 대조군(wrapper)이 db/pg 에 도달하지 않는다 — 검사기가 눈먼 상태다"); fail++; }
else console.log("✅ 대조군 확인 — 검사기는 도달을 실제로 볼 수 있다");
console.log(`runner 파일 ${runnerG.files.size}개 · db/pg 도달 ${hitsDb(runnerG)} (동적 import 포함)`);
if (hitsDb(runnerG)) { console.log("❌ 평가 runner 가 db/pg 에 도달한다"); fail++; }
else console.log("✅ 평가 runner 도 db/pg 에 도달하지 않는다 (--live-model 의 동적 import 까지 포함)");

// ── (나) 런타임 tripwire
console.log("\n── (나) 런타임 tripwire");
let connectAttempts = 0;
const realConnect = net.Socket.prototype.connect;
(net.Socket.prototype as any).connect = function (...args: any[]) {
  connectAttempts++;
  throw new Error("TRIPWIRE: socket connect attempted");
};
// 양성대조: tripwire 가 실제로 걸리나
let tripworks = false;
try { new net.Socket().connect(1, "127.0.0.1"); } catch { tripworks = true; }
console.log(tripworks ? "✅ tripwire 양성대조 통과 (연결 시도가 실제로 잡힌다)" : "❌ tripwire 가 동작하지 않는다");
if (!tripworks) fail++;
connectAttempts = 0;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nodb-"));
execFileSync(path.join(REPO, "node_modules/.bin/esbuild"),
  [path.join(SRC, "cold_path/tagger_core.ts"), "--bundle", "--format=esm", "--platform=node",
   `--outfile=${path.join(tmp, "core.mjs")}`], { stdio: "pipe" });
const core: any = await import(path.join(tmp, "core.mjs"));

const evalPorts = (over: any = {}) => ({
  systemPrompt: "SYS",
  isLocalProvider: () => true,
  fallbackEnabled: () => true,
  callPrimary: async () => over.out ?? '{"p_tag":null,"d_tag":[]}',
  callFallback: async () => over.fb ?? '{"p_tag":null,"d_tag":["f"]}',
  judgeJev: async () => over.jev ?? null,
  applyJev: () => !!over.jevApply,
  listCandidates: async () => over.cands ?? { rows: [{ id: 1, name: "alpha", description: null }], registry: false },
  listHints: async () => new Map(),
  resolveCanonical: async (n: string) => (over.canon ?? {})[n] ?? null,
  isBlockedNewName: async (n: string) => (over.blocked ?? new Set()).has(n),
  // getOrCreateTag 없음 — 평가 포트
});
const input = { message: "m", role: "user" as const, agent_platform: "p", agent_model: "mm" };

/** 사례마다 **예상 반환·예외·trace** 를 못 박는다 — 무연결만 보면 경로가 안 돌아도 PASS 된다(코디 지적). */
type Expect = { p_tag_id?: number | null; reason?: string; persist?: string; proposed?: string;
                throws?: RegExp; jev_applied?: boolean; fallback_attempted?: boolean;
                fallback_used?: boolean; model_raw?: string | null; effective?: string | null };
const paths: Array<[string, any, Expect]> = [
  ["NEW 제안", { out: '{"p_tag":"NEW:beta","d_tag":[]}' },
    { p_tag_id: null, reason: "new_proposal_no_persist", persist: "skipped_no_port", proposed: "beta",
      model_raw: "NEW:beta", effective: "NEW:beta" }],
  ["NEW 금지", { out: '{"p_tag":"NEW:banned","d_tag":[]}', blocked: new Set(["banned"]) },
    { p_tag_id: null, reason: "blocked_by_policy", persist: "none", proposed: "banned" }],
  ["p_tag null", { out: '{"p_tag":null,"d_tag":[]}' },
    { p_tag_id: null, reason: "no_answer", persist: "none", model_raw: null, effective: null }],
  ["잘못된 JSON", { out: "not-json" }, { throws: /invalid JSON/ }],
  ["모델 실패→fallback", { out: null },
    { p_tag_id: null, reason: "no_answer", fallback_attempted: true, fallback_used: true }],
  ["fallback 도 실패", { out: null, fbThrows: true },
    { throws: /fallback down/, fallback_attempted: true, fallback_used: false }],
  ["명부 모드 별칭", { out: '{"p_tag":"a-old","d_tag":[]}',
      cands: { rows: [{ id: 1, name: "alpha", description: "x" }], registry: true }, canon: { "a-old": 1 } },
    { p_tag_id: 1, reason: "resolved_existing" }],
  ["후보 외 이름", { out: '{"p_tag":"zzz","d_tag":[]}' },
    { p_tag_id: null, reason: "rejected_not_candidate" }],
  ["Jev 적용", { out: '{"p_tag":null,"d_tag":[]}', jev: { choice: "alpha", confidence: 1 }, jevApply: true, canon: { alpha: 1 } },
    { p_tag_id: 1, reason: "resolved_existing", jev_applied: true, model_raw: null, effective: "alpha" }],
];
for (const [name, over, exp] of paths) {
  const ports: any = evalPorts(over);
  if (over.out === null) ports.callPrimary = async () => { throw new Error("model down"); };
  if (over.fbThrows) ports.callFallback = async () => { throw new Error("fallback down"); };
  const trace: any = {};
  const bad: string[] = [];
  let r: any = null, thrown: Error | null = null;
  try { r = await core.runTagger(input, ports, trace); } catch (e: any) { thrown = e; }
  if (thrown && /TRIPWIRE/.test(thrown.message)) { bad.push("TRIPWIRE 발동"); fail++; }
  if (exp.throws) {
    if (!thrown) bad.push(`예외를 기대했는데 정상 반환`);
    else if (!exp.throws.test(thrown.message)) bad.push(`예외 문구 불일치: ${thrown.message.slice(0, 50)}`);
  } else if (thrown) {
    bad.push(`예상 밖 예외: ${thrown.message.slice(0, 50)}`);
  }
  const chk = (k: string, got: any, want: any) => { if (want !== undefined && got !== want) bad.push(`${k} ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`); };
  if (!exp.throws) chk("p_tag_id", r?.p_tag_id ?? null, exp.p_tag_id);
  chk("decision_reason", trace.decision_reason, exp.reason);
  chk("persistence_action", trace.persistence_action, exp.persist);
  chk("proposed_name", trace.proposed_name, exp.proposed);
  chk("jev_applied", trace.jev_applied, exp.jev_applied);
  chk("fallback_attempted", trace.fallback_attempted, exp.fallback_attempted);
  chk("fallback_used", trace.fallback_used, exp.fallback_used);
  chk("model_raw_p_tag", trace.model_raw_p_tag, exp.model_raw);
  chk("effective_p_tag", trace.effective_p_tag, exp.effective);
  if (bad.length) fail++;
  console.log(`   ${bad.length ? "❌" : "✅"} ${name.padEnd(18)}` +
    (bad.length ? ` ${bad.join(" · ")}`
                : ` ${thrown ? `throw(${thrown.message.slice(0, 22)})` : `p_tag_id=${JSON.stringify(r?.p_tag_id ?? null)}`}` +
                  ` reason=${trace.decision_reason ?? "-"}`));
}
(net.Socket.prototype as any).connect = realConnect;
console.log(connectAttempts === 0 ? "✅ 실패 경로 전부 실행 — 소켓 연결 시도 0회" : `❌ 소켓 연결 시도 ${connectAttempts}회`);
if (connectAttempts !== 0) fail++;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail === 0 ? "\n✅ DB 미도달 검증 통과" : `\n❌ ${fail}건 실패`);
if (fail) process.exit(1);
