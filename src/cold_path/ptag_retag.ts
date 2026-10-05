/**
 * retag-ptag — 프로젝트 태그(p_tag)만 명부 기준으로 다시 붙인다 (DEVLOG §24 L2).
 *
 * 대상:
 *   (a) stale    정본이 명부 밖인 p_tag가 붙은 살아 있는 행 (고정 행 제외)
 *   (b) untagged 최근 N일 무태그 행 중 명부가 생기기 전 글 (고정 행 포함) — 명부 뒤 글은 이미 명부로 판정됐다
 *   둘 다 콜드패스가 이미 처리한 행(tag_processed)만. 처리 대기 행은 콜드패스가 명부로 태깅한다.
 *
 * 판정은 콜드패스와 같은 tagMessage(명부 모드)를 쓰고 p_tag만 쓴다. d_tag·본문·임베딩·tag_processed·cold_error는
 * 건드리지 않는다(원본은 그대로, 파생값만 — 2026-09-02 형 원칙). 쓰기는 행마다 따로, 읽은 뒤 바뀐 행은 안 쓴다.
 *
 * 결정은 행마다 JSONL 기록에 남는다 = 백업(옛 값) + 재개 지점(결정된 행은 다음 실행에서 건너뜀) + --rollback 근거.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { db } from "../db.js";
import { tagMessage } from "./tagger.js";
import { beginJevRun } from "./jev_judge.js";
import { REGISTRY_MEMBER_SQL, isUndefinedColumn } from "./project_registry.js";
import { promptSource } from "../prompts/index.js";
import {
  decidedIds,
  formatDuration,
  isContextOverflow,
  percentile,
  replayLog,
  rollbackPlan,
  transitionCounts,
  type LogEntry,
  type RetagMode,
  type RetagOptions,
} from "./ptag_retag_plan.js";

const MAX_CONSECUTIVE_ERRORS = 5;
const PROGRESS_EVERY_ROWS = 25;
const PROGRESS_EVERY_MS = 60_000;

const REGISTRY_IDS_SQL = `SELECT id FROM project_tags WHERE ${REGISTRY_MEMBER_SQL}`;

/** 대상을 고르는 값들 — (b) 일수·상한 시각, (c) 채널. */
type Scope = { days: number; before: string; venue: string | null };

/**
 * 대상 조건. (a)는 파라미터 없음, (b)는 $1 = 일수·$2 = 상한 시각, (c)는 $1 = 채널.
 * (c)는 명부 태그가 붙은 행도 다시 판정한다(채널 힌트 전 판정이 틀렸을 수 있다). 고정 행은 무태그일 때만 — (a)·(b)와 같은 규칙.
 */
function targetWhere(mode: RetagMode): string {
  if (mode === "stale") {
    return `m.is_active AND m.tag_processed AND NOT m.is_pinned AND m.p_tag_id IS NOT NULL
       AND canonical_project_tag_id(m.p_tag_id) NOT IN (${REGISTRY_IDS_SQL})`;
  }
  if (mode === "untagged") {
    return `m.is_active AND m.tag_processed AND m.p_tag_id IS NULL
       AND m.created_at >= NOW() - make_interval(days => $1::int) AND m.created_at < $2::timestamptz`;
  }
  return `m.is_active AND m.tag_processed AND m.venue = $1 AND (NOT m.is_pinned OR m.p_tag_id IS NULL)`;
}

function targetParams(mode: RetagMode, scope: Scope): unknown[] {
  if (mode === "stale") return [];
  if (mode === "untagged") return [scope.days, scope.before];
  return [scope.venue];
}

function defaultLogPath(): string {
  return path.join(os.homedir(), ".local", "state", "mcp-agents-memory", "ptag-retag", "decisions.jsonl");
}

function readLog(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf8").split("\n");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function appendLog(file: string, e: LogEntry): void {
  fs.appendFileSync(file, JSON.stringify(e) + "\n");
}

async function listTargetIds(mode: RetagMode, scope: Scope): Promise<number[]> {
  const r = await db.query(`SELECT m.id FROM memory m WHERE ${targetWhere(mode)} ORDER BY m.id DESC`, targetParams(mode, scope));
  return r.rows.map((row: { id: string | number }) => Number(row.id));
}

/** 시험용 고른 순서 — 두 대상을 섞어 같은 seed면 늘 같은 순서. */
function sampleKey(id: number, seed: string): string {
  return createHash("md5").update(`${id}:${seed}`).digest("hex");
}

interface TargetRow {
  id: number;
  message: string;
  role: "user" | "assistant";
  agent_platform: string;
  agent_model: string;
  venue: string | null;
  p_tag_id: number | null;
}

/** 처리 직전에 다시 읽는다 — 목록을 뽑은 뒤 콜드패스 등이 바꿨으면 더는 대상이 아니다(null). */
async function fetchTarget(mode: RetagMode, id: number, scope: Scope): Promise<TargetRow | null> {
  const params = targetParams(mode, scope);
  params.push(id);
  const r = await db.query(
    `SELECT m.id, m.message, m.role, m.agent_platform, m.agent_model, m.venue, m.p_tag_id
       FROM memory m WHERE ${targetWhere(mode)} AND m.id = $${params.length}`,
    params
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: Number(row.id),
    message: row.message,
    role: row.role,
    agent_platform: row.agent_platform,
    agent_model: row.agent_model,
    venue: row.venue ?? null,
    p_tag_id: row.p_tag_id === null ? null : Number(row.p_tag_id),
  };
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> };

/**
 * p_tag_id만 바꾼다. 읽은 값(expected)에서 그 사이 바뀌었으면 0행. updated_at은 memory_touch 트리거가 올린다.
 * q는 검사에서 트랜잭션 연결을 넘기려고 받는다.
 */
export async function writePTag(id: number, expected: number | null, next: number | null, requireActive: boolean, q: Queryable = db): Promise<boolean> {
  const r = await q.query(
    `UPDATE memory SET p_tag_id = $2 WHERE id = $1 AND p_tag_id IS NOT DISTINCT FROM $3${requireActive ? " AND is_active" : ""}`,
    [id, next, expected]
  );
  return (r.rowCount ?? 0) > 0;
}

export interface RetagReport {
  action: "count" | "dry-run" | "run" | "rollback" | "rollback-preview";
  log: string;
  registry: { members: number; since: string };
  /** 태거 안내문 출처 — 운영 배포라면 local(또는 env)이어야 한다. generic이면 결과가 운영 태깅과 다르다 */
  taggerPrompt: "env" | "local" | "generic";
  before: string;
  /** stale·untagged는 지금 조건에 맞는 행 수(이미 결정된 행 포함), queued가 이번에 실제로 할 행 수 */
  targets?: {
    stale: number | null;
    untagged: number | null;
    venue: number | null;
    overlap: number;
    alreadyDecided: number;
    queued: number;
    queuedByMode: Record<RetagMode, number>;
  };
  /** --venue일 때 그 채널에 걸린 명부 항목(채널 힌트). null이면 힌트 없이 다시 판정하는 것 */
  venueHint?: string | null;
  processed?: number;
  updated?: number;
  /** --hold-new 태그로 판정돼 쓰지 않은 행 (다음 실행 때 다시 판정) */
  held?: number;
  holdNew?: string[];
  same?: number;
  conflict?: number;
  gone?: number;
  errors?: number;
  contextOverflow?: number;
  stoppedBy?: string | null;
  elapsed?: string;
  perRowMs?: { avg: number | null; p50: number | null; p95: number | null };
  ratePerMin?: number | null;
  remaining?: number;
  etaRemaining?: string | null;
  transitions?: Array<[string, number]>;
  rollback?: { planned: number; restored: number; conflicts: number };
  malformedLogLines?: number;
}

export async function runRetag(opts: RetagOptions): Promise<RetagReport> {
  const reg = (
    await db.query(`SELECT count(*)::int AS n, min(updated_at) AS since FROM project_tags WHERE ${REGISTRY_MEMBER_SQL}`)
  ).rows[0];
  if (!reg || reg.n === 0) throw new Error("retag-ptag: 명부가 비어 있다 — 명부 모드가 아니면 다시 붙일 기준이 없다");
  const registry = { members: Number(reg.n), since: new Date(reg.since).toISOString() };
  // --hold-new: 오타로 아무것도 안 보류한 채 돌지 않게, 명부에 있는 이름인지 먼저 확인한다
  const holdIds = new Set<number>();
  if (opts.holdNew.length) {
    const h = await db.query(`SELECT id, name FROM project_tags WHERE ${REGISTRY_MEMBER_SQL} AND name = ANY($1)`, [opts.holdNew]);
    const found = new Set(h.rows.map((r: { name: string }) => r.name));
    const missing = opts.holdNew.filter((n) => !found.has(n));
    if (missing.length) throw new Error(`--hold-new: 명부 태그가 아니다 — ${missing.join(", ")}`);
    for (const r of h.rows) holdIds.add(Number(r.id));
  }
  const before = opts.before ?? registry.since;
  const days = opts.untaggedDays ?? 0;

  const logFile = opts.log ?? defaultLogPath();
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const { latest, malformed } = replayLog(readLog(logFile));
  const taggerPrompt = promptSource("tagger");
  if (taggerPrompt === "generic") {
    console.error("⚠️ [retag-ptag] 태거 안내문이 공개용 기본값이다 (prompts.local/tagger.md·MEMORY_PROMPTS_DIR 없음) — 운영 태깅과 판정이 다르다. 운영 체크아웃에서 돌리고 있는지 확인할 것.");
  }
  let venueHint: string | null | undefined;
  if (opts.venue !== null) {
    try {
      const h = await db.query(`SELECT name FROM project_tags WHERE ${REGISTRY_MEMBER_SQL} AND $1 = ANY(hint_venues)`, [opts.venue]);
      venueHint = h.rows[0]?.name ?? null;
    } catch (err) {
      if (!isUndefinedColumn(err)) throw err;
      venueHint = null;
    }
    if (venueHint === null) console.error(`⚠️ [retag-ptag] ${opts.venue}에 걸린 채널 힌트가 없다 — 힌트 없이 다시 판정한다 (register_project channels)`);
  }
  const base = { log: logFile, registry, taggerPrompt, before, venueHint, malformedLogLines: malformed || undefined };

  if (opts.rollback) {
    const plan = rollbackPlan(latest, opts.since);
    if (opts.dryRun) return { action: "rollback-preview", ...base, rollback: { planned: plan.length, restored: 0, conflicts: 0 } };
    let restored = 0;
    let conflicts = 0;
    for (const p of plan) {
      const ok = await writePTag(p.id, p.from, p.to, false);
      ok ? restored++ : conflicts++;
      appendLog(logFile, { id: p.id, mode: "rollback", old: p.from, new: p.to, result: ok ? "rolledback" : "rollback_conflict", at: new Date().toISOString() });
    }
    return { action: "rollback", ...base, rollback: { planned: plan.length, restored, conflicts } };
  }

  // 대상 목록 — (a) 먼저, (b)는 (a)에 없는 것만, (c)는 --venue일 때만. 이미 결정된 행은 뺀다(재개).
  const scope: Scope = { days, before, venue: opts.venue };
  const decided = decidedIds(latest);
  const staleIds = opts.stale ? await listTargetIds("stale", scope) : [];
  const untaggedIds = opts.untaggedDays !== null ? await listTargetIds("untagged", scope) : [];
  const venueIds = opts.venue !== null ? await listTargetIds("venue", scope) : [];
  const seen = new Set<number>();
  const queue: Array<{ id: number; mode: RetagMode }> = [];
  let overlap = 0;
  let alreadyDecided = 0;
  for (const [mode, ids] of [["stale", staleIds], ["untagged", untaggedIds], ["venue", venueIds]] as const) {
    for (const id of ids) {
      if (seen.has(id)) {
        overlap++;
        continue;
      }
      seen.add(id);
      if (decided.has(id)) {
        alreadyDecided++;
        continue;
      }
      queue.push({ id, mode });
    }
  }
  const queuedByMode: Record<RetagMode, number> = { stale: 0, untagged: 0, venue: 0 };
  for (const q of queue) queuedByMode[q.mode]++;
  if (opts.sample) queue.sort((a, b) => (sampleKey(a.id, opts.seed) < sampleKey(b.id, opts.seed) ? -1 : 1));
  const targets = {
    stale: opts.stale ? staleIds.length : null,
    untagged: opts.untaggedDays !== null ? untaggedIds.length : null,
    venue: opts.venue !== null ? venueIds.length : null,
    overlap,
    alreadyDecided,
    queued: queue.length,
    queuedByMode,
  };
  if (opts.count) return { action: "count", ...base, targets };

  const work = opts.max !== null ? queue.slice(0, opts.max) : queue;
  const names = new Map<number, string>(
    (await db.query(`SELECT id, name FROM project_tags`)).rows.map((r: { id: string; name: string }) => [Number(r.id), r.name])
  );
  const nameOf = (id: number | null) => (id === null ? null : names.get(id) ?? null);

  // 시험(dry-run) 결정은 따로 남긴다 — 재개 기록을 건드리지 않게
  const outFile = opts.dryRun
    ? path.join(path.dirname(logFile), `dryrun-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
    : logFile;

  // 대량 작업이 유료 grok으로 새지 않게: 로컬 실패는 기록하고 다음 실행 때 다시 시도
  const prevFallback = process.env.LOCAL_GROK_FALLBACK;
  if (!opts.allowFallback) process.env.LOCAL_GROK_FALLBACK = "false";
  beginJevRun();

  let stopReason: string | null = null;
  const onSignal = () => {
    if (!stopReason) {
      stopReason = "signal";
      console.error("⏸ [retag-ptag] 멈춤 요청 — 처리 중인 행까지 끝내고 기록을 남긴다");
    }
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const deadline = opts.minutes !== null ? Date.now() + opts.minutes * 60_000 : null;

  const started = Date.now();
  const durations: number[] = [];
  const entries: LogEntry[] = [];
  const c = { processed: 0, updated: 0, same: 0, conflict: 0, held: 0, gone: 0, errors: 0, overflow: 0 };
  let consecutiveErrors = 0;
  let next = 0;
  let lastProgress = Date.now();

  const progress = (force = false) => {
    if (!force && c.processed % PROGRESS_EVERY_ROWS !== 0 && Date.now() - lastProgress < PROGRESS_EVERY_MS) return;
    lastProgress = Date.now();
    const mins = (Date.now() - started) / 60_000;
    const rate = mins > 0 ? c.processed / mins : 0;
    const left = Math.max(0, work.length - c.processed - c.gone);
    console.error(
      `🔁 [retag-ptag] ${c.processed}/${work.length} · 바꿈 ${c.updated} · 그대로 ${c.same}${holdIds.size ? ` · 보류 ${c.held}` : ""} · 오류 ${c.errors} · ${rate.toFixed(1)}행/분 · 남은 ${left}행 ≈ ${rate > 0 ? formatDuration((left / rate) * 60) : "?"}`
    );
  };

  async function worker(): Promise<void> {
    while (!stopReason) {
      if (deadline !== null && Date.now() >= deadline) {
        stopReason = "minutes";
        return;
      }
      const item = work[next++];
      if (!item) return;
      const row = await fetchTarget(item.mode, item.id, scope);
      if (!row) {
        c.gone++;
        continue;
      }
      const t0 = Date.now();
      let newId: number | null;
      try {
        newId = (
          await tagMessage({ message: row.message, role: row.role, agent_platform: row.agent_platform, agent_model: row.agent_model, venue: row.venue })
        ).p_tag_id;
      } catch (err) {
        const msg = String((err as Error)?.message ?? err).slice(0, 300);
        const overflow = isContextOverflow(msg);
        c.errors++;
        if (overflow) c.overflow++;
        else consecutiveErrors++;
        const e: LogEntry = { id: row.id, mode: item.mode, old: row.p_tag_id, new: null, result: "error", at: new Date().toISOString(), err: msg };
        appendLog(outFile, e);
        c.processed++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS && !stopReason) {
          stopReason = "consecutive_errors";
          console.error(`❌ [retag-ptag] 연속 오류 ${MAX_CONSECUTIVE_ERRORS}번 — 멈춤. 마지막 오류: ${msg}`);
        }
        progress();
        continue;
      }
      consecutiveErrors = 0;
      const ms = Date.now() - t0;
      durations.push(ms);

      let result: LogEntry["result"];
      if (newId === row.p_tag_id) result = "same";
      else if (newId !== null && holdIds.has(newId)) result = "held";
      else if (opts.dryRun) result = "updated";
      else result = (await writePTag(row.id, row.p_tag_id, newId, true)) ? "updated" : "conflict";
      c[result === "updated" ? "updated" : result === "same" ? "same" : result === "held" ? "held" : "conflict"]++;
      const e: LogEntry = {
        id: row.id,
        mode: item.mode,
        old: row.p_tag_id,
        new: newId,
        result,
        at: new Date().toISOString(),
        ms,
        oldName: nameOf(row.p_tag_id),
        newName: nameOf(newId),
      };
      appendLog(outFile, e);
      entries.push(e);
      c.processed++;
      progress();
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(opts.concurrency, Math.max(1, work.length)) }, () => worker()));
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (prevFallback === undefined) delete process.env.LOCAL_GROK_FALLBACK;
    else process.env.LOCAL_GROK_FALLBACK = prevFallback;
  }
  progress(true);

  const elapsedMin = (Date.now() - started) / 60_000;
  const rate = elapsedMin > 0 ? c.processed / elapsedMin : null;
  // 시험은 아무것도 안 썼으니 전부 남는다. 오류 행은 다음 실행 때 다시 시도하므로 남은 쪽에 센다.
  const remaining = opts.dryRun ? queue.length : queue.length - (c.updated + c.same + c.conflict) - c.gone;
  return {
    action: opts.dryRun ? "dry-run" : "run",
    ...base,
    log: outFile,
    targets,
    processed: c.processed,
    updated: c.updated,
    same: c.same,
    conflict: c.conflict,
    ...(opts.holdNew.length ? { held: c.held, holdNew: opts.holdNew } : {}),
    gone: c.gone,
    errors: c.errors,
    contextOverflow: c.overflow,
    stoppedBy: stopReason,
    elapsed: formatDuration(elapsedMin * 60),
    perRowMs: {
      avg: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
    },
    ratePerMin: rate === null ? null : Math.round(rate * 10) / 10,
    remaining,
    etaRemaining: rate ? formatDuration((remaining / rate) * 60) : null,
    transitions: transitionCounts(entries),
  };
}
