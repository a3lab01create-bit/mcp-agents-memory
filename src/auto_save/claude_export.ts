/**
 * 클로드 앱 내보내기 파일 넣기 — CLI `import-claude-export`.
 *
 * 클로드 앱(claude.ai 웹·데스크톱 앱 일반 대화창·모바일) 대화는 이 기계에 대화 파일을 남기지 않아서
 * 실시간 수집이 못 넣는다. 모델이 도구로 남길 때만 몇 줄 들어갈 뿐이다(11-22 실측: 5주에 7줄, 5줄은 강제기억 메모).
 * 설정 → 개인정보 → 내보내기로 받은 conversations.json 을 넣어 그 구멍을 채운다.
 *
 * 내보내기 모양 (2026-11-21 실물 확인, manifest version 1.0, conversations-000.zip 안 conversations.json):
 *   [ { uuid, name, summary, created_at, updated_at, account, chat_messages: [
 *       { uuid, parent_message_uuid, sender: "human"|"assistant", text, content: [...], created_at, ... } ] } ]
 *   content 조각 종류: text · thinking · tool_use · tool_result · image.
 *
 * - 본문은 content 의 text 조각만 잇는다(클로드 코드 수집과 같게 줄바꿈 하나로). 생각 과정·도구 호출은 넣지 않는다.
 *   `text` 칸은 쓰지 않는다 — 도구 조각 자리에 "This block is not supported on your current device yet."
 *   자리표시가 끼어 있다(실물 26개 중 3개). content 가 없을 때만 `text` 에서 자리표시를 걷어 쓴다.
 * - external_uuid = `claude-export:<대화 uuid>:<메시지 uuid>` → 같은 파일을 여러 번 넣어도 중복이 안 생긴다.
 * - created_at = 메시지 시각. 지금 시각으로 넣으면 지난 대화가 시작 브리핑 "최근 대화" 맨 위로 올라온다.
 * - agent_platform = "claude-export" (수집 경로 이름 — 'buzz' 와 같은 뜻. 웹·데스크톱·모바일 중 어디서 했는지는
 *   내보내기에 없다). venue = "terminal" (migration 029 정의: 사람과 1:1). device_name = NULL (어느 기기였는지 모른다).
 * - 내보내기에는 지금 계정에 남아 있는 대화만 들어온다. 지운 대화는 없다(11-22: 11-16 결과물의 대화가 빠져 있었다).
 */
import fs from "node:fs";
import { insertRawMemory } from "../hot_path.js";
import { getDefaultUserId } from "../users.js";

export const CLAUDE_EXPORT_PLATFORM = "claude-export";
export const CLAUDE_EXPORT_VENUE = "terminal";

/** 도구 조각 자리에 `text` 칸이 끼워 넣는 자리표시 (코드 울타리 포함). */
const UNSUPPORTED_BLOCK_RE = /\n*```\nThis block is not supported on your current device yet\.\n```\n*/g;

export interface ClaudeExportRow {
  externalUuid: string;
  role: "user" | "assistant";
  message: string;
  createdAt: Date;
}

export interface ClaudeExportParse {
  rows: ClaudeExportRow[];
  conversations: number;
  /** 파일 안 메시지 수 (넣을 수 없는 것 포함) */
  messages: number;
  /** 본문이 비어 건너뜀 (도구 호출만 있는 메시지 등) */
  skippedEmpty: number;
  /** 보낸 사람·uuid·시각을 읽을 수 없어 건너뜀 */
  skippedInvalid: number;
  /** 가장 이른·늦은 메시지 시각 (rows 기준) */
  first: Date | null;
  last: Date | null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 메시지 하나의 본문 — content 의 text 조각만, 클로드 코드 수집처럼 줄바꿈 하나로 잇는다. */
export function claudeExportMessageText(m: Record<string, unknown>): string {
  if (Array.isArray(m.content)) {
    let text = "";
    for (const part of m.content) {
      if (isObj(part) && part.type === "text" && typeof part.text === "string") {
        text += (text ? "\n" : "") + part.text;
      }
    }
    return text.trim();
  }
  return typeof m.text === "string" ? m.text.replace(UNSUPPORTED_BLOCK_RE, "\n").trim() : "";
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** conversations.json 내용(JSON.parse 결과) → 넣을 줄. DB 를 안 쓴다. 모양이 아니면 던진다. */
export function parseClaudeExport(data: unknown): ClaudeExportParse {
  if (!Array.isArray(data)) {
    throw new Error("클로드 내보내기 conversations.json 모양이 아닙니다 (맨 바깥이 배열이어야 함).");
  }
  const out: ClaudeExportParse = {
    rows: [], conversations: 0, messages: 0, skippedEmpty: 0, skippedInvalid: 0, first: null, last: null,
  };
  for (const conv of data) {
    if (!isObj(conv) || typeof conv.uuid !== "string" || !conv.uuid || !Array.isArray(conv.chat_messages)) {
      throw new Error("클로드 내보내기 conversations.json 모양이 아닙니다 (대화마다 uuid·chat_messages 가 있어야 함).");
    }
    out.conversations++;
    for (const m of conv.chat_messages) {
      out.messages++;
      if (!isObj(m)) { out.skippedInvalid++; continue; }
      const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : null;
      const createdAt = parseDate(m.created_at);
      if (!role || typeof m.uuid !== "string" || !m.uuid || !createdAt) { out.skippedInvalid++; continue; }
      const message = claudeExportMessageText(m);
      if (!message) { out.skippedEmpty++; continue; }
      out.rows.push({ externalUuid: `claude-export:${conv.uuid}:${m.uuid}`, role, message, createdAt });
      if (!out.first || createdAt < out.first) out.first = createdAt;
      if (!out.last || createdAt > out.last) out.last = createdAt;
    }
  }
  return out;
}

/** 이 명령이 쓸 DB — 비밀번호 없이 호스트·포트·이름만. 넣기 전에 사람이 눈으로 확인하게 찍는다. */
export function describeDbTarget(env: NodeJS.ProcessEnv = process.env): string {
  const tunnel = env.SSH_HOST ? ` (SSH 터널: ${env.SSH_HOST})` : "";
  if (env.DATABASE_URL) {
    try {
      const u = new URL(env.DATABASE_URL);
      return `${u.hostname}:${u.port || "5432"}${u.pathname}${tunnel}`;
    } catch {
      return `DATABASE_URL (주소를 읽지 못함)${tunnel}`;
    }
  }
  if (env.DB_HOST) return `${env.DB_HOST}:${env.DB_PORT || "5432"}/${env.DB_NAME ?? "?"}${tunnel}`;
  return "설정 없음";
}

export interface ClaudeExportImportResult {
  file: string;
  conversations: number;
  messages: number;
  /** 넣을 수 있는 줄 수 */
  rows: number;
  inserted: number;
  /** 이미 들어가 있어 건너뜀 (external_uuid) */
  dedup: number;
  skippedEmpty: number;
  skippedInvalid: number;
  /** INSERT 실패 (DB 문제) — 0 이 아니면 CLI 가 실패로 끝낸다 */
  failed: number;
  first: string | null;
  last: string | null;
  agent_platform: string;
  venue: string;
}

/** conversations.json 하나를 넣는다. dryRun 이면 DB 를 안 열고 셈만 한다. */
export async function importClaudeExportFile(
  file: string,
  opts: { dryRun?: boolean } = {}
): Promise<ClaudeExportImportResult> {
  const parsed = parseClaudeExport(JSON.parse(fs.readFileSync(file, "utf-8")));
  const result: ClaudeExportImportResult = {
    file,
    conversations: parsed.conversations,
    messages: parsed.messages,
    rows: parsed.rows.length,
    inserted: 0,
    dedup: 0,
    skippedEmpty: parsed.skippedEmpty,
    skippedInvalid: parsed.skippedInvalid,
    failed: 0,
    first: parsed.first?.toISOString() ?? null,
    last: parsed.last?.toISOString() ?? null,
    agent_platform: CLAUDE_EXPORT_PLATFORM,
    venue: CLAUDE_EXPORT_VENUE,
  };
  if (opts.dryRun) return result;

  const userId = await getDefaultUserId();
  for (const row of parsed.rows) {
    try {
      const r = await insertRawMemory({
        user_id: userId,
        agent_platform: CLAUDE_EXPORT_PLATFORM,
        // 내보내기에는 메시지별 모델이 없다 → 수집과 같게 assistant 는 'unknown'
        agent_model: row.role === "user" ? null : "unknown",
        role: row.role,
        message: row.message,
        external_uuid: row.externalUuid,
        device_name: null,
        venue: CLAUDE_EXPORT_VENUE,
        created_at: row.createdAt,
      });
      if (r.inserted) result.inserted++;
      else result.dedup++;
    } catch (err) {
      console.error(`⚠️ [claude-export] insert failed for ${row.externalUuid}:`, err);
      result.failed++;
    }
  }
  return result;
}
