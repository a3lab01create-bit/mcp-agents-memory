/**
 * Memory Auditor — SYNC external knowledge grounding for high-importance facts.
 *
 * Mirrors src/skill_auditor.ts shape so the two paths stay aligned. Future work
 * may unify them; for now they are deliberately parallel.
 *
 * Gating is the caller's responsibility. The auditor itself runs unconditionally
 * once invoked.
 */

import { searchExternal } from "./external_search.js";
import { callRole } from "./model_registry.js";
import type { ExternalSource } from "./external_search.js";

export type MemoryValidationTier =
  | 'validated_external'
  | 'validated_internal'
  | 'unvalidated'
  | 'contested';

export interface AuditedMemory {
  reconciled_content: string;
  sources: ExternalSource[];
  validation_tier: MemoryValidationTier;
  audit_reasoning: string;
}

interface AuditorResponse {
  reconciled_content?: unknown;
  validation_tier?: unknown;
  audit_reasoning?: unknown;
  cited_indices?: unknown;
}

const VALIDATION_TIERS: MemoryValidationTier[] = [
  'validated_external',
  'validated_internal',
  'unvalidated',
  'contested',
];

function normalizeAuditorResponse(raw: string): {
  reconciled_content: string;
  validation_tier: MemoryValidationTier;
  audit_reasoning: string;
  cited_indices: number[];
} {
  const stripped = raw.replace(/```json|```/g, "").trim();
  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  const cleaned = firstBrace >= 0 && lastBrace > firstBrace
    ? stripped.slice(firstBrace, lastBrace + 1)
    : stripped;
  const parsed = JSON.parse(cleaned) as AuditorResponse;
  const validationTier = VALIDATION_TIERS.includes(parsed.validation_tier as MemoryValidationTier)
    ? parsed.validation_tier as MemoryValidationTier
    : 'contested';
  const citedIndices = Array.isArray(parsed.cited_indices)
    ? parsed.cited_indices
        .filter((value): value is number => Number.isInteger(value))
        .map((value) => Number(value))
    : [];

  return {
    reconciled_content: typeof parsed.reconciled_content === 'string'
      ? parsed.reconciled_content
      : "",
    validation_tier: validationTier,
    audit_reasoning: typeof parsed.audit_reasoning === 'string'
      ? parsed.audit_reasoning
      : "",
    cited_indices: Array.from(new Set(citedIndices)),
  };
}

/**
 * Ground a memory's content against external sources and return a reconciled version.
 *
 * Output contract:
 *   - On no external results → tier='unvalidated', content unchanged, sources=[].
 *   - On LLM failure → tier='unvalidated' with a diagnostic audit_reasoning, original sources retained.
 *   - On success → tier ∈ {validated_external, validated_internal, contested},
 *     reconciled_content may augment with corroborating detail or mark contradictions inline as
 *     [contested: <source>].
 */
export async function auditMemory(content: string, factType: string): Promise<AuditedMemory> {
  const query = content.slice(0, 500);
  const searchResults = await searchExternal(query);

  if (searchResults.length === 0) {
    return {
      reconciled_content: content,
      sources: [],
      validation_tier: 'unvalidated',
      audit_reasoning: "External search disabled or no results",
    };
  }

  const system = `You are a Memory Auditor. Given a draft FACT and external SOURCES, you must:
(a) reconcile the fact with sources by augmenting it with corroborating detail when supported,
(b) mark contradictions inline as [contested: <source>],
(c) cite sources by index, and
(d) classify validation_tier.

Validation rules:
- Return "validated_external" only when at least one cited source has authority="high" and there are no contradictions.
- Return "validated_internal" when the cited sources are all authority="low" with no contradictions, or when fewer than 2 sources are available but you can still cite at least 1 source without contradiction.
- Return "contested" when at least one high- or medium-authority source disagrees with the fact content.
- Do not return "unvalidated" unless there are no sources, which is handled before you are called.

Reconciliation guidance for fact_type="${factType}":
- If the fact is empirically verifiable (technical claim, public event, public spec), augment with cited specifics.
- If the fact is internal/subjective and the sources are off-topic, return reconciled_content unchanged and explain in audit_reasoning.
- Never invent facts not supported by sources.

Output strict JSON only:
{
  "reconciled_content": "string",
  "validation_tier": "validated_external" | "validated_internal" | "contested",
  "audit_reasoning": "1-3 sentence explanation",
  "cited_indices": [0, 1]
}`;

  const user = `FACT TYPE: ${factType}
FACT CONTENT: ${content}
SOURCES:
${searchResults.map((source, index) =>
  `[${index}] (engine=${source.engine}, authority=${source.authority}, weight=${source.weight}) ${source.title}: ${source.snippet}`
).join("\n")}`;

  try {
    const raw = await callRole('memory_auditor', {
      system,
      user,
      responseFormat: 'json',
      maxTokens: 2048,
    });
    const normalized = normalizeAuditorResponse(raw);
    const citedSources = normalized.cited_indices
      .filter((index) => index >= 0 && index < searchResults.length)
      .map((index) => searchResults[index]);

    return {
      reconciled_content: normalized.reconciled_content || content,
      sources: citedSources,
      validation_tier: normalized.validation_tier,
      audit_reasoning: normalized.audit_reasoning || "Memory Auditor returned an incomplete response",
    };
  } catch (err) {
    return {
      reconciled_content: content,
      sources: searchResults,
      validation_tier: 'unvalidated',
      audit_reasoning: `Auditor LLM call failed: ${err}`,
    };
  }
}
