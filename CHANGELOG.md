# Changelog

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
