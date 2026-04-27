/**
 * Auto Forgetting (v5.0 Phase 3) — closes the "잊고" half of
 * "기억하고, 잊고, 연결한다."
 *
 * Decay model: importance × exp(-age_days / half_life_days), where
 * half_life_days = base_half_life[fact_type] × (1 + log10(access_count + 1)).
 *
 * Eligibility:
 *   - profile facts: never decay (identity)
 *   - validation_status='pending': skip (grounding hasn't matured)
 *   - is_active=FALSE rows: not scanned (filter at SQL level)
 *
 * Action: soft-delete (is_active=FALSE) + stamp metadata.forgotten_at /
 * forgotten_reason. No row deletion — provenance > storage.
 */

import { db } from "./db.js";

export type FactType =
  | "preference"
  | "profile"
  | "state"
  | "skill"
  | "decision"
  | "learning"
  | "relationship";

export const HALF_LIFE_DAYS: Record<FactType, number> = {
  profile: Infinity, // never decay
  preference: 365,
  skill: 180,
  decision: 180,
  learning: 90,
  state: 14,
  relationship: 365,
};

export interface ScoreInput {
  importance: number;
  fact_type: FactType;
  access_count: number;
  age_days: number;
}

export interface MemoryRow {
  id: number;
  fact_type: FactType;
  importance: number;
  access_count: number;
  last_accessed_at: Date | null;
  created_at: Date;
}

export interface ForgettingResult {
  scanned: number;
  forgotten: number;
  by_type: Record<string, number>;
  threshold: number;
  dry_run: boolean;
}

export const DEFAULT_FORGET_THRESHOLD = 0.5;
const MS_PER_DAY = 86400 * 1000;

export function scoreMemory(input: ScoreInput): number {
  const baseHalfLife = HALF_LIFE_DAYS[input.fact_type];
  if (!Number.isFinite(baseHalfLife)) return Number.POSITIVE_INFINITY;

  const accessBoost = 1 + Math.log10(input.access_count + 1);
  const halfLife = baseHalfLife * accessBoost;
  const decay = Math.exp(-input.age_days / halfLife);
  return input.importance * decay;
}

function ageDays(row: MemoryRow): number {
  const ref = row.last_accessed_at ?? row.created_at;
  const ms = Date.now() - new Date(ref).getTime();
  return Math.max(0, ms / MS_PER_DAY);
}

export function scoreRow(row: MemoryRow): number {
  return scoreMemory({
    importance: row.importance,
    fact_type: row.fact_type,
    access_count: row.access_count,
    age_days: ageDays(row),
  });
}

export interface ForgetOptions {
  threshold?: number;
  dryRun?: boolean;
}

export async function runForgettingPass(opts: ForgetOptions = {}): Promise<ForgettingResult> {
  const threshold = opts.threshold ?? DEFAULT_FORGET_THRESHOLD;
  const dryRun = opts.dryRun ?? false;

  const candidates = await db.query(
    `SELECT id, fact_type, importance, access_count, last_accessed_at, created_at
     FROM memories
     WHERE is_active = TRUE
       AND fact_type <> 'profile'
       AND (validation_status IS NULL OR validation_status <> 'pending')`
  );

  const byType: Record<string, number> = {};
  let forgotten = 0;

  for (const raw of candidates.rows as any[]) {
    const row: MemoryRow = {
      id: raw.id,
      fact_type: raw.fact_type as FactType,
      importance: Number(raw.importance),
      access_count: Number(raw.access_count),
      last_accessed_at: raw.last_accessed_at ?? null,
      created_at: raw.created_at,
    };
    const score = scoreRow(row);
    if (score >= threshold) continue;

    forgotten++;
    byType[row.fact_type] = (byType[row.fact_type] ?? 0) + 1;
    if (dryRun) continue;

    await db.query(
      `UPDATE memories
       SET is_active = FALSE,
           metadata = jsonb_set(
             jsonb_set(COALESCE(metadata, '{}'::jsonb), '{forgotten_at}', to_jsonb(NOW()::text), true),
             '{forgotten_reason}',
             to_jsonb($2::text),
             true
           )
       WHERE id = $1`,
      [row.id, `decay_score=${score.toFixed(3)} threshold=${threshold}`]
    );
  }

  return {
    scanned: candidates.rows.length,
    forgotten,
    by_type: byType,
    threshold,
    dry_run: dryRun,
  };
}

// ─────────────────────────────────────────────────────────────
// Restore (kill-switch for Auto Forgetting)
// ─────────────────────────────────────────────────────────────

export interface RestoreOptions {
  memoryId?: number;
  sinceMinutes?: number;
  dryRun?: boolean;
}

export interface RestoredRow {
  id: number;
  fact_type: string;
  content: string;
  forgotten_at?: string;
}

export interface RestoreResult {
  rows: RestoredRow[];
  dry_run: boolean;
  mode: "single" | "bulk";
}

export class RestoreInputError extends Error {}

/**
 * Restore memories that were soft-deleted by Auto Forgetting.
 *
 * Eligible rows: `is_active = FALSE` AND `metadata ? 'forgotten_at'`.
 * Superseded rows (which carry `superseded_by` and no `forgotten_at`)
 * are intentionally NOT restorable — they were replaced by a newer
 * fact and reviving them would resurrect a contradiction.
 */
export async function restoreMemories(opts: RestoreOptions = {}): Promise<RestoreResult> {
  const hasId = typeof opts.memoryId === "number";
  const hasSince = typeof opts.sinceMinutes === "number";
  if (hasId === hasSince) {
    throw new RestoreInputError(
      "Provide exactly one of `memoryId` or `sinceMinutes`."
    );
  }

  const dryRun = opts.dryRun ?? false;

  const candidates = hasId
    ? await db.query(
        `SELECT id, fact_type, content, metadata
         FROM memories
         WHERE id = $1
           AND is_active = FALSE
           AND metadata ? 'forgotten_at'`,
        [opts.memoryId]
      )
    : await db.query(
        `SELECT id, fact_type, content, metadata
         FROM memories
         WHERE is_active = FALSE
           AND metadata ? 'forgotten_at'
           AND (metadata->>'forgotten_at')::timestamptz > NOW() - ($1::int || ' minutes')::interval
         ORDER BY id`,
        [Math.ceil(opts.sinceMinutes!)]
      );

  const rows: RestoredRow[] = (candidates.rows as any[]).map((r) => ({
    id: r.id,
    fact_type: r.fact_type,
    content: r.content,
    forgotten_at: r.metadata?.forgotten_at,
  }));

  if (rows.length > 0 && !dryRun) {
    const ids = rows.map((r) => r.id);
    // last_accessed_at = NOW() resets age_days to 0, buying the row at least
    // one half-life of grace before the next decay pass can target it again.
    // Without this, restore + an imminent forget pass silently re-forgets.
    await db.query(
      `UPDATE memories
       SET is_active = TRUE,
           last_accessed_at = NOW(),
           metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{restored_at}',
             to_jsonb(NOW()::text),
             true
           )
       WHERE id = ANY($1::int[])`,
      [ids]
    );
  }

  return { rows, dry_run: dryRun, mode: hasId ? "single" : "bulk" };
}

// ─────────────────────────────────────────────────────────────
// Background loop
// ─────────────────────────────────────────────────────────────

let warmupTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;
let running = false;

const DEFAULT_WARMUP_MIN = 30;
const DEFAULT_INTERVAL_MIN = 60 * 24; // 24h

function parseMinutes(raw: string | undefined, fallback: number, label: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if ((label === "interval" && parsed < 1) || (label === "warmup" && parsed < 0)) {
    console.error(`🗑️ [Forgetting] invalid ${label}=${raw}; using default ${fallback}min`);
    return fallback;
  }
  return parsed;
}

function parseThreshold(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FORGET_THRESHOLD;
  return parsed;
}

export function maybeStartForgettingLoop(): void {
  if (process.env.FORGETTING_ENABLED !== "true") {
    console.error("🗑️ [Forgetting] disabled (set FORGETTING_ENABLED=true to enable)");
    return;
  }

  if (warmupTimer || intervalTimer) return;

  const warmupMin = parseMinutes(process.env.FORGETTING_WARMUP_MIN, DEFAULT_WARMUP_MIN, "warmup");
  const intervalMin = parseMinutes(process.env.FORGETTING_INTERVAL_MIN, DEFAULT_INTERVAL_MIN, "interval");
  const threshold = parseThreshold(process.env.FORGET_THRESHOLD);

  warmupTimer = setTimeout(() => {
    warmupTimer = null;
    void tickForgettingLoop(threshold);
    intervalTimer = setInterval(() => {
      void tickForgettingLoop(threshold);
    }, intervalMin * 60 * 1000);
  }, warmupMin * 60 * 1000);

  console.error(
    `🗑️ [Forgetting] scheduled: warmup=${warmupMin}min, interval=${intervalMin}min, threshold=${threshold}`
  );
}

async function tickForgettingLoop(threshold: number): Promise<void> {
  if (running) {
    console.error("🗑️ [Forgetting] skip overlap");
    return;
  }
  running = true;
  const startedAt = Date.now();
  console.error("🗑️ [Forgetting] tick start");

  try {
    const result = await runForgettingPass({ threshold });
    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.error(
      `🗑️ [Forgetting] tick done — scanned=${result.scanned}, forgotten=${result.forgotten} (in ${durationSec}s)`
    );
  } catch (err) {
    console.error(`🗑️ [Forgetting] tick failed — ${err}`);
  } finally {
    running = false;
  }
}

export function stopForgettingLoop(): void {
  if (warmupTimer) {
    clearTimeout(warmupTimer);
    warmupTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}
