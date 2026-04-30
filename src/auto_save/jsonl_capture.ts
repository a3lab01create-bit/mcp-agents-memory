/**
 * Claude Code JSONL 자동 캡처 — RESPEC PROBLEMS.md §4 fix.
 *
 * v0.x `transcript_capture.ts` 패턴 재도입. 단 새 `memory` 테이블에 직접 INSERT
 * (legacy `transcript_queue` X, librarian fact_type 추출 layer 없음).
 *
 * **Multi-file dir-watch 설계 (4-30 fix #2)**
 *
 * 단일 jsonl(latest-mtime)만 watch했더니 parallel 세션이 있을 때 엉뚱한 파일을
 * 잡는 버그 발생 — 이 대화 jsonl이 mtime 더 최신이면 새로 띄운 세션 MCP가
 * 자기 jsonl이 아닌 이 대화 jsonl을 봤음 → 자기 세션 entries 0건 INSERT.
 *
 * 해결: project dir 자체를 fs.watch + 디렉토리 안 모든 jsonl을 per-file cursor로
 * 추적. 어느 jsonl이든 grow하면 delta INSERT. "내 세션 식별" 불필요.
 *
 * 흐름:
 *   1. captureSessionStart(cwd) — projectDir 안 모든 jsonl 의 size 스냅샷
 *      (각 파일 cursor = 시작 시점 size, 옛 entries는 backfill 안 함) +
 *      dir 단위 fs.watch arm.
 *   2. 대화 중: 어느 jsonl이든 append → fs.watch fire → 200ms debounce →
 *      flushAllFiles() 가 dir 재 readdir, 각 jsonl 의 delta 읽고 INSERT,
 *      per-file cursor 전진.
 *   3. captureSessionEnd() — server shutdown 시 final flushAll. 보통 0건.
 *
 * 중복 안전망: external_uuid = `claude-code:<session_id>:<entry_uuid>` ON CONFLICT.
 * parallel MCP 서버가 같은 jsonl 중복 캡처해도 dedup. 한 세션 = 1개 row.
 *
 * Claude Code 한정: ~/.claude/projects/<slug>/<session_id>.jsonl convention 사용.
 * Gemini CLI / Codex 등은 본 path 작동 안 함 — save_message tool로 대체.
 *
 * Partial line 안전: fs.watch가 line 중간에 fire될 수 있어 마지막 \n까지만
 * parse + cursor 전진. \n 없는 trailing은 다음 flush에 흡수.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { insertRawMemory } from "../hot_path.js";
import { getDefaultUserId } from "../users.js";

const CLIENT_PLATFORM = "claude-code"; // 본 모듈은 Claude Code 전용
const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");
const FLUSH_DEBOUNCE_MS = 200; // fs.watch 다중 fire coalescing

interface FileState {
  /** 다음 read 시작 byte offset. 초기값 = arm 시점 size (또는 신규 파일이면 0).
   *  flushDeltaForFile 성공 후 마지막 \n 위치까지 전진. */
  cursorBytes: number;
  sessionId: string;
}

interface DirState {
  cwd: string;
  projectDir: string | null;
  /** jsonlPath → FileState. arm 시점에 존재한 파일 + 이후 발견된 신규 파일. */
  files: Map<string, FileState>;
}

let _state: DirState | null = null;

// --- watcher / mutex state ---
let _watcher: fs.FSWatcher | null = null;
let _flushInProgress = false;
let _flushPending = false;
let _flushDebounceTimer: NodeJS.Timeout | null = null;

/** project dir 이름 derivation: cwd → ~/.claude/projects/<slug> */
function deriveProjectDir(cwd: string): string {
  const slug = cwd.replace(/^\/+/, "").replace(/\//g, "-").replace(/^-+/, "-");
  return path.join(PROJECTS_ROOT, `-${slug}`);
}

/**
 * server 시작 시 호출. projectDir 안 모든 jsonl size 스냅샷 + dir watcher arm.
 * 옛 entries backfill 안 함 (cursor = 시작 시점 size).
 */
export function captureSessionStart(cwd: string): void {
  const projectDir = deriveProjectDir(cwd);
  _state = { cwd, projectDir: null, files: new Map() };

  if (!fs.existsSync(projectDir)) {
    return; // 비-Claude Code (Gemini / Codex) 또는 첫 세션 — no-op
  }
  _state.projectDir = projectDir;

  // 기존 jsonl 모두 snapshot
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const jsonlPath = path.join(projectDir, entry.name);
    let stat: fs.Stats;
    try { stat = fs.statSync(jsonlPath); } catch { continue; }
    const sessionId = entry.name.replace(/\.jsonl$/, "");
    _state.files.set(jsonlPath, { cursorBytes: stat.size, sessionId });
  }

  console.error(`📝 [JSONL] capture armed: ${_state.files.size} jsonl(s) in ${path.basename(projectDir)}/`);

  armDirWatcher();
}

export interface ParsedEntry {
  uuid: string;
  role: 'user' | 'assistant';
  message: string;
  agent_model?: string;
  subagent?: boolean;
  subagent_model?: string;
  subagent_role?: string;
}

/** Claude Code JSONL entry → ParsedEntry. parse 실패 / type 무효 시 null. */
export function parseEntry(line: string): ParsedEntry | null {
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }

  if (entry.type !== 'user' && entry.type !== 'assistant') return null;
  if (entry.isMeta === true) return null;

  const content = entry.message?.content;
  let messageText = "";
  if (typeof content === "string") {
    messageText = content;
  } else if (Array.isArray(content)) {
    // tool_use / tool_result는 protocol noise라 skip, text 블록만
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        messageText += (messageText ? "\n" : "") + block.text;
      }
    }
  }
  messageText = messageText.trim();
  if (!messageText) return null;

  // XML wrapper 노이즈 strip (system-reminder, command-*, task-notification 등)
  const noiseRe = /<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|task-notification|user-prompt-submit-hook|session-start-hook|session-end-hook)>[\s\S]*?<\/\1>/g;
  messageText = messageText.replace(noiseRe, "").trim();
  if (!messageText) return null;

  // Claude Code 내부 마커 drop
  if (messageText === "[Request interrupted by user for tool use]" || messageText === "[Request interrupted by user]") {
    return null;
  }

  // assistant entry는 model field 보유 (Claude Code 관행)
  const agent_model = entry.message?.model || undefined;

  return {
    uuid: entry.uuid ?? `${entry.timestamp ?? ''}-${Math.random()}`,
    role: entry.type,
    message: messageText,
    agent_model,
  };
}

/**
 * 한 jsonl 파일의 cursor부터 마지막 완성 line까지 읽고 INSERT, cursor 전진.
 * \n 없는 trailing partial은 보류, 다음 호출에 흡수.
 */
async function flushDeltaForFile(
  jsonlPath: string,
  fileState: FileState
): Promise<{ inserted: number; skipped: number; dedup: number }> {
  if (!fs.existsSync(jsonlPath)) return { inserted: 0, skipped: 0, dedup: 0 };

  let stat: fs.Stats;
  try { stat = fs.statSync(jsonlPath); } catch { return { inserted: 0, skipped: 0, dedup: 0 }; }

  if (stat.size <= fileState.cursorBytes) return { inserted: 0, skipped: 0, dedup: 0 };

  const length = stat.size - fileState.cursorBytes;
  const fd = fs.openSync(jsonlPath, "r");
  let raw: string;
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, fileState.cursorBytes);
    raw = buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }

  // 마지막 \n까지만 parse, 그 이후 partial은 다음 호출에 보류
  const lastNl = raw.lastIndexOf("\n");
  if (lastNl === -1) return { inserted: 0, skipped: 0, dedup: 0 };

  const parsable = raw.slice(0, lastNl);
  const advanceBy = Buffer.byteLength(parsable, "utf-8") + 1; // +1 = 그 \n
  const newCursor = fileState.cursorBytes + advanceBy;

  const lines = parsable.split("\n");
  const userId = await getDefaultUserId();

  let inserted = 0, skipped = 0, dedup = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseEntry(trimmed);
    if (!parsed) {
      skipped++;
      continue;
    }
    const externalUuid = `claude-code:${fileState.sessionId}:${parsed.uuid}`;
    try {
      const result = await insertRawMemory({
        user_id: userId,
        agent_platform: CLIENT_PLATFORM,
        agent_model: parsed.agent_model ?? "unknown",
        role: parsed.role,
        message: parsed.message,
        external_uuid: externalUuid,
      });
      if (result.inserted) inserted++;
      else dedup++;
    } catch (err) {
      console.error(`⚠️ [JSONL] insert failed for ${parsed.uuid}:`, err);
      skipped++;
    }
  }

  // cursor 전진 (성공 INSERT 못해도 dedup이 안전망 → 무한루프 방지 위해 전진)
  fileState.cursorBytes = newCursor;
  return { inserted, skipped, dedup };
}

/** dir 안 모든 jsonl 순회 + 신규 파일 발견 시 추가, 각각 flushDeltaForFile. */
async function flushAllFiles(): Promise<{ inserted: number; skipped: number; dedup: number }> {
  if (!_state || !_state.projectDir) return { inserted: 0, skipped: 0, dedup: 0 };
  const projectDir = _state.projectDir;
  if (!fs.existsSync(projectDir)) return { inserted: 0, skipped: 0, dedup: 0 };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return { inserted: 0, skipped: 0, dedup: 0 };
  }

  let totalI = 0, totalS = 0, totalD = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const jsonlPath = path.join(projectDir, entry.name);

    let fileState = _state.files.get(jsonlPath);
    if (!fileState) {
      // arm 이후 신규 jsonl — cursor 0부터 전체 캡처
      const sessionId = entry.name.replace(/\.jsonl$/, "");
      fileState = { cursorBytes: 0, sessionId };
      _state.files.set(jsonlPath, fileState);
      console.error(`📝 [JSONL] new session detected: ${entry.name}`);
    }

    const r = await flushDeltaForFile(jsonlPath, fileState);
    totalI += r.inserted;
    totalS += r.skipped;
    totalD += r.dedup;
  }

  return { inserted: totalI, skipped: totalS, dedup: totalD };
}

/** mutex 직렬화된 flush — 동시 호출은 큐잉 (한 번 더 실행 약속). */
async function flushWithMutex(): Promise<void> {
  if (_flushInProgress) {
    _flushPending = true;
    return;
  }
  _flushInProgress = true;
  try {
    const r = await flushAllFiles();
    if (r.inserted > 0 || r.skipped > 0 || r.dedup > 0) {
      console.error(`📝 [JSONL] live flush: inserted=${r.inserted}, dedup=${r.dedup}, skipped=${r.skipped}`);
    }
  } catch (err) {
    console.error("⚠️ [JSONL] live flush error:", err);
  } finally {
    _flushInProgress = false;
    if (_flushPending) {
      _flushPending = false;
      setImmediate(() => { void flushWithMutex(); });
    }
  }
}

/** fs.watch 다중 fire coalescing — debounce window 동안 모아서 1회. */
function scheduleFlush(): void {
  if (_flushDebounceTimer) clearTimeout(_flushDebounceTimer);
  _flushDebounceTimer = setTimeout(() => {
    _flushDebounceTimer = null;
    void flushWithMutex();
  }, FLUSH_DEBOUNCE_MS);
}

function armDirWatcher(): void {
  if (!_state || !_state.projectDir) return;
  if (_watcher) return; // 이미 arm됨
  try {
    _watcher = fs.watch(_state.projectDir, (_eventType, filename) => {
      // change: 파일 grow / rename: 파일 생성·삭제·이동. 어느쪽이든 flush 트리거.
      // filename이 없거나 jsonl 외 파일 변경이면 skip (subdir 등).
      if (filename && !filename.endsWith(".jsonl")) return;
      scheduleFlush();
    });
    console.error(`📝 [JSONL] dir watcher armed`);
  } catch (err) {
    console.error("⚠️ [JSONL] fs.watch dir failed (shutdown-only flush 폴백):", err);
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

/**
 * server shutdown 시 호출. watcher 닫고 final flushAll. 실패는 best-effort.
 */
export async function captureSessionEnd(): Promise<{ inserted: number; skipped: number; error?: string }> {
  disarmDirWatcher();

  // 진행 중 flush 마무리 대기 (최대 2s — shutdown 자체 timeout 안에서)
  const waitStart = Date.now();
  while (_flushInProgress && Date.now() - waitStart < 2000) {
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!_state || !_state.projectDir) {
    return { inserted: 0, skipped: 0, error: "session not armed" };
  }

  _flushInProgress = true;
  try {
    const r = await flushAllFiles();
    if (r.inserted > 0 || r.skipped > 0 || r.dedup > 0) {
      console.error(`📝 [JSONL] final flush: inserted=${r.inserted}, dedup=${r.dedup}, skipped=${r.skipped}`);
    }
    return { inserted: r.inserted, skipped: r.skipped };
  } finally {
    _flushInProgress = false;
  }
}

/** state reset (test용 / restart). */
export function resetCaptureState(): void {
  disarmDirWatcher();
  _state = null;
  _flushInProgress = false;
  _flushPending = false;
}
