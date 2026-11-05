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
    for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
      const spec = m[1];
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

const paths: Array<[string, any]> = [
  ["NEW 제안", { out: '{"p_tag":"NEW:beta","d_tag":[]}' }],
  ["NEW 금지", { out: '{"p_tag":"NEW:banned","d_tag":[]}', blocked: new Set(["banned"]) }],
  ["p_tag null", { out: '{"p_tag":null,"d_tag":[]}' }],
  ["잘못된 JSON", { out: "not-json" }],
  ["모델 실패→fallback", { out: null }],
  ["명부 모드 별칭", { out: '{"p_tag":"a-old","d_tag":[]}', cands: { rows: [{ id: 1, name: "alpha", description: "x" }], registry: true }, canon: { "a-old": 1 } }],
  ["후보 외 이름", { out: '{"p_tag":"zzz","d_tag":[]}' }],
  ["Jev 적용", { out: '{"p_tag":null,"d_tag":[]}', jev: { choice: "alpha", confidence: 1 }, jevApply: true, canon: { alpha: 1 } }],
];
for (const [name, over] of paths) {
  const ports: any = evalPorts(over);
  if (over.out === null) ports.callPrimary = async () => { throw new Error("model down"); };
  const trace: any = {};
  try {
    const r = await core.runTagger(input, ports, trace);
    console.log(`   ${name.padEnd(18)} p_tag_id=${r.p_tag_id} reason=${trace.decision_reason} persist=${trace.persistence_action}` +
                (trace.proposed_name ? ` proposed=${trace.proposed_name}` : ""));
  } catch (e: any) {
    console.log(`   ${name.padEnd(18)} throw: ${e.message.slice(0, 50)}`);
    if (/TRIPWIRE/.test(e.message)) fail++;
  }
}
(net.Socket.prototype as any).connect = realConnect;
console.log(connectAttempts === 0 ? "✅ 실패 경로 전부 실행 — 소켓 연결 시도 0회" : `❌ 소켓 연결 시도 ${connectAttempts}회`);
if (connectAttempts !== 0) fail++;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail === 0 ? "\n✅ DB 미도달 검증 통과" : `\n❌ ${fail}건 실패`);
if (fail) process.exit(1);
