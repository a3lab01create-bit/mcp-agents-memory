/**
 * bench_local_tagger.ts — 로컬 LLM vs grok 태거 벤치마크
 *
 * 목적:
 *   - 로컬 모델(ollama)로 p_tag + d_tag 추출의 실제 품질·속도 측정
 *   - grok 기준선 대비 일치율 계산
 *   - 일일 메시지 볼륨(§12 기준 3~5K) 소화 가능 여부 판단
 *
 * 실행:
 *   npx tsx scripts/bench_local_tagger.ts [--samples=30] [--model=qwen3.5:9b] [--no-grok]
 *
 * 환경:
 *   LOCAL_LLM_BASE_URL=http://localhost:11434/v1 (기본값)
 *   XAI_API_KEY= (grok 비교 시 필요; --no-grok 으로 skip 가능)
 */

import { db } from "../src/db.js";
import OpenAI from "openai";
import * as dotenv from "dotenv";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ── CLI 인자 파싱 ─────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (key: string, def: string) =>
  args.find(a => a.startsWith(`--${key}=`))?.split('=')[1] ?? def;

const SAMPLE_COUNT = parseInt(getArg('samples', '30'), 10);
// 벤치는 항상 로컬 모델 대상 — env TAGGER_MODEL(=grok 등 cloud 설정)은 무시
const LOCAL_MODEL  = getArg('model', process.env.LOCAL_TAGGER_MODEL ?? 'qwen3.5:9b');
const SKIP_GROK    = args.includes('--no-grok');
const LOCAL_BASE   = process.env.LOCAL_LLM_BASE_URL ?? 'http://localhost:11434/v1';

// ── 태거 프롬프트 (tagger.ts와 동일하게 유지) ─────────────
const SYSTEM_PROMPT = `Tagger for one user's personal long-term memory across AI agents.

OUTPUT (strict JSON):
{ "p_tag": "<existing-name>" | "NEW:<slug>" | null, "d_tag": ["<kw>", ...] }

p_tag: ONE project tag. STRONGLY prefer matching the candidate list below —
  synonyms / near-matches MUST map to an existing candidate (e.g. "Centrazen project" → "centragens").
  Use "NEW:<slug>" only when the message is clearly about a brand-new project
  absent from candidates. null when the message is too short / generic to project-tag.

d_tag: 0-3 short keywords (lowercase, hyphenated) about the topic.
  e.g. ["bug-fix", "schema", "memory_add"]. Skip if message has no signal.

ROLE: input includes role='user' or role='assistant'. For role='assistant',
  tag the topic — DO NOT treat the assistant's reply as a fact about the user.`;

interface Sample {
  id: number;
  role: 'user' | 'assistant';
  message: string;
  current_p_tag_id: number | null;
  current_d_tag: string[];
}

interface Candidate {
  id: number;
  name: string;
}

interface TagResult {
  p_tag: string | null;
  d_tag: string[];
}

interface RunResult {
  ok: boolean;
  parsed: TagResult | null;
  latencyMs: number;
  inputTokensEst: number;
  outputTokensEst: number;
  error?: string;
}

// ── 클라이언트 초기화 ─────────────────────────────────────
const localClient = new OpenAI({ apiKey: 'local', baseURL: LOCAL_BASE });
const grokClient  = SKIP_GROK || !process.env.XAI_API_KEY
  ? null
  : new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: 'https://api.x.ai/v1' });

// ── DB 헬퍼 ──────────────────────────────────────────────
async function fetchSamples(n: number): Promise<Sample[]> {
  const r = await db.query(
    `SELECT id, role, message, p_tag_id AS current_p_tag_id, d_tag AS current_d_tag
       FROM memory
      WHERE message IS NOT NULL AND LENGTH(message) > 15
      ORDER BY created_at DESC
      LIMIT $1`,
    [n]
  );
  return r.rows.map((row: any) => ({
    id: Number(row.id),
    role: row.role as 'user' | 'assistant',
    message: row.message,
    current_p_tag_id: row.current_p_tag_id ? Number(row.current_p_tag_id) : null,
    current_d_tag: Array.isArray(row.current_d_tag) ? row.current_d_tag : [],
  }));
}

async function fetchCandidates(): Promise<Candidate[]> {
  const r = await db.query(
    `SELECT id, name FROM project_tags WHERE alias_of IS NULL ORDER BY id ASC LIMIT 20`
  );
  return r.rows.map((row: any) => ({ id: Number(row.id), name: row.name }));
}

function buildUserPrompt(sample: Sample, candidates: Candidate[]): string {
  const candList = candidates.length > 0 ? candidates.map(c => c.name).join(', ') : '(none)';
  return `candidates: ${candList}\nrole=${sample.role}\nmessage: ${sample.message}`;
}

// ── 단일 호출 실행 ────────────────────────────────────────
async function runLocal(userPrompt: string, thinking: boolean): Promise<RunResult> {
  const t0 = Date.now();
  try {
    const res = await (localClient.chat.completions.create as Function)({
      model: LOCAL_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      // qwen3.x 계열: response_format:json_object 사용 시 content 빈 버그 있음.
      // qwen2.5:7b 같은 non-thinking 모델: response_format 정상 동작, 사용하는 게 안정적.
      // qwen3.5:9b 등 thinking 모델은 이 벤치 대신 --model=qwen2.5:7b 권장.
      response_format: { type: 'json_object' as const },
      temperature: 0.1,
      max_tokens: 256,
    });
    const latencyMs = Date.now() - t0;
    const raw = (res.choices[0]?.message?.content ?? '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/```json|```/g, '')
      .trim();

    const usage = res.usage;
    try {
      const parsed = JSON.parse(raw) as TagResult;
      return {
        ok: true,
        parsed,
        latencyMs,
        inputTokensEst: usage?.prompt_tokens ?? estimateTokens(SYSTEM_PROMPT + userPrompt),
        outputTokensEst: usage?.completion_tokens ?? estimateTokens(raw),
      };
    } catch {
      return { ok: false, parsed: null, latencyMs, inputTokensEst: 0, outputTokensEst: 0, error: `JSON parse fail: ${raw.slice(0, 120)}` };
    }
  } catch (err: any) {
    return { ok: false, parsed: null, latencyMs: Date.now() - t0, inputTokensEst: 0, outputTokensEst: 0, error: err.message?.slice(0, 120) };
  }
}

async function runGrok(userPrompt: string): Promise<RunResult> {
  if (!grokClient) return { ok: false, parsed: null, latencyMs: 0, inputTokensEst: 0, outputTokensEst: 0, error: 'grok skip' };
  const t0 = Date.now();
  try {
    const res = await grokClient.chat.completions.create({
      model: 'grok-4-1-fast-non-reasoning',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 256,
    });
    const latencyMs = Date.now() - t0;
    const raw = (res.choices[0]?.message?.content ?? '').replace(/```json|```/g, '').trim();
    const usage = res.usage;
    try {
      const parsed = JSON.parse(raw) as TagResult;
      return { ok: true, parsed, latencyMs, inputTokensEst: usage?.prompt_tokens ?? 0, outputTokensEst: usage?.completion_tokens ?? 0 };
    } catch {
      return { ok: false, parsed: null, latencyMs, inputTokensEst: 0, outputTokensEst: 0, error: `JSON parse fail: ${raw.slice(0, 120)}` };
    }
  } catch (err: any) {
    return { ok: false, parsed: null, latencyMs: Date.now() - t0, inputTokensEst: 0, outputTokensEst: 0, error: err.message?.slice(0, 120) };
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── 결과 비교 ─────────────────────────────────────────────
function ptagMatch(local: TagResult | null, grok: TagResult | null): 'match' | 'diff' | 'skip' {
  if (!local || !grok) return 'skip';
  const l = local.p_tag ?? 'null';
  const g = grok.p_tag ?? 'null';
  if (l === g) return 'match';
  // NEW: vs null 은 meaningful diff
  return 'diff';
}

// ── 메인 ──────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('='.repeat(60));
  console.log(`  bench_local_tagger  samples=${SAMPLE_COUNT}  model=${LOCAL_MODEL}`);
  console.log(`  local base: ${LOCAL_BASE}`);
  console.log(`  grok compare: ${grokClient ? 'yes' : 'skip (--no-grok or no XAI_API_KEY)'}`);
  console.log('='.repeat(60));

  // 연결 확인
  console.log('\n📡 DB 연결 중...');
  const [samples, candidates] = await Promise.all([
    fetchSamples(SAMPLE_COUNT),
    fetchCandidates(),
  ]);
  console.log(`✅ ${samples.length} 샘플 로드, p_tag 후보 ${candidates.length}개`);

  // 로컬 연결 확인
  console.log(`\n🤖 로컬 모델 연결 확인 (${LOCAL_BASE})...`);
  try {
    const models = await localClient.models.list();
    const names = models.data.map(m => m.id).slice(0, 5).join(', ');
    console.log(`✅ ollama 응답 OK. 로드된 모델: ${names || '(목록 없음)'}`);
  } catch (err: any) {
    console.error(`❌ ollama 연결 실패: ${err.message}`);
    console.error('   ollama가 실행 중인지 확인: HSA_OVERRIDE_GFX_VERSION=10.3.0 ollama serve &');
    process.exit(1);
  }

  // 실행
  console.log(`\n🏃 벤치 시작 (thinking=OFF — 태거는 단순 매핑, reasoning이 토큰 독점 방지)...\n`);

  const localResults: RunResult[] = [];
  const grokResults: RunResult[] = [];
  let localOk = 0, grokOk = 0, matchCount = 0, diffCount = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const userPrompt = buildUserPrompt(s, candidates);
    process.stdout.write(`  [${String(i + 1).padStart(2)}/${samples.length}] `);

    const [localR, grokR] = await Promise.all([
      runLocal(userPrompt, false),
      grokClient ? runGrok(userPrompt) : Promise.resolve({ ok: false, parsed: null, latencyMs: 0, inputTokensEst: 0, outputTokensEst: 0, error: 'skip' }),
    ]);

    localResults.push(localR);
    grokResults.push(grokR);

    const verdict = ptagMatch(localR.parsed, grokR.parsed);
    if (localR.ok) localOk++;
    if (grokR.ok) grokOk++;
    if (verdict === 'match') matchCount++;
    if (verdict === 'diff')  diffCount++;

    const localStr = localR.ok
      ? `✅ ${localR.latencyMs}ms  p_tag=${localR.parsed?.p_tag ?? 'null'}`
      : `❌ ${localR.error?.slice(0, 50)}`;
    const grokStr = grokClient
      ? (grokR.ok ? ` | grok=${grokR.parsed?.p_tag ?? 'null'} ${verdict === 'diff' ? '⚠️ diff' : ''}` : '')
      : '';

    console.log(`${localStr}${grokStr}`);
  }

  // 통계
  const n = localResults.length;
  const latencies = localResults.filter(r => r.ok).map(r => r.latencyMs).sort((a, b) => a - b);
  const avgMs  = latencies.length ? latencies.reduce((s, v) => s + v, 0) / latencies.length : 0;
  const p50    = latencies[Math.floor(latencies.length * 0.50)] ?? 0;
  const p95    = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  const maxMs  = latencies[latencies.length - 1] ?? 0;

  const totalInTokens  = localResults.reduce((s, r) => s + r.inputTokensEst, 0);
  const totalOutTokens = localResults.reduce((s, r) => s + r.outputTokensEst, 0);
  const avgInPer  = totalInTokens  / Math.max(n, 1);
  const avgOutPer = totalOutTokens / Math.max(n, 1);

  // 일일 볼륨 투영 (§12 기준)
  const DAILY_MSGS = 3500; // §12 관찰: 3K~5K, 중간값
  const secPerMsg   = avgMs / 1000;
  const minutesNeeded = (DAILY_MSGS * secPerMsg) / 60;

  console.log('\n' + '='.repeat(60));
  console.log('  📊 결과 요약');
  console.log('='.repeat(60));
  console.log(`  샘플수       : ${n}`);
  console.log(`  로컬 성공률  : ${localOk}/${n} (${(localOk/n*100).toFixed(1)}%)`);
  if (grokClient) {
    console.log(`  grok 성공률  : ${grokOk}/${n} (${(grokOk/n*100).toFixed(1)}%)`);
    const compared = matchCount + diffCount;
    console.log(`  p_tag 일치율 : ${matchCount}/${compared} (${compared ? (matchCount/compared*100).toFixed(1) : '-'}%) | 차이: ${diffCount}건`);
  }
  console.log('');
  console.log(`  지연 (avg)   : ${avgMs.toFixed(0)}ms`);
  console.log(`  지연 (p50)   : ${p50}ms`);
  console.log(`  지연 (p95)   : ${p95}ms`);
  console.log(`  지연 (max)   : ${maxMs}ms`);
  console.log('');
  console.log(`  평균 토큰/call : in=${avgInPer.toFixed(0)}, out=${avgOutPer.toFixed(0)}`);
  console.log('');
  console.log(`  ── 일일 볼륨 투영 (${DAILY_MSGS}msgs/day) ──`);
  console.log(`  처리 필요 시간: ${minutesNeeded.toFixed(0)}분/일`);

  if (minutesNeeded < 30) {
    console.log(`  ✅ PASS — cold path worker가 충분히 소화 가능`);
  } else if (minutesNeeded < 120) {
    console.log(`  ⚠️  MARGINAL — worker 병렬화 검토 필요`);
  } else {
    console.log(`  ❌ SLOW — 더 빠른 모델 또는 사이즈 축소 검토`);
  }

  console.log('');
  if (localOk / n >= 0.95 && minutesNeeded < 60) {
    console.log('  🎯 권장: .env에 로컬 태거 활성화 가능');
    console.log('     TAGGER_PROVIDER=local');
    console.log(`     TAGGER_MODEL=${LOCAL_MODEL}`);
  } else if (localOk / n < 0.8) {
    console.log('  ⛔ 권장: JSON 파싱 실패율이 높음. 모델/양자화 재확인 후 재시도');
  }
  console.log('='.repeat(60));

  await db.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
