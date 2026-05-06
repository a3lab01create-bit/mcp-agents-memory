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
import { spawnSync } from "node:child_process";
import { insertRawMemory } from "../hot_path.js";
import { getDefaultUserId } from "../users.js";

const DEVICE_NAME = os.hostname();
const SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");
const STATE_DB = path.join(os.homedir(), ".codex", "state_5.sqlite");
const FLUSH_DEBOUNCE_MS = 200;
const POLL_INTERVAL_MS = 3000; // OS 버퍼링 우회 — fs.watch 미발화 보완

/** state_5.sqlite threads.source → agent_platform 매핑 */
function sourceToPlatform(source: string): string {
  switch (source) {
    case "cli":    return "codex-cli";
    case "vscode": return "codex-desktop";
    case "mcp":    return "codex-mcp";
    case "exec":   return "codex-exec";
    default:       return "codex-mcp-client";
  }
}

/** sessionId로 state_5.sqlite 조회 → platform string. 실패 시 default. */
function lookupPlatform(sessionId: string): string {
  try {
    const res = spawnSync(
      "sqlite3",
      [STATE_DB, `SELECT source FROM threads WHERE id='${sessionId}' LIMIT 1;`],
      { encoding: "utf-8", timeout: 500 },
    );
    const source = (res.stdout ?? "").trim();
    if (source) return sourceToPlatform(source);
  } catch {}
  return "codex-mcp-client";
}

interface FileState {
  /** 다음 read 시작 byte. arm 시점 size 또는 신규 발견 파일이면 0. */
  cursorBytes: number;
  /** rollout 파일명에서 추출한 session UUID. */
  sessionId: string;
  /** state_5.sqlite source → platform (cli→codex-cli, vscode→codex-desktop …). */
  agentPlatform: string;
  /** 마지막으로 본 turn_context.payload.model (없으면 null → 'unknown'). */
  currentModel: string | null;
}

interface DirState {
  rootExists: boolean;
  files: Map<string, FileState>;
}

let _state: DirState | null = null;
/** 서버 시작 시각 (ms). 이보다 이전에 생성된 파일의 기존 내용은 skip. */
const SERVER_START_MS = Date.now();

let _watcher: fs.FSWatcher | null = null;
let _pollTimer: NodeJS.Timeout | null = null;
let _flushInProgress = false;
let _flushPending = false;
let _flushDebounceTimer: NodeJS.Timeout | null = null;

/** rollout 파일명에서 session UUID 추출. `rollout-<ts>-<UUID>.jsonl` 형식. */
function extractSessionId(filename: string): string | null {
  const m = filename.match(/^rollout-.+?-([0-9a-f-]{36})\.jsonl$/);
  return m ? m[1] : null;
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

export function captureSessionStart(_cwd: string): void {
  const rootExists = fs.existsSync(SESSIONS_ROOT);
  _state = {
    rootExists,
    files: new Map(),
  };

  if (!rootExists) {
    return;
  }

  // 기존 rollout snapshot — cursor = 현재 size (pre-existing 내용 bulk dump 방지)
  let count = 0;
  for (const filePath of walkRollouts(SESSIONS_ROOT)) {
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { continue; }
    const sessionId = extractSessionId(path.basename(filePath));
    if (!sessionId) continue;

    _state.files.set(filePath, {
      cursorBytes: stat.size,
      sessionId,
      agentPlatform: lookupPlatform(sessionId),
      currentModel: null,
    });
    count++;
  }

  console.error(`📝 [Codex] capture armed: ${count} rollout(s)`);
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

  // Codex agent_message에는 tool call 로그가 섞임 — 메모리 노이즈 제거
  if (message.startsWith("[external_agent_tool_call:") ||
      message.startsWith("[external_agent_tool_call_response:")) {
    return null;
  }

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

async function flushDeltaForFile(
  filePath: string,
  fileState: FileState,
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

    // turn_context면 model 갱신만 하고 다음
    const m = extractModelFromTurnContext(trimmed);
    if (m !== null) {
      fileState.currentModel = m;
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

    const externalUuid = `codex:${fileState.sessionId}:${parsed.byteOffset}`;
    const agentModel =
      parsed.role === "user" ? null : (fileState.currentModel ?? "unknown");

    try {
      const result = await insertRawMemory({
        user_id: userId,
        agent_platform: fileState.agentPlatform,
        agent_model: agentModel,
        role: parsed.role,
        message: parsed.message,
        external_uuid: externalUuid,
        device_name: DEVICE_NAME,
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

  let totalI = 0, totalS = 0, totalD = 0;

  for (const filePath of walkRollouts(SESSIONS_ROOT)) {
    let fileState = _state.files.get(filePath);
    if (!fileState) {
      const sessionId = extractSessionId(path.basename(filePath));
      if (!sessionId) continue;

      // 서버 시작 이전에 이미 존재하던 파일 → 기존 내용 skip (cursor = 현재 size).
      // Codex Desktop이 과거 세션을 bulk dump할 때 오래된 내용이 대량 삽입되는 것 방지.
      let stat: fs.Stats | null = null;
      try { stat = fs.statSync(filePath); } catch {}
      const fileBirthMs = stat ? stat.birthtimeMs || stat.ctimeMs : SERVER_START_MS;
      const isPreExisting = fileBirthMs < SERVER_START_MS - 5000; // 5s 여유
      const initialCursor = isPreExisting ? (stat?.size ?? 0) : 0;

      if (isPreExisting) {
        console.error(`📝 [Codex] pre-existing rollout skipped (cursor=${initialCursor}): ${path.basename(filePath)}`);
      } else {
        console.error(`📝 [Codex] new rollout detected: ${path.basename(filePath)}`);
      }

      fileState = {
        cursorBytes: initialCursor,
        sessionId,
        agentPlatform: lookupPlatform(sessionId),
        currentModel: null,
      };
      _state.files.set(filePath, fileState);
    }

    const r = await flushDeltaForFile(filePath, fileState);
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
    console.error("⚠️ [Codex] fs.watch failed — polling only:", err);
  }
  // OS 버퍼링으로 fs.watch 이벤트 누락될 수 있음 → 폴링으로 보완
  _pollTimer = setInterval(() => { void flushWithMutex(); }, POLL_INTERVAL_MS);
}

function disarmDirWatcher(): void {
  if (_flushDebounceTimer) {
    clearTimeout(_flushDebounceTimer);
    _flushDebounceTimer = null;
  }
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
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
