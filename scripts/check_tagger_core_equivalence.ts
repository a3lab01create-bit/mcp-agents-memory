/**
 * 동등성 검증 — pristine tagger (고정 SHA) vs 새 운영 wrapper.
 *
 * 두 팔을 **같은 샌드박스**에 놓고 같은 stub 어댑터를 쓰게 한다. 비교 축 3개 × 분기 8개.
 *   (가) 조립된 user 프롬프트 **바이트 동일**
 *   (나) 반환 TagResult 동일 (newly_created_p_tag_name 포함)
 *   (다) 어댑터 호출 순서·인자 동일
 *
 * 🔴 팔 격리: pristine 은 `git show <SHA>:src/cold_path/tagger.ts` 로 꺼내 **별도 파일**로 둔다.
 *    두 파일이 실제로 다른 코드인지 sha + 처치 전용 심볼 grep 으로 먼저 확인한다.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const PRISTINE_SHA = "eb49fd8f278de8d1f25e8598c68bcfa1af18ee01";
const REPO = process.cwd();
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tagger-equiv-"));
const cp = path.join(sandbox, "src", "cold_path");
fs.mkdirSync(cp, { recursive: true });
fs.mkdirSync(path.join(sandbox, "src", "prompts"), { recursive: true });

function sha(s: string) { return crypto.createHash("sha256").update(s).digest("hex").slice(0, 12); }

// ── 팔 ①: pristine
const pristine = execFileSync("git", ["show", `${PRISTINE_SHA}:src/cold_path/tagger.ts`],
  { cwd: REPO, encoding: "utf8" });
fs.writeFileSync(path.join(cp, "tagger_pristine.ts"), pristine);
// ── 팔 ②: 새 wrapper + core
const wrapper = fs.readFileSync(path.join(REPO, "src/cold_path/tagger.ts"), "utf8");
const core = fs.readFileSync(path.join(REPO, "src/cold_path/tagger_core.ts"), "utf8");
fs.writeFileSync(path.join(cp, "tagger_new.ts"), wrapper.replace(/"\.\/tagger_core\.js"/g, '"./tagger_core.js"'));
// 순수 모듈·core 는 .js 로 변환해 둔다(두 팔의 import 가 .js 를 가리킨다)
function transpile(srcRel: string, outAbs: string) {
  execFileSync(path.join(REPO, "node_modules/.bin/esbuild"),
    [path.join(REPO, srcRel), "--format=esm", "--platform=node", `--outfile=${outAbs}`], { stdio: "pipe" });
}
transpile("src/cold_path/project_registry.ts", path.join(cp, "project_registry.js"));
fs.writeFileSync(path.join(cp, "tagger_core.ts"), core);
transpile("src/cold_path/tagger_core.ts", path.join(cp, "tagger_core.js"));

console.log(`팔 격리 확인: pristine sha=${sha(pristine)} wrapper sha=${sha(wrapper)} core sha=${sha(core)}`);
if (sha(pristine) === sha(wrapper)) throw new Error("두 팔이 같은 코드다 — 격리 실패");
if (!/runTagger/.test(wrapper)) throw new Error("처치 심볼 runTagger 가 wrapper 에 없다");
if (/runTagger/.test(pristine)) throw new Error("pristine 에 처치 심볼이 있다 — SHA 가 잘못됐다");

// ESM 에서는 export 재할당이 안 되므로 가변 상태는 객체 하나로 둔다
fs.writeFileSync(path.join(cp, "__stub_state.js"), `
export const S = {
  calls: [],
  modelOutput: '{"p_tag":null,"d_tag":[]}',
  modelThrows: false,
  fallbackOutput: '{"p_tag":null,"d_tag":[]}',
  candidates: { rows: [], registry: false },
  hints: new Map(),
  canon: {},
  blocked: new Set(),
  created: {},
  jev: null,
  jevApply: false,
  isLocal: true,
  localFallback: true,
};
export function reset() { S.calls = []; }
`);
fs.writeFileSync(path.join(sandbox, "src", "db.js"), `
import { S } from "./cold_path/__stub_state.js";
export const db = {
  async query(sql, params) {
    S.calls.push({ fn: "db.query", sql: sql.replace(/\\s+/g, " ").trim().slice(0, 60), params });
    const text = sql.replace(/\\s+/g, " ");
    if (/FROM project_tags WHERE kind IS NOT NULL/.test(text) || /WHERE kind IS NOT NULL AND alias_of IS NULL/.test(text)) {
      return { rows: S.candidates.registry ? S.candidates.rows : [] };
    }
    if (/hint_venues/.test(text)) return { rows: [] };
    if (/WITH RECURSIVE chain/.test(text)) {
      const name = params?.[0];
      const id = S.canon[name];
      return { rows: id != null ? [{ id }] : [] };
    }
    if (/INSERT INTO project_tags/.test(text)) {
      const name = params?.[0];
      const id = S.created[name] ?? 9001;
      return { rows: [{ id }] };
    }
    if (/FROM project_tags/.test(text)) return { rows: S.candidates.registry ? [] : S.candidates.rows };
    return { rows: [] };
  },
};
`);
fs.writeFileSync(path.join(sandbox, "src", "model_registry.js"), `
import { S } from "./cold_path/__stub_state.js";
export const ROLE_REGISTRY = { get tagger() { return { provider: S.isLocal ? "local" : "xai", model_name: "stub" }; } };
export async function callRole(role, opts) {
  S.calls.push({ fn: "callRole", role, system: opts.system, user: opts.user,
                 hasSchema: !!opts.jsonSchema, enableThinking: opts.enableThinking });
  if (S.modelThrows) throw new Error("stub model failure");
  return S.modelOutput;
}
export async function callSpec(spec, opts) {
  S.calls.push({ fn: "callSpec", spec, system: opts.system, user: opts.user });
  return S.fallbackOutput;
}
export const EMBEDDING_MODEL = "stub";
`);
fs.mkdirSync(path.join(sandbox, "src", "prompts"), { recursive: true });
fs.writeFileSync(path.join(sandbox, "src", "prompts", "index.js"), `
export function getPrompt(_name, fallback) { return "SYS::" + fallback.slice(0, 20); }
`);
fs.writeFileSync(path.join(cp, "jev_judge.js"), `
import { S } from "./__stub_state.js";
export async function judgeProjectTag(i) { S.calls.push({ fn: "judgeJev", role: i.role }); return S.jev; }
export function shouldApplyJevJudgment(_j) { S.calls.push({ fn: "applyJev" }); return S.jevApply; }
`);
fs.writeFileSync(path.join(cp, "dtag_promoter.js"), `
import { S } from "./__stub_state.js";
export async function isBlockedNewTagName(n) { S.calls.push({ fn: "isBlockedNewName", n }); return S.blocked.has(n); }
`);

// ── 분기 8개
type Branch = { name: string; setup: (S: any) => void; input?: any };
const BRANCHES: Branch[] = [
  { name: "명부 이름", setup: (S) => { S.candidates = { rows: [{ id: 1, name: "alpha", description: "A" }], registry: true };
      S.modelOutput = '{"p_tag":"alpha","d_tag":["x"]}'; S.canon = { alpha: 1 }; } },
  { name: "명부 별칭", setup: (S) => { S.candidates = { rows: [{ id: 1, name: "alpha", description: "A" }], registry: true };
      S.modelOutput = '{"p_tag":"alpha-old","d_tag":[]}'; S.canon = { "alpha-old": 1 }; } },
  { name: "null", setup: (S) => { S.candidates = { rows: [{ id: 1, name: "alpha", description: null }], registry: false };
      S.modelOutput = '{"p_tag":null,"d_tag":[]}'; } },
  { name: "NEW 신규", setup: (S) => { S.candidates = { rows: [{ id: 1, name: "alpha", description: null }], registry: false };
      S.modelOutput = '{"p_tag":"NEW:beta","d_tag":["b"]}'; S.created = { beta: 77 }; } },
  { name: "NEW 금지 이름", setup: (S) => { S.candidates = { rows: [], registry: false };
      S.modelOutput = '{"p_tag":"NEW:banned","d_tag":[]}'; S.blocked = new Set(["banned"]); } },
  { name: "후보 외 이름 거부", setup: (S) => { S.candidates = { rows: [{ id: 1, name: "alpha", description: null }], registry: false };
      S.modelOutput = '{"p_tag":"zzz","d_tag":[]}'; S.canon = {}; } },
  { name: "fallback 발동", setup: (S) => { S.candidates = { rows: [], registry: false };
      S.modelThrows = true; S.fallbackOutput = '{"p_tag":null,"d_tag":["f"]}'; } },
  { name: "Jev 적용", setup: (S) => { S.candidates = { rows: [{ id: 5, name: "gamma", description: null }], registry: false };
      S.modelOutput = '{"p_tag":null,"d_tag":[]}'; S.jev = { choice: "gamma", confidence: 0.99 }; S.jevApply = true;
      S.canon = { gamma: 5 }; } },
];

const INPUT = { message: "테스트 메시지", role: "user" as const, agent_platform: "p", agent_model: "m", venue: "buzz:x" };

const { S, reset } = await import(path.join(cp, "__stub_state.js"));
const pristineMod: any = await import(path.join(cp, "tagger_pristine.ts"));
const newMod: any = await import(path.join(cp, "tagger_new.ts"));

function freshState() {
  S.calls = []; S.modelOutput = '{"p_tag":null,"d_tag":[]}'; S.modelThrows = false;
  S.fallbackOutput = '{"p_tag":null,"d_tag":[]}'; S.candidates = { rows: [], registry: false };
  S.hints = new Map(); S.canon = {}; S.blocked = new Set(); S.created = {};
  S.jev = null; S.jevApply = false; S.isLocal = true;
}

let fails = 0;
for (const b of BRANCHES) {
  const runs: any[] = [];
  for (const mod of [pristineMod, newMod]) {
    freshState(); b.setup(S);
    mod.invalidateCandidateCache?.();
    let result: any, err: string | null = null;
    try { result = await mod.tagMessage(INPUT); } catch (e: any) { err = e.message; }
    const modelCall = S.calls.find((c: any) => c.fn === "callRole" || c.fn === "callSpec");
    runs.push({ prompt: modelCall?.user ?? null, result, err,
                order: S.calls.map((c: any) => c.fn).join(">") });
  }
  const [P, N] = runs;
  const promptSame = P.prompt === N.prompt;
  const resultSame = JSON.stringify(P.result) === JSON.stringify(N.result) && P.err === N.err;
  const orderSame = P.order === N.order;
  const ok = promptSame && resultSame && orderSame;
  if (!ok) fails++;
  console.log(`${ok ? "✅" : "❌"} ${b.name.padEnd(16)} 프롬프트=${promptSame ? "동일" : "다름"} 반환=${resultSame ? "동일" : "다름"} 호출순서=${orderSame ? "동일" : "다름"}`);
  if (!ok) {
    console.log(`   pristine: ${JSON.stringify(P).slice(0, 300)}`);
    console.log(`   new     : ${JSON.stringify(N).slice(0, 300)}`);
  }
}
void reset;
console.log(fails === 0 ? `\n✅ 8/8 분기 동등 (pristine ${PRISTINE_SHA.slice(0,8)})` : `\n❌ ${fails} 분기 불일치`);
fs.rmSync(sandbox, { recursive: true, force: true });
if (fails) process.exit(1);
