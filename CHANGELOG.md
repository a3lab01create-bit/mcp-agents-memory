# Changelog

## 0.8.0 — 2026-04-28

### Project scoping for skills (Phase 1 of Project Rules Engine)

Skills used to leak across projects. A skill formed from Project A memories would auto-inject into a Project B `memory_startup`, regardless of project context. This shipped a single-axis correctness fix using JSONB extension — no schema migration.

A 3-way design review (Codex GPT-5.5, Gemini-3-Pro, advisor) produced an unanchored ranking. Advisor flagged that two consultants had piggybacked on Opus's prompt anchor (Skill Application Telemetry was the original direction), and surfaced Project Rules Engine as the under-weighted candidate. Code evidence confirmed the leak: `getInjectableSkills` had no project filter, `applicable_to` JSONB only checked `models` and `platforms`, and the curator never propagated cluster `projectId` to the resulting skill.

### Added
- `applicable_to.projects` JSONB key — opt-in project scope. Skills with this key only inject when `memory_startup` is called with a matching `project_key`. Skills without it (the existing default `'{}'` shape) match all projects (backward compatible).
- `memory_startup` and `memory_save_skill` tools accept a new `project_key` argument.
- `getInjectableSkills(ctx)` accepts `project_key`; SQL filter respects null-tolerant pattern (NULL = no filter).
- Curator propagates cluster `projectKey` to `SkillCandidate.project_key`. `getPersistedSkillFields` merges it into `applicable_to.projects` if the auditor didn't already specify one.
- Accumulate path (similarity ≥ 0.9) now unions project keys via `jsonb_set`. Rules: NULL project → no-op; existing match-all (no `projects` key) → don't narrow; project already in array → no-op; otherwise append. Branch and create paths inherit the candidate's `applicable_to` directly (no merge needed).

### Backward compatibility
Verified against live DB before ship: all 4 existing skills had `applicable_to = '{}'`. They continue to inject for any `project_key` (or none).

### Skill Auditor inference (deferred — principled)
The auditor's system prompt could in principle infer `applicable_to.projects`, but it adds no information the cluster's projectId doesn't already carry, and adds hallucination risk. Phase 2 may revisit if there's evidence the cluster signal is ambiguous.

### Verification
`scratch/test_v08_project_scoping.ts` — 11/11 against Neon: read filter (4 cases) + backward compat (2 cases) + write propagation (1 case) + merge semantics on accumulate (3 cases: union, match-all preservation, null-project preservation).

## 0.7.0 — 2026-04-28

### Breaking schema change: `trust_weight` infrastructure retired

The `trust_weight` / `effective_confidence` columns existed since v0.5 but were never wired into ranking, contradiction resolution, or any automated decision — only displayed as a label in `memory_search` results. Setting `trust_weight` to 0.5 vs 0.98 produced identical system behavior.

After a 3-way design review (Codex GPT-5.5, Gemini-3-Pro, advisor), all three independently recommended deprecation over wiring. Two killer risks for the wiring path: (1) `effective_confidence` was computed once at write time and frozen — demoting a model later would not recompute past memories, so any ORDER BY on it would rank on stale historical artifacts; (2) auto-defaulting unknown models to 0.8 produces a "SOTA Penalty" — newly released frontier models would suppress their own facts under older benchmarked models until manually seeded.

The narrow audit gate (`fact_type='learning' AND importance>7`) was kept intentionally — those facts are externally groundable via Tavily+Exa. Subjective fact types (preference / profile / project / decision) cannot be grounded externally and so do not benefit from audit expansion. Audit scope is correct as-is, not deferred.

### Removed
- `models.trust_weight` column (migration 017)
- `platforms.trust_weight` column (migration 017)
- `memories.effective_confidence` column (migration 017)
- `computeEffectiveConfidence` function in `librarian.ts`
- `DEFAULT_TRUST_WEIGHT` constant
- `effective_confidence` field from `memory_search` SELECT and result label

### Added
- Auto-registration of unknown author models in `resolveModel` (`src/librarian.ts`). Two-branch behavior:
  - **Prefix-known** (`claude-*` / `gpt-*` / `o1-*` / `o3-*` / `gemini-*` / `grok-*`): provider is inferred, model is auto-INSERTed, `author_model_id` FK is populated.
  - **Prefix-unknown** (custom or non-standard models): falls back to `author_model_id=NULL` with a warning. This is the same behavior as before — auto-register does NOT eliminate NULL completely, only for models that match a known provider prefix.
- `inferProvider` is now exported from `src/model_registry.ts` (single source of truth for prefix → provider mapping, reused by both env-config inference and DB auto-registration).

### Migration
Migration 017 runs automatically on first server startup against existing databases. It uses `DROP COLUMN IF EXISTS` and is idempotent. **Note: column drops are not reversible without a backup**, so users on 0.6.x who want to roll back should take a snapshot before upgrading.

### Internal
- `ResolvedModel` and `ResolvedPlatform` interfaces no longer carry `trust_weight`. The `resolveModel` / `resolvePlatform` functions remain (they're still used by `skills.ts` for provenance FK lookup).

## 0.6.3 — 2026-04-28
- Per-call `agent_curator_id` for multi-persona harnesses (commit `151f2bf`).

## 0.6.2 — 2026-04-28
- Drop env-static `AGENT_MODEL`, capture curator model per-call (commit `16ab470`).

## 0.6.1
- Split Producer (`author_model`) and Curator (`agent_*`) provenance (commit `59ca76c`).

## 0.6.0 — 2026-04-27
- First npm publish (commit `53bb9ba`).
