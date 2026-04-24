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
    console.error("❌ [Librarian] API Key present:", !!process.env.OPENAI_API_KEY);
    console.error("❌ [Librarian] Model:", model);
    return [];
  }
}

/**
 * Check if a new fact contradicts any existing facts for the same subject.
 */
export async function resolveContradiction(
  newFact: ExtractedFact,
  subjectId: number
): Promise<ContradictionResult> {
  try {
    // Fetch existing active facts for this subject with similar types
    const existing = await db.query(
      `SELECT id, content, fact_type, tags
       FROM facts
       WHERE subject_id = $1 AND is_active = TRUE AND fact_type = $2
       ORDER BY updated_at DESC
       LIMIT 10`,
      [subjectId, newFact.fact_type]
    );

    if (existing.rows.length === 0) {
      return { supersedes_id: null, reason: "No existing facts to compare" };
    }

    // Use embedding similarity for initial screening
    const newEmbedding = await generateEmbedding(newFact.content);
    if (newEmbedding) {
      const embSql = vectorToSql(newEmbedding);
      const similar = await db.query(
        `SELECT id, content, fact_type
         FROM facts
         WHERE subject_id = $1 AND is_active = TRUE AND embedding IS NOT NULL
           AND 1 - (embedding <=> $2::vector) > 0.7
         ORDER BY embedding <=> $2::vector
         LIMIT 5`,
        [subjectId, embSql]
      );

      // If highly similar facts exist, check for contradiction via LLM
      if (similar.rows.length > 0) {
        const existingList = similar.rows
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
          return {
            supersedes_id: parsed.supersedes_id ?? null,
            reason: parsed.reason || "Unknown",
          };
        }
      }
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
): Promise<ProcessResult> {
  const result: ProcessResult = {
    extracted: 0,
    saved: 0,
    contradictions_resolved: 0,
    facts: [],
    errors: [],
  };

  // Step 1: Extract facts from text
  const extracted = await extractFacts(text);
  result.extracted = extracted.length;

  if (extracted.length === 0) {
    return result;
  }

  // Step 2: Process each fact
  for (const fact of extracted) {
    try {
      // Determine the actual subject for this fact
      let factSubjectId = subjectId;
      if (fact.subject_hint) {
        // Try to resolve subject_hint to an actual subject ID
        const hintRes = await db.query(
          "SELECT id FROM subjects WHERE subject_key = $1",
          [fact.subject_hint]
        );
        if (hintRes.rows.length > 0) {
          factSubjectId = hintRes.rows[0].id;
        }
      }

      // Determine project subject
      let factProjectId = projectSubjectId;
      if (fact.subject_hint?.startsWith('project_')) {
        const projRes = await db.query(
          "SELECT id FROM subjects WHERE subject_key = $1",
          [fact.subject_hint]
        );
        if (projRes.rows.length > 0) {
          factProjectId = projRes.rows[0].id;
        }
      }

      // Step 2a: Resolve contradictions
      const contradiction = await resolveContradiction(fact, factSubjectId);

      if (contradiction.supersedes_id) {
        // Mark old fact as superseded
        await db.query(
          `UPDATE facts SET is_active = FALSE, superseded_by = NULL, updated_at = NOW()
           WHERE id = $1`,
          [contradiction.supersedes_id]
        );
        result.contradictions_resolved++;
      }

      // Step 2b: Generate embedding for the new fact
      const embedding = await generateEmbedding(fact.content);

      // Step 2c: Save the new fact
      const insertRes = await db.query(
        `INSERT INTO facts (subject_id, project_subject_id, content, source_text, fact_type, confidence, importance, tags, embedding, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'librarian')
         RETURNING id`,
        [
          factSubjectId,
          factProjectId,
          fact.content,
          sourceText?.substring(0, 2000) || null,
          fact.fact_type,
          fact.confidence,
          fact.importance,
          fact.tags,
          vectorToSql(embedding),
        ]
      );

      const newId = insertRes.rows[0].id;

      // If we superseded a fact, update the chain
      if (contradiction.supersedes_id) {
        await db.query(
          `UPDATE facts SET superseded_by = $1 WHERE id = $2`,
          [newId, contradiction.supersedes_id]
        );
      }

      result.saved++;
      result.facts.push({
        id: newId,
        content: fact.content,
        fact_type: fact.fact_type,
        superseded: contradiction.supersedes_id || undefined,
      });

    } catch (err) {
      const errMsg = `Failed to save fact "${fact.content.substring(0, 50)}...": ${err}`;
      console.error(`⚠️ ${errMsg}`);
      result.errors.push(errMsg);
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
