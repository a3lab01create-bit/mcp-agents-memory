/**
 * Claude Code JSONL 자동 캡처 — RESPEC PROBLEMS.md §4 fix.
 *
 * v0.x `transcript_capture.ts` 패턴 재도입. 단 새 `memory` 테이블에 직접 INSERT
 * (legacy `transcript_queue` X, librarian fact_type 추출 layer 없음).
 *
 * 흐름:
 *   1. captureSessionStart(cwd) — server 시작 시 호출. 현재 cwd의 최신 JSONL
 *      식별 + byte 시작 cursor 기록.
 *   2. captureSessionEnd() — server shutdown 시 호출. 시작 cursor 이후 새
 *      entries만 파싱 → insertRawMemory()로 INSERT.
 *
 * Claude Code 한정: ~/.claude/projects/<slug>/<session_id>.jsonl convention
 * 사용. Gemini CLI / Codex 등은 본 path 작동 안 함 — save_message tool로 대체.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { insertRawMemory } from "../hot_path.js";
import { getDefaultUserId } from "../users.js";

const CLIENT_PLATFORM = "claude-code"; // 본 모듈은 Claude Code 전용
const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

interface SessionState {
  cwd: string;
  jsonlPath: string | null;
  startByteOffset: number;
  sessionId: string | null;
}

let _state: SessionState | null = null;

/** project dir 이름 derivation: cwd → ~/.claude/projects/<slug> */
function deriveProjectDir(cwd: string): string {
  const slug = cwd.replace(/^\/+/, "").replace(/\//g, "-").replace(/^-+/, "-");
  return path.join(PROJECTS_ROOT, `-${slug}`);
}

/**
 * server 시작 시 호출. 현재 cwd의 최신 JSONL을 식별 + byte cursor 기록.
 * 옛 entries는 backfill 안 함 (cursor = file size at start).
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
}

interface ParsedEntry {
  uuid: string;
  role: 'user' | 'assistant';
  message: string;
  agent_model?: string;
  subagent?: boolean;
  subagent_model?: string;
  subagent_role?: string;
}

/** Claude Code JSONL entry → ParsedEntry. parse 실패 / type 무효 시 null. */
function parseEntry(line: string): ParsedEntry | null {
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
 * server shutdown 시 호출. session 시작 이후 byte range만 읽고 entries INSERT.
 * 실패는 best-effort (shutdown 막지 않음).
 */
export async function captureSessionEnd(): Promise<{ inserted: number; skipped: number; error?: string }> {
  if (!_state || !_state.jsonlPath) {
    return { inserted: 0, skipped: 0, error: "session not armed" };
  }

  const { jsonlPath, startByteOffset, sessionId } = _state;
  if (!fs.existsSync(jsonlPath)) {
    return { inserted: 0, skipped: 0, error: "jsonl missing" };
  }

  const stat = fs.statSync(jsonlPath);
  if (stat.size <= startByteOffset) {
    return { inserted: 0, skipped: 0 }; // 새 entry 없음
  }

  // 시작 cursor 이후 byte range 읽기
  const fd = fs.openSync(jsonlPath, "r");
  let raw: string;
  try {
    const length = stat.size - startByteOffset;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, startByteOffset);
    raw = buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }

  const lines = raw.split("\n");
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
    // dedup 키: session_id + entry uuid (Claude Code JSONL 고유 식별)
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
      else dedup++; // ON CONFLICT skip — save_message 또는 이전 capture가 이미 저장
    } catch (err) {
      console.error(`⚠️ [JSONL] insert failed for entry ${parsed.uuid}:`, err);
      skipped++;
    }
  }

  console.error(`📝 [JSONL] captured session=${sessionId}: inserted=${inserted}, dedup=${dedup}, skipped=${skipped}`);
  return { inserted, skipped };
}

/** state reset (test용 / restart). */
export function resetCaptureState(): void {
  _state = null;
}
