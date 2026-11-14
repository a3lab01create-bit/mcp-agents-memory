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
 * **작업 폴더가 "/" 일 때 = 전체 감시 (2026-11-14)**
 *   클로드 데스크톱 앱은 폴더 없이("this computer") 연 세션의 MCP 서버를 "/" 에서 띄운다.
 *   cwd 로 project dir 을 짐작할 수 없어서 예전엔 10초 재시도 뒤 조용히 포기했다 →
 *   그 세션 대화가 통째로 빠졌다 (맥북 c561dd53, 11-09~10 실측). 이제 cwd 가 파일시스템
 *   루트면 ~/.claude/projects/<slug>/*.jsonl **전부**를 지켜본다 (codex_capture 와 같은 방식,
 *   재귀 watch + 3초 폴링). 그 밖의 cwd 는 예전대로 그 폴더 하나만 본다 — 다른 클라이언트가
 *   띄운 서버가 기계 전체 클로드 대화를 줍지 않게 범위를 좁혀 둔다.
 *   하위 폴더의 jsonl(<sid>/subagents/agent-*.jsonl 등)은 어느 모드에서도 안 읽는다.
 *
 * **arm 직전에 생긴 파일은 처음부터 (2026-11-14)**
 *   예전엔 arm 시점에 이미 있던 파일을 전부 cursor=size 로 잡아서, 서버보다 먼저(또는 재시도
 *   10초 사이에) 생긴 세션 파일의 앞부분이 영구 누락됐다. 이제 arm 시작 60초 전 이후에 **생긴**
 *   (birthtime) 파일은 0 부터 읽는다. 겹쳐 읽혀도 external_uuid ON CONFLICT 가 막는다.
 *
 * Partial line 안전: fs.watch가 line 중간에 fire될 수 있어 마지막 \n까지만
 * parse + cursor 전진. \n 없는 trailing은 다음 flush에 흡수.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { insertRawMemory } from "../hot_path.js";
import { buzzTurnVenue, classifySessionVenue, lastBuzzVenueInFile, type SessionVenueKind } from "./venue.js";
import { getDefaultUserId } from "../users.js";

const CLIENT_PLATFORM = "claude-code"; // 본 모듈은 Claude Code 전용
const DEVICE_NAME = os.hostname();
const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");
const FLUSH_DEBOUNCE_MS = 200; // fs.watch 다중 fire coalescing
const GLOBAL_POLL_INTERVAL_MS = 3000; // 전체 감시 모드: fs.watch 누락 보완 (codex_capture 와 같은 값)
/** arm 시작 이 시간 전 이후에 생긴 파일은 0 부터 읽는다. 검사에서만 MEMORY_JSONL_FRESH_MS 로 바꾼다. */
const FRESH_FILE_MS = 60_000;

interface FileState {
  /** 다음 read 시작 byte offset. 초기값 = arm 시점 size (또는 신규 파일이면 0).
   *  flushDeltaForFile 성공 후 마지막 \n 위치까지 전진. */
  cursorBytes: number;
  sessionId: string;
  /** Claude Code가 tool 컨텍스트 재구성 시 같은 user 메시지를 다른 uuid로 재기록.
   *  uuid 기반 external_uuid만으론 dedup 불가 → content 기반 dedup (role::text). */
  contentSeen: Set<string>;
  /** 세션의 대화 자리 — 첫 user 턴으로 한 번 정한다 (undefined = 아직 안 봄, null = 모름). */
  venueKind?: SessionVenueKind | null;
  /** 버즈 세션: 가장 최근 턴의 venue (답글은 이걸 따른다). undefined = 아직 안 찾아봄. */
  buzzVenue?: string | null;
}

/**
 * 수집 상태.
 *   pending = project dir 찾는 중 (재시도 10초 안)
 *   dir     = cwd 의 project dir 하나를 본다
 *   global  = cwd 가 루트라 ~/.claude/projects 전체를 본다
 *   off     = 수집 안 함 (reason 에 이유)
 */
export type CaptureMode = "pending" | "dir" | "global" | "off";

interface DirState {
  cwd: string;
  mode: CaptureMode;
  /** mode=off 일 때 이유. */
  reason?: string;
  /** captureSessionStart 시각 — 갓 생긴 파일 판정 기준. */
  startedAtMs: number;
  projectDir: string | null;
  /** jsonlPath → FileState. arm 시점에 존재한 파일 + 이후 발견된 신규 파일. */
  files: Map<string, FileState>;
}

let _state: DirState | null = null;

// --- watcher / mutex state ---
let _watcher: fs.FSWatcher | null = null;
let _pollTimer: NodeJS.Timeout | null = null;
let _flushInProgress = false;
let _flushPending = false;
let _flushDebounceTimer: NodeJS.Timeout | null = null;

/**
 * cwd → Claude Code project dir 탐색.
 *
 * 1차: slug 직접 계산 (cwd의 '/' → '-'). JSONL 없어도 즉시 확정.
 *    타이밍 문제(MCP가 JSONL 생성 전에 시작) 완전 해소.
 * 2차: fallback — JSONL cwd 필드 스캔 (레거시 slug 변환이 다른 경우 대비).
 */
/** Claude Code slug 알고리즘: 영숫자 제외 모든 문자 → '-' (슬래시, 언더스코어 등 포함). */
function cwdToSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function findProjectDir(cwd: string): string | null {
  // 1차: slug 직접 계산 (Claude Code와 동일 알고리즘 — 영숫자 외 전부 '-')
  const slug = cwdToSlug(cwd);
  const slugPath = path.join(PROJECTS_ROOT, slug);
  try {
    if (fs.statSync(slugPath).isDirectory()) return slugPath;
  } catch { /* not found — fallback */ }

  // 2차: JSONL cwd 필드 스캔 (fallback)
  let subdirs: fs.Dirent[];
  try {
    subdirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const subdir of subdirs) {
    if (!subdir.isDirectory()) continue;
    const dirPath = path.join(PROJECTS_ROOT, subdir.name);

    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    // 모든 JSONL 체크 (find → some으로 변경해 첫 파일만 보는 버그 수정)
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const foundCwd = readCwdFromJsonl(path.join(dirPath, f.name));
      if (foundCwd === cwd) return dirPath;
    }
  }

  return null;
}

/** JSONL 파일 첫 2KB에서 cwd 필드를 읽어 반환. 없으면 null. */
function readCwdFromJsonl(jsonlPath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(jsonlPath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(2048);
    const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
    const raw = buf.slice(0, bytesRead).toString("utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry.cwd === "string") return entry.cwd;
      } catch {
        // partial line — skip
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * server 시작 시 호출. projectDir 안 모든 jsonl size 스냅샷 + dir watcher arm.
 * 옛 entries backfill 안 함 (cursor = 시작 시점 size).
 *
 * 타이밍 안전: Claude Code가 MCP 시작 후 project dir / JSONL을 조금 뒤에 생성하는
 * 경우 대비 → 500ms 간격으로 최대 20회(10초) retry.
 */
export function captureSessionStart(cwd: string): void {
  _state = { cwd, mode: "pending", startedAtMs: Date.now(), projectDir: null, files: new Map() };
  // 데스크톱 앱이 폴더 없이 연 세션은 서버를 "/" 에서 띄운다 → cwd 로는 project dir 을 못 찾는다.
  if (isFilesystemRoot(cwd)) {
    armGlobal();
    return;
  }
  _tryArm(cwd, 0);
}

const _MAX_ARM_RETRIES = 20; // 20 × 500ms = 10s

function isFilesystemRoot(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  return resolved === path.parse(resolved).root;
}

/** 검사에서만 바꾼다 (MEMORY_JSONL_FRESH_MS). 잘못된 값이면 기본값. */
function freshWindowMs(): number {
  const raw = process.env.MEMORY_JSONL_FRESH_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : FRESH_FILE_MS;
}

/**
 * arm 시점에 이미 있던 파일의 시작 cursor.
 * arm 시작 직전(기본 60초 안)에 **생긴** 파일은 0 — 서버보다 먼저 쓰인 첫 턴을 살린다.
 * 그보다 오래된 파일은 예전대로 끝(size)부터 — 옛 대화를 통째로 다시 넣지 않는다.
 * birthtime 을 못 주는 파일시스템(0)이면 예전 동작.
 */
function initialCursor(stat: fs.Stats, startedAtMs: number): number {
  const born = stat.birthtimeMs;
  return born > 0 && born >= startedAtMs - freshWindowMs() ? 0 : stat.size;
}

/** dir 안의 <sid>.jsonl 만 (하위 폴더는 안 본다). */
function listJsonlIn(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => path.join(dir, e.name));
}

/** 전체 감시 대상: ~/.claude/projects/<slug>/<sid>.jsonl. 점으로 시작하는 폴더(.omc 등)는 뺀다. */
function listAllProjectJsonl(): string[] {
  let slugs: fs.Dirent[];
  try {
    slugs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const s of slugs) {
    if (!s.isDirectory() || s.name.startsWith(".")) continue;
    out.push(...listJsonlIn(path.join(PROJECTS_ROOT, s.name)));
  }
  return out;
}

/** 지금 모드에서 볼 파일 목록. */
function listTrackedJsonl(): string[] {
  if (!_state) return [];
  if (_state.mode === "global") return listAllProjectJsonl();
  if (_state.mode === "dir" && _state.projectDir) return listJsonlIn(_state.projectDir);
  return [];
}

/** watch 이벤트의 파일 이름(PROJECTS_ROOT 기준 상대 경로)이 <slug>/<sid>.jsonl 모양인가. */
function isProjectJsonlEvent(filename: string): boolean {
  const parts = filename.split(/[\\/]/).filter(Boolean);
  return parts.length === 2 && !parts[0].startsWith(".") && parts[1].endsWith(".jsonl");
}

function snapshotFiles(paths: string[]): void {
  if (!_state) return;
  for (const jsonlPath of paths) {
    let stat: fs.Stats;
    try { stat = fs.statSync(jsonlPath); } catch { continue; }
    const sessionId = path.basename(jsonlPath).replace(/\.jsonl$/, "");
    _state.files.set(jsonlPath, {
      cursorBytes: initialCursor(stat, _state.startedAtMs),
      sessionId,
      contentSeen: new Set(),
    });
  }
}

function armGlobal(): void {
  if (!_state) return;
  if (!fs.existsSync(PROJECTS_ROOT)) {
    _state.mode = "off";
    _state.reason = `no ${PROJECTS_ROOT}`;
    console.error(`⚠️ [JSONL] cwd="${_state.cwd}" 전체 감시 불가 — ${PROJECTS_ROOT} 없음, capture 건너뜀`);
    return;
  }
  _state.mode = "global";
  snapshotFiles(listAllProjectJsonl());
  const fromStart = [..._state.files.values()].filter((f) => f.cursorBytes === 0).length;
  console.error(
    `📝 [JSONL] capture armed (global, cwd="${_state.cwd}"): ${_state.files.size} jsonl(s) under ${PROJECTS_ROOT}` +
    (fromStart ? `, ${fromStart} fresh file(s) read from start` : "")
  );
  armDirWatcher();
  // 갓 생긴 파일은 0 부터 → 이벤트를 기다리지 않고 한 번 바로 읽는다
  if (fromStart) scheduleFlush();
}

function _tryArm(cwd: string, attempt: number): void {
  const projectDir = findProjectDir(cwd);

  if (!projectDir) {
    if (attempt < _MAX_ARM_RETRIES) {
      setTimeout(() => {
        // 세션이 끊기거나 리셋됐으면 조용히 중단
        if (!_state || _state.cwd !== cwd) return;
        _tryArm(cwd, attempt + 1);
      }, 500);
    } else {
      // 10초 후에도 못 찾으면 진단 로그 남기고 포기 (memory_startup 이 이 상태를 보여 준다)
      if (_state && _state.cwd === cwd) {
        _state.mode = "off";
        _state.reason = `project dir not found for cwd "${cwd}"`;
      }
      console.error(
        `⚠️ [JSONL] project dir not found after ${_MAX_ARM_RETRIES} retries — capture 건너뜀.\n` +
        `   cwd="${cwd}"\n` +
        `   PROJECTS_ROOT="${PROJECTS_ROOT}"\n` +
        `   expected slug="${cwdToSlug(cwd)}"`
      );
    }
    return;
  }

  if (!_state || _state.cwd !== cwd) return; // race: session ended
  _state.projectDir = projectDir;
  _state.mode = "dir";

  // 기존 jsonl 모두 snapshot (갓 생긴 파일은 0 부터 — initialCursor)
  snapshotFiles(listJsonlIn(projectDir));
  const fromStart = [..._state.files.values()].filter((f) => f.cursorBytes === 0).length;

  if (attempt > 0) {
    console.error(`📝 [JSONL] project dir found on retry #${attempt}: ${path.basename(projectDir)}/`);
  }
  console.error(
    `📝 [JSONL] capture armed: ${_state.files.size} jsonl(s) in ${path.basename(projectDir)}/` +
    (fromStart ? `, ${fromStart} fresh file(s) read from start` : "")
  );

  armDirWatcher();
  if (fromStart) scheduleFlush();
}

export interface CaptureStatus {
  mode: CaptureMode;
  cwd: string | null;
  projectDir: string | null;
  files: number;
  reason?: string;
}

/** 지금 클로드 대화 수집이 어떤 상태인가 (memory_startup 이 "수집 안 되는 중" 경고에 쓴다). */
export function getCaptureStatus(): CaptureStatus {
  if (!_state) return { mode: "off", cwd: null, projectDir: null, files: 0, reason: "not started" };
  return {
    mode: _state.mode,
    cwd: _state.cwd,
    projectDir: _state.projectDir,
    files: _state.files.size,
    ...(_state.reason ? { reason: _state.reason } : {}),
  };
}

export interface ParsedEntry {
  uuid: string;
  role: 'user' | 'assistant';
  message: string;
  agent_model?: string;
  subagent?: boolean;
  subagent_model?: string;
  subagent_role?: string;
  /** Claude Code가 줄마다 남기는 실행 방식 (cli = 대화형, sdk-cli / sdk-ts = 프로그램 실행). */
  entrypoint?: string;
  /** 줄이 쓰인 시각 (ISO). 다시 채우기(backfill)에서만 created_at 으로 쓴다. */
  timestamp?: string;
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
    entrypoint: typeof entry.entrypoint === "string" ? entry.entrypoint : undefined,
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
  };
}

const HEAD_SCAN_BYTES = 2 * 1024 * 1024;

/**
 * 세션 파일 앞부분에서 첫 user 턴을 찾아 대화 자리를 정한다.
 * 첫 user 턴이 아직 안 써졌으면 undefined (다음 flush에 다시 본다). 앞 2MB를 다 봤는데도
 * 없으면(첫 줄이 거대한 경우 등) null로 포기한다.
 */
function sessionVenueKind(jsonlPath: string): SessionVenueKind | null | undefined {
  const fd = fs.openSync(jsonlPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(Math.min(HEAD_SCAN_BYTES, size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString("utf-8").split("\n")) {
      const parsed = line.trim() ? parseEntry(line) : null;
      if (parsed?.role === "user") return classifySessionVenue(parsed.message, parsed.entrypoint);
    }
    return size >= HEAD_SCAN_BYTES ? null : undefined;
  } finally {
    fs.closeSync(fd);
  }
}

const userTextOf = (line: string): string | null => {
  const parsed = parseEntry(line);
  return parsed?.role === "user" ? parsed.message : null;
};

interface FlushOptions {
  /** 다시 채우기: 줄의 timestamp 를 created_at 으로 (없거나 이상하면 NOW). 실시간 수집은 안 씀. */
  createdAtFromEntry?: boolean;
  /** 다시 채우기 미리보기: INSERT 없이 세기만. inserted = 넣을 줄 수 (DB 에 이미 있는지는 모름). */
  dryRun?: boolean;
}

/** jsonl timestamp → created_at 으로 쓸 값. 파싱 안 되면 null (NOW 로 들어간다). */
function entryCreatedAt(ts: string | undefined): Date | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * 한 jsonl 파일의 cursor부터 마지막 완성 line까지 읽고 INSERT, cursor 전진.
 * \n 없는 trailing partial은 보류, 다음 호출에 흡수.
 */
async function flushDeltaForFile(
  jsonlPath: string,
  fileState: FileState,
  opts: FlushOptions = {}
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
  const userId = opts.dryRun ? 0 : await getDefaultUserId();

  if (fileState.venueKind === undefined) {
    try { fileState.venueKind = sessionVenueKind(jsonlPath); } catch { fileState.venueKind = null; }
  }
  const deltaStart = fileState.cursorBytes;

  let inserted = 0, skipped = 0, dedup = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseEntry(trimmed);
    if (!parsed) {
      skipped++;
      continue;
    }
    // Claude Code가 tool 컨텍스트 재구성 시 user 메시지를 같은 내용 다른 uuid로 재기록 → dedup
    const ck = `${parsed.role}::${parsed.message}`;
    if (fileState.contentSeen.has(ck)) { dedup++; continue; }
    fileState.contentSeen.add(ck);

    const externalUuid = `claude-code:${fileState.sessionId}:${parsed.uuid}`;
    // 버즈 세션은 한 세션이 여러 채널을 번갈아 처리한다 → 답글은 바로 앞 턴의 채널을 따른다.
    let venue: string | null = fileState.venueKind ?? null;
    if (fileState.venueKind === "buzz") {
      const own = parsed.role === "user" ? buzzTurnVenue(parsed.message) : null;
      if (own) {
        fileState.buzzVenue = own;
      } else if (fileState.buzzVenue === undefined) {
        try { fileState.buzzVenue = lastBuzzVenueInFile(jsonlPath, deltaStart, userTextOf); } catch { fileState.buzzVenue = null; }
      }
      venue = own ?? fileState.buzzVenue ?? "buzz";
    }
    // user role: agent_model = null (사람이 친 거, N/A). assistant: 모델 명 (없으면 'unknown').
    const agentModel = parsed.role === 'user' ? null : (parsed.agent_model ?? 'unknown');
    if (opts.dryRun) { inserted++; continue; }
    const createdAt = opts.createdAtFromEntry ? entryCreatedAt(parsed.timestamp) : null;
    try {
      const result = await insertRawMemory({
        user_id: userId,
        agent_platform: CLIENT_PLATFORM,
        agent_model: agentModel,
        role: parsed.role,
        message: parsed.message,
        external_uuid: externalUuid,
        device_name: DEVICE_NAME,
        venue,
        ...(createdAt ? { created_at: createdAt } : {}),
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

/** 지금 모드의 모든 jsonl 순회 + 신규 파일 발견 시 추가, 각각 flushDeltaForFile. */
async function flushAllFiles(): Promise<{ inserted: number; skipped: number; dedup: number }> {
  if (!_state || (_state.mode !== "dir" && _state.mode !== "global")) return { inserted: 0, skipped: 0, dedup: 0 };

  let totalI = 0, totalS = 0, totalD = 0;

  for (const jsonlPath of listTrackedJsonl()) {
    const name = path.basename(jsonlPath);
    let fileState = _state.files.get(jsonlPath);
    if (!fileState) {
      // arm 이후 신규 jsonl — cursor 0부터 전체 캡처
      const sessionId = name.replace(/\.jsonl$/, "");
      fileState = { cursorBytes: 0, sessionId, contentSeen: new Set() };
      _state.files.set(jsonlPath, fileState);
      console.error(
        `📝 [JSONL] new session detected: ${_state.mode === "global" ? path.relative(PROJECTS_ROOT, jsonlPath) : name}`
      );
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
  if (!_state) return;
  if (_watcher || _pollTimer) return; // 이미 arm됨

  if (_state.mode === "global") {
    try {
      _watcher = fs.watch(PROJECTS_ROOT, { recursive: true }, (_eventType, filename) => {
        // filename = PROJECTS_ROOT 기준 상대 경로. <slug>/<sid>.jsonl 만 (subagents 등 하위 폴더 제외).
        if (filename && !isProjectJsonlEvent(filename.toString())) return;
        scheduleFlush();
      });
      console.error(`📝 [JSONL] dir watcher armed (global, recursive)`);
    } catch (err) {
      console.error("⚠️ [JSONL] fs.watch recursive failed — polling only:", err);
    }
    // OS 버퍼링·새 slug 폴더 등 이벤트 누락 보완 (codex_capture 와 같은 방식)
    _pollTimer = setInterval(() => { void flushWithMutex(); }, GLOBAL_POLL_INTERVAL_MS);
    _pollTimer.unref?.();
    return;
  }

  if (!_state.projectDir) return;
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
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
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

  if (!_state || (_state.mode !== "dir" && _state.mode !== "global")) {
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

export interface BackfillResult {
  file: string;
  sessionId: string;
  inserted: number;
  dedup: number;
  skipped: number;
}

/**
 * 빠진 대화 다시 채우기 — jsonl 하나를 **처음부터** 읽어 넣는다 (CLI `backfill-claude`).
 *
 * - 같은 줄이 이미 들어가 있으면 external_uuid ON CONFLICT 로 건너뛴다 → 여러 번 돌려도 안전.
 * - created_at 은 줄의 timestamp (실제 대화 시각). 지금 시각으로 넣으면 지난 대화가 시작 브리핑
 *   맨 위에 "최근 대화"로 올라온다.
 * - device_name 은 이 명령을 돌리는 기계 이름 → **그 파일이 있는 기계에서** 돌려야 맞다.
 * - 실시간 수집 상태(_state)와 무관하다 — 서버 안 띄우고 혼자 돈다.
 */
export async function backfillJsonlFile(
  jsonlPath: string,
  opts: { dryRun?: boolean } = {}
): Promise<BackfillResult> {
  const sessionId = path.basename(jsonlPath).replace(/\.jsonl$/, "");
  const fileState: FileState = { cursorBytes: 0, sessionId, contentSeen: new Set() };
  const r = await flushDeltaForFile(jsonlPath, fileState, { createdAtFromEntry: true, dryRun: opts.dryRun });
  return { file: jsonlPath, sessionId, ...r };
}

/** state reset (test용 / restart). */
export function resetCaptureState(): void {
  disarmDirWatcher();
  _state = null;
  _flushInProgress = false;
  _flushPending = false;
}
