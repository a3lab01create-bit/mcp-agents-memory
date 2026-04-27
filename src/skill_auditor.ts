import { searchExternal } from "./external_search.js";
import { callRole } from "./model_registry.js";
import type { ExternalSource } from "./external_search.js";
import type { SkillCandidate } from "./skills.js";

export type ValidationTier = 'validated_external' | 'validated_internal' | 'unvalidated' | 'contested';

export interface AuditedSkillCandidate extends SkillCandidate {
  reconciled_content: string;
  sources: ExternalSource[];
  validation_tier: ValidationTier;
  audit_reasoning: string;
}

interface AuditorResponse {
  reconciled_content?: unknown;
  validation_tier?: unknown;
  audit_reasoning?: unknown;
  cited_indices?: unknown;
}

const VALIDATION_TIERS: ValidationTier[] = [
  'validated_external',
  'validated_internal',
  'unvalidated',
  'contested',
];

function truncateForSearch(candidate: SkillCandidate): string {
  return `${candidate.title}\n${candidate.content}`.slice(0, 500);
}

function normalizeAuditorResponse(raw: string): {
  reconciled_content: string;
  validation_tier: ValidationTier;
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
  const validationTier = VALIDATION_TIERS.includes(parsed.validation_tier as ValidationTier)
    ? parsed.validation_tier as ValidationTier
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

export async function auditSkill(candidate: SkillCandidate): Promise<AuditedSkillCandidate> {
  const query = truncateForSearch(candidate);
  const searchResults = await searchExternal(query);

  if (searchResults.length === 0) {
    return {
      ...candidate,
      reconciled_content: candidate.content,
      sources: [],
      validation_tier: 'unvalidated',
      audit_reasoning: "External search disabled or no results",
    };
  }

  const system = `You are a Skill Auditor. Given a draft SKILL and external SOURCES, you must:
(a) reconcile the skill content with sources by augmenting it with corroborating detail when supported,
(b) mark contradictions inline as [contested: <source>],
(c) cite sources by index, and
(d) classify validation_tier.

Validation rules:
- Return "validated_external" only when at least one cited source has authority="high" and there are no contradictions.
- Return "validated_internal" when the cited sources are all authority="low" with no contradictions, or when fewer than 2 sources are available but you can still cite at least 1 source without contradiction.
- Return "contested" when at least one high- or medium-authority source disagrees with the skill content.
- Do not return "unvalidated" unless there are no sources, which is handled before you are called.

Output strict JSON only:
{
  "reconciled_content": "string",
  "validation_tier": "validated_external" | "validated_internal" | "contested",
  "audit_reasoning": "1-3 sentence explanation",
  "cited_indices": [0, 1]
}`;

  const user = `SKILL TITLE: ${candidate.title}
SKILL CONTENT: ${candidate.content}
SOURCES:
${searchResults.map((source, index) =>
  `[${index}] (engine=${source.engine}, authority=${source.authority}, weight=${source.weight}) ${source.title}: ${source.snippet}`
).join("\n")}`;

  try {
    const raw = await callRole('skill_auditor', {
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
      ...candidate,
      reconciled_content: normalized.reconciled_content || candidate.content,
      sources: citedSources,
      validation_tier: normalized.validation_tier,
      audit_reasoning: normalized.audit_reasoning || "Skill Auditor returned an incomplete response",
    };
  } catch (err) {
    return {
      ...candidate,
      reconciled_content: candidate.content,
      sources: searchResults,
      validation_tier: 'unvalidated',
      audit_reasoning: `Auditor LLM call failed: ${err}`,
    };
  }
}
