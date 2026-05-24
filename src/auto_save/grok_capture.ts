/**
 * Grok Build (xAI CLI) 자동 캡처 — RESPEC PROBLEMS.md §5 (cross-platform passive capture).
 *
 * Grok transcript: ~/.grok/sessions/<urlencoded-cwd>/<session-uuid>/chat_history.jsonl
 *   (예: ~/.grok/sessions/%2Fhome%2Fadmin_3alab/019e5a75-...-bfd8a5ae3577/chat_history.jsonl)
 *
 * codex_capture.ts 패턴 복제 + Grok 고유 처리:
 *   - dir 구조: <cwd를 encodeURIComponent한 폴더>/<session UUID 폴더>/chat_history.jsonl.
 *     codex처럼 session_meta로 cwd 비교할 필요 없음 — sessions root 전체 recursive walk.
 *     (중복은 external_uuid ON CONFLICT로 dedup.)
 *   - ⚠️ codex/gemini와 결정적 차이: grok은 chat_history.jsonl을 **순수 append가 아니라
 *     세션 초기에 prefix를 in-place rewrite** 한다 (MCP 연결 확정 시 system-reminder가
 *     커지면서 그 뒤 줄들의 byte offset이 통째로 밀림). 실측: 첫 user_query가
 *     31988 → 32825로 +837 이동. 따라서 codex식 byte-offset cursor/uuid를 쓰면
 *     같은 메시지가 다른 offset으로 재INSERT되어 첫 메시지가 2번 찍힘.
 *     → cursor·external_uuid를 **byte offset이 아니라 line index** 기준으로.
 *       rewrite는 줄 "내용 확장"이지 "줄 삽입"이 아님(실측: user_query는 항상 line 4)
 *       → line index는 안정적이라 dedup이 정확히 작동.
 *   - per-msg UUID 없음 → external_uuid = `grok:<sid>:<lineIndex>` (sid = 부모 폴더명 UUID).
 *   - 엔트리: { type, content, model_id?, tool_calls?, synthetic_reason?, reasoning? }
 *       · type=user      → content은 [{type:'text',text}] 블록 배열. 실제 입력은
 *                          <user_query>...</user_query>로 감싸짐. 그 안쪽만 캡처.
 *                          <user_info>/<system-reminder>(synthetic_reason) 주입분은 skip.
 *       · type=assistant → content은 문자열. 빈 문자열이면 tool-call-only 턴 → skip.
 *                          model_id(="grok-build")가 agent_model.
 *       · type=system / tool_result → skip.
 *   - timestamp는 안 넘김 — DB가 INSERT 시점 now()로 자동. hot path가 실시간 read라 정합.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { insertRawMemory } from "../hot_path.js";
import { getDefaultUserId } from "../users.js";

const DEVICE_NAME = os.hostname();
const SESSIONS_ROOT = path.join(os.homedir(), ".grok", "sessions");
const CHAT_FILE = "chat_history.jsonl";
const AGENT_PLATFORM = "grok-cli";
const FLUSH_DEBOUNCE_MS = 200;
const POLL_INTERVAL_MS = 3000; // OS 버퍼링 우회 — fs.watch 미발화 보완

interface FileState {
  /** 이미 처리한 완결 줄 수. 다음 flush는 이 index부터 처리. arm/신규발견 시 baseline. */
  cursorLines: number;
  /** 마지막으로 본 file size. 안 바뀌면 새 줄 없음 → read skip (효율). */
  lastSize: number;
  /** chat_history.jsonl의 부모 폴더명 = session UUID. */
  sessionId: string;
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

/** chat_history.jsonl 경로 → session UUID (부모 폴더명). */
function extractSessionId(filePath: string): string {
  return path.basename(path.dirname(filePath));
}

/** 파일의 완결 줄 수 (= '\n' 개수). 끝에 newline 없는 미완성 줄은 제외. */
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
 * sessions root 아래 모든 chat_history.jsonl 경로 yield (재귀 walk).
 */
function* walkChatHistories(root: string): Generator<string> {
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

  // 기존 chat_history snapshot — cursor = 현재 완결 줄 수 (pre-existing 내용 skip)
  let count = 0;
  for (const filePath of walkChatHistories(SESSIONS_ROOT)) {
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { continue; }

    _state.files.set(filePath, {
      cursorLines: countCompleteLines(filePath),
      lastSize: stat.size,
      sessionId: extractSessionId(filePath),
    });
    count++;
  }

  console.error(`📝 [Grok] capture armed: ${count} chat_history(s)`);
  armDirWatcher();
}

export interface ParsedEntry {
  /** file 내 line index (0-based) — external_uuid 합성에 사용 (byte offset 아님). */
  lineIndex: number;
  role: "user" | "assistant";
  message: string;
  /** assistant 턴의 model_id (user면 null). */
  agentModel: string | null;
}

/** content (string | [{type,text}]) → 평문 텍스트. */
function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/** <user_query>...</user_query> 안쪽 텍스트. 없으면 null (= system-injected). */
function extractUserQuery(text: string): string | null {
  const m = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  return m ? m[1].trim() : null;
}

/**
 * 한 jsonl line → ParsedEntry | null.
 * type=user (<user_query>만) / type=assistant (비어있지 않은 content)만 캡처.
 * system / tool_result / 주입성(user_info, system_reminder) 메시지는 skip.
 */
export function parseEntry(line: string, lineIndex: number): ParsedEntry | null {
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }

  const type = entry.type;

  if (type === "user") {
    // synthetic_reason 있는 건 system_reminder 등 주입 메시지 — skip
    if (entry.synthetic_reason) return null;
    const text = extractText(entry.content);
    const query = extractUserQuery(text);
    // <user_query> 없으면 <user_info> 같은 system-injected → skip
    if (!query) return null;
    return { lineIndex, role: "user", message: query, agentModel: null };
  }

  if (type === "assistant") {
    const message = extractText(entry.content).trim();
    if (!message) return null; // tool-call-only 턴 (content 빈 문자열)
    const model = typeof entry.model_id === "string" && entry.model_id
      ? entry.model_id
      : "unknown";
    return { lineIndex, role: "assistant", message, agentModel: model };
  }

  // system / tool_result 등 → skip
  return null;
}

async function flushDeltaForFile(
  filePath: string,
  fileState: FileState,
): Promise<{ inserted: number; skipped: number; dedup: number }> {
  let stat: fs.Stats;
  try { stat = fs.statSync(filePath); } catch { return { inserted: 0, skipped: 0, dedup: 0 }; }

  // size 안 바뀌면 새 줄 없음 (append든 in-place rewrite든 byte 수 변함) → read skip
  if (stat.size === fileState.lastSize) return { inserted: 0, skipped: 0, dedup: 0 };

  let content: string;
  try { content = fs.readFileSync(filePath, "utf-8"); }
  catch { return { inserted: 0, skipped: 0, dedup: 0 }; }

  fileState.lastSize = stat.size;

  // 끝 element는 trailing '' (newline으로 끝남) 또는 미완성 줄 → 둘 다 제외
  const completeLines = content.split("\n").slice(0, -1);
  const total = completeLines.length;
  // 줄 수 안 늘었으면 (prefix in-place 확장만 일어난 경우 등) 처리할 새 줄 없음.
  // 이미 처리한 줄(index < cursorLines)은 절대 재처리 안 함 → 중복 INSERT 방지.
  if (total <= fileState.cursorLines) return { inserted: 0, skipped: 0, dedup: 0 };

  const userId = await getDefaultUserId();
  let inserted = 0, skipped = 0, dedup = 0;

  for (let i = fileState.cursorLines; i < total; i++) {
    const line = completeLines[i].trim();
    if (!line) continue;

    const parsed = parseEntry(line, i);
    if (!parsed) {
      skipped++;
      continue;
    }

    const externalUuid = `grok:${fileState.sessionId}:${parsed.lineIndex}`;

    try {
      const result = await insertRawMemory({
        user_id: userId,
        agent_platform: AGENT_PLATFORM,
        agent_model: parsed.agentModel,
        role: parsed.role,
        message: parsed.message,
        external_uuid: externalUuid,
        device_name: DEVICE_NAME,
      });
      if (result.inserted) inserted++;
      else dedup++;
    } catch (err) {
      console.error(`⚠️ [Grok] insert failed at line ${i}:`, err);
      skipped++;
    }
  }

  fileState.cursorLines = total;
  return { inserted, skipped, dedup };
}

async function flushAllFiles(): Promise<{ inserted: number; skipped: number; dedup: number }> {
  if (!_state || !_state.rootExists) return { inserted: 0, skipped: 0, dedup: 0 };

  let totalI = 0, totalS = 0, totalD = 0;

  for (const filePath of walkChatHistories(SESSIONS_ROOT)) {
    let fileState = _state.files.get(filePath);
    if (!fileState) {
      // 서버 시작 이전에 이미 존재하던 파일 → 기존 내용 skip (cursor = 현재 줄 수).
      // 과거 grok 세션이 startup 시 대량 삽입되는 것 방지.
      let stat: fs.Stats | null = null;
      try { stat = fs.statSync(filePath); } catch {}
      const fileBirthMs = stat ? stat.birthtimeMs || stat.ctimeMs : SERVER_START_MS;
      const isPreExisting = fileBirthMs < SERVER_START_MS - 5000; // 5s 여유
      const initialCursor = isPreExisting ? countCompleteLines(filePath) : 0;
      const initialSize = isPreExisting ? (stat?.size ?? 0) : 0;

      if (isPreExisting) {
        console.error(`📝 [Grok] pre-existing session skipped (lines=${initialCursor}): ${extractSessionId(filePath)}`);
      } else {
        console.error(`📝 [Grok] new session detected: ${extractSessionId(filePath)}`);
      }

      fileState = {
        cursorLines: initialCursor,
        lastSize: initialSize,
        sessionId: extractSessionId(filePath),
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
      console.error(`📝 [Grok] live flush: inserted=${r.inserted}, dedup=${r.dedup}, skipped=${r.skipped}`);
    }
  } catch (err) {
    console.error("⚠️ [Grok] live flush error:", err);
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
    console.error(`📝 [Grok] dir watcher armed (recursive)`);
  } catch (err) {
    console.error("⚠️ [Grok] fs.watch failed — polling only:", err);
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
      console.error(`📝 [Grok] final flush: inserted=${r.inserted}, dedup=${r.dedup}, skipped=${r.skipped}`);
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
