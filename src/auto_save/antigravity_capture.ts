/**
 * Antigravity CLI passive capture — RESPEC §5 cross-platform.
 *
 * Template: grok_capture.ts (line-cursor + size-gate + watcher + pre-existing skip).
 * Differences (exactly 2 as per recon):
 *   - Walk target: ~/.gemini/antigravity-cli/brain/<sid>/.system_generated/logs/transcript_full.jsonl
 *   - external_uuid key: step_index (from JSON entry) instead of lineIndex.
 *     → `antigravity:<sid>:<step_index>`
 *
 * ⚠️ conversations/*.pb 는 암호화. 절대 건드리지 않음. transcript_full.jsonl만 사용.
 *
 * Checkpoint-driven. If stuck or quota low, stop at current CP.
 * Claude can resume from last verified checkpoint.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { insertRawMemory } from "../hot_path.js";
import { getDefaultUserId } from "../users.js";

const DEVICE_NAME = os.hostname();
const SESSIONS_ROOT = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
const CHAT_FILE = "transcript_full.jsonl";
const AGENT_PLATFORM = "antigravity-cli";
const FLUSH_DEBOUNCE_MS = 200;
const POLL_INTERVAL_MS = 3000;

interface FileState {
  cursorLines: number;
  lastSize: number;
  sessionId: string; // the <sid> UUID under brain/
  /** USER_INPUT의 <USER_SETTINGS_CHANGE>에서 추적한 현재 모델. 없으면 null → 'unknown'. */
  currentModel: string | null;
}

interface DirState {
  rootExists: boolean;
  files: Map<string, FileState>;
}

let _state: DirState | null = null;
const SERVER_START_MS = Date.now();

let _watcher: fs.FSWatcher | null = null;
let _pollTimer: NodeJS.Timeout | null = null;
let _flushInProgress = false;
let _flushPending = false;
let _flushDebounceTimer: NodeJS.Timeout | null = null;

/** brain/<sid>/.system_generated/logs/transcript_full.jsonl → sid */
function extractSid(filePath: string): string {
  // logs / .system_generated / <sid> / brain
  return path.basename(path.dirname(path.dirname(path.dirname(filePath))));
}

function countCompleteLines(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    let n = 0;
    for (let i = 0; i < content.length; i++) if (content[i] === "\n") n++;
    return n;
  } catch {
    return 0;
  }
}

/**
 * brain/ 아래 모든 transcript_full.jsonl 경로 yield (재귀).
 */
function* walkTranscripts(root: string): Generator<string> {
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
      } else if (e.isFile() && e.name === CHAT_FILE) {
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

  let count = 0;
  for (const filePath of walkTranscripts(SESSIONS_ROOT)) {
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { continue; }

    _state.files.set(filePath, {
      cursorLines: countCompleteLines(filePath),
      lastSize: stat.size,
      sessionId: extractSid(filePath),
      currentModel: null,
    });
    count++;
  }

  console.error(`📝 [Antigravity] capture armed: ${count} transcript(s)`);
  armDirWatcher();
}

export interface ParsedEntry {
  stepIndex: number;
  role: "user" | "assistant";
  message: string;
  /** USER_INPUT의 <USER_SETTINGS_CHANGE>에서 추출한 모델명. assistant/없으면 null. */
  modelHint: string | null;
}

/** <USER_REQUEST>...</USER_REQUEST> 안쪽만 추출. 없으면 null. */
function extractUserRequest(text: string): string | null {
  const m = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  return m ? m[1].trim() : null;
}

/**
 * "...changed setting `Model Selection` from None to Gemini 3.5 Flash (Medium). No need..."
 * → "Gemini 3.5 Flash (Medium)". 모델은 per-entry 필드가 없고 user의 settings-change에만 나옴.
 * 종료 마침표는 뒤에 공백/끝이 와야 매칭 → "3.5"의 점에서 끊기지 않음.
 */
function extractModelSelection(text: string): string | null {
  const m = text.match(/Model Selection[^\n]*?\bto\s+(.+?)\.(?:\s|$)/);
  return m ? m[1].trim() : null;
}

/**
 * transcript_full.jsonl 한 줄 → ParsedEntry | null
 * 규칙 (recon 확정):
 *   - USER_INPUT: <USER_REQUEST> 내부만. 추가 메타태그 버림.
 *   - PLANNER_RESPONSE + content 있음 → assistant
 *   - PLANNER_RESPONSE + content 없음(tool_calls만) → skip
 *   - 그 외 (CONVERSATION_HISTORY, LIST_DIRECTORY 등) → skip
 */
export function parseEntry(line: string): ParsedEntry | null {
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }

  const type = entry.type;
  const stepIndex = typeof entry.step_index === "number" ? entry.step_index : -1;
  if (stepIndex < 0) return null;

  if (type === "USER_INPUT") {
    const raw = typeof entry.content === "string" ? entry.content : "";
    const query = extractUserRequest(raw);
    if (!query) return null;
    return { stepIndex, role: "user", message: query, modelHint: extractModelSelection(raw) };
  }

  if (type === "PLANNER_RESPONSE") {
    const message = (entry.content || "").toString().trim();
    if (!message) return null; // tool_calls only
    return { stepIndex, role: "assistant", message, modelHint: null };
  }

  // CONVERSATION_HISTORY, LIST_DIRECTORY, SYSTEM 등 → skip
  return null;
}

async function flushDeltaForFile(
  filePath: string,
  fileState: FileState,
): Promise<{ inserted: number; skipped: number; dedup: number }> {
  let stat: fs.Stats;
  try { stat = fs.statSync(filePath); } catch { return { inserted: 0, skipped: 0, dedup: 0 }; }

  if (stat.size === fileState.lastSize) return { inserted: 0, skipped: 0, dedup: 0 };

  let content: string;
  try { content = fs.readFileSync(filePath, "utf-8"); }
  catch { return { inserted: 0, skipped: 0, dedup: 0 }; }

  fileState.lastSize = stat.size;

  const completeLines = content.split("\n").slice(0, -1);
  const total = completeLines.length;
  if (total <= fileState.cursorLines) return { inserted: 0, skipped: 0, dedup: 0 };

  const userId = await getDefaultUserId();
  let inserted = 0, skipped = 0, dedup = 0;

  for (let i = fileState.cursorLines; i < total; i++) {
    const line = completeLines[i].trim();
    if (!line) continue;

    const parsed = parseEntry(line);
    if (!parsed) {
      skipped++;
      continue;
    }

    // user의 settings-change에서 모델 잡으면 file-state에 추적 (codex_capture 방식).
    // 같은 세션 내 이후 assistant 턴들이 이 모델을 사용.
    if (parsed.modelHint) fileState.currentModel = parsed.modelHint;
    const agentModel = parsed.role === "user" ? null : (fileState.currentModel ?? "unknown");

    const externalUuid = `antigravity:${fileState.sessionId}:${parsed.stepIndex}`;

    try {
      const result = await insertRawMemory({
        user_id: userId,
        agent_platform: AGENT_PLATFORM,
        agent_model: agentModel,
        role: parsed.role,
        message: parsed.message,
        external_uuid: externalUuid,
        device_name: DEVICE_NAME,
      });
      if (result.inserted) inserted++;
      else dedup++;
    } catch (err) {
      console.error(`⚠️ [Antigravity] insert failed at step ${parsed.stepIndex}:`, err);
      skipped++;
    }
  }

  fileState.cursorLines = total;
  return { inserted, skipped, dedup };
}

async function flushAllFiles(): Promise<{ inserted: number; skipped: number; dedup: number }> {
  if (!_state || !_state.rootExists) return { inserted: 0, skipped: 0, dedup: 0 };

  let totalI = 0, totalS = 0, totalD = 0;

  for (const filePath of walkTranscripts(SESSIONS_ROOT)) {
    let fileState = _state.files.get(filePath);
    if (!fileState) {
      let stat: fs.Stats | null = null;
      try { stat = fs.statSync(filePath); } catch {}
      const fileBirthMs = stat ? stat.birthtimeMs || stat.ctimeMs : SERVER_START_MS;
      const isPreExisting = fileBirthMs < SERVER_START_MS - 5000;
      const initialCursor = isPreExisting ? countCompleteLines(filePath) : 0;
      const initialSize = isPreExisting ? (stat?.size ?? 0) : 0;

      if (isPreExisting) {
        console.error(`📝 [Antigravity] pre-existing session skipped (lines=${initialCursor}): ${extractSid(filePath)}`);
      } else {
        console.error(`📝 [Antigravity] new session detected: ${extractSid(filePath)}`);
      }

      fileState = {
        cursorLines: initialCursor,
        lastSize: initialSize,
        sessionId: extractSid(filePath),
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
      console.error(`📝 [Antigravity] live flush: inserted=${r.inserted}, dedup=${r.dedup}, skipped=${r.skipped}`);
    }
  } catch (err) {
    console.error("⚠️ [Antigravity] live flush error:", err);
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
      if (path.basename(filename) !== CHAT_FILE) return;
      scheduleFlush();
    });
    console.error(`📝 [Antigravity] dir watcher armed (recursive)`);
  } catch (err) {
    console.error("⚠️ [Antigravity] fs.watch failed — polling only:", err);
  }
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
      console.error(`📝 [Antigravity] final flush: inserted=${r.inserted}, dedup=${r.dedup}, skipped=${r.skipped}`);
    }
    return { inserted: r.inserted, skipped: r.skipped };
  } finally {
    _flushInProgress = false;
  }
}

export function isCaptureArmed(): boolean {
  return _state !== null && _state.rootExists;
}

export function resetCaptureState(): void {
  disarmDirWatcher();
  _state = null;
  _flushInProgress = false;
  _flushPending = false;
}
