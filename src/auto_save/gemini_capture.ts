/**
 * Gemini CLI 자동 캡처 — RESPEC PROBLEMS.md §5 (cross-platform passive capture).
 *
 * Gemini transcript: ~/.gemini/tmp/<projectKey>/chats/session-<ts>-<short>.json
 *   - projectKey 후보: SHA256(cwd) (64 hex) 또는 basename(cwd) — 둘 다 시도
 *   - jsonl 아님 — 단일 JSON 파일 전체 atomic replace
 *   - top-level: { kind, lastUpdated, messages, projectHash, sessionId, startTime }
 *
 * jsonl_capture / codex_capture와 다른 점:
 *   - cursor = byte offset이 아니라 messages.length (array index)
 *   - file이 grow하면 messages array가 길어짐 (mid-write JSON 깨짐 위험 → parse retry)
 *   - per-msg UUID = messages[i].id (gemini가 자체 부여) → external_uuid `gemini:<sid>:<id>`
 *
 * 캡처 대상:
 *   - messages[].type = 'user' → user role, content = content[].text 합치기
 *   - messages[].type = 'gemini' → assistant role, content = string (또는 array fallback)
 *   - thoughts / toolCalls 노이즈는 캡처 안 함 (raw 메시지만)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { insertRawMemory } from "../hot_path.js";
import { getDefaultUserId } from "../users.js";

const CLIENT_PLATFORM = "gemini-cli-mcp-client";
const GEMINI_TMP_ROOT = path.join(os.homedir(), ".gemini", "tmp");
const FLUSH_DEBOUNCE_MS = 200;
const PARSE_RETRY_MS = 80; // mid-write JSON 깨질 때 잠깐 backoff

interface FileState {
  /** 다음 read 시작 array index. arm 시점 messages.length 또는 신규 파일이면 0. */
  cursorIndex: number;
  /** 파일에서 추출한 sessionId (top-level field). 없으면 file basename에서 추출. */
  sessionId: string;
}

interface DirState {
  cwd: string;
  /** 활성 chats 디렉토리 (가장 가능성 높은 후보 1~2개). */
  chatsDirs: string[];
  files: Map<string, FileState>;
}

let _state: DirState | null = null;

const _watchers: fs.FSWatcher[] = [];
let _flushInProgress = false;
let _flushPending = false;
let _flushDebounceTimer: NodeJS.Timeout | null = null;

/** session 파일명에서 short id 추출 (sessionId fallback). */
function extractShortId(filename: string): string {
  const m = filename.match(/^session-.+?-([0-9a-f]+)\.json$/);
  return m ? m[1] : filename.replace(/\.json$/, "");
}

/** chats dir 후보 — SHA256(cwd) + basename(cwd) 둘 다 시도. */
function deriveChatsDirCandidates(cwd: string): string[] {
  const cwdHash = crypto.createHash("sha256").update(cwd).digest("hex");
  const candidates = [
    path.join(GEMINI_TMP_ROOT, cwdHash, "chats"),
    path.join(GEMINI_TMP_ROOT, path.basename(cwd), "chats"),
  ];
  return candidates.filter((d) => fs.existsSync(d));
}

interface GeminiMessage {
  id?: string;
  timestamp?: string;
  type?: string;
  content?: any;
  model?: string;
}

interface GeminiSessionFile {
  sessionId?: string;
  messages?: GeminiMessage[];
}

/**
 * file 전체 read + JSON parse. mid-write로 깨졌을 수 있어 한 번 retry.
 */
async function readSessionFile(filePath: string): Promise<GeminiSessionFile | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      if (!raw.trim()) return null;
      return JSON.parse(raw);
    } catch {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, PARSE_RETRY_MS));
        continue;
      }
      return null;
    }
  }
  return null;
}

export interface ParsedEntry {
  msgId: string;
  role: "user" | "assistant";
  message: string;
  agent_model: string | null;
}

/** Gemini message → ParsedEntry | null. content variability (array vs string) 처리. */
export function parseMessage(msg: GeminiMessage, fallbackId: string): ParsedEntry | null {
  let role: "user" | "assistant";
  if (msg.type === "user") role = "user";
  else if (msg.type === "gemini") role = "assistant";
  else return null;

  let text = "";
  const c = msg.content;
  if (typeof c === "string") {
    text = c;
  } else if (Array.isArray(c)) {
    for (const block of c) {
      if (block && typeof block === "object" && typeof block.text === "string") {
        text += (text ? "\n" : "") + block.text;
      }
    }
  }
  text = text.trim();
  if (!text) return null;

  const msgId = typeof msg.id === "string" && msg.id ? msg.id : fallbackId;
  const agent_model = role === "assistant" && typeof msg.model === "string" ? msg.model : null;

  return { msgId, role, message: text, agent_model };
}

async function flushDeltaForFile(
  filePath: string,
  fileState: FileState
): Promise<{ inserted: number; skipped: number; dedup: number }> {
  const session = await readSessionFile(filePath);
  if (!session || !Array.isArray(session.messages)) {
    return { inserted: 0, skipped: 0, dedup: 0 };
  }

  const messages = session.messages;
  if (messages.length <= fileState.cursorIndex) {
    return { inserted: 0, skipped: 0, dedup: 0 };
  }

  // sessionId가 top-level에 있으면 그걸로 갱신 (probe 시 fallback이었을 수 있음)
  if (typeof session.sessionId === "string" && session.sessionId) {
    fileState.sessionId = session.sessionId;
  }

  const userId = await getDefaultUserId();
  let inserted = 0, skipped = 0, dedup = 0;

  for (let i = fileState.cursorIndex; i < messages.length; i++) {
    const msg = messages[i];
    const fallbackId = `${fileState.sessionId}-${i}`;
    const parsed = parseMessage(msg, fallbackId);
    if (!parsed) {
      skipped++;
      continue;
    }
    const externalUuid = `gemini:${fileState.sessionId}:${parsed.msgId}`;
    const agentModel =
      parsed.role === "user" ? null : (parsed.agent_model ?? "unknown");

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
      console.error(`⚠️ [Gemini] insert failed at index ${i}:`, err);
      skipped++;
    }
  }

  fileState.cursorIndex = messages.length;
  return { inserted, skipped, dedup };
}

async function flushAllFiles(): Promise<{ inserted: number; skipped: number; dedup: number }> {
  if (!_state) return { inserted: 0, skipped: 0, dedup: 0 };

  let totalI = 0, totalS = 0, totalD = 0;

  for (const dir of _state.chatsDirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      if (!entry.name.startsWith("session-")) continue;
      const filePath = path.join(dir, entry.name);

      let fileState = _state.files.get(filePath);
      if (!fileState) {
        // 신규 — cursor 0부터 전체 캡처
        const sessionId = extractShortId(entry.name);
        fileState = { cursorIndex: 0, sessionId };
        _state.files.set(filePath, fileState);
        console.error(`📝 [Gemini] new session detected: ${entry.name}`);
      }

      const r = await flushDeltaForFile(filePath, fileState);
      totalI += r.inserted;
      totalS += r.skipped;
      totalD += r.dedup;
    }
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
      console.error(`📝 [Gemini] live flush: inserted=${r.inserted}, dedup=${r.dedup}, skipped=${r.skipped}`);
    }
  } catch (err) {
    console.error("⚠️ [Gemini] live flush error:", err);
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

export function captureSessionStart(cwd: string): void {
  const chatsDirs = deriveChatsDirCandidates(cwd);
  _state = { cwd, chatsDirs, files: new Map() };

  if (chatsDirs.length === 0) {
    return;
  }

  // 기존 session 파일 snapshot — cursor = messages.length
  let count = 0;
  for (const dir of chatsDirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      if (!entry.name.startsWith("session-")) continue;
      const filePath = path.join(dir, entry.name);

      let session: GeminiSessionFile | null = null;
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        session = JSON.parse(raw);
      } catch {
        // 깨졌거나 mid-write — cursor 0으로 두고 다음 flush에서 재시도
        session = null;
      }
      const sessionId =
        (session && typeof session.sessionId === "string" && session.sessionId) ||
        extractShortId(entry.name);
      const cursorIndex =
        session && Array.isArray(session.messages) ? session.messages.length : 0;
      _state.files.set(filePath, { cursorIndex, sessionId });
      count++;
    }
  }

  console.error(
    `📝 [Gemini] capture armed: ${count} session(s) across ${chatsDirs.length} chats dir(s)`
  );
  armDirWatchers();
}

function armDirWatchers(): void {
  if (!_state) return;
  if (_watchers.length > 0) return;
  for (const dir of _state.chatsDirs) {
    try {
      const w = fs.watch(dir, (_evt, filename) => {
        if (filename && !filename.endsWith(".json")) return;
        scheduleFlush();
      });
      _watchers.push(w);
    } catch (err) {
      console.error(`⚠️ [Gemini] fs.watch ${dir} failed:`, err);
    }
  }
  if (_watchers.length > 0) {
    console.error(`📝 [Gemini] dir watcher(s) armed: ${_watchers.length}`);
  }
}

function disarmDirWatchers(): void {
  if (_flushDebounceTimer) {
    clearTimeout(_flushDebounceTimer);
    _flushDebounceTimer = null;
  }
  for (const w of _watchers) {
    try { w.close(); } catch {}
  }
  _watchers.length = 0;
}

export async function captureSessionEnd(): Promise<{ inserted: number; skipped: number; error?: string }> {
  disarmDirWatchers();

  const waitStart = Date.now();
  while (_flushInProgress && Date.now() - waitStart < 2000) {
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!_state || _state.chatsDirs.length === 0) {
    return { inserted: 0, skipped: 0, error: "session not armed" };
  }

  _flushInProgress = true;
  try {
    const r = await flushAllFiles();
    if (r.inserted > 0 || r.skipped > 0 || r.dedup > 0) {
      console.error(`📝 [Gemini] final flush: inserted=${r.inserted}, dedup=${r.dedup}, skipped=${r.skipped}`);
    }
    return { inserted: r.inserted, skipped: r.skipped };
  } finally {
    _flushInProgress = false;
  }
}

export function resetCaptureState(): void {
  disarmDirWatchers();
  _state = null;
  _flushInProgress = false;
  _flushPending = false;
}
