/**
 * Claude Code 훅 — `mcp-agents-memory hook <session-start|prompt|print-config>`.
 *
 * - session-start (SessionStart): 시작 브리핑 전문을 대화 맨 앞에 넣는다. MCP instructions 칸은
 *   클라이언트가 ~2KB 에서 자르지만, 훅 출력은 10,000자까지 들어간다(Claude Code 문서).
 * - prompt (UserPromptSubmit): 사용자가 말할 때마다 비슷한 지난 기록 몇 줄을 찾아 맥락으로 넣는다.
 *   클로드는 세션마다 한 번, 앞선 대화가 DB 에 들어갔는지도 확인한다(hook_capture_check.ts) — 안 들어갔으면 경고.
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
import { captureCheckContext } from "./hook_capture_check.js";

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

/** 넣을 게 없을 때 stdout. agy 는 빈 JSON({})을 준다(Supermemory 안티그래비티 플러그인과 같은 모양). */
export function emptyHookOutput(client: HookClient): string {
  return client === "agy" ? "{}" : "";
}

/**
 * 도구별 출력 모양.
 * - claude·codex: {"hookSpecificOutput":{"hookEventName":…,"additionalContext":…}} (코덱스 0.171.0 실물 확인, 코디)
 * - agy: {"injectSteps":[{"systemMessage":{"systemMessage":…}}]} (agy 1.5.13 실물 확인 — 모델이 읽음)
 */
export function formatHookOutput(client: HookClient, event: HookEvent, context: string): string {
  if (!context) return emptyHookOutput(client);
  if (client === "agy") return JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: context } }] });
  const hookEventName = event === "session-start" ? "SessionStart" : "UserPromptSubmit";
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } });
}

/**
 * 도구별 글자 상한. 클로드는 10,000자 넘으면 미리보기만(→ 9,500). 코덱스는 기본 약 2,500토큰을 넘으면
 * 파일+미리보기(코디 실측) — 한글은 글자당 토큰이 많아서 3,000자로 잡는다(MEMORY_HOOK_CODEX_MAX_CHARS).
 * agy 는 문서에 상한이 없어 클로드와 같게 둔다.
 */
export function clientMaxChars(client: HookClient): number {
  if (client === "codex") return Math.max(500, Math.floor(numEnv("MEMORY_HOOK_CODEX_MAX_CHARS", 3000)));
  return HOOK_CONTEXT_MAX_CHARS;
}

/** 도구 입력에서 사용자가 친 말. agy 는 PreInvocation 이 모델 호출마다 돌므로 턴의 첫 호출(0)만 쓴다. */
export function hookPromptText(client: HookClient, input: any): { text: string; skip?: string } {
  if (client === "agy") {
    const n = input?.invocationNum;
    if (Number.isInteger(n) && n > 0) return { text: "", skip: "later-invocation" };
    return { text: typeof input?.lastUserInput === "string" ? input.lastUserInput : "" };
  }
  return { text: typeof input?.prompt === "string" ? input.prompt : "" };
}

/** `--client <이름>` (없으면 claude — 0.9.37 로 넣은 설정 호환). 모르는 이름이면 null. */
export function parseHookClient(args: readonly string[]): HookClient | null {
  const i = args.indexOf("--client");
  if (i < 0) return "claude";
  const v = args[i + 1];
  return (HOOK_CLIENTS as readonly string[]).includes(v ?? "") ? (v as HookClient) : null;
}

/** 훅이 도는 쪽 플랫폼. Claude Code 는 훅 프로세스에도 자기 환경변수를 물려준다. */
function hookPlatform(): string | null {
  const aiAgent = (process.env.AI_AGENT ?? "").toLowerCase();
  if (aiAgent.startsWith("claude-code") || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  return null;
}

/** 브리핑의 "현재 플랫폼". 코덱스는 수집 경로마다 이름이 달라(codex-cli·codex-desktop…) 전체로 본다. */
function clientPlatform(client: HookClient): string | null {
  if (client === "agy") return "antigravity-cli";
  if (client === "codex") return null;
  return hookPlatform();
}

async function sessionStartContext(client: HookClient): Promise<HookContextResult> {
  await db.connect();
  const max = clientMaxChars(client);
  const brief = await collectBrief({ currentPlatform: clientPlatform(client) });
  let md = formatBriefMarkdown(brief);
  let mode = "full";
  if (md.length > max) {
    // 강제기억이 많거나 상한이 작으면(코덱스) inject 모드로 예산 안에 맞춘다
    md = formatBriefMarkdown(brief, { mode: "inject", maxChars: Math.max(0, max - 200) });
    mode = "inject";
  }
  const context = capContext(`mcp-agents-memory 시작 브리핑 (지난 대화 기록에서 자동으로 모은 것)\n이 글은 memory_startup 도구가 돌려주는 것과 같은 브리핑을 이번 세션 시작 때 만든 것이다. 같은 내용을 위해 memory_startup 을 다시 부를 필요는 없다.\n\n${md}`, max);
  return { context, info: { mode, chars: context.length } };
}

interface HookContextResult {
  context: string;
  info: Record<string, unknown>;
  /** 출력을 내보내기 직전에 부른다 (수집 확인 판정 남기기). */
  commit?: () => void;
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/** 시간 넘김 표시 — 로그에서 outcome "timeout" 으로 남긴다. */
class HookTimeout extends Error {}

/** p 가 ms 안에 안 끝나면 HookTimeout 으로 끝낸다(p 자체는 계속 돌지만 결과는 버린다). */
function withBudget<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new HookTimeout(`${label} timeout`)), Math.max(0, ms));
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * UserPromptSubmit: 비슷한 지난 기록(recall) + 수집 확인(클로드만, 세션마다 한 번)을 같이 돌린다.
 * 서로 따로 끝낸다 — 한쪽이 실패하거나 늦어도 다른 쪽 글은 나간다(각자 budgetMs 안에서만 기다린다,
 * 코디 리뷰 #45-2). 수집 경고를 앞에 둬서 길이 상한에 안 잘린다.
 */
async function promptContext(input: any, client: HookClient, budgetMs: number): Promise<HookContextResult> {
  const [recall, capture] = await Promise.allSettled([
    withBudget(recallContext(input, client), budgetMs, "recall"),
    withBudget(captureCheckContext(input, client), budgetMs, "capture"),
  ]);
  const warning = capture.status === "fulfilled" ? capture.value.context : "";
  if (recall.status === "rejected" && !warning) throw recall.reason;
  const recallText = recall.status === "fulfilled" ? recall.value.context : "";
  return {
    context: capContext([warning, recallText].filter(Boolean).join("\n\n"), clientMaxChars(client)),
    info: {
      ...(recall.status === "fulfilled" ? recall.value.info : { recallError: errText(recall.reason) }),
      ...(capture.status === "fulfilled" ? capture.value.info : { capture: "error", captureError: errText(capture.reason) }),
    },
    commit: capture.status === "fulfilled" ? capture.value.commit : undefined,
  };
}

async function recallContext(input: any, client: HookClient): Promise<{ context: string; info: Record<string, unknown> }> {
  const s = recallSettings();
  const { text: raw, skip: clientSkip } = hookPromptText(client, input);
  if (clientSkip) return { context: "", info: { skipped: clientSkip } };
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
    context: capContext(formatRecall(rows, s), clientMaxChars(client)),
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

/** 넣을 게 없는 끝(꺼짐·오류·시간 넘김). agy 면 {} 를 동기로 쓰고 끝낸다(process.exit 전에 확실히 나가게). */
function exitQuiet(client: HookClient): never {
  const out = emptyHookOutput(client);
  if (out) {
    try { fs.writeSync(1, out); } catch { /* stdout 이 닫혔어도 exit 0 */ }
  }
  process.exit(0);
}

export async function runHookCli(sub: string | undefined, args: readonly string[] = []): Promise<void> {
  // 훅 stdout 은 도구가 맥락으로 읽는다 → 어떤 모듈의 console.log 도 stdout 을 더럽히지 못하게
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

  const started = Date.now();
  const client = parseHookClient(args);
  const event: HookEvent | null = sub === "session-start" || sub === "prompt" ? sub : null;
  if (!client) {
    console.error(`❌ hook: unknown --client (${HOOK_CLIENTS.join(" | ")})`);
    logLine({ event: sub, outcome: "error", error: "unknown client" });
    process.exit(0);
  }
  if (!event) {
    console.error(`❌ hook: unknown subcommand "${sub ?? ""}" (session-start | prompt | print-config)`);
    exitQuiet(client);
  }
  const logEvent = event === "session-start" ? "SessionStart" : "UserPromptSubmit";
  if (process.env.MEMORY_HOOKS_OFF === "1") {
    logLine({ event: logEvent, client, outcome: "off" });
    exitQuiet(client);
  }
  if (envLoadError) {
    // 지정한 설정을 못 읽었다 → DB 에 붙지 않는다(환경변수에 남은 DATABASE_URL 로 엉뚱한 DB 에 붙지 않게)
    logLine({ event: logEvent, client, outcome: "error", ms: Date.now() - started, error: `config: ${envLoadError.message}`.slice(0, 200) });
    exitQuiet(client);
  }

  const deadlineMs = event === "session-start"
    ? numEnv("MEMORY_HOOK_SESSION_DEADLINE_MS", 6000)
    : numEnv("MEMORY_HOOK_PROMPT_DEADLINE_MS", 3500);
  setTimeout(() => {
    logLine({ event: logEvent, client, outcome: "timeout", ms: Date.now() - started });
    exitQuiet(client);
  }, deadlineMs);

  try {
    const rawIn = await readStdin();
    let input: any = {};
    try { input = rawIn.trim() ? JSON.parse(rawIn) : {}; } catch { input = {}; }
    // 각 작업은 전체 deadline 보다 조금 먼저 끊어서, 끝난 쪽 결과를 내보낼 시간을 남긴다
    const margin = Math.min(300, Math.floor(deadlineMs / 4));
    const { context, info, commit } = event === "session-start"
      ? await sessionStartContext(client)
      : await promptContext(input, client, deadlineMs - margin - (Date.now() - started));
    const out = formatHookOutput(client, event, context);
    try { commit?.(); } catch { /* 표시를 못 남기면 다음 말에서 다시 확인할 뿐 */ }
    logLine({ event: logEvent, client, outcome: context ? "injected" : "none", ms: Date.now() - started, source: input?.source, ...info });
    finish(out);
  } catch (err) {
    logLine({ event: logEvent, client, outcome: err instanceof HookTimeout ? "timeout" : "error", ms: Date.now() - started, error: errText(err) });
    exitQuiet(client);
  }
}
