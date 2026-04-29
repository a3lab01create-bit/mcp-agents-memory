/**
 * Claude Code JSONL 자동 캡처 — RESPEC PROBLEMS.md §4 fix.
 *
 * v0.x `transcript_capture.ts` 패턴 재도입. 단 새 `memory` 테이블에 직접 INSERT
 * (legacy `transcript_queue` X, librarian fact_type 추출 layer 없음).
 *
 * 흐름 (real-time, 4-30 fix):
 *   1. captureSessionStart(cwd) — server 시작 시 호출. 최신 JSONL 식별 +
 *      byte cursor 기록 + **fs.watch arm** (파일 grow 시 즉시 delta flush).
 *   2. 대화 중: JSONL append → fs.watch fire → debounce 200ms → flushDelta()
 *      가 cursor~EOF 읽고 INSERT, cursor 전진. ColdPath worker(60s tick)가
 *      살아있는 동안 자연스럽게 tag+embed 처리.
 *   3. captureSessionEnd() — server shutdown 시. watcher 닫고 final flush.
 *      (이 시점엔 대부분 이미 들어가있음, 마지막 1-2건만 잡힘)
 *
 * Claude Code 한정: ~/.claude/projects/<slug>/<session_id>.jsonl convention
 * 사용. Gemini CLI / Codex 등은 본 path 작동 안 함 — save_message tool로 대체.
 *
 * Partial line 안전: fs.watch가 line 중간에 fire될 수 있어 마지막 \n까지만
 * parse + cursor 전진. \n 없는 trailing은 다음 flush에 남김. Dedup은
 * external_uuid (ON CONFLICT) 가 안전망.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { insertRawMemory } from "../hot_path.js";
import { getDefaultUserId } from "../users.js";

const CLIENT_PLATFORM = "claude-code"; // 본 모듈은 Claude Code 전용
const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");
const FLUSH_DEBOUNCE_MS = 200; // fs.watch 다중 fire coalescing

interface SessionState {
  cwd: string;
  jsonlPath: string | null;
  /** 다음 read 시작 byte offset. 초기값 = server 시작 시점 file size.
   *  flushDelta 성공 후 마지막 \n 위치까지 전진. */
  startByteOffset: number;
  sessionId: string | null;
}

let _state: SessionState | null = null;

// --- live watcher state ---
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
 * server 시작 시 호출. 현재 cwd의 최신 JSONL을 식별 + byte cursor 기록 +
 * fs.watch arm. 옛 entries는 backfill 안 함 (cursor = file size at start).
 */
export function captureSessionStart(cwd: string): void {
  const projectDir = deriveProjectDir(cwd);

  if (!fs.existsSync(projectDir)) {
    _state = { cwd, jsonlPath: null, startByteOffset: 0, sessionId: null };
    return;
  }

  // 최신 mtime jsonl 선택 (현재 active 세션)
  let latest: { name: string; mtime: number } | null = null;
  for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const stat = fs.statSync(path.join(projectDir, entry.name));
    if (!latest || stat.mtimeMs > latest.mtime) {
      latest = { name: entry.name, mtime: stat.mtimeMs };
    }
  }

  if (!latest) {
    _state = { cwd, jsonlPath: null, startByteOffset: 0, sessionId: null };
    return;
  }

  const jsonlPath = path.join(projectDir, latest.name);
  const stat = fs.statSync(jsonlPath);
  const sessionId = latest.name.replace(/\.jsonl$/, "");

  _state = {
    cwd,
    jsonlPath,
    startByteOffset: stat.size, // 시작 시점 size = 이후만 캡처
    sessionId,
  };

  console.error(`📝 [JSONL] capture armed: session=${sessionId} from byte=${stat.size}`);

  armWatcher();
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
 * cursor부터 마지막 완성 line(`\n` 끝)까지 읽고 parse + INSERT, cursor 전진.
 * \n 없는 trailing partial은 그대로 남기고 다음 호출에 흡수.
 */
async function flushDelta(): Promise<{ inserted: number; skipped: number; dedup: number }> {
  if (!_state || !_state.jsonlPath) return { inserted: 0, skipped: 0, dedup: 0 };
  const { jsonlPath, sessionId } = _state;

  if (!fs.existsSync(jsonlPath)) return { inserted: 0, skipped: 0, dedup: 0 };

  const stat = fs.statSync(jsonlPath);
  if (stat.size <= _state.startByteOffset) return { inserted: 0, skipped: 0, dedup: 0 };

  const length = stat.size - _state.startByteOffset;
  const fd = fs.openSync(jsonlPath, "r");
  let raw: string;
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, _state.startByteOffset);
    raw = buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }

  // 마지막 \n 위치까지만 parse, 그 이후 partial은 보류
  const lastNlInRaw = raw.lastIndexOf("\n");
  if (lastNlInRaw === -1) {
    // 완성 line 하나도 없음 — cursor 그대로 두고 next 호출 대기
    return { inserted: 0, skipped: 0, dedup: 0 };
  }
  const parsableRaw = raw.slice(0, lastNlInRaw); // \n 미포함
  const advanceBy = Buffer.byteLength(parsableRaw, "utf-8") + 1; // +1 = 그 \n
  const newCursor = _state.startByteOffset + advanceBy;

  const lines = parsableRaw.split("\n");
  const userId = await getDefaultUserId();

  let inserted = 0;
  let skipped = 0;
  let dedup = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseEntry(trimmed);
    if (!parsed) {
      skipped++;
      continue;
    }
    const externalUuid = sessionId ? `claude-code:${sessionId}:${parsed.uuid}` : `claude-code:${parsed.uuid}`;
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
      console.error(`⚠️ [JSONL] insert failed for entry ${parsed.uuid}:`, err);
      skipped++;
    }
  }

  // cursor 전진 (성공 INSERT 못해도 어차피 dedup 안전망 → re-read 무한루프 방지 위해 전진)
  _state.startByteOffset = newCursor;

  return { inserted, skipped, dedup };
}

/** mutex로 직렬화된 flush — 동시 호출은 큐잉 (한 번 더 실행 약속). */
async function flushWithMutex(): Promise<void> {
  if (_flushInProgress) {
    _flushPending = true;
    return;
  }
  _flushInProgress = true;
  try {
    const { inserted, skipped, dedup } = await flushDelta();
    if (inserted > 0 || skipped > 0 || dedup > 0) {
      console.error(`📝 [JSONL] live flush: inserted=${inserted}, dedup=${dedup}, skipped=${skipped}`);
    }
  } catch (err) {
    console.error("⚠️ [JSONL] live flush error:", err);
  } finally {
    _flushInProgress = false;
    if (_flushPending) {
      _flushPending = false;
      // 다음 microtask에 재진입 — 재귀 stack 회피
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

function armWatcher(): void {
  if (!_state || !_state.jsonlPath) return;
  if (_watcher) return; // 이미 arm됨
  try {
    _watcher = fs.watch(_state.jsonlPath, (eventType) => {
      if (eventType === "change") {
        scheduleFlush();
      } else if (eventType === "rename") {
        // 파일 rotate/삭제 — watcher 닫음 (final flush는 captureSessionEnd가 처리)
        disarmWatcher();
      }
    });
    console.error(`📝 [JSONL] live watcher armed`);
  } catch (err) {
    console.error("⚠️ [JSONL] fs.watch failed (shutdown-only flush 폴백):", err);
  }
}

function disarmWatcher(): void {
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
 * server shutdown 시 호출. watcher 닫고 final flush.
 * 실패는 best-effort (shutdown 막지 않음).
 */
export async function captureSessionEnd(): Promise<{ inserted: number; skipped: number; error?: string }> {
  disarmWatcher();

  // 진행 중 flush 마무리 대기 (최대 2s — shutdown 자체 timeout 안에서)
  const waitStart = Date.now();
  while (_flushInProgress && Date.now() - waitStart < 2000) {
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!_state || !_state.jsonlPath) {
    return { inserted: 0, skipped: 0, error: "session not armed" };
  }
  if (!fs.existsSync(_state.jsonlPath)) {
    return { inserted: 0, skipped: 0, error: "jsonl missing" };
  }

  _flushInProgress = true;
  try {
    const result = await flushDelta();
    if (result.inserted > 0 || result.skipped > 0 || result.dedup > 0) {
      console.error(`📝 [JSONL] final flush session=${_state.sessionId}: inserted=${result.inserted}, dedup=${result.dedup}, skipped=${result.skipped}`);
    }
    return { inserted: result.inserted, skipped: result.skipped };
  } finally {
    _flushInProgress = false;
  }
}

/** state reset (test용 / restart). */
export function resetCaptureState(): void {
  disarmWatcher();
  _state = null;
  _flushInProgress = false;
  _flushPending = false;
}
