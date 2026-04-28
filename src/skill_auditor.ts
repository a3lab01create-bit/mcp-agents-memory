import { searchExternal } from "./external_search.js";
import { callRole } from "./model_registry.js";
import type { ExternalSource } from "./external_search.js";
import type { SkillCandidate } from "./skills.js";

export type ValidationTier = 'validated_external' | 'validated_internal' | 'unvalidated' | 'contested';

export interface SkillApplicability {
  models?: string[];
  platforms?: string[];
  // v0.8: project scope. Set deterministically by curator from cluster's projectKey
  // (auditor does NOT infer this — see v08 spec §2 for principled deferral rationale).
  projects?: string[];
}

export interface AuditedSkillCandidate extends SkillCandidate {
  reconciled_content: string;
  sources: ExternalSource[];
  validation_tier: ValidationTier;
  audit_reasoning: string;
  applicable_to: SkillApplicability;
}

interface AuditorResponse {
  reconciled_content?: unknown;
  validation_tier?: unknown;
  audit_reasoning?: unknown;
  cited_indices?: unknown;
  applicable_to?: unknown;
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

function normalizeApplicability(raw: unknown): SkillApplicability {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const result: SkillApplicability = {};
  if (Array.isArray(obj.models)) {
    const models = obj.models.filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (models.length > 0) result.models = Array.from(new Set(models));
  }
  if (Array.isArray(obj.platforms)) {
    const platforms = obj.platforms.filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (platforms.length > 0) result.platforms = Array.from(new Set(platforms));
  }
  return result;
}

function normalizeAuditorResponse(raw: string): {
  reconciled_content: string;
  validation_tier: ValidationTier;
  audit_reasoning: string;
  cited_indices: number[];
  applicable_to: SkillApplicability;
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
    applicable_to: normalizeApplicability(parsed.applicable_to),
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
      applicable_to: {},
    };
  }

  const system = `You are a Skill Auditor. Given a draft SKILL and external SOURCES, you must:
(a) reconcile the skill content with sources by augmenting it with corroborating detail when supported,
(b) mark contradictions inline as [contested: <source>],
(c) cite sources by index,
(d) classify validation_tier, and
(e) infer applicable_to (which models/platforms this skill applies to).

Validation rules:
- Return "validated_external" only when at least one cited source has authority="high" and there are no contradictions.
- Return "validated_internal" when the cited sources are all authority="low" with no contradictions, or when fewer than 2 sources are available but you can still cite at least 1 source without contradiction.
- Return "contested" when at least one high- or medium-authority source disagrees with the skill content.
- Do not return "unvalidated" unless there are no sources, which is handled before you are called.

applicable_to inference rules:
- Default to empty object {} when the skill is general know-how (algorithms, language semantics, universal patterns) — matches all callers.
- Set "models" to specific model name strings ONLY when the skill is tied to a model's behavior (e.g., "claude-sonnet-4-6", "gpt-5.4"). Use lowercase exact strings. Omit the key entirely if not model-specific.
- Set "platforms" to specific platform identifiers ONLY when the skill is tied to a platform/IDE/runtime (e.g., "claude-code", "antigravity", "cli", "cursor"). Use lowercase exact strings. Omit the key entirely if not platform-specific.
- When in doubt, prefer empty object — over-narrow applicability is worse than over-broad (skills that should apply universally won't get injected if you constrain them).

Output strict JSON only:
{
  "reconciled_content": "string",
  "validation_tier": "validated_external" | "validated_internal" | "contested",
  "audit_reasoning": "1-3 sentence explanation",
  "cited_indices": [0, 1],
  "applicable_to": { "models": ["..."], "platforms": ["..."] }
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
      cache: true, // Sonnet/Haiku — system prompt is stable across promotion runs.
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
      applicable_to: normalized.applicable_to,
    };
  } catch (err) {
    return {
      ...candidate,
      reconciled_content: candidate.content,
      sources: searchResults,
      validation_tier: 'unvalidated',
      audit_reasoning: `Auditor LLM call failed: ${err}`,
      applicable_to: {},
    };
  }
}
