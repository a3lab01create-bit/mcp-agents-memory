/**
 * OpenCode (v2+, anomalyco/opencode) 자동 캡처 — RESPEC §5 cross-platform passive capture.
 *
 * OpenCode transcript: <data>/opencode/opencode.db (SQLite, WAL), `session_message` 테이블.
 *   <data> = $XDG_DATA_HOME 또는 ~/.local/share (Windows도 같은 경로 — v2.0.18 실측).
 *   $OPENCODE_DB가 경로면 그걸 우선 (":memory:"면 디스크 transcript 없음 → no-op).
 *
 * Hermes와 같은 SQLite read-only 폴링 패턴이지만 차이:
 *   - 행 id가 TEXT(`msg_…`)고 seq는 세션별 → 정수 커서 불가, `time_updated`(ms) 커서.
 *     같은 ms 경계는 `>=` 재조회 + seenAtCursor(그 시각에 이미 처리한 id)로 걸러냄.
 *   - assistant 행은 스트리밍 중 계속 UPDATE됨 → `data.time.completed` 있는 행만 저장.
 *     미완성 행을 넣으면 external_uuid dedup이 반쪽 텍스트를 영구 고정하므로 건너뛰고,
 *     완료 시 time_updated가 커서 너머로 올라가 다음 poll에 자연히 잡힌다.
 *   - user: data.text / assistant: data.content[] 중 type="text"만
 *     (reasoning·tool은 protocol noise라 skip, text 없는 tool-only step은 행 자체 skip).
 *   - type="idle" 등 그 외 행 skip — memory.role CHECK는 user/assistant만 허용.
 *   - 하위 세션(session_v2.parent_id 있음 = 서브에이전트 task)은 skip.
 *     Claude Code jsonl capture도 메인 대화 transcript만 받는다.
 *   - model: assistant data.model.id.
 *   - external_uuid = `opencode:<msg id>` (dedup — 같은 기기의 MCP 서버 여러 개가 함께 폴링해도 안전).
 *
 * clientInfo: OpenCode는 MCP clientInfo를 {name: $OPENCODE_CLIENT ?? "cli", version: <opencode 버전>}
 * 으로 보낸다 (v2.0.18 바이너리 실측, acp 모드는 "acp"). "cli"는 흔한 이름이라 이름만으론 판별 불가 →
 * opencode.db `session_v2.version`에 있는 버전과 일치할 때만 OpenCode로 인정 (isOpencodeClientInfo).
 *
 * Option A (live-from-now): arm 시점 max(time_updated)를 커서 초기값으로 → 과거 backfill 안 함.
 * OpenCode v1(JSON 파일 storage)이나 session_message 테이블 없는 DB는 graceful no-op → save_message fallback.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { insertRawMemory } from "../hot_path.js";
import { getDefaultUserId } from "../users.js";

const DEVICE_NAME = os.hostname();
const AGENT_PLATFORM = "opencode";
const POLL_INTERVAL_MS = 3000;
/** OpenCode가 clientInfo.name으로 보내는 값들 ($OPENCODE_CLIENT ?? "cli", acp 모드 "acp"). */
const OPENCODE_CLIENT_NAMES = new Set(["cli", "acp"]);

function resolveDbPath(): string | null {
  const override = process.env.OPENCODE_DB;
  if (override) return override === ":memory:" ? null : override;
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "opencode.db");
}

// node:sqlite DatabaseSync 클래스 (lazy load). 없으면 null → capture no-op.
let _DatabaseSync: any | null = null;
let _sqliteUnavailable = false;
async function loadSqlite(): Promise<any | null> {
  if (_DatabaseSync) return _DatabaseSync;
  if (_sqliteUnavailable) return null;
  try {
    // node:sqlite는 Node 22.5+ 빌트인. @types/node(node20 타겟)엔 타입이 없어 억제.
    // @ts-ignore
    const mod: any = await import("node:sqlite");
    _DatabaseSync = mod?.DatabaseSync ?? null;
    if (!_DatabaseSync) _sqliteUnavailable = true;
    return _DatabaseSync;
  } catch {
    _sqliteUnavailable = true; // Node < 22.5 등
    return null;
  }
}

interface CaptureState {
  dbPath: string;
  /** 마지막으로 처리 완료한 time_updated (ms). */
  cursor: number;
  /** time_updated === cursor 인 행 중 이미 처리한 id. `>=` 재조회 시 중복 insert 방지. */
  seenAtCursor: Set<string>;
  /** session_v2.version DISTINCT — clientInfo "cli"가 OpenCode인지 대조용. */
  knownVersions: Set<string>;
}

let _state: CaptureState | null = null;
let _pollTimer: NodeJS.Timeout | null = null;
let _flushInProgress = false;
/** openRo 연속 실패 횟수. 임계 도달 시 disarm → save_message fallback 복귀. */
let _consecutiveOpenFailures = 0;
const MAX_OPEN_FAILURES = 5;

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
  time_updated: number;
  data: string;
  parent_id: string | null;
}

/** time_updated >= cursor 인 행을 시간순으로. 하위 세션 판별용 parent_id 동봉. */
export function selectRowsSince(db: any, cursor: number): RawRow[] {
  return db
    .prepare(
      `SELECT m.id, m.type, m.time_updated, m.data, s.parent_id
         FROM session_message m
         LEFT JOIN session_v2 s ON s.id = m.session_id
        WHERE m.time_updated >= ?
        ORDER BY m.time_updated ASC, m.id ASC`
    )
    .all(cursor)
    .map((r: any) => ({
      id: String(r.id),
      type: String(r.type),
      time_updated: Number(r.time_updated),
      data: String(r.data ?? ""),
      parent_id: r.parent_id == null ? null : String(r.parent_id),
    }));
}

export type Classified =
  | { kind: "skip" }
  | { kind: "pending" }
  | { kind: "row"; role: "user" | "assistant"; message: string; model: string | null };

/**
 * session_message 행 1개 → 저장 여부 판정. 순수 함수 (fixture로 단위테스트 가능).
 *   - skip: 저장 안 함, 처리 완료로 간주 (idle·하위 세션·빈 텍스트·파싱 실패)
 *   - pending: 스트리밍 중인 assistant — 처리 완료로 치지 않음 (완료 후 재조회)
 *   - row: 저장 대상
 */
export function classifyRow(r: RawRow): Classified {
  if (r.parent_id) return { kind: "skip" };
  if (r.type !== "user" && r.type !== "assistant") return { kind: "skip" };

  let data: any;
  try {
    data = JSON.parse(r.data);
  } catch {
    return { kind: "skip" };
  }

  if (r.type === "user") {
    const message = typeof data?.text === "string" ? data.text.trim() : "";
    return message ? { kind: "row", role: "user", message, model: null } : { kind: "skip" };
  }

  if (!data?.time?.completed) return { kind: "pending" };
  let message = "";
  for (const part of Array.isArray(data.content) ? data.content : []) {
    if (part && part.type === "text" && typeof part.text === "string") {
      message += (message ? "\n" : "") + part.text;
    }
  }
  message = message.trim();
  if (!message) return { kind: "skip" }; // reasoning/tool-only step
  const model = typeof data.model?.id === "string" ? data.model.id : null;
  return { kind: "row", role: "assistant", message, model };
}

export interface BatchResult {
  cursor: number;
  seenAtCursor: Set<string>;
  inserted: number;
  dedup: number;
  skipped: number;
}

/**
 * selectRowsSince 결과를 시간순 처리하고 다음 커서를 계산. insert는 주입 (true=신규, false=dedup).
 *   - 이미 처리한 경계 행(time_updated === cursor && seen) → 건너뜀
 *   - pending(스트리밍 중) → 처리 완료로 치지 않음. 완료되면 time_updated가 올라가 다시 잡힘
 *   - insert 실패 → 그 행 앞에서 멈춤 (다음 poll에 그 행부터 재시도)
 */
export async function processBatch(
  raw: RawRow[],
  cursor: number,
  seenAtCursor: Set<string>,
  insert: (row: RawRow, c: Extract<Classified, { kind: "row" }>) => Promise<boolean>
): Promise<BatchResult> {
  let nextCursor = cursor;
  let seen = new Set(seenAtCursor);
  let inserted = 0;
  let dedup = 0;
  let skipped = 0;
  const markDone = (r: RawRow) => {
    if (r.time_updated > nextCursor) {
      nextCursor = r.time_updated;
      seen = new Set([r.id]);
    } else if (r.time_updated === nextCursor) {
      seen.add(r.id);
    }
  };

  for (const r of raw) {
    if (r.time_updated === cursor && seenAtCursor.has(r.id)) continue;
    const c = classifyRow(r);
    if (c.kind === "pending") continue;
    if (c.kind === "skip") {
      markDone(r);
      continue;
    }
    try {
      if (await insert(r, c)) inserted++;
      else dedup++;
      markDone(r);
    } catch (err) {
      console.error(
        `⚠️ [OpenCode] insert failed at ${r.id}:`,
        err instanceof Error ? err.message : err
      );
      skipped++;
      break;
    }
  }
  return { cursor: nextCursor, seenAtCursor: seen, inserted, dedup, skipped };
}

function loadKnownVersions(db: any): Set<string> {
  try {
    const rows = db.prepare(`SELECT DISTINCT version FROM session_v2`).all() as Array<{ version: unknown }>;
    return new Set(rows.map((r) => String(r.version)).filter(Boolean));
  } catch {
    return new Set();
  }
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
  if (!_state || !version) return false;
  return OPENCODE_CLIENT_NAMES.has(name) && _state.knownVersions.has(version);
}

export async function captureSessionStart(_cwd: string): Promise<void> {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  _state = null;
  _consecutiveOpenFailures = 0;
  const dbPath = resolveDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) return; // OpenCode 미설치 기기 → no-op

  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) {
    console.error(
      "📝 [OpenCode] node:sqlite 미지원 (Node < 22.5?) — capture 비활성, save_message fallback"
    );
    return;
  }

  const db = openRo(DatabaseSync, dbPath);
  if (!db) {
    console.error("📝 [OpenCode] opencode.db 열기 실패 — capture 비활성");
    return;
  }

  let cursor = 0;
  let knownVersions: Set<string>;
  try {
    const row = db
      .prepare(`SELECT COALESCE(MAX(time_updated), 0) AS m FROM session_message`)
      .get() as { m: number };
    cursor = Number(row?.m ?? 0);
    knownVersions = loadKnownVersions(db);
  } catch (err) {
    // v1 storage 등 session_message 테이블 없는 DB
    console.error(
      "📝 [OpenCode] session_message 조회 실패 — capture 비활성:",
      err instanceof Error ? err.message : err
    );
    try { db.close(); } catch {}
    return;
  }
  try { db.close(); } catch {}

  // arm 시점 cursor와 같은 ms 행은 과거분 → seenAtCursor로 채워 재조회 시 제외.
  const seenAtCursor = new Set<string>();
  _state = { dbPath, cursor, seenAtCursor, knownVersions };
  const db2 = openRo(DatabaseSync, dbPath);
  if (db2) {
    try {
      for (const r of selectRowsSince(db2, cursor)) seenAtCursor.add(r.id);
    } catch {}
    try { db2.close(); } catch {}
  }

  console.error(
    `📝 [OpenCode] capture armed: cursor=${cursor} versions=[${[...knownVersions].join(",")}] (live-from-now)`
  );

  _pollTimer = setInterval(() => {
    void flush();
  }, POLL_INTERVAL_MS);
}

async function flush(): Promise<{ inserted: number; dedup: number; skipped: number }> {
  const empty = { inserted: 0, dedup: 0, skipped: 0 };
  if (!_state || _flushInProgress) return empty;
  _flushInProgress = true;

  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) {
    _flushInProgress = false;
    return empty;
  }
  const db = openRo(DatabaseSync, _state.dbPath);
  if (!db) {
    // 연속 실패 시 disarm — 안 그러면 isCaptureArmed()=true로 save_message gate가
    // fallback까지 막아 silent total loss가 됨 (Hermes와 동일).
    _consecutiveOpenFailures++;
    if (_consecutiveOpenFailures >= MAX_OPEN_FAILURES) {
      console.error(
        `📝 [OpenCode] openRo ${_consecutiveOpenFailures}회 연속 실패 — capture 비활성(save_message fallback 복귀)`
      );
      resetCaptureState();
    }
    _flushInProgress = false;
    return empty;
  }
  _consecutiveOpenFailures = 0;

  let inserted = 0;
  let dedup = 0;
  let skipped = 0;
  try {
    _state.knownVersions = loadKnownVersions(db);
    const raw = selectRowsSince(db, _state.cursor);
    let userId: number | null = null;
    const r = await processBatch(raw, _state.cursor, _state.seenAtCursor, async (row, c) => {
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
    if (_state) {
      // await 도중 resetCaptureState()로 disarm됐을 수 있음
      _state.cursor = r.cursor;
      _state.seenAtCursor = r.seenAtCursor;
    }
    inserted = r.inserted;
    dedup = r.dedup;
    skipped = r.skipped;
  } catch (err) {
    console.error(
      "⚠️ [OpenCode] flush error:",
      err instanceof Error ? err.message : err
    );
  } finally {
    try { db.close(); } catch {}
    _flushInProgress = false;
  }

  if (inserted || dedup || skipped) {
    console.error(
      `📝 [OpenCode] flush: inserted=${inserted}, dedup=${dedup}, skipped=${skipped}, cursor=${_state?.cursor}`
    );
  }
  return { inserted, dedup, skipped };
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
  if (r.inserted || r.skipped) {
    console.error(
      `📝 [OpenCode] final flush: inserted=${r.inserted}, dedup=${r.dedup}, skipped=${r.skipped}`
    );
  }
  return { inserted: r.inserted, skipped: r.skipped };
}

export function resetCaptureState(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  _state = null;
  _flushInProgress = false;
}
