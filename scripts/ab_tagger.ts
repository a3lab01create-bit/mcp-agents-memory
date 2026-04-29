/**
 * Tagger A/B harness — RESPEC PROBLEMS.md §3 (M2).
 *
 * 같은 sample set에 대해 Gemini 2.5 Flash vs Grok-4-1-fast-reasoning 비교.
 * 목표: form 결정 (M1 Flash 유지 vs M3 Grok 즉시 전환) 데이터 기반 근거 제공.
 *
 * 측정:
 *   - JSON parse 성공률
 *   - p_tag 후보 매칭률 (existing project_tags에 매칭되거나 NEW: 또는 null)
 *   - latency (avg / p95)
 *   - tokens in/out (model별 가격으로 비용 추정)
 *
 * 실행: npm run bench:tagger [--samples=100] [--model=both|flash|grok]
 *
 * 차단:
 *   - Gemini Flash: 일일 quota 10K/day 풀려있어야 함 (4-29 catch)
 *   - Grok: XAI_API_KEY env 필요. 없으면 grok side skip + 보고에 명시
 */

import { db } from "../src/db.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";

const FLASH_MODEL = "gemini-2.5-flash";
const GROK_MODEL = "grok-4-1-fast-reasoning";
const XAI_BASE_URL = "https://api.x.ai/v1";

// 가격 (RESPEC.md form 기재 + Grok 단가)
const PRICES = {
  flash: { input: 0.30, output: 2.50 }, // $/M tokens
  grok:  { input: 0.20, output: 0.50 },
};

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
  role: "user" | "assistant";
  message: string;
  /** 정답 (이전 Cold Path가 박은 결과) — Flash 결과와 ground truth가 같은 분포라 absolute 정답 X. */
  current_p_tag_id: number | null;
  current_d_tag: string[];
}

interface Candidate {
  id: number;
  name: string;
}

interface CallResult {
  ok: boolean;
  parse_ok: boolean;
  p_tag: string | null;
  p_tag_matched: "existing" | "new" | "null" | "rejected" | "parse-fail";
  d_tag: string[];
  d_tag_count: number;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  raw_excerpt: string;
  error?: string;
}

// ─── DB ────────────────────────────────────────────────────────

async function fetchSamples(n: number): Promise<Sample[]> {
  const half = Math.floor(n / 2);
  const r = await db.query(
    `(SELECT id, role, message, p_tag_id AS current_p_tag_id, d_tag AS current_d_tag
        FROM memory WHERE is_active=TRUE AND role='user'
        ORDER BY random() LIMIT $1)
     UNION ALL
     (SELECT id, role, message, p_tag_id AS current_p_tag_id, d_tag AS current_d_tag
        FROM memory WHERE is_active=TRUE AND role='assistant'
        ORDER BY random() LIMIT $2)`,
    [half, n - half]
  );
  return r.rows.map((row: any) => ({
    id: Number(row.id),
    role: row.role,
    message: row.message,
    current_p_tag_id: row.current_p_tag_id != null ? Number(row.current_p_tag_id) : null,
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
  const list = candidates.length > 0 ? candidates.map((c) => c.name).join(", ") : "(none)";
  return `candidates: ${list}\nrole=${sample.role}\nmessage: ${sample.message}`;
}

// ─── Model callers ─────────────────────────────────────────────

let _gemini: GoogleGenerativeAI | null = null;
function geminiClient() {
  if (!_gemini) {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
    _gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return _gemini;
}

let _xai: OpenAI | null = null;
function xaiClient() {
  if (!_xai) {
    if (!process.env.XAI_API_KEY) throw new Error("XAI_API_KEY missing");
    _xai = new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: XAI_BASE_URL });
  }
  return _xai;
}

async function callFlash(sample: Sample, candidates: Candidate[]): Promise<CallResult> {
  const userPrompt = buildUserPrompt(sample, candidates);
  const start = Date.now();
  try {
    const client = geminiClient();
    const model = client.getGenerativeModel({ model: FLASH_MODEL });
    const res = await model.generateContent([{ text: SYSTEM_PROMPT }, { text: userPrompt }]);
    const latency_ms = Date.now() - start;
    const response = await res.response;
    const raw = response.text().replace(/```json|```/g, "").trim();
    const usage = (response as any).usageMetadata;
    return analyzeResult({
      raw,
      latency_ms,
      input_tokens: usage?.promptTokenCount ?? null,
      output_tokens: usage?.candidatesTokenCount ?? null,
      candidates,
    });
  } catch (err) {
    return {
      ok: false, parse_ok: false, p_tag: null, p_tag_matched: "parse-fail",
      d_tag: [], d_tag_count: 0,
      latency_ms: Date.now() - start,
      input_tokens: null, output_tokens: null,
      raw_excerpt: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** advisor catch: xAI usage shape 첫 응답 한 번만 dump — completion_tokens가 reasoning 포함인지 별도 필드인지 확인용. */
let _grokUsageLogged = false;

async function callGrok(sample: Sample, candidates: Candidate[]): Promise<CallResult> {
  const userPrompt = buildUserPrompt(sample, candidates);
  const start = Date.now();
  try {
    const client = xaiClient();
    const res = await client.chat.completions.create({
      model: GROK_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 512,
    });
    const latency_ms = Date.now() - start;
    const raw = (res.choices[0]?.message?.content ?? "").replace(/```json|```/g, "").trim();
    const usage = res.usage as any;
    if (!_grokUsageLogged) {
      _grokUsageLogged = true;
      console.log(`\n🔍 [grok-usage-debug] 첫 응답 usage:`);
      console.log(JSON.stringify(usage, null, 2));
      console.log(`(probe 결과: xAI는 completion_tokens=visible만, reasoning은 completion_tokens_details.reasoning_tokens 별도. 합산 적용됨.)\n`);
    }
    // probe 검증: xAI는 reasoning을 completion_tokens에 포함 안 시킴 → 직접 합산.
    const visibleOut = usage?.completion_tokens ?? 0;
    const reasoningOut = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const outputTokens = visibleOut + reasoningOut;
    return analyzeResult({
      raw,
      latency_ms,
      input_tokens: usage?.prompt_tokens ?? null,
      output_tokens: outputTokens || null,
      candidates,
    });
  } catch (err) {
    return {
      ok: false, parse_ok: false, p_tag: null, p_tag_matched: "parse-fail",
      d_tag: [], d_tag_count: 0,
      latency_ms: Date.now() - start,
      input_tokens: null, output_tokens: null,
      raw_excerpt: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function analyzeResult(args: {
  raw: string; latency_ms: number; input_tokens: number | null; output_tokens: number | null;
  candidates: Candidate[];
}): CallResult {
  const { raw, latency_ms, input_tokens, output_tokens, candidates } = args;
  let parse_ok = false;
  let p_tag: string | null = null;
  let d_tag: string[] = [];
  try {
    const obj = JSON.parse(raw);
    parse_ok = true;
    p_tag = typeof obj.p_tag === "string" ? obj.p_tag : null;
    d_tag = Array.isArray(obj.d_tag) ? obj.d_tag.filter((t: any): t is string => typeof t === "string") : [];
  } catch { /* parse_ok remains false */ }

  const candidateNames = new Set(candidates.map((c) => c.name.toLowerCase()));
  let p_tag_matched: CallResult["p_tag_matched"];
  if (!parse_ok) p_tag_matched = "parse-fail";
  else if (p_tag === null) p_tag_matched = "null";
  else if (typeof p_tag === "string" && p_tag.startsWith("NEW:")) p_tag_matched = "new";
  else if (typeof p_tag === "string" && candidateNames.has(p_tag.toLowerCase().trim())) p_tag_matched = "existing";
  else p_tag_matched = "rejected"; // 후보 list 외 (오타/hallucination)

  return {
    ok: true,
    parse_ok,
    p_tag,
    p_tag_matched,
    d_tag,
    d_tag_count: d_tag.length,
    latency_ms,
    input_tokens, output_tokens,
    raw_excerpt: raw.slice(0, 120),
  };
}

// ─── Aggregation & report ──────────────────────────────────────

function pct(numerator: number, denom: number): string {
  if (denom === 0) return "-";
  return ((numerator / denom) * 100).toFixed(1) + "%";
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

interface Summary {
  model: string;
  total: number;
  parse_ok: number;
  matched_existing: number;
  matched_new: number;
  matched_null: number;
  rejected: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  total_input_tokens: number;
  total_output_tokens: number;
  est_cost_usd: number;
  errors: string[];
}

function summarize(model: string, results: CallResult[], price: { input: number; output: number }): Summary {
  const total = results.length;
  const ok = results.filter((r) => r.ok);
  const totalIn = ok.reduce((s, r) => s + (r.input_tokens ?? 0), 0);
  const totalOut = ok.reduce((s, r) => s + (r.output_tokens ?? 0), 0);
  const cost = (totalIn / 1_000_000) * price.input + (totalOut / 1_000_000) * price.output;
  return {
    model,
    total,
    parse_ok: results.filter((r) => r.parse_ok).length,
    matched_existing: results.filter((r) => r.p_tag_matched === "existing").length,
    matched_new: results.filter((r) => r.p_tag_matched === "new").length,
    matched_null: results.filter((r) => r.p_tag_matched === "null").length,
    rejected: results.filter((r) => r.p_tag_matched === "rejected").length,
    avg_latency_ms: avg(ok.map((r) => r.latency_ms)),
    p95_latency_ms: p95(ok.map((r) => r.latency_ms)),
    total_input_tokens: totalIn,
    total_output_tokens: totalOut,
    est_cost_usd: cost,
    errors: results.filter((r) => r.error).map((r) => r.error!).slice(0, 5),
  };
}

function printReport(summaries: Summary[], n_samples: number): void {
  console.log(`\n=== Tagger A/B (${n_samples} samples) ===\n`);
  console.log(
    "| model".padEnd(35) + "| parse OK".padEnd(11) + "| existing".padEnd(11) +
    "| new".padEnd(8) + "| null".padEnd(8) + "| rejected".padEnd(11) +
    "| avg lat".padEnd(11) + "| p95 lat".padEnd(11) + "| in/out tok".padEnd(15) + "| est cost"
  );
  for (const s of summaries) {
    console.log(
      `| ${s.model}`.padEnd(35) +
      `| ${pct(s.parse_ok, s.total)}`.padEnd(11) +
      `| ${pct(s.matched_existing, s.total)}`.padEnd(11) +
      `| ${pct(s.matched_new, s.total)}`.padEnd(8) +
      `| ${pct(s.matched_null, s.total)}`.padEnd(8) +
      `| ${pct(s.rejected, s.total)}`.padEnd(11) +
      `| ${s.avg_latency_ms.toFixed(0)}ms`.padEnd(11) +
      `| ${s.p95_latency_ms.toFixed(0)}ms`.padEnd(11) +
      `| ${s.total_input_tokens}/${s.total_output_tokens}`.padEnd(15) +
      `| $${s.est_cost_usd.toFixed(4)}`
    );
  }
  console.log("");
  for (const s of summaries) {
    if (s.errors.length > 0) {
      console.log(`⚠️ ${s.model} sample errors (first 5):`);
      for (const e of s.errors) console.log(`   - ${e.slice(0, 200)}`);
    }
  }
}

// ─── main ──────────────────────────────────────────────────────

async function main() {
  const args = new Map<string, string>();
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) args.set(m[1], m[2]);
  }
  const n = Number(args.get("samples") ?? "100");
  const which = (args.get("model") ?? "both") as "both" | "flash" | "grok";

  console.log(`📊 Tagger A/B start: samples=${n} model=${which}`);

  const samples = await fetchSamples(n);
  const candidates = await fetchCandidates();
  console.log(`   loaded ${samples.length} samples, ${candidates.length} candidates`);

  const flashResults: CallResult[] = [];
  const grokResults: CallResult[] = [];

  let processed = 0;
  for (const s of samples) {
    const promises: Promise<void>[] = [];
    if (which === "both" || which === "flash") {
      promises.push(callFlash(s, candidates).then((r) => { flashResults.push(r); }));
    }
    if (which === "both" || which === "grok") {
      promises.push(callGrok(s, candidates).then((r) => { grokResults.push(r); }));
    }
    await Promise.all(promises);
    processed++;
    if (processed % 10 === 0) {
      console.log(`   ${processed}/${samples.length} done...`);
    }
  }

  const summaries: Summary[] = [];
  if (flashResults.length > 0) summaries.push(summarize(FLASH_MODEL, flashResults, PRICES.flash));
  if (grokResults.length > 0) summaries.push(summarize(GROK_MODEL, grokResults, PRICES.grok));

  printReport(summaries, samples.length);

  await db.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ bench failed:", err);
  process.exit(1);
});
