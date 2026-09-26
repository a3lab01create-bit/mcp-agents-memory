/**
 * OpenCode (v2+, anomalyco/opencode) 자동 캡처 — RESPEC §5 cross-platform passive capture.
 *
 * OpenCode transcript: <data>/opencode/opencode.db (SQLite, WAL), `session_message` 테이블.
 *   <data> = $XDG_DATA_HOME 또는 ~/.local/share (Windows도 같은 경로 — v2.0.18 실측).
 *   $OPENCODE_DB가 있으면 우선 (상대경로는 OpenCode처럼 data dir 기준, ":memory:"면 no-op).
 *
 * Hermes와 같은 SQLite read-only 폴링 패턴이지만 차이:
 *   - 행 id가 TEXT(`msg_…`)고 seq는 세션별 → 정수 커서 불가.
 *     `time_created` 색인으로 **최근 LOOKBACK_MS 창**만 읽고, 창 안에서 처리한 id는 done 맵으로 거름.
 *     (time_updated엔 색인이 없어 매 poll 전체 스캔이 됨. 또 OpenCode는 time 값을 JS에서 찍고
 *      busy_timeout 5s까지 커밋이 늦을 수 있어, 단조 커서는 늦게 커밋된 행을 영구히 놓친다.)
 *   - assistant 행은 스트리밍 중 계속 UPDATE됨 → `data.time.completed` 있는 행만 저장.
 *     미완성 행을 넣으면 external_uuid dedup이 반쪽 텍스트를 영구 고정하므로 pending 맵에 두고
 *     완료될 때까지 PK로 재조회한다 (긴 step은 LOOKBACK 창 밖으로 나가도 계속 추적).
 *   - user: data.text / assistant: data.content[] 중 type="text"만
 *     (reasoning·tool은 protocol noise라 skip, text 없는 tool-only step은 행 자체 skip).
 *   - type="idle"·"model-switched"·"synthetic" 등 그 외 행 skip — memory.role CHECK는 user/assistant만.
 *   - 하위 세션(session_v2.parent_id 있음 = 서브에이전트 task)은 skip.
 *     Claude Code jsonl capture도 메인 대화 transcript만 받는다. (서브에이전트의 save_message도
 *     같은 "cli" 연결이라 gate에 막힘 — 메인 대화만 남기는 의도된 동작.)
 *   - insert 실패 행은 pending에 넣어 재시도하되 뒤 행들은 계속 처리 (Hermes처럼 한 행이 전체를
 *     막지 않게). 데이터 자체 오류(pg SQLSTATE 22/23)만 MAX_ROW_ATTEMPTS회 후 포기 — 연결 끊김 등
 *     일시 오류는 횟수에 안 넣고 계속 재시도 (DB 재시작 동안의 대화를 버리지 않게).
 *   - fork된 세션은 원본 행을 새 id로 복사하되 time_created는 원본 값 유지 → 세션 생성 시각보다
 *     이른 행은 복사본이라 skip (중복 저장 방지).
 *   - external_uuid = `opencode:<msg id>` (dedup — 같은 기기의 MCP 서버 여러 개가 함께 폴링해도 안전).
 *
 * 스키마 게이트: OpenCode v1.18.x도 같은 opencode.db에 session_message를 두지만 session_v2가 없다.
 * arm 시 session_v2 존재 + 실제 폴링 쿼리 성공을 확인하고, 아니면 arm하지 않는다 → instructions에
 * OpenCode가 안 올라가 모델이 save_message를 계속 부름. flush의 연속 실패도 disarm으로 이어짐.
 *
 * clientInfo: OpenCode는 MCP clientInfo를 {name: $OPENCODE_CLIENT ?? "cli", version: <opencode 버전>}
 * 으로 보낸다 (v2.0.18 바이너리 실측, acp 모드는 "acp"). "cli"는 흔한 이름이라 이름만으론 판별 불가 →
 * opencode.db `session_v2.version`에 있는 버전과 일치할 때만 OpenCode로 인정 (isOpencodeClientInfo).
 *
 * Option A (live-from-now): arm 시점 창 안의 행은 처리 완료로 표시 → 과거 backfill 안 함
 * (단 창 안에서 스트리밍 중인 답변은 pending으로 받아 완료 시 저장. 창보다 먼저 시작된 step은 안 받음).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { insertRawMemory } from "../hot_path.js";
import { getDefaultUserId } from "../users.js";

const DEVICE_NAME = os.hostname();
const AGENT_PLATFORM = "opencode";
const POLL_INTERVAL_MS = 3000;
/** 늦은 커밋(busy_timeout 5s)·시계 흔들림 여유. 이 창 안의 행을 매 poll 재조회. */
const LOOKBACK_MS = 30_000;
/** 이보다 오래 미완성인 pending은 버림 (중단돼 영영 completed 안 찍힌 행). */
const PENDING_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_ROW_ATTEMPTS = 5;
/** open/query 연속 실패 임계 — 넘으면 disarm → save_message fallback 복귀. */
const MAX_CONSECUTIVE_FAILURES = 5;
/** OpenCode가 clientInfo.name으로 보내는 값들 ($OPENCODE_CLIENT ?? "cli", acp 모드 "acp"). */
const OPENCODE_CLIENT_NAMES = new Set(["cli", "acp"]);
/** v2+만 session_v2에 기록 → capture 대상. v1 세션도 마이그레이션되며 버전이 복사되므로 대조에서 제외. */
const V2_VERSION_RE = /^([2-9]|\d{2,})\./;

function resolveDbPath(): string | null {
  const dataDir = path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    "opencode"
  );
  const override = process.env.OPENCODE_DB;
  if (override) {
    if (override === ":memory:") return null;
    return path.isAbsolute(override) ? override : path.join(dataDir, override);
  }
  return path.join(dataDir, "opencode.db");
}

// node:sqlite DatabaseSync 클래스 (lazy load). 없으면 null → capture no-op.
let _DatabaseSync: any | null = null;
let _sqliteUnavailable = false;
async function loadSqlite(): Promise<any | null> {
  if (_DatabaseSync) return _DatabaseSync;
  if (_sqliteUnavailable) return null;
  try {
    // node:sqlite는 Node 22.13+/23.4+ 빌트인 (그 전엔 플래그 필요). @types/node(node20 타겟)엔 타입이 없어 억제.
    // @ts-ignore
    const mod: any = await import("node:sqlite");
    _DatabaseSync = mod?.DatabaseSync ?? null;
    if (!_DatabaseSync) _sqliteUnavailable = true;
    return _DatabaseSync;
  } catch {
    _sqliteUnavailable = true; // 구버전 node 등
    return null;
  }
}

/** processBatch가 갱신하는 추적 상태. */
export interface Tracker {
  /** 지금까지 본 최대 time_created. 조회 하한 = createdCursor - LOOKBACK_MS. */
  createdCursor: number;
  /** LOOKBACK 창 안에서 처리 완료한 id → time_created (창 밖은 prune). */
  done: Map<string, number>;
  /** 미완성 assistant·insert 실패 행 id → time_created. 창과 무관하게 PK로 재조회. */
  pending: Map<string, number>;
  /** 행별 insert 실패 횟수. */
  failures: Map<string, number>;
}

interface CaptureState extends Tracker {
  dbPath: string;
  /** session_v2.version DISTINCT — clientInfo "cli"가 OpenCode인지 대조용. */
  knownVersions: Set<string>;
}

let _state: CaptureState | null = null;
let _pollTimer: NodeJS.Timeout | null = null;
let _flushInProgress = false;
let _consecutiveFailures = 0;

function openRo(DatabaseSync: any, dbPath: string): any | null {
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

export interface RawRow {
  id: string;
  type: string;
  time_created: number;
  data: string;
  parent_id: string | null;
  /** fork 세션이면 fork 원본 세션 id (session_v2.fork_session_id). */
  fork_session_id?: string | null;
  /** session_v2.time_created — fork 복사본 판별용. */
  session_created?: number | null;
}

const ROW_COLUMNS = `m.id, m.type, m.time_created, m.data, s.parent_id,
         s.fork_session_id, s.time_created AS session_created
         FROM session_message m
         LEFT JOIN session_v2 s ON s.id = m.session_id`;

function toRawRow(r: any): RawRow {
  return {
    id: String(r.id),
    type: String(r.type),
    time_created: Number(r.time_created),
    data: String(r.data ?? ""),
    parent_id: r.parent_id == null ? null : String(r.parent_id),
    fork_session_id: r.fork_session_id == null ? null : String(r.fork_session_id),
    session_created: r.session_created == null ? null : Number(r.session_created),
  };
}

/** 조회 창 하한. 미래 시각 행 하나가 창을 미래로 밀어 새 행을 놓치지 않게 현재 시각으로 clamp. */
function windowFloor(t: { createdCursor: number }): number {
  return Math.min(t.createdCursor, Date.now()) - LOOKBACK_MS;
}

/**
 * 폴링 대상 행: time_created >= floor (색인 range scan) ∪ pending id들 (PK 조회).
 * time_created·id 순. 스키마가 안 맞으면 throw (호출부가 arm 거부/실패 카운트).
 */
export function selectCandidates(db: any, floor: number, pendingIds: Iterable<string> = []): RawRow[] {
  const byId = new Map<string, RawRow>();
  const recent = db
    .prepare(`SELECT ${ROW_COLUMNS} WHERE m.time_created >= ? ORDER BY m.time_created ASC, m.id ASC`)
    .all(floor) as any[];
  for (const r of recent) byId.set(String(r.id), toRawRow(r));
  const one = db.prepare(`SELECT ${ROW_COLUMNS} WHERE m.id = ?`);
  for (const id of pendingIds) {
    if (byId.has(id)) continue;
    const r = one.get(id);
    if (r) byId.set(id, toRawRow(r));
  }
  return [...byId.values()].sort(
    (a, b) => a.time_created - b.time_created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export type Classified =
  | { kind: "skip" }
  | { kind: "pending" }
  | { kind: "row"; role: "user" | "assistant"; message: string; model: string | null };

/** Postgres TEXT는 NUL(0x00)을 거부 → insert가 영구 실패하지 않도록 제거. */
function clean(text: string): string {
  return text.replace(/\u0000/g, "").trim();
}

/**
 * session_message 행 1개 → 저장 여부 판정. 순수 함수 (fixture로 단위테스트 가능).
 *   - skip: 저장 안 함, 처리 완료로 간주 (idle·하위 세션·빈 텍스트·파싱 실패)
 *   - pending: 스트리밍 중인 assistant — 완료될 때까지 재조회
 *   - row: 저장 대상
 */
export function classifyRow(r: RawRow): Classified {
  if (r.parent_id) return { kind: "skip" };
  // fork 복사본: 원본 time_created 유지 → fork 세션 생성보다 이르다 (원본 세션에서 이미 저장됨)
  if (r.fork_session_id && r.session_created != null && r.time_created < r.session_created) {
    return { kind: "skip" };
  }
  if (r.type !== "user" && r.type !== "assistant") return { kind: "skip" };

  let data: any;
  try {
    data = JSON.parse(r.data);
  } catch {
    return { kind: "skip" };
  }

  if (r.type === "user") {
    const message = typeof data?.text === "string" ? clean(data.text) : "";
    return message ? { kind: "row", role: "user", message, model: null } : { kind: "skip" };
  }

  if (!data?.time?.completed) return { kind: "pending" };
  const texts: string[] = [];
  for (const part of Array.isArray(data.content) ? data.content : []) {
    if (part && part.type === "text" && typeof part.text === "string") texts.push(part.text);
  }
  const message = clean(texts.join("\n"));
  if (!message) return { kind: "skip" }; // reasoning/tool-only step
  const model = typeof data.model?.id === "string" ? data.model.id : null;
  return { kind: "row", role: "assistant", message, model };
}

export interface BatchResult {
  inserted: number;
  dedup: number;
  failed: number;
  gaveUp: number;
}

/**
 * selectCandidates 결과를 처리하고 Tracker를 갱신. insert는 주입 (true=신규, false=dedup).
 *   - done에 있는 행 → 건너뜀
 *   - pending(스트리밍 중) → pending 맵에 두고 다음 poll에 PK 재조회
 *   - insert 실패 → pending에 넣어 재시도, 뒤 행은 계속 처리. MAX_ROW_ATTEMPTS회면 포기(done)
 */
export async function processBatch(
  raw: RawRow[],
  t: Tracker,
  insert: (row: RawRow, c: Extract<Classified, { kind: "row" }>) => Promise<boolean>
): Promise<BatchResult> {
  let inserted = 0;
  let dedup = 0;
  let failed = 0;
  let gaveUp = 0;
  const markDone = (r: RawRow) => {
    t.done.set(r.id, r.time_created);
    t.pending.delete(r.id);
    t.failures.delete(r.id);
  };

  for (const r of raw) {
    if (r.time_created > t.createdCursor) t.createdCursor = r.time_created;
    if (t.done.has(r.id)) continue;
    const c = classifyRow(r);
    if (c.kind === "pending") {
      t.pending.set(r.id, r.time_created);
      continue;
    }
    if (c.kind === "skip") {
      markDone(r);
      continue;
    }
    try {
      if (await insert(r, c)) inserted++;
      else dedup++;
      markDone(r);
    } catch (err) {
      t.pending.set(r.id, r.time_created); // 창과 무관하게 PK로 재시도
      failed++;
      if (!isDataError(err)) continue; // 연결 끊김 등 일시 오류 → 횟수 안 셈, 계속 재시도
      const attempts = (t.failures.get(r.id) ?? 0) + 1;
      if (attempts >= MAX_ROW_ATTEMPTS) {
        console.error(
          `⚠️ [OpenCode] insert ${attempts}회 실패 — ${r.id} 포기:`,
          err instanceof Error ? err.message : err
        );
        markDone(r);
        failed--;
        gaveUp++;
      } else {
        t.failures.set(r.id, attempts);
      }
    }
  }

  // 창 밖 done은 다시 조회될 일이 없으니 정리. 오래된 pending(중단된 step)도 정리.
  const floor = windowFloor(t);
  for (const [id, tc] of t.done) if (tc < floor) t.done.delete(id);
  for (const [id, tc] of t.pending) {
    if (tc < t.createdCursor - PENDING_MAX_AGE_MS) {
      t.pending.delete(id);
      t.failures.delete(id);
    }
  }
  return { inserted, dedup, failed, gaveUp };
}

/** pg 데이터 오류(SQLSTATE class 22 data exception / 23 integrity violation)만 true.
 *  이 행은 재시도해도 영원히 실패 → 포기 대상. 그 외(연결·타임아웃·code 없음)는 일시 오류. */
function isDataError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^(22|23)/.test(code);
}

function loadKnownVersions(db: any): Set<string> {
  const rows = db.prepare(`SELECT DISTINCT version FROM session_v2`).all() as Array<{ version: unknown }>;
  return new Set(rows.map((r) => String(r.version)).filter(Boolean));
}

function hasV2Schema(db: any): boolean {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_message', 'session_v2')`
    )
    .all() as Array<{ name: string }>;
  return rows.length === 2;
}

/** save_message tool이 중복 저장 방지 여부 판단에 사용. */
export function isCaptureArmed(): boolean {
  return _state !== null;
}

/**
 * MCP clientInfo가 OpenCode인지. name "opencode"는 그대로 인정, "cli"/"acp"는 이 기기
 * opencode.db에 기록된 OpenCode 버전과 clientInfo.version이 일치할 때만 (capture armed 전제).
 */
export function isOpencodeClientInfo(name?: string | null, version?: string | null): boolean {
  if (!name) return false;
  if (name.toLowerCase() === "opencode") return true;
  if (!_state || !version || !V2_VERSION_RE.test(version)) return false;
  return OPENCODE_CLIENT_NAMES.has(name) && _state.knownVersions.has(version);
}

export async function captureSessionStart(_cwd: string): Promise<void> {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  _state = null;
  _consecutiveFailures = 0;
  const dbPath = resolveDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) return; // OpenCode 미설치 기기 → no-op

  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) {
    console.error(
      "📝 [OpenCode] node:sqlite 미지원 (Node < 22.13?) — capture 비활성, save_message fallback"
    );
    return;
  }

  const db = openRo(DatabaseSync, dbPath);
  if (!db) {
    console.error("📝 [OpenCode] opencode.db 열기 실패 — capture 비활성");
    return;
  }

  let state: CaptureState;
  try {
    if (!hasV2Schema(db)) {
      console.error("📝 [OpenCode] session_v2 스키마 아님 (OpenCode v1?) — capture 비활성, save_message fallback");
      return;
    }
    const row = db
      .prepare(`SELECT COALESCE(MAX(time_created), 0) AS m FROM session_message`)
      .get() as { m: number };
    const createdCursor = Number(row?.m ?? 0);
    state = {
      dbPath,
      createdCursor,
      done: new Map(),
      pending: new Map(),
      failures: new Map(),
      knownVersions: loadKnownVersions(db),
    };
    // 실제 폴링 쿼리를 한 번 돌려 스키마 호환 확인 (실패 시 arm 거부) + live-from-now 기준선:
    // 창 안의 기존 행은 처리 완료, 스트리밍 중 답변만 pending으로.
    for (const r of selectCandidates(db, windowFloor(state))) {
      if (classifyRow(r).kind === "pending") state.pending.set(r.id, r.time_created);
      else state.done.set(r.id, r.time_created);
    }
  } catch (err) {
    console.error(
      "📝 [OpenCode] opencode.db 조회 실패 — capture 비활성:",
      err instanceof Error ? err.message : err
    );
    return;
  } finally {
    try { db.close(); } catch {}
  }

  _state = state;
  console.error(
    `📝 [OpenCode] capture armed: cursor=${state.createdCursor} versions=[${[...state.knownVersions].join(",")}] (live-from-now)`
  );

  _pollTimer = setInterval(() => {
    void flush();
  }, POLL_INTERVAL_MS);
}

/** open/query 실패 1회 기록. 연속 임계 도달 시 disarm — 안 그러면 isCaptureArmed()=true로
 *  save_message gate가 fallback까지 막아 silent total loss가 됨 (Hermes와 동일).
 *  단 instructions는 시작 시점에 고정이라 "OpenCode 자동 저장" 문구는 남는다 (Hermes와 같은 한계). */
function recordFailure(what: string, err?: unknown): void {
  _consecutiveFailures++;
  if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    console.error(
      `📝 [OpenCode] ${what} ${_consecutiveFailures}회 연속 실패 — capture 비활성(save_message fallback 복귀):`,
      err instanceof Error ? err.message : err ?? ""
    );
    resetCaptureState();
  }
}

async function flush(): Promise<BatchResult> {
  const empty: BatchResult = { inserted: 0, dedup: 0, failed: 0, gaveUp: 0 };
  if (!_state || _flushInProgress) return empty;
  _flushInProgress = true;

  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) {
    _flushInProgress = false;
    return empty;
  }
  const state = _state;
  const db = openRo(DatabaseSync, state.dbPath);
  if (!db) {
    recordFailure("openRo");
    _flushInProgress = false;
    return empty;
  }

  let result = empty;
  try {
    let raw: RawRow[];
    try {
      state.knownVersions = loadKnownVersions(db);
      raw = selectCandidates(db, windowFloor(state), state.pending.keys());
      _consecutiveFailures = 0;
    } catch (err) {
      recordFailure("query", err);
      return empty;
    }
    let userId: number | null = null;
    result = await processBatch(raw, state, async (row, c) => {
      userId ??= await getDefaultUserId();
      const res = await insertRawMemory({
        user_id: userId,
        agent_platform: AGENT_PLATFORM,
        agent_model: c.role === "user" ? null : c.model ?? "unknown",
        role: c.role,
        message: c.message,
        external_uuid: `opencode:${row.id}`,
        device_name: DEVICE_NAME,
      });
      return res.inserted;
    });
  } catch (err) {
    console.error(
      "⚠️ [OpenCode] flush error:",
      err instanceof Error ? err.message : err
    );
  } finally {
    try { db.close(); } catch {}
    _flushInProgress = false;
  }

  const { inserted, dedup, failed, gaveUp } = result;
  if (inserted || dedup || failed || gaveUp) {
    console.error(
      `📝 [OpenCode] flush: inserted=${inserted}, dedup=${dedup}, failed=${failed}, gaveUp=${gaveUp}, pending=${state.pending.size}`
    );
  }
  return result;
}

export async function captureSessionEnd(): Promise<{
  inserted: number;
  skipped: number;
  error?: string;
}> {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }

  const waitStart = Date.now();
  while (_flushInProgress && Date.now() - waitStart < 2000) {
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!_state) return { inserted: 0, skipped: 0, error: "session not armed" };

  const r = await flush();
  if (r.inserted || r.failed || r.gaveUp) {
    console.error(
      `📝 [OpenCode] final flush: inserted=${r.inserted}, dedup=${r.dedup}, failed=${r.failed}, gaveUp=${r.gaveUp}`
    );
  }
  return { inserted: r.inserted, skipped: r.failed + r.gaveUp };
}

export function resetCaptureState(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  _state = null;
  _flushInProgress = false;
}
