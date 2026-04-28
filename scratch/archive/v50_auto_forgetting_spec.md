# v5.0 Auto Forgetting — Spec

Phase 3 second slice. Closes the "잊고" half of v5.0's "기억하고, 잊고, 연결한다" mantra.
Memory Graph (first slice) is already in main as commit 396c124.

## Why this is the right next step

- Original roadmap (`project_original_roadmap.md`) lists Auto Forgetting as the third Phase-3 item.
- All decay signals already exist on `memories`: `importance` (1-10), `access_count`, `last_accessed_at`, `created_at`. `tools.ts:475` already increments access_count + last_accessed_at on every search hit, so the data has been accruing.
- Soft-delete plumbing already exists: every reader (`tools.ts`, `curator.ts:139`, `librarian.ts:333,508`) filters `is_active = TRUE`. Setting `is_active = false` is the entire "forget" action — no new schema needed for the basic path.

## What's in scope (Phase 1 of forgetting — keep narrow)

1. **Decay scoring function** — pure, importable, unit-testable.
2. **Eligibility gate** — never decay `profile` facts; skip rows with `validation_status='pending'` (their grounding hasn't matured); apply differentiated half-lives by `fact_type`. (No need to special-case `superseded_by` — `librarian.ts:508` already flips those `is_active=FALSE` and they fall out of the scan automatically.)
3. **Forgetting pass** — single function that scans active memories, applies decay scoring, soft-deletes those below threshold. Records `forgotten_at` + `forgotten_reason` in `memories.metadata` so it's recoverable.
4. **Trigger surface** — opt-in env flag `FORGETTING_ENABLED=false` + interval (matches `PROMOTION_ENABLED` pattern). Loop scheduled in `index.ts` startup just like promotion. The pass function is also importable so the test harness drives it directly without going through the loop.
5. **Memory_status report** — add 🗑️ Forgetting section: total forgotten count + per-type breakdown. (Last-pass timestamp deferred — needs side state.)
6. **E2E test** — `scratch/test_v50_auto_forgetting.js` covering: decay function math, profile immunity, validation_status='pending' immunity, threshold boundary, apply-then-search excludes, idempotence, status reflects.

## What's deferred (write down so it doesn't sneak in)

- Memory↔memory edges, multi-hop graph traversal — Phase 1 graph deferral, still deferred here.
- `restore_memory` / un-forget tool — soft-delete is recoverable via direct SQL; tool surface can wait.
- Hard delete after extended dormancy — keep all rows for now, provenance > storage.
- LLM-judge forgetting (asking model "is this still relevant?") — pure-function only for v1, no LLM cost.
- Adaptive half-lives based on user behavior — fixed table for now.

## Decay function (concrete)

Switched from hyperbolic to exponential after advisor review — the hyperbolic form did not deliver actual half-life semantics (a default-importance state fact would have lasted 126 days under HL=14, contradicting the per-type table). Exponential matches the table's intent.

```
score(memory) = importance × exp(-age_days / half_life_days)

where:
  age_days       = days_since(COALESCE(last_accessed_at, created_at))
  half_life_days = base_half_life × (1 + log10(access_count + 1))

forget if: score < FORGET_THRESHOLD (default 0.5)
```

`access_count` boosts the half-life logarithmically — heavily-accessed memories take much longer to fade. Importance acts as a ceiling on the starting score.

### Forgetting age, by importance × type (no access boost, threshold 0.5)
forget age = `half_life × ln(2 × importance)`

| importance | state(HL=14) | learning(HL=90) | skill(HL=180) | preference(HL=365) |
|------------|--------------|-----------------|---------------|---------------------|
| 3          | 25 days      | 161 days        | 322 days      | 654 days            |
| 5          | 32 days      | 207 days        | 414 days      | 840 days            |
| 7          | 37 days      | 238 days        | 475 days      | 964 days            |
| 10         | 42 days      | 270 days        | 539 days      | 1094 days           |

Access boost: 10 hits → half_life × ~2.04, so dates roughly double.

### Per-type base_half_life (days)
| fact_type      | half_life | notes |
|----------------|-----------|-------|
| profile        | ∞         | NEVER FORGET (filtered before scoring) |
| preference     | 365       | tastes drift slowly |
| skill          | 180       | skills get rusty but keep value |
| decision       | 180       | past decisions matter for context |
| learning       | 90        | the world moves; learnings get stale |
| state          | 14        | by nature ephemeral |
| relationship   | 365       | relationships are sticky |

`type_factor` is just `1.0` in v1 — half-life IS the per-type knob. Keeping `type_factor` in the formula leaves a clean hook for future tuning without re-shaping callers.

## File-level changes

### New
- `src/forgetting.ts` — exports `scoreMemory(row)`, `runForgettingPass(opts)`, `FORGET_DEFAULTS`.
- `scratch/test_v50_auto_forgetting.js` — e2e harness.

### Modified
- `src/tools.ts` — 🗑️ Forgetting section added to `memory_status` (count + per-type). No new MCP tool in v1 — env-flag loop is enough; manual `memory_forget` tool can land later when there's a concrete UX need.
- `src/index.ts` — gate-and-schedule forgetting loop on startup (mirror PROMOTION wire-up).
- `.env.example` — `FORGETTING_ENABLED=false`, `FORGETTING_INTERVAL_MS=86400000` (24h), `FORGET_THRESHOLD=0.5`.

### NOT modified
- `setup.ts` — no schema change. `is_active` + metadata cover everything.
- `librarian.ts` — write path doesn't change.
- `memory_search` — already filters `is_active = TRUE`. Forgotten memories disappear automatically.

## How "forgetting" is recorded

Soft-delete UPDATE:
```sql
UPDATE memories
SET is_active = FALSE,
    metadata = jsonb_set(
      jsonb_set(COALESCE(metadata, '{}'), '{forgotten_at}', to_jsonb(NOW())),
      '{forgotten_reason}',
      to_jsonb('decay_score=' || $score)
    )
WHERE id = $id;
```

Wait — `metadata` doesn't exist on `memories` (it's on `subjects`). Need to either add it (small migration) or stash in a side table.

**Decision:** add a tiny migration #011 that adds `metadata JSONB DEFAULT '{}'::jsonb` to `memories`. It's the minimal-surface choice; alternative is a `forgotten_memories` audit table which is more weight than a JSONB column. The column is also useful beyond forgetting (e.g., we already stash audit `original_content` via `fact_validations.metadata`, but per-memory metadata is missing).

## Test plan

`scratch/test_v50_auto_forgetting.js` (drives `runForgettingPass()` directly):
1. **Math test** — handcraft inputs with known importance/access/age, assert `scoreMemory()` matches the closed-form `importance × exp(-age/half_life)`.
2. **Profile immunity** — insert `profile` fact with importance=1, last_access 5 years ago. Run pass. Assert still active.
3. **Pending immunity** — insert `learning` fact with `validation_status='pending'` aged past threshold. Assert pass leaves it alone.
4. **Threshold boundary** — insert two `state` facts, one just over and one just under threshold. Run pass. Assert exactly one forgotten.
5. **Apply + search exclusion** — run pass; subsequent `memory_search` excludes forgotten rows; `memory_status` shows updated count.
6. **Idempotence** — second pass is a no-op (already-forgotten rows have `is_active=FALSE`, scan never reads them).
7. **Metadata trace** — confirm `forgotten_at` + `forgotten_reason` recorded in `memories.metadata`.

## Open questions for advisor

1. **half-life numbers** — these are eyeballed Hermes/supermemory-style guesses. Is there a published baseline? If not, keep these and tune later from real telemetry.
2. **Threshold semantics** — `score < 0.5` with default importance 5 means a learning fact at default importance forgets after roughly half-life when never re-accessed. Is that aggressive enough / too aggressive?
3. **Migration #011 metadata column** — fine to ship a one-column migration just for forgetting trace, or should we batch with future needs?
4. **Skill memories vs Skills table** — `fact_type='skill'` memories vs the dedicated `skills` table from v4.5. Is `skills` table inside the forgetting scope, or strictly memories-only for v1? Recommend memories-only; skills decay is a separate decision (skills are promotion-gated and have their own quality signals).
5. **Edge cleanup** — when a subject's last memory is forgotten, the `subject_relationships` edges are still there. Stale-but-harmless, or worth cleaning? Recommend leaving for v1; edges are cheap and might point to other still-active subjects.
