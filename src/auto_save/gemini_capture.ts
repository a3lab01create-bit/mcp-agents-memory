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
const DEVICE_NAME = os.hostname();
const GEMINI_TMP_ROOT = path.join(os.homedir(), ".gemini", "tmp");
const FLUSH_DEBOUNCE_MS = 200;
const PARSE_RETRY_MS = 80; // mid-write JSON 깨질 때 잠깐 backoff
const POLL_INTERVAL_MS = 3000; // OS 버퍼링 우회

interface FileState {
  /** json: messages array index / jsonl: byte offset */
  cursor: number;
  format: "json" | "jsonl";
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
let _pollTimer: NodeJS.Timeout | null = null;
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
  else return null; // info / $set / 기타 타입 skip

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

  // Gemini CLI 시스템 주입 메시지 필터 (사용자 실발화 아님)
  if (text.startsWith("System:") || text === "Please continue.") return null;

  const msgId = typeof msg.id === "string" && msg.id ? msg.id : fallbackId;
  const agent_model = role === "assistant" && typeof msg.model === "string" ? msg.model : null;

  return { msgId, role, message: text, agent_model };
}

async function flushDeltaForFile(
  filePath: string,
  fileState: FileState,
  contentSeen: Set<string>,
): Promise<{ inserted: number; skipped: number; dedup: number }> {
  return fileState.format === "jsonl"
    ? flushJsonlFile(filePath, fileState, contentSeen)
    : flushJsonFile(filePath, fileState, contentSeen);
}

/** 구버전 .json (배열 전체 atomic replace) 처리 */
async function flushJsonFile(
  filePath: string,
  fileState: FileState,
  contentSeen: Set<string>,
): Promise<{ inserted: number; skipped: number; dedup: number }> {
  const session = await readSessionFile(filePath);
  if (!session || !Array.isArray(session.messages)) {
    return { inserted: 0, skipped: 0, dedup: 0 };
  }

  const messages = session.messages;
  if (messages.length <= fileState.cursor) {
    return { inserted: 0, skipped: 0, dedup: 0 };
  }

  if (typeof session.sessionId === "string" && session.sessionId) {
    fileState.sessionId = session.sessionId;
  }

  const userId = await getDefaultUserId();
  let inserted = 0, skipped = 0, dedup = 0;

  for (let i = fileState.cursor; i < messages.length; i++) {
    const msg = messages[i];
    const fallbackId = `${fileState.sessionId}-${i}`;
    const parsed = parseMessage(msg, fallbackId);
    if (!parsed) { skipped++; continue; }
    const ck = `${parsed.role}::${parsed.message}`;
    if (contentSeen.has(ck)) { dedup++; continue; }
    contentSeen.add(ck);
    const externalUuid = `gemini:${fileState.sessionId}:${parsed.msgId}`;
    const agentModel = parsed.role === "user" ? null : (parsed.agent_model ?? "unknown");
    try {
      const result = await insertRawMemory({
        user_id: userId, agent_platform: CLIENT_PLATFORM, agent_model: agentModel,
        role: parsed.role, message: parsed.message,
        external_uuid: externalUuid, device_name: DEVICE_NAME,
      });
      if (result.inserted) inserted++; else dedup++;
    } catch (err) {
      console.error(`⚠️ [Gemini] insert failed at index ${i}:`, err);
      skipped++;
    }
  }

  fileState.cursor = messages.length;
  return { inserted, skipped, dedup };
}

/** 신버전 .jsonl (라인별 append) 처리 */
async function flushJsonlFile(
  filePath: string,
  fileState: FileState,
  contentSeen: Set<string>,
): Promise<{ inserted: number; skipped: number; dedup: number }> {
  if (!fs.existsSync(filePath)) return { inserted: 0, skipped: 0, dedup: 0 };
  let stat: fs.Stats;
  try { stat = fs.statSync(filePath); } catch { return { inserted: 0, skipped: 0, dedup: 0 }; }
  if (stat.size <= fileState.cursor) return { inserted: 0, skipped: 0, dedup: 0 };

  const length = stat.size - fileState.cursor;
  const fd = fs.openSync(filePath, "r");
  let raw: string;
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, fileState.cursor);
    raw = buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }

  const lastNl = raw.lastIndexOf("\n");
  if (lastNl === -1) return { inserted: 0, skipped: 0, dedup: 0 };

  const parsable = raw.slice(0, lastNl);
  const advanceBy = Buffer.byteLength(parsable, "utf-8") + 1;
  const newCursor = fileState.cursor + advanceBy;

  const userId = await getDefaultUserId();
  let inserted = 0, skipped = 0, dedup = 0;
  let lineIdx = fileState.cursor === 0 ? 0 : -1; // 0이면 첫 줄(세션 메타) 포함

  for (const line of parsable.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) { lineIdx++; continue; }
    let obj: any;
    try { obj = JSON.parse(trimmed); } catch { lineIdx++; continue; }

    // 첫 줄 — 세션 메타에서 sessionId 추출
    if (lineIdx === 0 && typeof obj.sessionId === "string" && obj.sessionId) {
      fileState.sessionId = obj.sessionId;
      lineIdx++;
      continue;
    }
    lineIdx++;

    // $set — 메타 업데이트, skip
    if (obj.$set !== undefined) continue;

    const parsed = parseMessage(obj, `${fileState.sessionId}-${lineIdx}`);
    if (!parsed) { skipped++; continue; }

    const ck = `${parsed.role}::${parsed.message}`;
    if (contentSeen.has(ck)) { dedup++; continue; }
    contentSeen.add(ck);

    const externalUuid = `gemini:${fileState.sessionId}:${parsed.msgId}`;
    const agentModel = parsed.role === "user" ? null : (parsed.agent_model ?? "unknown");
    try {
      const result = await insertRawMemory({
        user_id: userId, agent_platform: CLIENT_PLATFORM, agent_model: agentModel,
        role: parsed.role, message: parsed.message,
        external_uuid: externalUuid, device_name: DEVICE_NAME,
      });
      if (result.inserted) inserted++; else dedup++;
    } catch (err) {
      console.error(`⚠️ [Gemini] jsonl insert failed:`, err);
      skipped++;
    }
  }

  fileState.cursor = newCursor;
  return { inserted, skipped, dedup };
}

export function isCaptureArmed(): boolean {
  return _state !== null && _state.chatsDirs.length > 0;
}

async function flushAllFiles(): Promise<{ inserted: number; skipped: number; dedup: number }> {
  if (!_state) return { inserted: 0, skipped: 0, dedup: 0 };

  let totalI = 0, totalS = 0, totalD = 0;
  // 동일 flush pass 내 content 기반 dedup (같은 메시지가 .json + .jsonl에 동시 존재할 때 방지)
  const contentSeen = new Set<string>();

  for (const dir of _state.chatsDirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("session-")) continue;
      if (!entry.name.endsWith(".json") && !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, entry.name);

      let fileState = _state.files.get(filePath);
      if (!fileState) {
        // 신규 — cursor 0부터 전체 캡처
        const sessionId = extractShortId(entry.name);
        const format: "json" | "jsonl" = entry.name.endsWith(".jsonl") ? "jsonl" : "json";
        fileState = { cursor: 0, format, sessionId };
        _state.files.set(filePath, fileState);
        console.error(`📝 [Gemini] new session detected: ${entry.name} (${format})`);
      }

      const r = await flushDeltaForFile(filePath, fileState, contentSeen);
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
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("session-")) continue;
      if (!entry.name.endsWith(".json") && !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, entry.name);

      const format: "json" | "jsonl" = entry.name.endsWith(".jsonl") ? "jsonl" : "json";
      const sessionId = extractShortId(entry.name);
      let cursor = 0;

      let realSessionId = sessionId;
      if (format === "json") {
        let session: GeminiSessionFile | null = null;
        try { session = JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch {}
        cursor = session && Array.isArray(session.messages) ? session.messages.length : 0;
        if (session?.sessionId) realSessionId = session.sessionId;
      } else {
        // jsonl: cursor = 현재 파일 크기 (기존 내용 skip).
        // 헤더 라인에서 정확한 sessionId 추출 — extractShortId regex는 .jsonl 불일치로
        // 잘못된 sessionId를 반환, 다른 프로세스와 external_uuid가 달라져 ON CONFLICT 우회됨.
        try { cursor = fs.statSync(filePath).size; } catch {}
        try {
          const fd = fs.openSync(filePath, "r");
          const buf = Buffer.alloc(512);
          const n = fs.readSync(fd, buf, 0, 512, 0);
          fs.closeSync(fd);
          const firstLine = buf.slice(0, n).toString("utf-8").split("\n")[0].trim();
          const header = JSON.parse(firstLine);
          if (typeof header.sessionId === "string" && header.sessionId) {
            realSessionId = header.sessionId;
          }
        } catch {}
      }

      _state.files.set(filePath, { cursor, format, sessionId: realSessionId });
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
        if (filename && !filename.endsWith(".json") && !filename.endsWith(".jsonl")) return;
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
  _pollTimer = setInterval(() => { void flushWithMutex(); }, POLL_INTERVAL_MS);
}

function disarmDirWatchers(): void {
  if (_flushDebounceTimer) {
    clearTimeout(_flushDebounceTimer);
    _flushDebounceTimer = null;
  }
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
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
