/**
 * Librarian Engine — Autonomous Fact Extraction & Contradiction Resolution
 * 
 * Uses gpt-4o-mini (configurable) to:
 * 1. Extract atomic facts from raw text
 * 2. Classify each fact by type
 * 3. Detect and resolve contradictions with existing facts
 * 
 * This is the "brain" of the memory system — the quality of extraction
 * directly determines the quality of recall.
 */

import { getClient } from "./embeddings.js";
import { generateEmbedding, vectorToSql } from "./embeddings.js";
import { db } from "./db.js";

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
  subject_hint?: string;   // e.g., "user_hoon", "project_yoontube"
}

export interface ContradictionResult {
  supersedes_id: number | null;
  reason: string;
}

export interface ProvenanceInfo {
  author_model?: string;   // e.g., "claude-3-5-sonnet"
  platform?: string;       // e.g., "antigravity"
  session_id?: string;     // UUID or session name
  metadata?: Record<string, any>;
}

export interface ProcessResult {
  extracted: number;
  saved: number;
  contradictions_resolved: number;
  facts: Array<{ id: number; content: string; fact_type: FactType; superseded?: number }>;
  errors: string[];
}

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

function getLibrarianModel(): string {
  return process.env.LIBRARIAN_MODEL || "gpt-4o-mini";
}

// ─────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are a Librarian AI that extracts atomic facts from conversation text.
Your job is to identify important, persistent information worth remembering across sessions.

RULES:
1. Each fact must be a SINGLE, self-contained statement. One fact = one clear piece of information.
2. SKIP trivial statements, greetings, or temporary information (e.g., "let me check", "okay").
3. FOCUS on: preferences, decisions, technical facts, project states, skills, relationships.
4. Each fact needs a type classification:
   - preference: User likes/dislikes, communication style, working patterns
   - profile: Identity info, background, role, location
   - state: Current project status, ongoing work, active tasks
   - skill: Technical abilities, tools used, expertise areas
   - decision: Architecture choices, design decisions, resolved debates
   - learning: Lessons learned, best practices discovered, debugging insights
   - relationship: Team affiliations, project ownership, collaborations
5. Assign confidence (1-10): How certain is this fact? Direct statements = 8-10, inferred = 4-7.
6. Assign importance (1-10): How useful is this for future sessions? Core identity = 9-10, minor detail = 3-5.
7. Generate 2-4 relevant tags per fact for searchability.
8. If you can identify WHO or WHAT PROJECT a fact is about, provide a subject_hint using the convention:
   - Users: "user_<name>" (e.g., "user_hoon")
   - Projects: "project_<name>" (e.g., "project_yoontube")
   - Agents: "agent_<name>" (e.g., "agent_claude")
9. If no facts are worth extracting, return an empty array. Do NOT force extraction.
10. Output in Korean or English — match the language of the content.

OUTPUT FORMAT (strict JSON):
{
  "facts": [
    {
      "content": "명확한 단일 사실 문장",
      "fact_type": "preference|profile|state|skill|decision|learning|relationship",
      "confidence": 8,
      "importance": 7,
      "tags": ["tag1", "tag2"],
      "subject_hint": "user_hoon"
    }
  ]
}`;

const CONTRADICTION_SYSTEM_PROMPT = `You are a Contradiction Resolver. Given a NEW fact and a list of EXISTING facts, determine if the new fact contradicts or updates any existing fact.

RULES:
1. A contradiction means the new fact makes an existing fact outdated or incorrect.
   - Example: NEW "Hoon lives in Busan" contradicts EXISTING "Hoon lives in Seoul"
   - Example: NEW "YoonTube uses hq720 fallback" supersedes EXISTING "YoonTube uses maxresdefault"
2. Preference changes ARE contradictions (e.g., "prefers dark mode" → "prefers light mode")
3. Additive facts are NOT contradictions (e.g., "knows React" + "knows Vue" = both valid)
4. State updates ARE contradictions (e.g., "working on feature A" → "working on feature B")
5. If multiple existing facts are contradicted, return the most relevant one.

OUTPUT FORMAT (strict JSON):
{
  "supersedes_id": <number or null>,
  "reason": "Brief explanation of why this is/isn't a contradiction"
}`;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

async function resolveModelId(modelName?: string): Promise<number | null> {
  if (!modelName) return null;
  const normalized = modelName.trim().toLowerCase();
  
  const res = await db.query(
    "SELECT id FROM models WHERE model_name = $1 OR metadata->>'alias' = $1",
    [normalized]
  );
  
  if (res.rows.length > 0) {
    return res.rows[0].id;
  }

  // Auto-register new model with default trust weight
  try {
    const provider = normalized.split('-')[0] || 'unknown';
    const insertRes = await db.query(
      `INSERT INTO models (provider, model_name, trust_weight, metadata) 
       VALUES ($1, $2, 0.80, $3) 
       ON CONFLICT (model_name) DO UPDATE SET model_name = EXCLUDED.model_name
       RETURNING id`,
      [provider, normalized, JSON.stringify({ auto_registered: true, registered_at: new Date().toISOString() })]
    );
    console.error(`🌱 [Librarian] Auto-registered new model: ${normalized}`);
    return insertRes.rows[0].id;
  } catch (err) {
    console.error(`⚠️ [Librarian] Failed to auto-register model ${normalized}:`, err);
    return null;
  }
}

async function resolvePlatformId(platformName?: string): Promise<number | null> {
  if (!platformName) return null;
  const normalized = platformName.trim().toLowerCase();

  const res = await db.query(
    "SELECT id FROM platforms WHERE name = $1",
    [normalized]
  );

  if (res.rows.length > 0) {
    return res.rows[0].id;
  }

  // Auto-register new platform
  try {
    const insertRes = await db.query(
      `INSERT INTO platforms (name, trust_weight) 
       VALUES ($1, 1.00) 
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [normalized]
    );
    console.error(`🌱 [Librarian] Auto-registered new platform: ${normalized}`);
    return insertRes.rows[0].id;
  } catch (err) {
    console.error(`⚠️ [Librarian] Failed to auto-register platform ${normalized}:`, err);
    return null;
  }
}

async function calculateEffectiveConfidence(
  base: number,
  modelId: number | null,
  platformId: number | null
): Promise<number> {
  let modelWeight = 0.8;
  let platformWeight = 1.0;

  if (modelId) {
    const res = await db.query("SELECT trust_weight FROM models WHERE id = $1", [modelId]);
    if (res.rows.length > 0) modelWeight = parseFloat(res.rows[0].trust_weight);
  }
  if (platformId) {
    const res = await db.query("SELECT trust_weight FROM platforms WHERE id = $1", [platformId]);
    if (res.rows.length > 0) platformWeight = parseFloat(res.rows[0].trust_weight);
  }

  // Formula: (Base / 10) * ModelWeight * PlatformWeight * 10
  // Result is on a 1-10 scale
  return parseFloat(((base / 10) * modelWeight * platformWeight * 10).toFixed(2));
}

// ─────────────────────────────────────────────────────────────
// Core Functions
// ─────────────────────────────────────────────────────────────

/**
 * Extract atomic facts from raw text using LLM.
 */
export async function extractFacts(text: string): Promise<ExtractedFact[]> {
  const model = getLibrarianModel();
  console.error(`📚 [Librarian] Extracting facts using ${model}...`);
  console.error(`📚 [Librarian] Input text length: ${text.length} chars`);

  try {
    const client = getClient();
    const response = await client.chat.completions.create({
      model: model,
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: `Extract facts from the following text:\n\n${text.substring(0, 6000)}` }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 2000,
    });

    const content = response.choices[0]?.message?.content;
    console.error(`📚 [Librarian] Raw LLM response: ${content?.substring(0, 300)}...`);
    if (!content) {
      console.error("⚠️ [Librarian] Empty response from LLM");
      return [];
    }

    const parsed = JSON.parse(content);
    if (!parsed.facts || !Array.isArray(parsed.facts)) {
      console.error("⚠️ [Librarian] Response missing 'facts' array:", Object.keys(parsed));
      return [];
    }

    console.error(`📚 [Librarian] Extracted ${parsed.facts.length} raw facts`);

    // Validate and sanitize each fact
    const validated = parsed.facts
      .filter((f: any) =>
        f.content && typeof f.content === 'string' && f.content.length > 0 &&
        f.fact_type && isValidFactType(f.fact_type)
      )
      .map((f: any) => ({
        content: f.content.substring(0, 500),
        fact_type: f.fact_type as FactType,
        confidence: clamp(f.confidence ?? 5, 1, 10),
        importance: clamp(f.importance ?? 5, 1, 10),
        tags: Array.isArray(f.tags) ? f.tags.slice(0, 5) : [],
        subject_hint: f.subject_hint || undefined,
      }));

    console.error(`📚 [Librarian] Validated ${validated.length} facts (${parsed.facts.length - validated.length} filtered out)`);
    return validated;
  } catch (err: any) {
    console.error("❌ [Librarian] Extraction FAILED:", err?.message || err);
    return [];
  }
}

/**
 * Sanitize tags: string only, trimmed, unique, lowercase, max length.
 */
function sanitizeTags(tags: any[]): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(
    tags
      .filter(t => typeof t === 'string')
      .map(t => t.trim().toLowerCase().substring(0, 50))
      .filter(t => t.length > 0)
  )].slice(0, 10);
}

/**
 * Sanitize subject hint: only allow user_, project_, agent_, team_, system_, category_.
 */
function sanitizeSubjectHint(hint?: string): string | undefined {
  if (!hint) return undefined;
  const normalized = hint.trim().toLowerCase().substring(0, 100);
  const allowed = ['user_', 'project_', 'agent_', 'team_', 'system_', 'category_'];
  if (allowed.some(prefix => normalized.startsWith(prefix))) {
    return normalized;
  }
  return undefined;
}

/**
 * Check if a new fact contradicts any existing facts for the same subject.
 */
export async function resolveContradiction(
  newFact: ExtractedFact,
  subjectId: number,
  existingEmbedding?: number[]
): Promise<ContradictionResult> {
  try {
    // 1. Fetch Candidates (Similarity Search + Recent Fallback)
    const embedding = existingEmbedding || await generateEmbedding(newFact.content);
    let candidates: any[] = [];
    let candidateIds: number[] = [];

    if (embedding) {
      const embSql = vectorToSql(embedding);
      const similar = await db.query(
        `SELECT id, content, fact_type
         FROM facts
         WHERE subject_id = $1 AND is_active = TRUE AND fact_type = $2 AND embedding IS NOT NULL
           AND 1 - (embedding <=> $3::vector) > 0.65
         ORDER BY embedding <=> $3::vector
         LIMIT 5`,
        [subjectId, newFact.fact_type, embSql]
      );
      candidates = similar.rows;
    }

    // Fallback: If no good vector matches, take 10 most recent of the same type
    if (candidates.length < 3) {
      const recent = await db.query(
        `SELECT id, content, fact_type
         FROM facts
         WHERE subject_id = $1 AND is_active = TRUE AND fact_type = $2
           AND id != ALL($3::int[])
         ORDER BY updated_at DESC
         LIMIT 10`,
        [subjectId, newFact.fact_type, candidates.map(c => c.id)]
      );
      candidates = [...candidates, ...recent.rows];
    }

    if (candidates.length === 0) {
      return { supersedes_id: null, reason: "No existing facts to compare" };
    }

    candidateIds = candidates.map(c => c.id);

    // 2. Ask LLM to compare
    const existingList = candidates
      .map((r: any) => `[ID: ${r.id}] ${r.content}`)
      .join("\n");

    const client = getClient();
    const response = await client.chat.completions.create({
      model: getLibrarianModel(),
      messages: [
        { role: "system", content: CONTRADICTION_SYSTEM_PROMPT },
        {
          role: "user",
          content: `NEW FACT: "${newFact.content}"\n\nEXISTING FACTS:\n${existingList}`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 200,
    });

    const content = response.choices[0]?.message?.content;
    if (content) {
      const parsed = JSON.parse(content);
      const targetId = parsed.supersedes_id ?? null;

      // Validate targetId is in our candidate list
      if (targetId && !candidateIds.includes(targetId)) {
        console.error(`⚠️ [Librarian] LLM suggested target #${targetId} which was not in candidates.`);
        return { supersedes_id: null, reason: "LLM suggested out-of-bounds target" };
      }

      return {
        supersedes_id: targetId,
        reason: parsed.reason || "Unknown",
      };
    }

    return { supersedes_id: null, reason: "No contradiction detected" };
  } catch (err) {
    console.error("⚠️ Contradiction resolution failed:", err);
    return { supersedes_id: null, reason: `Error: ${err}` };
  }
}

/**
 * Main pipeline: Extract → Classify → Resolve → Save
 */
export async function processBatch(
  text: string,
  subjectId: number,
  projectSubjectId: number | null,
  sourceText?: string,
  provenance?: ProvenanceInfo
): Promise<ProcessResult> {
  const result: ProcessResult = {
    extracted: 0,
    saved: 0,
    contradictions_resolved: 0,
    facts: [],
    errors: [],
  };

  // Step 0: Resolve metadata IDs
  const authorModelId = await resolveModelId(provenance?.author_model);
  const platformId = await resolvePlatformId(provenance?.platform);

  // Step 1: Extract facts from text
  const extracted = await extractFacts(text);
  result.extracted = extracted.length;

  if (extracted.length === 0) {
    return result;
  }

  // Step 2: Process each fact
  for (const fact of extracted) {
    // 2a & 2b: Move LLM/Embedding work OUTSIDE the transaction
    const embedding = await generateEmbedding(fact.content);
    const hint = sanitizeSubjectHint(fact.subject_hint);
    const tags = sanitizeTags(fact.tags);

    // Get the actual subject IDs before the transaction
    let factSubjectId = subjectId;
    let factProjectId = projectSubjectId;

    if (hint) {
      const hintRes = await db.query("SELECT id FROM subjects WHERE subject_key = $1", [hint]);
      if (hintRes.rows.length > 0) {
        factSubjectId = hintRes.rows[0].id;
        if (hint.startsWith('project_')) factProjectId = factSubjectId;
      }
    }

    const contradiction = await resolveContradiction(fact, factSubjectId, embedding || undefined);

    // 2c: Database Transaction
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      let actualSupersedesId = null;

      if (contradiction.supersedes_id) {
        // Atomic update with validation
        const updateRes = await client.query(
          `UPDATE facts 
           SET is_active = FALSE, updated_at = NOW() 
           WHERE id = $1 AND subject_id = $2 AND fact_type = $3 AND is_active = TRUE
           RETURNING id`,
          [contradiction.supersedes_id, factSubjectId, fact.fact_type]
        );
        
        if (updateRes.rows.length > 0) {
          actualSupersedesId = updateRes.rows[0].id;
          result.contradictions_resolved++;
        }
      }

      const effectiveConfidence = await calculateEffectiveConfidence(
        fact.confidence,
        authorModelId,
        platformId
      );

      // Save the new fact
      const insertRes = await client.query(
        `INSERT INTO facts (
          subject_id, project_subject_id, content, source_text, 
          fact_type, confidence, importance, tags, embedding, 
          source, author_model_id, effective_confidence
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'librarian', $10, $11)
        RETURNING id`,
        [
          factSubjectId,
          factProjectId,
          fact.content,
          sourceText?.substring(0, 2000) || null,
          fact.fact_type,
          fact.confidence,
          fact.importance,
          tags,
          vectorToSql(embedding),
          authorModelId,
          effectiveConfidence
        ]
      );

      const newId = insertRes.rows[0].id;

      // Save provenance details
      await client.query(
        `INSERT INTO fact_provenances (
          fact_id, author_model_id, platform_id, session_id, raw_input, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          newId,
          authorModelId,
          platformId,
          provenance?.session_id || null,
          sourceText?.substring(0, 5000) || null,
          provenance?.metadata || {}
        ]
      );

      // Link supersedes chain
      if (actualSupersedesId) {
        await client.query(
          `UPDATE facts SET superseded_by = $1 WHERE id = $2`,
          [newId, actualSupersedesId]
        );
      }

      await client.query('COMMIT');

      result.saved++;
      result.facts.push({
        id: newId,
        content: fact.content,
        fact_type: fact.fact_type,
        superseded: actualSupersedesId || undefined,
      });

    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const errMsg = `Failed to save fact "${fact.content.substring(0, 50)}...": ${err}`;
      console.error(`⚠️ ${errMsg}`);
      result.errors.push(errMsg);
    } finally {
      client.release();
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const VALID_FACT_TYPES: FactType[] = [
  'preference', 'profile', 'state', 'skill', 'decision', 'learning', 'relationship'
];

function isValidFactType(type: string): type is FactType {
  return VALID_FACT_TYPES.includes(type as FactType);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
