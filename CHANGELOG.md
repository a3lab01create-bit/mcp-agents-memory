# Changelog

## 0.9.9 — 2026-05-23

### `search_memory` device scoping — "search wide, resume narrow"

New `device_scope: 'local' | 'global'` param (default `global`). `local` restricts results to the current device (`os.hostname()`), but pinned memories stay cross-device (`device_name = $N OR is_pinned = TRUE`) — mirroring the brief's device-scope + pinned-exempt precedent, since pinned facts are important regardless of context. Applied to both the vector/recency path and the ILIKE fallback.

Two bugs surfaced during the brief-continuity verification are fixed:

- `agent_platform: "*"` was a literal SQL match (`= '*'`) returning 0 rows, despite the startup brief documenting `"*"` as a cross-platform search. Now treated as no-filter.
- `device_name` was absent from `search_memory` results (the brief renders `@hostname`, but search dropped it). Added to the result schema, all three SELECTs, and all three row mappers.

Zero-config preserved: the server resolves the hostname; no per-client configuration.

## 0.9.8 — 2026-05-22

### Startup brief — budget cap + device-scoped continuity

Two-channel brief assembly so the client-injected MCP `instructions` block survives the client's ~2KB truncation while `memory_startup` carries the rich context.

- **Inject mode (Phase 1)**: `STATIC_INSTRUCTIONS` trimmed (1,436→565 chars); the auto-injected brief now guarantees header + Core Profile + pinned + active projects within `INSTRUCTIONS_MAX_CHARS` (default 1900) via budgeted line-fill, dropping Sub Profile / Recent in inject mode (they load lazily via `memory_startup`). Pinned hoisted above Sub Profile.
- **`memory_startup` continuity (Phase 2)**: previous-conversation continuity rides the uncapped `memory_startup` tool response, not a Claude-Code-only `SessionStart` hook — that hook attempt was built then reverted for violating the zero-config standard-env principle. `recent_messages_current` scoped to the current device (`device_name = os.hostname()`); preview length decoupled from the inject cap (`MAX_PREVIEW_STORE` 500 / `PREVIEW_RECENT` 300 / `PREVIEW_COMPACT` 100); `BRIEF_MAX_CHARS` 3000→8000 so the thicker Recent is not dropped.
- **Proactive resource use**: brief footer + STATIC instructions nudge agents to call `search_memory` on named-entity mentions and before assuming past preferences/decisions.

The `instructions` pointer drives every platform (Claude / Codex / Gemini) to call `memory_startup`, so all clients get rich device-scoped continuity with zero client config.

## 0.9.7 — 2026-05-22

### Librarian v2 — daily user profile promotion

Background job that reads 50 recent `role='user'` messages once per day and promotes stable identity/preference facts to `users.core_profile` / `users.sub_profile` via qwen3.6:35b-a3b (local, Q4_K_M).

Gate logic: `LIBRARIAN_ENABLED=true` + 30 new messages since last run + 24h cooldown. Attempt timestamp written immediately on every call (hammer prevention); `msg_count_at_run` updated on success only so gate re-opens after failed run.

Hardened against two known qwen3.x failure modes: (1) `response_format: json_object` → empty content bug — omitted entirely, relying on callSpec local-case fence stripping; (2) reasoning token exhaustion at 8k — bumped to `max_tokens=32768`. Added JSON-in-string guard (rejects `sub_profile` that starts with `{` or `[`) and null protection (`parsed.field ?? existing` so model returning null preserves existing data).

### Added
- `src/librarian.ts` — full rebuild (v1 → v2): gate check, per-attempt `last_run_at` update, 32k token budget, null guard, JSON-in-string guard, prose-only system prompt rule
- `src/migrations/023_librarian_gate.ts` — adds `librarian_last_run_at TIMESTAMPTZ` and `librarian_msg_count_at_run BIGINT` to `users` table
- `src/cold_path/worker.ts` — wires `maybeRunLibrarian()` into cold path tick (gated by `LIBRARIAN_ENABLED`)
- `src/model_registry.ts` — `librarian` role in ROLE_REGISTRY; local provider singleton client; `callSpec` exported as public API; qwen3 thinking flag support
- `src/cold_path/tagger.ts` — grok fallback for local tagger failures (`LOCAL_GROK_FALLBACK=true`)
- `.env.example` — `LIBRARIAN_PROVIDER`, `LIBRARIAN_MODEL`, `LIBRARIAN_ENABLED` added

### Configuration
- Ollama tuning applied on 몰타르 서버: `FLASH_ATTENTION=1`, `KV_CACHE_TYPE=q8_0`, `TIMEOUT=900`, `KEEP_ALIVE=60m` via systemd drop-in; Modelfile `num_ctx 16384` (down from 131072 — VRAM 97% constraint), `temperature 0.65`, `repeat_penalty 1.1`

## 0.8.1 — 2026-04-28

### Skill injection eval harness (dev tool)

Adds `npm run eval` — a curated scenario suite for `getInjectableSkills` filter behavior. Runs 6 multi-axis scenarios (project × model × platform intersections, multi-project unions, status filtering) against the live DB. Cleanup via `applicable_to.eval_run_id` metadata tag — no test fixtures can leak into production data.

This is a development tool, not user-facing API. No schema change, no MCP tool exposure, no metric → behavior wiring. Decision basis: 3-way design meeting #2 + advisor surfaced that v0.8 ships multi-axis filter logic that has never executed against real production data (all 4 existing skills are `applicable_to = '{}'`). The harness exercises the unrun code paths.

Discriminator before scope finalization: 4 production skills, all match-all shape, 2 distinct sessions across 148 memories. Production telemetry counters (the lighter alternative path) would yield no signal for months. Eval harness produces signal in the first run.

### Added
- `src/eval/runner.ts`, `src/eval/scenarios.ts`, `src/eval/index.ts` — scenario runner and initial 6-scenario suite
- `npm run eval` script (compiles via existing `npm run build` esbuild pipeline, then runs)
- `build.mjs` extended to bundle eval entry point alongside index + migrations

### Out of scope (settled)
- Coverage of full `memory_startup` briefing assembly (`tools.ts:140-163` wrap) — eval harness exercises `getInjectableSkills` filter only
- Single-axis scenarios (project-only, model-only, platform-only) — already covered by `scratch/test_v08_project_scoping.ts`. The harness focuses on intersections to earn its keep
- Production telemetry: counters, use_count auto-increment, agent self-reporting — all deferred until real-user signal exists

### No npm publish
0.8.1 ships to git only. No user-facing API change, so no registry update warranted. 0.8.0 remains the latest published version.

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
