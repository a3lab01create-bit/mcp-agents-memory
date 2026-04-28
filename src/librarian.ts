/**
 * Librarian Engine — Autonomous Fact Extraction & Contradiction Resolution
 * 
 * Uses a Multi-Model Pipeline:
 * 1. Triage (Gemini Flash) - Noise removal
 * 2. Extraction (GPT-4o-mini) - Atomic fact generation
 * 3. Audit (Grok/Opus) - Quality assurance & refinement
 */

import { generateEmbedding, vectorToSql } from "./embeddings.js";
import { db } from "./db.js";
import { validateFact } from "./validator.js";
import { callRole, ROLE_REGISTRY, inferProvider } from "./model_registry.js";
import { getOrCreateSubject } from "./subjects.js";
import { auditMemory } from "./memory_auditor.js";
import type { AuditedMemory, MemoryValidationTier } from "./memory_auditor.js";

// ─────────────────────────────────────────────────────────────
// Clients
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type FactType = 'preference' | 'profile' | 'state' | 'skill' | 'decision' | 'learning' | 'relationship';

export type RelationshipType = 'owns' | 'delegates_to' | 'advises' | 'reports_to' | 'collaborates';
export const RELATIONSHIP_TYPES: ReadonlySet<RelationshipType> = new Set([
  'owns', 'delegates_to', 'advises', 'reports_to', 'collaborates',
]);

export interface SubjectEdge {
  from: string;
  to: string;
  type: RelationshipType;
}

export interface ExtractedFact {
  content: string;
  fact_type: FactType;
  confidence: number;
  importance: number;
  tags: string[];
  subject_hint?: string;
  edge?: SubjectEdge;
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
  /**
   * Curator identity — the agent that called memory_add. Distinct from
   * Producer (author_model).
   * agent_platform: server-populated from process.env.AGENT_PLATFORM (harness identity).
   * agent_model: per-call value from args.curator_model (or fallback to args.author_model).
   * Captures the actual model running at save time, which env can't track because
   * /model swaps mid-session.
   */
  agent_platform?: string;
  agent_model?: string;
  /**
   * agent_curator_id: FK to subjects(id) for the agent persona that called
   * memory_add (or memory_save_skill / memory_curator_run via the skill path).
   * Resolved per-call (args.agent_key) with env AGENT_KEY as fallback.
   * NULL for connector-sourced and auto-promotion writes.
   */
  agent_curator_id?: number | null;
  session_id?: string;
  /**
   * Override for `memories.source` column. Defaults to 'librarian' when omitted.
   * Used by Connectors (e.g. 'connector') to mark connector-derived memories.
   * Must be one of the values allowed by the `memories_source_check` CHECK constraint.
   */
  source?: string;
}

export interface ProcessResult {
  extracted: number;
  saved: number;
  contradictions_resolved: number;
  edges_saved: number;
  audited: number;
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
When fact_type is "profile" or "preference", ALSO set the profile axis:
- Add tag "profile_static" if the fact is stable across weeks/months: identity (name, role), tooling preferences, coding style, language, long-running interests, baseline workflow patterns.
- Add tag "profile_dynamic" if the fact reflects current context that may change within days/weeks: active project, this-week goal, recent decision pattern, current blocker, in-progress task focus.
- When in doubt, default to "profile_static" — over-stable is less misleading than over-current.

For fact_types other than profile/preference, do NOT add either tag.

When fact_type is "relationship", ALSO include an "edge" object describing the directed link between two subjects:
  edge: { "from": "<subject_key>", "to": "<subject_key>", "type": "owns" | "delegates_to" | "advises" | "reports_to" | "collaborates" }
Subject keys MUST be lowercase slug strings prefixed by entity type — user_<name>, agent_<name>, project_<name>, team_<name>, system_<name>, category_<name>.
Example: { "from": "user_hoon", "to": "project_centragens", "type": "owns" }
If you cannot confidently identify BOTH endpoints AND a relationship type from the allowed list, OMIT the edge field (still emit the fact). Never invent endpoints.

Output JSON: { "facts": [{ "content": "...", "fact_type": "...", "confidence": 1-10, "importance": 1-10, "tags": ["..."], "subject_hint": "...", "edge": { "from": "...", "to": "...", "type": "..." } }] }`;

const AUDIT_SYSTEM_PROMPT = `You are a Senior Librarian Auditor. Review and refine extracted facts.
Refine wording for clarity and ensure high-stakes facts (decisions, preferences) are precise.
CRITICAL: Each input fact has an "_idx" field — preserve it EXACTLY in your output. Do not modify, drop, or renumber it.
If the input fact has an "edge" field, preserve it verbatim — do not modify endpoints or relationship_type.
Return JSON: { "facts": [{"_idx": 0, "content": "...", "fact_type": "...", "confidence": 1-10, "importance": 1-10, "tags": [...], "edge": {...}?}, ...] }`;

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

function normalizeProfileAxisTags(fact: ExtractedFact): ExtractedFact {
  const tags = Array.isArray(fact.tags) ? [...new Set(fact.tags)] : [];
  const staticIdx = tags.indexOf("profile_static");
  const dynamicIdx = tags.indexOf("profile_dynamic");

  if (fact.fact_type !== 'profile' && fact.fact_type !== 'preference') {
    return {
      ...fact,
      tags: tags.filter((tag) => tag !== "profile_static" && tag !== "profile_dynamic"),
    };
  }

  if (dynamicIdx >= 0) {
    return {
      ...fact,
      tags: tags.filter((tag) => tag !== "profile_static"),
    };
  }

  if (staticIdx === -1) {
    tags.push("profile_static");
  }

  return {
    ...fact,
    tags,
  };
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
      return normalizeProfileAxisTags({
        ...f,
        audit_score,
        audit_required: audit_score > 0.7 || f.fact_type === 'decision',
      });
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
          merged[targetIdx] = normalizeProfileAxisTags(merged[targetIdx]);
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
// Model & Platform Resolution (provenance FK lookup)
// ─────────────────────────────────────────────────────────────

interface ResolvedModel {
  id: number;
  model_name: string;
}

interface ResolvedPlatform { id: number; name: string; }

const MODEL_CACHE = new Map<string, ResolvedModel | null>();
const PLATFORM_CACHE = new Map<string, ResolvedPlatform | null>();

export async function resolvePlatform(name: string | undefined | null): Promise<ResolvedPlatform | null> {
  if (!name) return null;
  const key = name.toLowerCase();
  if (PLATFORM_CACHE.has(key)) return PLATFORM_CACHE.get(key) as ResolvedPlatform | null;

  const sel = await db.query("SELECT id, name FROM platforms WHERE LOWER(name) = $1 LIMIT 1", [key]);
  if (sel.rows.length > 0) {
    const r: ResolvedPlatform = { id: sel.rows[0].id, name: sel.rows[0].name };
    PLATFORM_CACHE.set(key, r);
    return r;
  }

  const ins = await db.query(
    "INSERT INTO platforms (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id, name",
    [name]
  );
  const r: ResolvedPlatform = { id: ins.rows[0].id, name: ins.rows[0].name };
  PLATFORM_CACHE.set(key, r);
  console.error(`✨ [Librarian] Auto-registered platform "${name}"`);
  return r;
}

/**
 * Resolve a model name (or alias) to its DB id.
 * Resolution order:
 *   1. Exact match on models.model_name (case-insensitive)
 *   2. Alias match via metadata->>'alias' (case-insensitive)
 *   3. Auto-register if provider can be inferred from name prefix (claude-*, gpt-*, gemini-*, grok-*, o1-*, o3-*)
 *   4. null (provider unknown — author_model_id stays NULL)
 */
export async function resolveModel(name: string | undefined | null): Promise<ResolvedModel | null> {
  if (!name) return null;
  const key = name.toLowerCase();
  if (MODEL_CACHE.has(key)) return MODEL_CACHE.get(key) as ResolvedModel | null;

  try {
    const res = await db.query(
      `SELECT id, model_name
       FROM models
       WHERE LOWER(model_name) = $1
          OR LOWER(metadata->>'alias') = $1
       LIMIT 1`,
      [key]
    );

    if (res.rows.length > 0) {
      const resolved: ResolvedModel = {
        id: res.rows[0].id,
        model_name: res.rows[0].model_name,
      };
      MODEL_CACHE.set(key, resolved);
      return resolved;
    }

    // Auto-register: infer provider from prefix, INSERT, return new id.
    const provider = inferProvider(name);
    if (!provider) {
      console.error(`⚠️ [Librarian] Unknown model "${name}" — provider not inferable, author_model_id=NULL`);
      MODEL_CACHE.set(key, null);
      return null;
    }

    const ins = await db.query(
      `INSERT INTO models (provider, model_name, metadata)
       VALUES ($1, $2, '{}'::jsonb)
       ON CONFLICT (model_name) DO UPDATE SET model_name = EXCLUDED.model_name
       RETURNING id, model_name`,
      [provider, name]
    );
    const resolved: ResolvedModel = {
      id: ins.rows[0].id,
      model_name: ins.rows[0].model_name,
    };
    MODEL_CACHE.set(key, resolved);
    console.error(`✨ [Librarian] Auto-registered model "${name}" (provider=${provider})`);
    return resolved;
  } catch (err) {
    console.error(`❌ [Librarian] resolveModel failed for "${name}":`, err);
    return null;
  }
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

// ─────────────────────────────────────────────────────────────
// Memory Auditor gate (v5.0 External Knowledge Grounding)
// ─────────────────────────────────────────────────────────────

const AUDITABLE_FACT_TYPES: ReadonlySet<FactType> = new Set(['learning']);

function memoryAuditEnabled(): boolean {
  const flag = (process.env.MEMORY_AUDIT_ENABLED || '').toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

function shouldAuditFact(fact: ExtractedFact): boolean {
  if (!memoryAuditEnabled()) return false;
  if (!AUDITABLE_FACT_TYPES.has(fact.fact_type)) return false;
  return fact.importance > 7;
}

/**
 * Map MemoryValidationTier → memories.validation_status (free-form VARCHAR(20)).
 * 'unvalidated' returns null so callers know to skip persistence (no row in fact_validations).
 */
function tierToStatus(tier: MemoryValidationTier): string | null {
  switch (tier) {
    case 'validated_external':
    case 'validated_internal':
      return 'valid';
    case 'contested':
      return 'contested';
    case 'unvalidated':
      return null;
  }
}

async function persistAuditResult(
  factId: number,
  audited: AuditedMemory,
  originalContent: string
): Promise<void> {
  const status = tierToStatus(audited.validation_tier);
  if (status === null) return; // skip persistence for unvalidated
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO fact_validations (fact_id, status, confidence_score, research_report, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        factId,
        audited.validation_tier,
        audited.validation_tier === 'validated_external' ? 0.9 : audited.validation_tier === 'validated_internal' ? 0.7 : 0.4,
        audited.audit_reasoning,
        JSON.stringify({ sources: audited.sources, original_content: originalContent, audit_path: 'sync' }),
      ]
    );
    await client.query(
      `UPDATE memories SET validation_status = $1, last_validated_at = NOW() WHERE id = $2`,
      [status, factId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`❌ [MemoryAuditor] Failed to persist audit for fact #${factId}:`, err);
  } finally {
    client.release();
  }
}

/**
 * Upsert a directed edge into subject_relationships.
 * Returns true if a NEW edge was inserted, false if skipped or already existed.
 * Skips: invalid relationship_type, missing endpoints, self-loops.
 */
async function upsertSubjectEdge(edge: SubjectEdge): Promise<boolean> {
  if (!edge.from || !edge.to) return false;
  if (!RELATIONSHIP_TYPES.has(edge.type)) {
    console.error(`⚠️ [Librarian] Invalid relationship_type "${edge.type}" — skipping edge`);
    return false;
  }
  try {
    const fromId = await getOrCreateSubject(edge.from);
    const toId = await getOrCreateSubject(edge.to);
    if (fromId === toId) return false; // self-loop blocked by CHECK anyway
    const res = await db.query(
      `INSERT INTO subject_relationships (from_subject_id, to_subject_id, relationship_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (from_subject_id, to_subject_id, relationship_type) DO NOTHING
       RETURNING id`,
      [fromId, toId, edge.type]
    );
    return res.rowCount! > 0;
  } catch (err) {
    console.error(`❌ [Librarian] upsertSubjectEdge failed:`, err);
    return false;
  }
}

export async function processBatch(
  text: string,
  subjectId: number,
  projectId: number | null,
  rawSource: string,
  provenance: ProvenanceInfo = {}
): Promise<ProcessResult> {
  const result: ProcessResult = { extracted: 0, saved: 0, contradictions_resolved: 0, edges_saved: 0, audited: 0, sources: [], facts: [], errors: [] };

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
      // v5.0 SYNC Memory Auditor — gate on env flag + fact_type + importance.
      // Runs BEFORE embedding so the persisted vector matches the reconciled wording.
      const originalContent = fact.content;
      let auditResult: AuditedMemory | null = null;
      if (shouldAuditFact(fact)) {
        try {
          auditResult = await auditMemory(fact.content, fact.fact_type);
          if (auditResult.reconciled_content && auditResult.reconciled_content !== fact.content) {
            fact.content = auditResult.reconciled_content;
          }
          result.audited++;
        } catch (err: any) {
          console.error(`❌ [Librarian] auditMemory failed:`, err);
          result.errors.push(`auditMemory: ${err?.message || err}`);
        }
      }

      const emb = await generateEmbedding(fact.content);
      const { supersedes_id } = await resolveContradiction(fact, subjectId, emb || undefined);

      if (supersedes_id) {
        await db.query(`UPDATE memories SET is_active = FALSE WHERE id = $1`, [supersedes_id]);
        result.contradictions_resolved++;
      }

      // Resolve model + platform → provenance FK ids
      const resolvedModel = await resolveModel(provenance.author_model);
      const resolvedPlatform = await resolvePlatform(provenance.platform);

      // Pick validation_status: sync audit wins; otherwise legacy async-pending rule.
      const auditedStatus = auditResult ? tierToStatus(auditResult.validation_tier) : null;
      const validationStatus = auditedStatus ?? (fact.importance > 7 ? 'pending' : 'valid');

      const insertRes = await db.query(
        `INSERT INTO memories (
           subject_id, project_subject_id, content, fact_type,
           confidence, importance, tags, embedding, validation_status,
           author_model, platform, session_id,
           agent_platform, agent_model, agent_curator_id,
           author_model_id, platform_id, source
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         RETURNING id`,
        [
          subjectId, projectId, fact.content, fact.fact_type,
          fact.confidence, fact.importance, fact.tags,
          emb ? vectorToSql(emb) : null,
          validationStatus,
          provenance.author_model, provenance.platform, provenance.session_id,
          provenance.agent_platform, provenance.agent_model,
          provenance.agent_curator_id ?? null,
          resolvedModel?.id ?? null,
          resolvedPlatform?.id ?? null,
          provenance.source ?? 'librarian'
        ]
      );

      const newId = insertRes.rows[0].id;
      result.saved++;
      result.facts.push({ id: newId, content: fact.content, fact_type: fact.fact_type, superseded: supersedes_id });

      // v5.0 Memory Graph — persist directed edge alongside the relationship fact.
      if (fact.fact_type === 'relationship' && fact.edge) {
        const inserted = await upsertSubjectEdge(fact.edge);
        if (inserted) result.edges_saved++;
      }

      // Persist sync audit result OR fall back to async validation queue.
      // Apply the same fact_type gate to async — subjective facts (preference / profile /
      // state / relationship) should never be web-grounded regardless of importance.
      if (auditResult) {
        if (auditedStatus !== null) {
          await persistAuditResult(newId, auditResult, originalContent);
        }
      } else if (fact.importance > 7 && AUDITABLE_FACT_TYPES.has(fact.fact_type)) {
        scheduleValidation(fact.content, newId);
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

export function scheduleValidation(factContent: string, factId: number): void {
  validationQueue.enqueue(() =>
    validateFact(factContent, factId)
      .then(() => {})
      .catch(err => console.error(`❌ [ValidationQueue] validateFact failed for memory #${factId}:`, err))
  );
}

const VALIDATION_LIMIT = parseInt(
  process.env.VALIDATE_CONCURRENCY || process.env.VALIDATION_CONCURRENCY || '2'
);
export const validationQueue = new BoundedQueue(VALIDATION_LIMIT);
