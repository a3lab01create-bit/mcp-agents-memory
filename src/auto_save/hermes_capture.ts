/**
 * Hermes (hermes-agent) 자동 캡처 — RESPEC §5 cross-platform passive capture.
 *
 * Hermes transcript: ~/.hermes/state.db (SQLite), `messages` 테이블.
 *
 * 다른 capture(jsonl/codex/gemini/grok/antigravity)는 append-only 파일을 fs.watch
 * 하지만 Hermes는 SQLite라 패턴이 다름:
 *   - WAL 모드라 .db mtime 신뢰 불가 → fs.watch 대신 *폴링*.
 *   - read-only로 열어 Hermes의 라이브 write와 충돌 회피 (WAL은 concurrent reader 허용).
 *   - cursor = 마지막으로 처리한 messages.id (INTEGER AUTOINCREMENT, 단조증가).
 *   - external_uuid = `hermes:<id>` (dedup).
 *   - role='tool' / content 빈 행(tool-call-only assistant) skip
 *     — memory.role CHECK는 ('user','assistant')만 허용하므로 tool은 매핑 아닌 *제거*.
 *   - messages엔 model 컬럼 없음 → sessions.model 조회 (session별 캐시).
 *     Hermes는 백엔드 모델을 교체하므로 세션마다 model이 다를 수 있음.
 *   - 외부 `sqlite3` 바이너리 대신 Node 내장 `node:sqlite` 사용.
 *     구버전 node(< 22.5)면 graceful no-op → save_message fallback (회귀 없음).
 *
 * Option A (live-from-now): arm 시점 max(id)를 cursor 초기값으로 잡아 과거 행 backfill 안 함.
 * 다른 platform capture와 동일한 동작.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { insertRawMemory } from "../hot_path.js";
import { getDefaultUserId } from "../users.js";

const DEVICE_NAME = os.hostname();
const STATE_DB = path.join(os.homedir(), ".hermes", "state.db");
const AGENT_PLATFORM = "hermes";
const POLL_INTERVAL_MS = 3000;

// node:sqlite DatabaseSync 클래스 (lazy load). 없으면 null → capture no-op.
let _DatabaseSync: any | null = null;
let _sqliteUnavailable = false;
async function loadSqlite(): Promise<any | null> {
  if (_DatabaseSync) return _DatabaseSync;
  if (_sqliteUnavailable) return null;
  try {
    // node:sqlite는 Node 22.5+ 빌트인. @types/node(node20 타겟)엔 타입이 없어
    // 타입 에러 억제. 구버전 node면 import 자체가 throw → 아래 catch에서 no-op.
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
  /** 마지막으로 본 messages.id (skip된 행 포함). */
  cursor: number;
  /** session_id → sessions.model (없으면 null). 중복 조회 방지. */
  modelCache: Map<string, string | null>;
}

let _state: CaptureState | null = null;
let _pollTimer: NodeJS.Timeout | null = null;
let _flushInProgress = false;
/** openRo 연속 실패 횟수. 임계 도달 시 disarm → save_message fallback 복귀. */
let _consecutiveOpenFailures = 0;
const MAX_OPEN_FAILURES = 5;

function openRo(DatabaseSync: any): any | null {
  try {
    return new DatabaseSync(STATE_DB, { readOnly: true });
  } catch {
    return null;
  }
}

export interface ParsedRow {
  id: number;
  role: "user" | "assistant";
  message: string;
  sessionId: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  /** 스캔한 행 중 최대 id (skip 포함). cursor 전진용. */
  maxId: number;
}

/**
 * id > afterId 인 messages 행을 파싱. skip 규칙 적용.
 * db 핸들을 인자로 받는 (거의) 순수 함수 — fixture로 단위테스트 가능.
 *
 * skip 대상:
 *   - role이 user/assistant 아님 (tool 등) → memory.role CHECK 위반 방지.
 *   - content 빈 행 (tool-call-only assistant) → 의미 없는 noise.
 */
export function parseNewRows(db: any, afterId: number): ParseResult {
  const raw = db
    .prepare(
      `SELECT id, session_id, role, content
         FROM messages
        WHERE id > ?
        ORDER BY id ASC`
    )
    .all(afterId) as Array<{
    id: number;
    session_id: string;
    role: string;
    content: string | null;
  }>;

  const rows: ParsedRow[] = [];
  let maxId = afterId;
  for (const r of raw) {
    const id = Number(r.id);
    if (id > maxId) maxId = id;

    let role: "user" | "assistant";
    if (r.role === "user") role = "user";
    else if (r.role === "assistant") role = "assistant";
    else continue; // tool 등 → skip

    const message = (r.content ?? "").trim();
    if (!message) continue; // tool-call-only assistant 등 → skip

    rows.push({ id, role, message, sessionId: String(r.session_id) });
  }
  return { rows, maxId };
}

/** sessions.model 조회 (세션별 캐시). 실패/없음 → null. */
export function lookupModel(
  db: any,
  sessionId: string,
  cache: Map<string, string | null>
): string | null {
  if (cache.has(sessionId)) return cache.get(sessionId)!;
  let model: string | null = null;
  try {
    const row = db
      .prepare(`SELECT model FROM sessions WHERE id = ? LIMIT 1`)
      .get(sessionId) as { model?: string | null } | undefined;
    model = row?.model ?? null;
  } catch {
    model = null;
  }
  cache.set(sessionId, model);
  return model;
}

/** save_message tool이 중복 저장 방지 여부 판단에 사용. */
export function isCaptureArmed(): boolean {
  return _state !== null;
}

export async function captureSessionStart(_cwd: string): Promise<void> {
  // 재호출(재arm) 대비: 기존 타이머 먼저 정리 (early-return 경로 타이머 leak 방지).
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  _state = null;
  _consecutiveOpenFailures = 0;
  if (!fs.existsSync(STATE_DB)) return; // Hermes 미설치 기기 → no-op

  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) {
    console.error(
      "📝 [Hermes] node:sqlite 미지원 (Node < 22.5?) — capture 비활성, save_message fallback"
    );
    return;
  }

  const db = openRo(DatabaseSync);
  if (!db) {
    console.error("📝 [Hermes] state.db 열기 실패 — capture 비활성");
    return;
  }

  let maxId = 0;
  try {
    const row = db
      .prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM messages`)
      .get() as { m: number };
    maxId = Number(row?.m ?? 0);
  } catch (err) {
    console.error(
      "📝 [Hermes] messages 조회 실패 — capture 비활성:",
      err instanceof Error ? err.message : err
    );
    try { db.close(); } catch {}
    return;
  }
  try { db.close(); } catch {}

  _state = { cursor: maxId, modelCache: new Map() };
  console.error(`📝 [Hermes] capture armed: cursor=${maxId} (live-from-now)`);

  if (_pollTimer) clearInterval(_pollTimer);
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
  const db = openRo(DatabaseSync);
  if (!db) {
    // DB가 startup 이후 사라지거나 권한이 바뀌면 매 poll openRo가 null. 연속 실패가
    // 임계를 넘으면 disarm — 안 그러면 isCaptureArmed()=true로 save_message gate가
    // fallback까지 막아 silent total loss가 됨 (리뷰 지적).
    _consecutiveOpenFailures++;
    if (_consecutiveOpenFailures >= MAX_OPEN_FAILURES) {
      console.error(
        `📝 [Hermes] openRo ${_consecutiveOpenFailures}회 연속 실패 — capture 비활성(save_message fallback 복귀)`
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
    const { rows, maxId } = parseNewRows(db, _state.cursor);
    // 첫 insert 실패 id (행은 id 오름차순 → 최솟값). 실패분은 다음 poll에 재시도.
    let firstFailedId: number | null = null;
    if (rows.length > 0) {
      const userId = await getDefaultUserId();
      for (const r of rows) {
        const agentModel =
          r.role === "user"
            ? null
            : lookupModel(db, r.sessionId, _state.modelCache) ?? "unknown";
        try {
          const res = await insertRawMemory({
            user_id: userId,
            agent_platform: AGENT_PLATFORM,
            agent_model: agentModel,
            role: r.role,
            message: r.message,
            external_uuid: `hermes:${r.id}`,
            device_name: DEVICE_NAME,
          });
          if (res.inserted) inserted++;
          else dedup++;
        } catch (err) {
          console.error(
            `⚠️ [Hermes] insert failed at id ${r.id}:`,
            err instanceof Error ? err.message : err
          );
          skipped++;
          if (firstFailedId === null) firstFailedId = r.id;
        }
      }
    }
    // cursor 전진: 실패가 있으면 첫 실패 직전까지만 (그 행부터 다음 poll 재시도).
    // 실패 없으면 maxId까지 (skip된 trailing tool/빈행 포함 → 반복 재스캔 방지).
    // external_uuid dedup이라 성공분 재읽기는 안전(ON CONFLICT skip).
    const advanceTo = firstFailedId !== null ? firstFailedId - 1 : maxId;
    if (advanceTo > _state.cursor) _state.cursor = advanceTo;
  } catch (err) {
    console.error(
      "⚠️ [Hermes] flush error:",
      err instanceof Error ? err.message : err
    );
  } finally {
    try { db.close(); } catch {}
    _flushInProgress = false;
  }

  if (inserted || dedup || skipped) {
    console.error(
      `📝 [Hermes] flush: inserted=${inserted}, dedup=${dedup}, skipped=${skipped}, cursor=${_state?.cursor}`
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
      `📝 [Hermes] final flush: inserted=${r.inserted}, dedup=${r.dedup}, skipped=${r.skipped}`
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
