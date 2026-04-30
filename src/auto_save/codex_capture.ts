/**
 * Codex CLI 자동 캡처 — RESPEC PROBLEMS.md §5 (cross-platform passive capture).
 *
 * Codex transcript: ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<sid>.jsonl
 *
 * jsonl_capture.ts 패턴 그대로 복제 + Codex 고유 처리:
 *   - dir 구조가 cwd 기반 아니라 *날짜 기반*. 모든 cwd 세션이 같은 dir에 섞임.
 *     → session_meta(line 1)의 cwd를 server cwd와 비교해 일치하는 file만 INSERT.
 *   - 자정 rollover: 새 day dir에 새 jsonl이 생김 → fs.watch(root, { recursive: true })
 *     darwin에서 안전. flush 도 dir tree 전체 walk.
 *   - jsonl entry에 per-msg UUID 없음 → external_uuid = `codex:<sid>:<line-byte-offset>`
 *     (jsonl append-only 가정으로 stable).
 *   - agent_model은 turn_context.payload.model에 있음 (session_meta 아님).
 *     → file-state로 마지막 turn_context.model 추적, event_msg에 그 값 사용.
 *   - 캡처 대상: event_msg (payload.type=user_message | agent_message)만.
 *     response_item은 environment_context 같은 system-injected — skip.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { insertRawMemory } from "../hot_path.js";
import { getDefaultUserId } from "../users.js";

const CLIENT_PLATFORM = "codex-mcp-client";
const SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");
const FLUSH_DEBOUNCE_MS = 200;

interface FileState {
  /** 다음 read 시작 byte. arm 시점 size 또는 신규 발견 파일이면 0. */
  cursorBytes: number;
  /** rollout 파일명에서 추출한 session UUID. */
  sessionId: string;
  /**
   * cwd 매칭 결과:
   *   - null: 아직 session_meta line 못 봄 (probe 실패 또는 미존재)
   *   - true: session_meta cwd가 server cwd와 일치 → INSERT 대상
   *   - false: 불일치 → cursor만 진전, INSERT skip
   */
  cwdMatched: boolean | null;
  /** 마지막으로 본 turn_context.payload.model (없으면 null → 'unknown'). */
  currentModel: string | null;
}

interface DirState {
  cwd: string;
  /** 정규화된 server cwd (path.resolve 결과). cwd 비교용. */
  cwdNormalized: string;
  rootExists: boolean;
  files: Map<string, FileState>;
}

let _state: DirState | null = null;

let _watcher: fs.FSWatcher | null = null;
let _flushInProgress = false;
let _flushPending = false;
let _flushDebounceTimer: NodeJS.Timeout | null = null;

/** rollout 파일명에서 session UUID 추출. `rollout-<ts>-<UUID>.jsonl` 형식. */
function extractSessionId(filename: string): string | null {
  const m = filename.match(/^rollout-.+?-([0-9a-f-]{36})\.jsonl$/);
  return m ? m[1] : null;
}

/**
 * file 첫 줄 (session_meta) 한 번 읽어 cwd / sessionId 추출.
 * 실패 시 null (file이 너무 작거나 첫 줄이 session_meta 아님).
 */
function probeSessionMeta(filePath: string): { sessionId: string; cwd: string } | null {
  let fd: number;
  try { fd = fs.openSync(filePath, "r"); } catch { return null; }
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    if (n === 0) return null;
    const slice = buf.slice(0, n).toString("utf-8");
    const nl = slice.indexOf("\n");
    if (nl === -1) return null;
    const entry = JSON.parse(slice.slice(0, nl));
    if (entry.type !== "session_meta") return null;
    const sid = entry.payload?.id;
    const cwd = entry.payload?.cwd;
    if (typeof sid !== "string" || typeof cwd !== "string") return null;
    return { sessionId: sid, cwd };
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

/**
 * sessions root 아래 모든 rollout-*.jsonl 경로 yield (재귀 walk).
 */
function* walkRollouts(root: string): Generator<string> {
  if (!fs.existsSync(root)) return;
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (
        e.isFile() &&
        e.name.startsWith("rollout-") &&
        e.name.endsWith(".jsonl")
      ) {
        yield p;
      }
    }
  }
}

export function captureSessionStart(cwd: string): void {
  const cwdNormalized = path.resolve(cwd);
  const rootExists = fs.existsSync(SESSIONS_ROOT);
  _state = {
    cwd,
    cwdNormalized,
    rootExists,
    files: new Map(),
  };

  if (!rootExists) {
    return;
  }

  // 기존 rollout snapshot — cursor = 현재 size, cwd 매칭은 probe로 결정
  let count = 0, matched = 0;
  for (const filePath of walkRollouts(SESSIONS_ROOT)) {
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { continue; }
    const sessionId = extractSessionId(path.basename(filePath));
    if (!sessionId) continue;

    const meta = probeSessionMeta(filePath);
    let cwdMatched: boolean | null = null;
    if (meta) {
      cwdMatched = path.resolve(meta.cwd) === cwdNormalized;
    }

    _state.files.set(filePath, {
      cursorBytes: stat.size,
      sessionId,
      cwdMatched,
      currentModel: null,
    });
    count++;
    if (cwdMatched) matched++;
  }

  console.error(`📝 [Codex] capture armed: ${count} rollout(s), ${matched} cwd-matched`);
  armDirWatcher();
}

export interface ParsedEntry {
  /** byte offset (line 시작 위치, file 내) — external_uuid 합성에 사용. */
  byteOffset: number;
  role: "user" | "assistant";
  message: string;
}

/**
 * 한 jsonl line → ParsedEntry | null.
 * event_msg payload.type = user_message | agent_message만 캡처.
 * 그 외 (response_item / turn_context / session_meta / function_call / reasoning 등) skip.
 */
export function parseEntry(line: string, byteOffset: number): ParsedEntry | null {
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }

  if (entry.type !== "event_msg") return null;
  const payload = entry.payload;
  if (!payload || typeof payload !== "object") return null;

  const ptype = payload.type;
  let role: "user" | "assistant";
  if (ptype === "user_message") {
    role = "user";
  } else if (ptype === "agent_message") {
    role = "assistant";
  } else {
    return null;
  }

  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!message) return null;

  return { byteOffset, role, message };
}

/**
 * turn_context line → 새 model 추출. file-state 업데이트용.
 */
function extractModelFromTurnContext(line: string): string | null {
  try {
    const entry = JSON.parse(line);
    if (entry.type !== "turn_context") return null;
    const m = entry.payload?.model;
    return typeof m === "string" ? m : null;
  } catch {
    return null;
  }
}

/**
 * session_meta line이 이전에 probe 실패했을 때, delta read 중 발견되면 cwd 판정.
 * (file이 처음 생긴 직후 watcher가 fire하면 probe보다 line 통과가 먼저일 수 있음)
 */
function applySessionMetaIfPresent(line: string, fileState: FileState, cwdNormalized: string): void {
  if (fileState.cwdMatched !== null) return;
  try {
    const entry = JSON.parse(line);
    if (entry.type !== "session_meta") return;
    const cwd = entry.payload?.cwd;
    if (typeof cwd !== "string") return;
    fileState.cwdMatched = path.resolve(cwd) === cwdNormalized;
  } catch {}
}

async function flushDeltaForFile(
  filePath: string,
  fileState: FileState,
  cwdNormalized: string
): Promise<{ inserted: number; skipped: number; dedup: number }> {
  if (!fs.existsSync(filePath)) return { inserted: 0, skipped: 0, dedup: 0 };

  let stat: fs.Stats;
  try { stat = fs.statSync(filePath); } catch { return { inserted: 0, skipped: 0, dedup: 0 }; }
  if (stat.size <= fileState.cursorBytes) return { inserted: 0, skipped: 0, dedup: 0 };

  const length = stat.size - fileState.cursorBytes;
  const fd = fs.openSync(filePath, "r");
  let raw: string;
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, fileState.cursorBytes);
    raw = buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }

  const lastNl = raw.lastIndexOf("\n");
  if (lastNl === -1) return { inserted: 0, skipped: 0, dedup: 0 };

  const parsable = raw.slice(0, lastNl);
  const advanceBy = Buffer.byteLength(parsable, "utf-8") + 1;
  const startBase = fileState.cursorBytes;
  const newCursor = fileState.cursorBytes + advanceBy;

  const userId = await getDefaultUserId();
  let inserted = 0, skipped = 0, dedup = 0;

  // line별 byte offset 재계산 위해 누적 traverse
  let lineStartInRaw = 0;
  const lines = parsable.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      lineStartInRaw += Buffer.byteLength(line, "utf-8") + 1;
      continue;
    }

    // session_meta가 늦게 흘러들어왔으면 cwd 판정 update
    applySessionMetaIfPresent(trimmed, fileState, cwdNormalized);

    // turn_context면 model 갱신만 하고 다음
    const m = extractModelFromTurnContext(trimmed);
    if (m !== null) {
      fileState.currentModel = m;
      lineStartInRaw += Buffer.byteLength(line, "utf-8") + 1;
      continue;
    }

    // cwd 불일치 file이면 INSERT skip (cursor만 진전)
    if (fileState.cwdMatched === false) {
      lineStartInRaw += Buffer.byteLength(line, "utf-8") + 1;
      continue;
    }

    const byteOffset = startBase + lineStartInRaw;
    const parsed = parseEntry(trimmed, byteOffset);
    if (!parsed) {
      skipped++;
      lineStartInRaw += Buffer.byteLength(line, "utf-8") + 1;
      continue;
    }

    // cwd 미정 (cwdMatched===null)이면 안전상 보류 — 다음 flush에 재시도 안 함.
    // session_meta 한 번도 못 본 jsonl은 의심스러우니 INSERT skip.
    if (fileState.cwdMatched !== true) {
      skipped++;
      lineStartInRaw += Buffer.byteLength(line, "utf-8") + 1;
      continue;
    }

    const externalUuid = `codex:${fileState.sessionId}:${parsed.byteOffset}`;
    const agentModel =
      parsed.role === "user" ? null : (fileState.currentModel ?? "unknown");

    try {
      const result = await insertRawMemory({
        user_id: userId,
        agent_platform: CLIENT_PLATFORM,
        agent_model: agentModel,
        role: parsed.role,
        message: parsed.message,
        external_uuid: externalUuid,
      });
      if (result.inserted) inserted++;
      else dedup++;
    } catch (err) {
      console.error(`⚠️ [Codex] insert failed at offset ${byteOffset}:`, err);
      skipped++;
    }

    lineStartInRaw += Buffer.byteLength(line, "utf-8") + 1;
  }

  fileState.cursorBytes = newCursor;
  return { inserted, skipped, dedup };
}

async function flushAllFiles(): Promise<{ inserted: number; skipped: number; dedup: number }> {
  if (!_state || !_state.rootExists) return { inserted: 0, skipped: 0, dedup: 0 };
  const cwdNormalized = _state.cwdNormalized;

  let totalI = 0, totalS = 0, totalD = 0;

  for (const filePath of walkRollouts(SESSIONS_ROOT)) {
    let fileState = _state.files.get(filePath);
    if (!fileState) {
      // 신규 파일 — cursor 0, 곧이어 session_meta delta-read로 cwd 판정
      const sessionId = extractSessionId(path.basename(filePath));
      if (!sessionId) continue;
      fileState = {
        cursorBytes: 0,
        sessionId,
        cwdMatched: null,
        currentModel: null,
      };
      _state.files.set(filePath, fileState);
      console.error(`📝 [Codex] new rollout detected: ${path.basename(filePath)}`);
    }

    const r = await flushDeltaForFile(filePath, fileState, cwdNormalized);
    totalI += r.inserted;
    totalS += r.skipped;
    totalD += r.dedup;
  }

  return { inserted: totalI, skipped: totalS, dedup: totalD };
}

async function flushWithMutex(): Promise<void> {
  if (_flushInProgress) {
    _flushPending = true;
    return;
  }
  _flushInProgress = true;
  try {
    const r = await flushAllFiles();
    if (r.inserted > 0 || r.skipped > 0 || r.dedup > 0) {
      console.error(`📝 [Codex] live flush: inserted=${r.inserted}, dedup=${r.dedup}, skipped=${r.skipped}`);
    }
  } catch (err) {
    console.error("⚠️ [Codex] live flush error:", err);
  } finally {
    _flushInProgress = false;
    if (_flushPending) {
      _flushPending = false;
      setImmediate(() => { void flushWithMutex(); });
    }
  }
}

function scheduleFlush(): void {
  if (_flushDebounceTimer) clearTimeout(_flushDebounceTimer);
  _flushDebounceTimer = setTimeout(() => {
    _flushDebounceTimer = null;
    void flushWithMutex();
  }, FLUSH_DEBOUNCE_MS);
}

function armDirWatcher(): void {
  if (!_state || !_state.rootExists) return;
  if (_watcher) return;
  try {
    _watcher = fs.watch(SESSIONS_ROOT, { recursive: true }, (_evt, filename) => {
      if (!filename) return;
      const base = path.basename(filename);
      if (!base.startsWith("rollout-") || !base.endsWith(".jsonl")) return;
      scheduleFlush();
    });
    console.error(`📝 [Codex] dir watcher armed (recursive)`);
  } catch (err) {
    console.error("⚠️ [Codex] fs.watch failed (shutdown-only flush 폴백):", err);
  }
}

function disarmDirWatcher(): void {
  if (_flushDebounceTimer) {
    clearTimeout(_flushDebounceTimer);
    _flushDebounceTimer = null;
  }
  if (_watcher) {
    try { _watcher.close(); } catch {}
    _watcher = null;
  }
}

export async function captureSessionEnd(): Promise<{ inserted: number; skipped: number; error?: string }> {
  disarmDirWatcher();

  const waitStart = Date.now();
  while (_flushInProgress && Date.now() - waitStart < 2000) {
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!_state || !_state.rootExists) {
    return { inserted: 0, skipped: 0, error: "session not armed" };
  }

  _flushInProgress = true;
  try {
    const r = await flushAllFiles();
    if (r.inserted > 0 || r.skipped > 0 || r.dedup > 0) {
      console.error(`📝 [Codex] final flush: inserted=${r.inserted}, dedup=${r.dedup}, skipped=${r.skipped}`);
    }
    return { inserted: r.inserted, skipped: r.skipped };
  } finally {
    _flushInProgress = false;
  }
}

export function resetCaptureState(): void {
  disarmDirWatcher();
  _state = null;
  _flushInProgress = false;
  _flushPending = false;
}
