/**
 * Codex CLI 자동 캡처 — RESPEC PROBLEMS.md §5 (cross-platform passive capture).
 *
 * Codex transcript: $CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<sid>.jsonl
 *   (CODEX_HOME 미설정 시 ~/.codex)
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
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { insertRawMemory } from "../hot_path.js";
import { getDefaultUserId } from "../users.js";
import { buzzTurnVenue } from "./venue.js";

const DEVICE_NAME = os.hostname();
// 2026-10-31: CODEX_HOME 을 존중한다. 버즈 코디는 codex-home 을 쓰고(launcher 가 env 로 지정),
// Isaac 터미널 codex 는 이 변수가 없어 ~/.codex 로 떨어진다 → 기존 동작 불변.
// ⚠️ codex 는 MCP 서버 자식에게 env 를 5개(HOME/LOGNAME/PATH/SHELL/USER)만 넘긴다 →
//    codex-home/config.toml 의 [mcp_servers.mcp-agents-memory.env] 로 CODEX_HOME 을
//    전달해야 이 코드가 효력을 갖는다. 코드만 고치면 동작이 안 바뀐다 (2026-10-31 실측).
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const SESSIONS_ROOT = path.join(CODEX_HOME, "sessions");
/**
 * `state_5.sqlite` 경로. **호출 시점**에 env 를 읽는다 (SESSIONS_ROOT 는 watcher 때문에 로드 시점 고정).
 * 이렇게 두면 검사에서 CODEX_HOME 을 case 별로 바꿔 끼울 수 있다.
 */
function stateDbPath(): string {
  return path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "state_5.sqlite");
}
const FLUSH_DEBOUNCE_MS = 200;
const POLL_INTERVAL_MS = 3000; // OS 버퍼링 우회 — fs.watch 미발화 보완

/**
 * state_5.sqlite `threads.source` → agent_platform **폴백** 매핑.
 *
 * 🔴 `source` 는 더 이상 플랫폼 구분자가 아니다 (2026-10-31 실측, `~/.codex`):
 *    codex 신버전은 CLI(`codex-tui`)·`buzz-acp`·`codex-acp` 를 전부 `source='vscode'` 로 쓴다.
 *    같은 originator 가 source 두 값으로 나오기도 한다 — `codex-tui`: vscode 2 · cli 1.
 *    `source='cli'` 은 2026-09-19 이후 0건이다.
 * ⇒ 구분자는 `originator` 다. 이 함수는 originator 가 없거나 모르는 값일 때만 쓴다.
 * ⚠️ 미확인 source 를 desktop 으로 만들지 않는다 — default 는 기존대로 codex-mcp-client.
 */
export function sourceToPlatform(source: string): string {
  switch (source) {
    case "cli":    return "codex-cli";
    case "vscode": return "codex-desktop";
    case "mcp":    return "codex-mcp";
    case "exec":   return "codex-exec";
    default:       return "codex-mcp-client";
  }
}

/**
 * `threads.originator` → agent_platform. 모르는 값이면 null (호출자가 source 로 폴백).
 *
 * 확인된 값은 **실행 경로**이지 사람/에이전트의 정체가 아니다 — 그래서 `codex-acp` 로 쓴다
 * (`codex-agent` 는 exec·CLI 로 돌는 에이전트까지 포함해 범위가 모호하다).
 */
export function originatorToPlatform(originator: string): string | null {
  // 값의 표기가 통일돼 있지 않다 — `codex-tui`·`codex_exec`·`buzz-acp` 는 소문자 기호식인데
  // 데스크톱 앱은 **`Codex Desktop`**(공백·대문자, cli_version 0.166.0-alpha.5.1, 2026-10-31
  // 맥스튜디오 실측)이다. 그래서 소문자로 맞춰 비교한다. 느슨한 정규화는 하지 않는다 —
  // 모르는 값을 억지로 분류하면 지금 고치는 오분류가 다른 모양으로 재발한다.
  const o = originator.trim().toLowerCase();
  if (!o) return null;
  if (o === "codex-tui") return "codex-cli";
  if (o === "codex_exec") return "codex-exec";
  if (o === "codex desktop") return "codex-desktop";
  if (o === "buzz-acp" || o.includes("codex-acp")) return "codex-acp";
  return null;
}

/**
 * node:sqlite 를 **지연·동기** 로드한다 (Node 22.13+/23.4+ 빌트인).
 * 최상위 static import 로 두면 미지원 Node 에서 서버 전체 기동이 깨진다 → 여기서 try 로 감싼다.
 * `lookupPlatform` 이 동기 함수라 opencode_capture 의 async 로더를 그대로 쓸 수 없어 createRequire 를 쓴다.
 */
let _DatabaseSync: any | null | undefined;
function sqliteSync(): any | null {
  if (_DatabaseSync !== undefined) return _DatabaseSync;
  try {
    // @ts-ignore — @types/node(node20 타겟)엔 node:sqlite 타입이 없다
    _DatabaseSync = createRequire(import.meta.url)("node:sqlite")?.DatabaseSync ?? null;
  } catch {
    _DatabaseSync = null;
  }
  return _DatabaseSync;
}

/** sessionId로 state_5.sqlite 조회 → platform string. 실패 시 default. */
export function lookupPlatform(sessionId: string): string {
  const DatabaseSync = sqliteSync();
  if (!DatabaseSync) return "codex-mcp-client";
  let db: any = null;
  try {
    db = new DatabaseSync(stateDbPath(), { readOnly: true });
    // 구형 DB 에는 `originator` 칸이 없다 → 있을 때만 읽는다 (없으면 source 만)
    const cols = new Set<string>(
      db.prepare("PRAGMA table_info(threads)").all().map((c: any) => String(c.name)),
    );
    const hasOriginator = cols.has("originator");
    const row: any = db
      .prepare(
        hasOriginator
          ? "SELECT source, originator FROM threads WHERE id = ? LIMIT 1"
          : "SELECT source FROM threads WHERE id = ? LIMIT 1",
      )
      .get(sessionId);
    if (!row) return "codex-mcp-client";
    if (hasOriginator && typeof row.originator === "string") {
      const byOriginator = originatorToPlatform(row.originator);
      if (byOriginator) return byOriginator;
    }
    const source = typeof row.source === "string" ? row.source.trim() : "";
    if (source) return sourceToPlatform(source);
  } catch {
    // DB 없음·잠김·스키마 변경 → 라벨만 포기하고 **캡처는 계속한다**
  } finally {
    try { db?.close(); } catch {}
  }
  return "codex-mcp-client";
}

interface FileState {
  /** 다음 read 시작 byte. arm 시점 size 또는 신규 발견 파일이면 0. */
  cursorBytes: number;
  /** rollout 파일명에서 추출한 session UUID. */
  sessionId: string;
  /** state_5.sqlite source → platform (cli→codex-cli, vscode→codex-desktop …). */
  agentPlatform: string;
  /** 두 스키마에 같은 메시지가 기록되는 것을 억제하기 위한 파일별 상태. */
  parseState: CaptureParseState;
  /** 버즈 세션: 가장 최근 user 턴의 venue. 답장은 이걸 따른다. */
  buzzVenue?: string | null;
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
      parseState: { mirrors: [] },
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
  /**
   * venue(자리) 를 읽을 원문. UserMessage 는 message 에 마지막 조각만 담기지만
   * `<context>` 조각은 그 앞에 따로 있어서, 자리는 조각 전체에서 읽어야 한다.
   * assistant 턴은 없음 → 세션에 물려둔 값을 쓴다.
   */
  venueSource?: string;
  /**
   * 조각 원문 (주입문 필터·trim 이전). hot_path 가 raw_message 칸에 넣는다.
   * message 와 같으면 생략한다.
   */
  rawMessage?: string;
}

/** 파일 하나 안에서 같은 메시지가 두 스키마로 두 번 기록되는 것을 억제하기 위한 상태. */
export interface CaptureParseState {
  mirrors: Array<{ key: string; sources: string[] }>;
}

/** 알려진 단독 주입 블록만 판정한다. 인용된 평문은 남긴다. */
function isInjectedUserText(text: string): boolean {
  const t = text.trim();
  return /^(?:<environment_context>[\s\S]*<\/environment_context>|<recommended_plugins>[\s\S]*<\/recommended_plugins>)$/.test(t) ||
    /^# AGENTS\.md instructions for /i.test(t);
}

/**
 * 같은 메시지가 다른 스키마로도 기록됐으면 한 번만 반환한다
 * (같은 스키마의 반복 턴은 억제하지 않는다).
 *
 * 🔴 2026-10-31: 키에 **제외된 조각 목록까지** 넣는다. 본문 해시만 보면
 *    `response=[plugins, hello]` 와 `item=[hello]` 가 같은 턴으로 판정돼
 *    **먼저 온 쪽의 raw 만 남는다** → 저장되는 원문이 도착 순서에 따라 달라졌다.
 *    제외된 조각이 다르면 "같은 턴"이라는 증거가 아니므로 **둘 다 남긴다.**
 *    ⇒ **(message, 제외 목록) 쌍의 저장 집합**은 도착 순서와 무관하다. 버퍼링·커서 조작 불필요.
 *
 * ⚠️ 정규화 범위 (과장 금지 — Codi 교정 2026-10-31):
 *    키가 같은데 raw 만 다른 경우에는 **먼저 온 쪽의 raw 가 남는다**(선착순). 해당 경우는 두 가지:
 *      ① 조각 순서만 다름: [plugins, hello] vs [hello, plugins] → 같은 키, raw 는 다름
 *      ② 공백만 다름: `join("\n")` 꼬리 줄바꿈 차이
 *    즉 "원문 전체가 순서 무관"은 **아니다**. ②는 의도된 정규화지만(같은 턴을 쪼개지 않기 위해)
 *    ①은 남아 있는 한계다. 조각 위치까지 원문으로 보존하려면 별도 설계가 필요하다.
 *    ⚠️ raw 전체를 키로 쓰면 안 된다 — `join("\n")` 의 **공백 한 글자 차이**로 같은 턴이 갈린다
 *       (동결 코퍼스에서 raw 길이가 1바이트만 다른 묶음 5건이 전부 같은 턴이었다).
 *       그래서 trim 한 **제외 목록**으로 비교한다.
 *    ⚠️ 이것은 손실 방지책이다. "중복제거 완료"로 보고하지 않는다 —
 *       조각 집합이 다른 두 기록은 근거가 없어 **합치지 않고 둘 다 보존**하는 것이다.
 */
function isMirroredEntry(
  state: CaptureParseState,
  source: string,
  role: string,
  message: string,
  dropped: string[],
): boolean {
  const key = createHash("sha256")
    .update(role + "\0" + message + "\0" + dropped.join("\u0001"))
    .digest("hex");
  const mirror = state.mirrors.find((item) => item.key === key && !item.sources.includes(source));
  if (mirror) {
    mirror.sources.push(source);
    return true;
  }
  state.mirrors.push({ key, sources: [source] });
  if (state.mirrors.length > 256) state.mirrors.shift();
  return false;
}

/**
 * content[] → { message, raw }.
 *
 * UserMessage/response_item 의 content 는 codex 가 조립한 프롬프트 조각들이다:
 *   [<base> 설명서, <agent-instructions>, <core-memory>, <context>, 이번 턴]
 *
 * ⚠️ message 는 조각을 **전부** 잇는다. 조각을 골라 버리는 규칙(옛 "마지막 조각만")은
 *    사람이 앞 조각에 붙인 XML·인용문까지 같이 버린다 (2026-10-31 Codi 반례:
 *    ["<invoice><amount>100</amount></invoice>", "위 XML의 금액을 알려줘"] → XML 소실).
 *    조각 텍스트의 모양은 그 조각이 주입문이라는 증거가 아니다.
 * 🎯 버즈 봉투는 여기서 걷지 않는다 — hot_path 의 cleanBuzzEnvelope 가
 *    `Scope:` + `Channel: …(#uuid)` 문법으로 **확인된 봉투만** 걷는다. 그래서 사람이 쓴
 *    `<invoice>`·`<새것>` 같은 글은 구조적으로 건드려지지 않는다.
 * ⚠️ raw 는 주입문 필터와 trim **이전**의 조각이어야 "원문 보존"이 성립한다.
 */
function fragmentsOf(
  content: any,
  role: "user" | "assistant",
): { message: string; raw: string; dropped: string[] } {
  if (typeof content === "string") return { message: content.trim(), raw: content, dropped: [] };
  if (!Array.isArray(content) || content.length === 0) return { message: "", raw: "", dropped: [] };
  const all = content.map((c: any) => (c && typeof c.text === "string" ? c.text : ""));
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const t of all) {
    const trimmed = t.trim();
    if (!trimmed) continue;
    if (role === "user" && isInjectedUserText(trimmed)) dropped.push(trimmed);
    else kept.push(trimmed);
  }
  return { message: kept.join("\n"), raw: all.join("\n"), dropped };
}

/**
 * 한 jsonl line → ParsedEntry | null.
 *
 * 구 스키마 (~2026-06): event_msg payload.type = user_message | agent_message, payload.message 평문.
 * 신 스키마 (2026-09~): event_msg payload.type = item_completed,
 *                      payload.item.type = UserMessage | AgentMessage, 본문은 item.content[].
 *   → codex 가 중간에 스키마를 바꿨고 이 파서가 따라가지 못해 2026-06-14 이후 캡처가
 *     전원(사람 터미널 포함) 0건이었다. 두 스키마를 모두 받는다.
 * 그 외 (response_item / turn_context / session_meta / CommandExecution / McpToolCall / Reasoning) skip.
 *   ⚠️ response_item/message 로 바꾸지 마라 — role='developer' 인 주입 지시문과
 *      <recommended_plugins> 보일러플레이트가 같이 들어온다.
 */
export function parseEntry(
  line: string,
  byteOffset: number,
  state?: CaptureParseState,
): ParsedEntry | null {
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }

  if (!entry || (entry.type !== "event_msg" && entry.type !== "response_item")) return null;
  const payload = entry.payload;
  if (!payload || typeof payload !== "object") return null;

  const ptype = payload.type;
  let role: "user" | "assistant";
  let message: string;
  let rawMessage: string | undefined;
  let droppedFragments: string[] = [];
  let venueSource: string | undefined;
  const source =
    entry.type === "response_item" ? "response" : ptype === "item_completed" ? "item" : "legacy";

  if (entry.type === "response_item") {
    // response_item/message 에는 role='developer'/'system'/'tool' 인 주입 지시문도 온다 → 둘만 받는다.
    if (ptype !== "message" || (payload.role !== "user" && payload.role !== "assistant")) return null;
    // 내부 추론 채널(analysis 등)은 담지 않는다.
    if (payload.channel && !["final", "commentary"].includes(payload.channel)) return null;
    if (payload.phase && !["final", "final_answer", "commentary"].includes(payload.phase)) return null;
    role = payload.role;
    if (!Array.isArray(payload.content)) return null;
    const f = fragmentsOf(payload.content, role);
    message = f.message;
    rawMessage = f.raw;
    droppedFragments = f.dropped;
    if (role === "user") venueSource = f.raw;
  } else if (ptype === "user_message" || ptype === "agent_message") {
    role = ptype === "user_message" ? "user" : "assistant";
    message = typeof payload.message === "string" ? payload.message.trim() : "";
  } else if (ptype === "item_completed") {
    const item = payload.item;
    const itype = item && typeof item === "object" ? item.type : null;
    if (itype === "UserMessage") role = "user";
    else if (itype === "AgentMessage") role = "assistant";
    else return null;
    const f = fragmentsOf(item?.content, role);
    message = f.message;
    rawMessage = f.raw;
    droppedFragments = f.dropped;
    if (role === "user") venueSource = f.raw;
  } else {
    return null;
  }
  if (!message) return null;
  if (role === "user" && isInjectedUserText(message)) return null;

  // Codex agent_message에는 tool call 로그가 섞임 — 메모리 노이즈 제거
  if (message.startsWith("[external_agent_tool_call:") ||
      message.startsWith("[external_agent_tool_call_response:")) {
    return null;
  }

  if (state && isMirroredEntry(state, source, role, message, droppedFragments)) return null;

  const out: ParsedEntry = { byteOffset, role, message };
  if (venueSource !== undefined) out.venueSource = venueSource;
  if (rawMessage !== undefined && rawMessage !== message) out.rawMessage = rawMessage;
  return out;
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
    const parsed = parseEntry(trimmed, byteOffset, fileState.parseState);
    if (!parsed) {
      skipped++;
      lineStartInRaw += Buffer.byteLength(line, "utf-8") + 1;
      continue;
    }

    const externalUuid = `codex:${fileState.sessionId}:${parsed.byteOffset}`;
    const agentModel =
      parsed.role === "user" ? null : (fileState.currentModel ?? "unknown");

    // 버즈 세션: user 턴에서 자리를 읽어 두고, 답장(assistant)은 그 값을 따른다.
    // 답장엔 `<context>` 봉투가 없어서 이걸 안 하면 venue 가 전부 NULL 이 된다.
    if (parsed.role === "user" && parsed.venueSource) {
      const own = buzzTurnVenue(parsed.venueSource);
      if (own) fileState.buzzVenue = own;
    }
    const venue = fileState.buzzVenue ?? null;

    try {
      const result = await insertRawMemory({
        user_id: userId,
        agent_platform: fileState.agentPlatform,
        agent_model: agentModel,
        role: parsed.role,
        message: parsed.message,
        external_uuid: externalUuid,
        device_name: DEVICE_NAME,
        venue,
        raw_message: parsed.rawMessage ?? null,
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
        parseState: { mirrors: [] },
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
