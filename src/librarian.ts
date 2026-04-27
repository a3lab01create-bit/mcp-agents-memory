/**
 * Librarian Engine — Autonomous Fact Extraction & Contradiction Resolution
 * 
 * Uses a Multi-Model Pipeline (v0.6):
 * 1. Triage (Gemini Flash) - Noise removal
 * 2. Extraction (GPT-4o-mini) - Atomic fact generation
 * 3. Audit (Grok/Opus) - Quality assurance & refinement
 */

import { generateEmbedding, vectorToSql } from "./embeddings.js";
import { db } from "./db.js";
import { validateFact } from "./validator.js";
import { callRole, ROLE_REGISTRY } from "./model_registry.js";

// ─────────────────────────────────────────────────────────────
// Clients
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type FactType = 'preference' | 'profile' | 'state' | 'skill' | 'decision' | 'learning' | 'relationship';

export interface ExtractedFact {
  content: string;
  fact_type: FactType;
  confidence: number;
  importance: number;
  tags: string[];
  subject_hint?: string;
  audit_required: boolean;
  audit_score?: number;
  audit_reason?: string[];
  _idx?: number;   // ← 추가
}

export interface ContradictionResult {
  supersedes_id: number | null;
  reason: string;
}

export interface ProvenanceInfo {
  author_model?: string;
  platform?: string;
  session_id?: string;
}

export interface ProcessResult {
  extracted: number;
  saved: number;
  contradictions_resolved: number;
  sources: Array<{ 
    title: string; 
    url: string; 
    snippet: string; 
    engine: 'tavily' | 'exa';
  }>;
  facts: Array<{ id: number; content: string; fact_type: FactType; superseded: number | null }>;
  errors: string[];
}

// ─────────────────────────────────────────────────────────────
// Config & Prompts
// ─────────────────────────────────────────────────────────────


const TRIAGE_SYSTEM_PROMPT = `You are a Triage AI for a memory system.
Identify segments of text that contain persistent information worth remembering (preferences, project decisions, technical stack, identities).
Return a JSON object: { "worthy_segments": ["..."] }`;

const EXTRACTION_SYSTEM_PROMPT = `You are a Librarian AI. Extract atomic facts from the provided text.
FACT TYPES: preference, profile, state, skill, decision, learning, relationship.
Output JSON: { "facts": [{ "content": "...", "fact_type": "...", "confidence": 1-10, "importance": 1-10, "tags": ["..."], "subject_hint": "..." }] }`;

const AUDIT_SYSTEM_PROMPT = `You are a Senior Librarian Auditor. Review and refine extracted facts.
Refine wording for clarity and ensure high-stakes facts (decisions, preferences) are precise.
CRITICAL: Each input fact has an "_idx" field — preserve it EXACTLY in your output. Do not modify, drop, or renumber it.
Return JSON: { "facts": [{"_idx": 0, "content": "...", "fact_type": "...", "confidence": 1-10, "importance": 1-10, "tags": [...]}, ...] }`;

const CONTRADICTION_SYSTEM_PROMPT = `You are a Contradiction Resolver.
Given a NEW FACT and EXISTING FACTS for the same subject, decide if the new fact SUPERSEDES any existing fact.
Return JSON: { "supersedes_id": number | null, "reason": "..." }`;

// ─────────────────────────────────────────────────────────────
// Pipeline Stages
// ─────────────────────────────────────────────────────────────

export function computeAuditScore(fact: any): number {
  const importanceScore = (fact.importance || 0) / 10;
  const confidencePenalty = (10 - (fact.confidence || 0)) / 10;
  return (importanceScore * 0.7) + (confidencePenalty * 0.3);
}

export async function triageTranscript(text: string): Promise<string[]> {
  try {
    const raw = await callRole('triage', {
      system: TRIAGE_SYSTEM_PROMPT,
      user: `Text:\n\n${text}`,
      responseFormat: 'json',
    });
    return JSON.parse(raw).worthy_segments || [];
  } catch (err) {
    console.error("❌ [Librarian] Triage FAILED:", err);
    return [text];
  }
}

export async function extractFacts(text: string): Promise<ExtractedFact[]> {
  try {
    const raw = await callRole('extract', {
      system: EXTRACTION_SYSTEM_PROMPT,
      user: `Extract from:\n\n${text}`,
      responseFormat: 'json',
    });
    const parsed = JSON.parse(raw || '{"facts":[]}');
    return (parsed.facts || []).map((f: any) => {
      const audit_score = computeAuditScore(f);
      return {
        ...f,
        audit_score,
        audit_required: audit_score > 0.7 || f.fact_type === 'decision',
      };
    });
  } catch (err) {
    console.error("❌ [Librarian] Extraction FAILED:", err);
    return [];
  }
}

export async function auditFacts(facts: ExtractedFact[]): Promise<ExtractedFact[]> {
  const toAudit = facts.filter(f => f.audit_required);
  if (toAudit.length === 0) return facts;

  try {
    const raw = await callRole('audit', {
      system: AUDIT_SYSTEM_PROMPT,
      user: `Verify these facts. Preserve "_idx" exactly:\n\n${JSON.stringify(toAudit)}`,
      responseFormat: 'json',
    });
    const verified = JSON.parse(raw || '{"facts":[]}').facts || [];

    // Merge by _idx — refined values overwrite, but original fields preserved.
    // Unmatched _idx is ignored (no LLM hallucination), missing _idx keeps original (no data loss).
    const merged = [...facts];
    for (const refined of verified) {
      if (typeof refined._idx === 'number') {
        const targetIdx = merged.findIndex(f => f._idx === refined._idx);
        if (targetIdx >= 0) {
          merged[targetIdx] = {
            ...merged[targetIdx],
            ...refined,
            _idx: merged[targetIdx]._idx,
          };
        }
      }
    }
    return merged;
  } catch (err) {
    console.error("❌ [Librarian] Audit FAILED:", err);
    return facts;
  }
}

// ─────────────────────────────────────────────────────────────
// Logic & Utils
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Model Resolution & Trust Weight
// ─────────────────────────────────────────────────────────────

interface ResolvedModel {
  id: number;
  trust_weight: number;
  model_name: string;
}

interface ResolvedPlatform { id: number; trust_weight: number; name: string; }

const MODEL_CACHE = new Map<string, ResolvedModel | null>();
const PLATFORM_CACHE = new Map<string, ResolvedPlatform | null>();
const DEFAULT_TRUST_WEIGHT = 0.80;

export async function resolvePlatform(name: string | undefined | null): Promise<ResolvedPlatform | null> {
  if (!name) return null;
  const key = name.toLowerCase();
  if (PLATFORM_CACHE.has(key)) return PLATFORM_CACHE.get(key) as ResolvedPlatform | null;

  // Try exact match first
  const sel = await db.query("SELECT id, name, trust_weight FROM platforms WHERE LOWER(name) = $1 LIMIT 1", [key]);
  if (sel.rows.length > 0) {
    const r: ResolvedPlatform = { id: sel.rows[0].id, name: sel.rows[0].name, trust_weight: parseFloat(sel.rows[0].trust_weight) };
    PLATFORM_CACHE.set(key, r);
    return r;
  }

  // Auto-register with default trust_weight=1.00
  const ins = await db.query(
    "INSERT INTO platforms (name, trust_weight) VALUES ($1, 1.00) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id, name, trust_weight",
    [name]
  );
  const r: ResolvedPlatform = { id: ins.rows[0].id, name: ins.rows[0].name, trust_weight: parseFloat(ins.rows[0].trust_weight) };
  PLATFORM_CACHE.set(key, r);
  console.error(`✨ [Librarian] Auto-registered platform "${name}"`);
  return r;
}

/**
 * Resolve a model name (or alias) to its DB id and trust_weight.
 * Resolution order:
 *   1. Exact match on models.model_name (case-insensitive)
 *   2. Alias match via metadata->>'alias' (case-insensitive)
 *   3. null (not found — caller uses DEFAULT_TRUST_WEIGHT)
 */
export async function resolveModel(name: string | undefined | null): Promise<ResolvedModel | null> {
  if (!name) return null;
  const key = name.toLowerCase();
  if (MODEL_CACHE.has(key)) return MODEL_CACHE.get(key) as ResolvedModel | null;

  try {
    const res = await db.query(
      `SELECT id, model_name, trust_weight
       FROM models
       WHERE LOWER(model_name) = $1
          OR LOWER(metadata->>'alias') = $1
       LIMIT 1`,
      [key]
    );

    if (res.rows.length === 0) {
      console.error(`⚠️ [Librarian] Unknown model "${name}" — defaulting trust_weight ${DEFAULT_TRUST_WEIGHT}, author_model_id=NULL`);
      MODEL_CACHE.set(key, null);
      return null;
    }

    const resolved: ResolvedModel = {
      id: res.rows[0].id,
      trust_weight: parseFloat(res.rows[0].trust_weight),
      model_name: res.rows[0].model_name,
    };
    MODEL_CACHE.set(key, resolved);
    return resolved;
  } catch (err) {
    console.error(`❌ [Librarian] resolveModel failed for "${name}":`, err);
    return null;
  }
}

/**
 * effective_confidence = (confidence / 10.0) * trust_weight
 * confidence: 1-10 → trust_weight: 0.00-1.00 → result: 0.00-1.00
 * Stored as NUMERIC(4,2).
 */
export function computeEffectiveConfidence(confidence: number, trustWeight: number): number {
  const raw = (confidence / 10.0) * trustWeight;
  return Math.round(raw * 100) / 100;
}

async function resolveContradiction(
  newFact: ExtractedFact,
  subjectId: number,
  existingEmbedding?: number[]
): Promise<ContradictionResult> {
  try {
    const embedding = existingEmbedding || await generateEmbedding(newFact.content);
    if (!embedding) return { supersedes_id: null, reason: "No embedding" };

    const similar = await db.query(
      `SELECT id, content FROM memories
       WHERE subject_id = $1 AND is_active = TRUE AND fact_type = $2 
       ORDER BY embedding <=> $3::vector LIMIT 5`,
      [subjectId, newFact.fact_type, vectorToSql(embedding)]
    );

    if (similar.rows.length === 0) return { supersedes_id: null, reason: "No similar facts" };

    const raw = await callRole('contradiction', {
      system: CONTRADICTION_SYSTEM_PROMPT,
      user: `NEW: ${newFact.content}\nEXISTING:\n${similar.rows.map(r => `[ID ${r.id}] ${r.content}`).join("\n")}`,
      responseFormat: 'json',
    });
    return JSON.parse(raw || '{"supersedes_id": null}');
  } catch (err) {
    console.error("❌ [Librarian] Contradiction resolution FAILED:", err);
    return { supersedes_id: null, reason: "Error in resolution" };
  }
}

export async function processBatch(
  text: string,
  subjectId: number,
  projectId: number | null,
  rawSource: string,
  provenance: ProvenanceInfo = {}
): Promise<ProcessResult> {
  const result: ProcessResult = { extracted: 0, saved: 0, contradictions_resolved: 0, sources: [], facts: [], errors: [] };

  try {
    const segments = await triageTranscript(text);
    let allExtracted: ExtractedFact[] = [];
    for (const seg of segments) {
      const extracted = await extractFacts(seg);
      allExtracted.push(...extracted);
    }

    // Tag each fact with stable index (replaces fragile content-string matching)
    const indexed: ExtractedFact[] = allExtracted.map((f, idx) => ({ ...f, _idx: idx }));

    // Pick top-5 indices by audit_score
    const auditIdxSet = new Set(
      indexed
        .filter(f => f.audit_required)
        .sort((a, b) => (b.audit_score || 0) - (a.audit_score || 0))
        .slice(0, 5)
        .map(f => f._idx!)
    );

    // Mark audit_required by index
    const tagged: ExtractedFact[] = indexed.map(f => ({
      ...f,
      audit_required: auditIdxSet.has(f._idx!),
    }));

    const audited = await auditFacts(tagged);
    result.extracted = audited.length;

    for (const fact of audited) {
      const emb = await generateEmbedding(fact.content);
      const { supersedes_id } = await resolveContradiction(fact, subjectId, emb || undefined);

      if (supersedes_id) {
        await db.query(`UPDATE memories SET is_active = FALSE WHERE id = $1`, [supersedes_id]);
        result.contradictions_resolved++;
      }

      // Resolve model → FK id + trust_weight
      const resolvedModel = await resolveModel(provenance.author_model);
      const resolvedPlatform = await resolvePlatform(provenance.platform);
      const trustWeight = resolvedModel?.trust_weight ?? DEFAULT_TRUST_WEIGHT;
      const effectiveConfidence = computeEffectiveConfidence(fact.confidence, trustWeight);

      const insertRes = await db.query(
        `INSERT INTO memories (
           subject_id, project_subject_id, content, fact_type,
           confidence, importance, tags, embedding, validation_status,
           author_model, platform, session_id,
           author_model_id, platform_id, effective_confidence
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id`,
        [
          subjectId, projectId, fact.content, fact.fact_type, 
          fact.confidence, fact.importance, fact.tags, 
          emb ? vectorToSql(emb) : null,
          fact.importance > 7 ? 'pending' : 'valid',
          provenance.author_model, provenance.platform, provenance.session_id,
          resolvedModel?.id ?? null,
          resolvedPlatform?.id ?? null,
          effectiveConfidence
        ]
      );

      const newId = insertRes.rows[0].id;
      result.saved++;
      result.facts.push({ id: newId, content: fact.content, fact_type: fact.fact_type, superseded: supersedes_id });

      if (fact.importance > 7) {
        validationQueue.enqueue(() =>
          validateFact(fact.content, newId)
            .then(() => {})
            .catch(err => console.error("❌ Validation error:", err))
        );
      }
    }
  } catch (err: any) {
    result.errors.push(err.message);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// Validation Queue — bounded concurrency to prevent self-DoS
// ─────────────────────────────────────────────────────────────

class BoundedQueue {
  private queue: Array<() => Promise<void>> = [];
  private active = 0;
  constructor(private readonly limit: number) {}

  enqueue(task: () => Promise<void>): void {
    this.queue.push(task);
    this.runNext();
  }

  private runNext(): void {
    if (this.active >= this.limit || this.queue.length === 0) return;
    this.active++;
    const task = this.queue.shift()!;
    task().finally(() => {
      this.active--;
      this.runNext();
    });
  }

  stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }
}

const VALIDATION_LIMIT = parseInt(process.env.VALIDATION_CONCURRENCY || '2');
export const validationQueue = new BoundedQueue(VALIDATION_LIMIT);
