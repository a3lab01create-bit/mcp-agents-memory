/**
 * Claude Code 훅 — `mcp-agents-memory hook <session-start|prompt|print-config>`.
 *
 * - session-start (SessionStart): 시작 브리핑 전문을 대화 맨 앞에 넣는다. MCP instructions 칸은
 *   클라이언트가 ~2KB 에서 자르지만, 훅 출력은 10,000자까지 들어간다(Claude Code 문서).
 * - prompt (UserPromptSubmit): 사용자가 말할 때마다 비슷한 지난 기록 몇 줄을 찾아 맥락으로 넣는다.
 *
 * 계약 (훅이 사용자의 말을 막거나 대화를 더럽히면 안 된다):
 * - 어떤 경우에도 exit 0. UserPromptSubmit 에서 exit 2 는 사용자의 말을 막는다.
 * - stdout 은 JSON 한 덩어리 또는 빈 문자열. 다른 출력(console.log 등)은 전부 stderr 로 돌린다.
 * - 정해진 시간(deadline) 안에 못 끝나면 아무것도 넣지 않고 끝낸다 — process.exit 로 강제
 *   (embedMessage 재시도·pg pool 이 프로세스를 붙잡고 있어도 끝난다).
 * - 실패는 조용히 넘기되, 매 호출마다 상태 폴더 hooks.log 에 한 줄 남긴다(말 내용은 안 남김).
 *
 * 이 모듈은 search_memory 도구를 고치지 않는다 — 훅 전용 조회(짧은 줄·봉투 줄 제외, 최근 줄 제외,
 * 유사도 하한)를 따로 둔다.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, envLoadError, loadEnv } from "./db.js";
import { collectBrief, formatBriefMarkdown } from "./briefing.js";
import { embedMessage, vectorToHalfvecSql } from "./cold_path/embedder.js";
import { buzzDisplayText } from "./auto_save/buzz_envelope.js";
import { getDefaultUserId } from "./users.js";

/** Claude Code 가 훅 문자열 하나에 받는 최대치는 10,000자. 넘으면 2,000자 미리보기만 간다 → 여유를 둔다. */
export const HOOK_CONTEXT_MAX_CHARS = 9500;

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface RecallSettings {
  minSimilarity: number;
  limit: number;
  minPromptChars: number;
  minMemoryChars: number;
  recentMinutes: number;
  snippetChars: number;
}

export function recallSettings(): RecallSettings {
  return {
    minSimilarity: numEnv("MEMORY_RECALL_MIN_SIMILARITY", 0.5),
    limit: Math.max(1, Math.min(10, Math.floor(numEnv("MEMORY_RECALL_LIMIT", 3)))),
    minPromptChars: numEnv("MEMORY_RECALL_MIN_PROMPT_CHARS", 8),
    minMemoryChars: numEnv("MEMORY_RECALL_MIN_MEMORY_CHARS", 40),
    recentMinutes: numEnv("MEMORY_RECALL_RECENT_MINUTES", 30),
    snippetChars: Math.max(40, Math.floor(numEnv("MEMORY_RECALL_SNIPPET_CHARS", 280))),
  };
}

// jsonl_capture.parseEntry 와 같은 감싸개 + 붙여넣기 표시. 사람이 친 말만 남긴다.
const WRAPPER_RE = /<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|task-notification|user-prompt-submit-hook|session-start-hook|session-end-hook)>[\s\S]*?<\/\1>/g;

/** 훅 입력 prompt → 검색에 쓸 글. 버즈 봉투·감싸개를 벗긴다. */
export function cleanPromptForRecall(prompt: string): string {
  let text = prompt.replace(WRAPPER_RE, " ");
  text = buzzDisplayText(text);
  return text.replace(/\s+/g, " ").trim();
}

/** 넣지 않을 말이면 이유, 넣을 말이면 null. */
export function recallSkipReason(cleaned: string, s: RecallSettings): string | null {
  if (!cleaned) return "empty";
  if (cleaned.startsWith("/")) return "slash-command";
  if (cleaned.startsWith("<")) return "wrapper";  // 작업 알림·다른 세션 메시지 같은 기계 글
  if ([...cleaned].length < s.minPromptChars) return "short";
  return null;
}

export interface RecallRow {
  id: number;
  role: string;
  message: string;
  created_at: Date;
  p_tag_name: string | null;
  similarity: number;
}

function localDate(d: Date): string {
  // sv-SE 는 YYYY-MM-DD 꼴. 기계의 지역 시간대 기준.
  return d.toLocaleDateString("sv-SE");
}

function snippet(message: string, max: number): string {
  const flat = buzzDisplayText(message).replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? chars.slice(0, max).join("") + "…" : flat;
}

/** 후보 → 유사도 하한·같은 글 중복 제거 → 상위 limit 개. */
export function pickRecallRows(candidates: RecallRow[], s: RecallSettings): RecallRow[] {
  const seen = new Set<string>();
  const out: RecallRow[] = [];
  for (const r of candidates) {
    if (!(r.similarity >= s.minSimilarity)) continue;
    const key = r.message.replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= s.limit) break;
  }
  return out;
}

/** 넣을 맥락 글. 사실만 적는다(문서: 시스템 명령처럼 쓰면 프롬프트 주입 방어에 걸릴 수 있음). */
export function formatRecall(rows: RecallRow[], s: RecallSettings): string {
  if (rows.length === 0) return "";
  const lines = [
    "mcp-agents-memory: 방금 말과 비슷한 지난 대화 기록이다. 자동 검색 결과라 지금 일과 관계없거나 오래된 내용일 수 있다. 더 필요하면 search_memory 로 찾아볼 수 있다.",
  ];
  for (const r of rows) {
    const who = r.role === "user" ? "사용자" : "에이전트";
    const tag = r.p_tag_name ? ` · ${r.p_tag_name}` : "";
    lines.push(`- #${r.id} · ${localDate(r.created_at)} · ${who}${tag} · 유사도 ${r.similarity.toFixed(2)}: ${snippet(r.message, s.snippetChars)}`);
  }
  return capContext(lines.join("\n"));
}

/** 10,000자 상한 안으로. 넘치면 잘라서 끝에 표시. */
export function capContext(text: string, max = HOOK_CONTEXT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const tail = "\n…(길어서 잘림. 나머지는 memory_startup 또는 search_memory 로)";
  return text.slice(0, Math.max(0, max - tail.length)) + tail;
}

function hookOutput(eventName: "SessionStart" | "UserPromptSubmit", context: string): string {
  if (!context) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: context } });
}

/** 훅이 도는 쪽 플랫폼. Claude Code 는 훅 프로세스에도 자기 환경변수를 물려준다. */
function hookPlatform(): string | null {
  const aiAgent = (process.env.AI_AGENT ?? "").toLowerCase();
  if (aiAgent.startsWith("claude-code") || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  return null;
}

async function sessionStartContext(): Promise<{ context: string; info: Record<string, unknown> }> {
  await db.connect();
  const brief = await collectBrief({ currentPlatform: hookPlatform() });
  let md = formatBriefMarkdown(brief);
  let mode = "full";
  if (md.length > HOOK_CONTEXT_MAX_CHARS) {
    // 강제기억이 많으면 full 이 BRIEF_MAX_CHARS 를 넘을 수 있다 → inject 모드로 예산 안에 맞춘다
    md = formatBriefMarkdown(brief, { mode: "inject", maxChars: HOOK_CONTEXT_MAX_CHARS - 200 });
    mode = "inject";
  }
  const context = capContext(`mcp-agents-memory 시작 브리핑 (지난 대화 기록에서 자동으로 모은 것)\n\n${md}`);
  return { context, info: { mode, chars: context.length } };
}

async function promptContext(input: any): Promise<{ context: string; info: Record<string, unknown> }> {
  const s = recallSettings();
  const raw = typeof input?.prompt === "string" ? input.prompt : "";
  const cleaned = cleanPromptForRecall(raw);
  const skip = recallSkipReason(cleaned, s);
  if (skip) return { context: "", info: { skipped: skip } };

  await db.connect();
  const userId = await getDefaultUserId();
  const vec = vectorToHalfvecSql(await embedMessage(cleaned.slice(0, 2000)));
  const r = await db.query(
    `SELECT m.id, m.role, m.message, m.created_at, pt.name AS p_tag_name,
            1 - (m.embedding <=> $2::halfvec) AS similarity
       FROM memory m
       LEFT JOIN project_tags pt ON pt.id = canonical_project_tag_id(m.p_tag_id)
      WHERE m.user_id = $1
        AND m.is_active = TRUE
        AND m.entry_type = 'memory'
        AND m.embedding IS NOT NULL
        AND m.created_at < now() - make_interval(mins => $3::int)
        AND length(m.message) >= $4
        AND left(ltrim(m.message), 1) <> '<'
      ORDER BY m.embedding <=> $2::halfvec
      LIMIT $5`,
    [userId, vec, Math.floor(s.recentMinutes), Math.floor(s.minMemoryChars), s.limit * 4]
  );
  const candidates: RecallRow[] = r.rows.map((row: any) => ({
    id: Number(row.id),
    role: row.role,
    message: row.message,
    created_at: new Date(row.created_at),
    p_tag_name: row.p_tag_name ?? null,
    similarity: Number(row.similarity),
  }));
  const rows = pickRecallRows(candidates, s);
  return {
    context: formatRecall(rows, s),
    info: {
      candidates: candidates.length,
      rows: rows.length,
      top: candidates.length ? Number(candidates[0].similarity.toFixed(3)) : null,
      ids: rows.map((x) => x.id),
    },
  };
}

export function hookLogPath(): string {
  return process.env.MEMORY_HOOK_LOG
    ?? path.join(os.homedir(), ".local", "state", "mcp-agents-memory", "hooks.log");
}

function logLine(entry: Record<string, unknown>): void {
  try {
    const file = hookLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // 로그 실패로 훅이 실패하면 안 된다
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function finish(out: string): void {
  // 맥 등에서는 파이프 쓰기가 비동기 → 다 쓴 뒤에 끝낸다
  if (!out) process.exit(0);
  process.stdout.write(out, () => process.exit(0));
}

/**
 * `hook print-config` — ~/.claude/settings.json 의 "hooks" 에 넣을 조각. 설정 파일은 직접 안 건드린다.
 * 경로는 절대경로로 박는다(훅은 세션의 작업 폴더에서 돈다). 끝의 `|| true` 는 마지막 방어선:
 * 모듈을 불러오다 죽는 것처럼 훅 코드 밖에서 난 실패도 exit 0 으로 만든다(2 는 사용자의 말을 막는다).
 */
export function hookConfigSnippet(entryScript: string, configPath: string | null, node?: string): string {
  const cmd = (event: HookEvent) => hookCommand("claude", event, { entry: entryScript, configPath, node });
  return JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: cmd("session-start"), timeout: 15 }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd("prompt"), timeout: 10 }] }],
    },
  }, null, 2);
}

/** 훅을 받는 도구. 입력을 읽는 곳과 출력 모양이 도구마다 다르다. */
export type HookClient = "claude" | "codex" | "agy";
export type HookEvent = "session-start" | "prompt";
export const HOOK_CLIENTS: readonly HookClient[] = ["claude", "codex", "agy"];

function realpathOrNull(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; }
}

/**
 * 훅 명령에 박을 node 경로. brew 의 버전 경로(<prefix>/Cellar/node/26.0.0/bin/node)는 node 를 올리면
 * 사라져 훅이 조용히 멈춘다(맥북 쿠우 지적) → 같은 파일을 가리키는 안 바뀌는 링크로 바꾼다.
 * 우선 <prefix>/opt/<formula>/bin/node(그 formula 를 따라감), 다음 <prefix>/bin/node. 실제 파일이 같을 때만.
 * nvm(~/.nvm/versions/…) 같은 다른 버전 경로는 바꿀 안정 경로가 없어 그대로 둔다.
 */
export function stableNodePath(execPath: string = process.execPath): string {
  const m = /^(.*)\/Cellar\/(node(?:@[0-9.]+)?)\/[^/]+\/bin\/node$/.exec(execPath);
  if (!m) return execPath;
  const [, prefix, formula] = m;
  const real = realpathOrNull(execPath);
  if (!real) return execPath;
  for (const cand of [path.join(prefix, "opt", formula, "bin", "node"), path.join(prefix, "bin", "node")]) {
    if (realpathOrNull(cand) === real) return cand;
  }
  return execPath;
}

/**
 * 도구 설정 파일에 넣을 훅 명령 한 줄(설치기·print-config 공용).
 * 경로는 절대경로로 박는다(훅은 세션의 작업 폴더에서 돈다). 끝의 `|| true` 는 마지막 방어선:
 * 모듈을 불러오다 죽는 것처럼 훅 코드 밖에서 난 실패도 exit 0 으로 만든다(2 는 사용자의 말을 막는다).
 */
export function hookCommand(
  client: HookClient,
  event: HookEvent,
  opts: { entry: string; configPath: string | null; node?: string },
): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const envPrefix = opts.configPath ? `MEMORY_CONFIG_PATH=${q(path.resolve(opts.configPath))} ` : "";
  const node = opts.node ?? stableNodePath();
  return `${envPrefix}${q(node)} ${q(path.resolve(opts.entry))} hook ${event} --client ${client} || true`;
}

export async function runHookCli(sub: string | undefined): Promise<void> {
  // 훅 stdout 은 Claude Code 가 맥락으로 읽는다 → 어떤 모듈의 console.log 도 stdout 을 더럽히지 못하게
  console.log = (...a: unknown[]) => console.error(...a);
  console.info = (...a: unknown[]) => console.error(...a);

  if (sub === "print-config") {
    if (envLoadError) {
      // 사람이 직접 치는 명령 — 훅과 달리 실패를 그대로 알린다
      console.error(`❌ 설정 파일을 읽지 못했다: ${envLoadError.message}`);
      process.exitCode = 1;
      return;
    }
    const entry = path.resolve(process.argv[1] ?? "");
    const configPath = loadEnv();
    if (!configPath) {
      console.error("⚠️ 설정 파일(.env)을 못 찾았다 — 훅이 DB 에 못 붙는다. `mcp-agents-memory setup` 을 먼저 하거나 MEMORY_CONFIG_PATH 를 정해라.");
    }
    process.stdout.write(hookConfigSnippet(entry, configPath) + "\n");
    return;
  }

  const event = sub === "session-start" ? "SessionStart" : sub === "prompt" ? "UserPromptSubmit" : null;
  const started = Date.now();
  if (!event) {
    console.error(`❌ hook: unknown subcommand "${sub ?? ""}" (session-start | prompt | print-config)`);
    process.exit(0);
  }
  if (process.env.MEMORY_HOOKS_OFF === "1") {
    logLine({ event, outcome: "off" });
    process.exit(0);
  }
  if (envLoadError) {
    // 지정한 설정을 못 읽었다 → DB 에 붙지 않는다(환경변수에 남은 DATABASE_URL 로 엉뚱한 DB 에 붙지 않게)
    logLine({ event, outcome: "error", ms: Date.now() - started, error: `config: ${envLoadError.message}`.slice(0, 200) });
    process.exit(0);
  }

  const deadlineMs = event === "SessionStart"
    ? numEnv("MEMORY_HOOK_SESSION_DEADLINE_MS", 6000)
    : numEnv("MEMORY_HOOK_PROMPT_DEADLINE_MS", 3500);
  setTimeout(() => {
    logLine({ event, outcome: "timeout", ms: Date.now() - started });
    process.exit(0);
  }, deadlineMs);

  try {
    const rawIn = await readStdin();
    let input: any = {};
    try { input = rawIn.trim() ? JSON.parse(rawIn) : {}; } catch { input = {}; }
    const { context, info } = event === "SessionStart"
      ? await sessionStartContext()
      : await promptContext(input);
    const out = hookOutput(event, context);
    logLine({ event, outcome: out ? "injected" : "none", ms: Date.now() - started, source: input?.source, ...info });
    finish(out);
  } catch (err) {
    logLine({ event, outcome: "error", ms: Date.now() - started, error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) });
    process.exit(0);
  }
}
