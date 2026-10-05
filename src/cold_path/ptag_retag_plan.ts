/**
 * retag-ptag(DEVLOG §24 L2)의 판단만 하는 부분 — DB 없음(검사 스크립트가 바로 부른다).
 *
 * 기록 파일(JSONL)은 백업이자 재개 지점이다: 한 줄 = 한 행의 결정(옛 p_tag → 새 p_tag).
 * 같은 행이 여러 번 나오면 마지막 줄이 이긴다.
 */

export type RetagMode = "stale" | "untagged" | "venue";

export interface RetagOptions {
  /** 대상 (a): 정본이 명부 밖인 p_tag가 붙은 행 */
  stale: boolean;
  /** 대상 (b): 최근 N일 무태그 행. null이면 (b)를 안 함 */
  untaggedDays: number | null;
  /** (b)의 상한 시각(ISO). null이면 명부가 생긴 시각(명부 항목의 가장 이른 updated_at) — 그 뒤 글은 이미 명부로 판정됐다 */
  before: string | null;
  /** (c) 한 채널(venue)의 글 전부를 다시 판정 — 채널 힌트(§24 L3)를 건 뒤 그 채널의 지난 글을 바로잡을 때. 주면 (a)(b)는 안 한다 */
  venue: string | null;
  count: boolean;
  dryRun: boolean;
  rollback: boolean;
  max: number | null;
  minutes: number | null;
  concurrency: number;
  /** 최신순 대신 고르게 섞어서 뽑는다(시험용). 같은 seed면 같은 순서 */
  sample: boolean;
  seed: string;
  log: string | null;
  /** 로컬 모델이 실패하면 grok으로 넘어가도 되는지 (기본: 안 됨 — 실패한 행은 기록만 하고 다음 실행 때 다시 시도) */
  allowFallback: boolean;
}

export const DEFAULT_UNTAGGED_DAYS = 30;
export const MAX_CONCURRENCY = 4;

function intArg(name: string, v: string | undefined, min: number): number {
  if (v === undefined || !/^\d+$/.test(v) || Number(v) < min) throw new Error(`${name}: ${min} 이상의 정수`);
  return Number(v);
}

export function parseRetagArgs(argv: string[]): RetagOptions {
  const o: RetagOptions = {
    stale: true,
    untaggedDays: DEFAULT_UNTAGGED_DAYS,
    before: null,
    venue: null,
    count: false,
    dryRun: false,
    rollback: false,
    max: null,
    minutes: null,
    concurrency: 1,
    sample: false,
    seed: "ptag-retag",
    log: null,
    allowFallback: false,
  };
  let only: RetagMode | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--count") o.count = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--rollback") o.rollback = true;
    else if (a === "--sample") o.sample = true;
    else if (a === "--allow-fallback") o.allowFallback = true;
    else if (a === "--only") {
      const v = argv[++i];
      if (v !== "stale" && v !== "untagged") throw new Error("--only: stale 또는 untagged");
      only = v;
    } else if (a === "--untagged-days") o.untaggedDays = intArg(a, argv[++i], 1);
    else if (a === "--venue") {
      const v = argv[++i];
      if (!v || !/^[a-z]+(:\S+)?$/.test(v)) throw new Error("--venue: 글이 온 자리 (예: buzz:MDs_copy_db)");
      o.venue = v;
    }
    else if (a === "--before") {
      const v = argv[++i];
      if (v === undefined || Number.isNaN(Date.parse(v))) throw new Error("--before: ISO 시각 (예: 2026-10-04T15:28:12+09:00)");
      o.before = new Date(v).toISOString();
    } else if (a === "--max") o.max = intArg(a, argv[++i], 1);
    else if (a === "--minutes") o.minutes = intArg(a, argv[++i], 1);
    else if (a === "--concurrency") {
      o.concurrency = intArg(a, argv[++i], 1);
      if (o.concurrency > MAX_CONCURRENCY) throw new Error(`--concurrency: 1~${MAX_CONCURRENCY}`);
    } else if (a === "--seed") {
      const v = argv[++i];
      if (!v) throw new Error("--seed: 값 필요");
      o.seed = v;
    } else if (a === "--log") {
      const v = argv[++i];
      if (!v) throw new Error("--log: 파일 경로 필요");
      o.log = v;
    } else throw new Error(`retag-ptag: 모르는 옵션 ${a}`);
  }
  if (o.venue !== null) {
    if (only !== null) throw new Error("--venue와 --only는 같이 못 씀 (--venue는 그 채널 글만 다시 판정한다)");
    o.stale = false;
    o.untaggedDays = null;
  }
  if (only === "stale") o.untaggedDays = null;
  if (only === "untagged") o.stale = false;
  if (o.count && o.rollback) throw new Error("--count와 --rollback은 같이 못 씀");
  if (o.rollback && (o.sample || o.max !== null)) throw new Error("--rollback은 기록 전체를 되돌린다 (--sample·--max 못 씀)");
  return o;
}

export type LogResult =
  | "updated" // p_tag를 바꿨다
  | "same" // 판정이 지금 값과 같다 (무태그 → 여전히 무태그 등)
  | "conflict" // 읽은 뒤 다른 곳에서 p_tag가 바뀌어 안 썼다
  | "error" // 태거 실패 — 다음 실행 때 다시 시도
  | "rolledback" // --rollback으로 옛 값으로 되돌렸다
  | "rollback_conflict"; // 되돌리려는데 그 사이 p_tag가 또 바뀌어 안 건드렸다

export interface LogEntry {
  id: number;
  mode: RetagMode | "rollback";
  old: number | null;
  new: number | null;
  result: LogResult;
  at: string;
  ms?: number;
  oldName?: string | null;
  newName?: string | null;
  err?: string;
}

/** 이미 결정된 것으로 보고 다음 실행에서 건너뛰는 결과. error·rolledback은 다시 시도한다. */
const DECIDED: ReadonlySet<LogResult> = new Set<LogResult>(["updated", "same", "conflict", "rollback_conflict"]);

export function replayLog(lines: Iterable<string>): { latest: Map<number, LogEntry>; malformed: number } {
  const latest = new Map<number, LogEntry>();
  let malformed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LogEntry;
      if (!Number.isSafeInteger(e?.id) || typeof e?.result !== "string") {
        malformed++;
        continue;
      }
      latest.set(e.id, e);
    } catch {
      malformed++;
    }
  }
  return { latest, malformed };
}

export function decidedIds(latest: ReadonlyMap<number, LogEntry>): Set<number> {
  const out = new Set<number>();
  for (const [id, e] of latest) if (DECIDED.has(e.result)) out.add(id);
  return out;
}

/** 되돌리기: 마지막 결정이 updated인 행만, new → old. */
export function rollbackPlan(latest: ReadonlyMap<number, LogEntry>): Array<{ id: number; from: number | null; to: number | null }> {
  const out: Array<{ id: number; from: number | null; to: number | null }> = [];
  for (const e of latest.values()) if (e.result === "updated") out.push({ id: e.id, from: e.new, to: e.old });
  return out.sort((a, b) => a.id - b.id);
}

/** "옛 → 새" 이름별 건수, 많은 순. 이름이 없으면 id, 무태그는 (none). */
export function transitionCounts(entries: Iterable<LogEntry>, top = 15): Array<[string, number]> {
  const label = (name: string | null | undefined, id: number | null) => (id === null ? "(none)" : name ?? `#${id}`);
  const m = new Map<string, number>();
  for (const e of entries) {
    if (e.result !== "updated" && e.result !== "same") continue;
    const k = `${label(e.oldName, e.old)} → ${label(e.newName, e.new)}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top);
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "?";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** llama.cpp가 입력이 문맥 크기를 넘어 거절한 것 — 서버 고장이 아니라 그 행만의 문제라 연속 오류로 안 센다. */
export function isContextOverflow(message: string): boolean {
  return /exceed[s]? (the )?(available )?context|context (size|length|window)|too many tokens|maximum context/i.test(message);
}
