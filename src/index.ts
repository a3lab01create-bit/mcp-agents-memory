#!/usr/bin/env node
// db.ts handles env loading via loadEnv() at module-import time —
// importing it first guarantees envs are populated before anything else reads them.
import { db } from "./db.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { startColdPathWorker, stopColdPathWorker, drainColdPath } from "./cold_path/worker.js";
import { collectBrief, formatBriefMarkdown } from "./briefing.js";
import { captureSessionStart, captureSessionEnd } from "./auto_save/jsonl_capture.js";
import {
  captureSessionStart as captureCodexStart,
  captureSessionEnd as captureCodexEnd,
} from "./auto_save/codex_capture.js";
import {
  captureSessionStart as captureGeminiStart,
  captureSessionEnd as captureGeminiEnd,
} from "./auto_save/gemini_capture.js";
import {
  captureSessionStart as captureGrokStart,
  captureSessionEnd as captureGrokEnd,
} from "./auto_save/grok_capture.js";
import {
  captureSessionStart as captureAntigravityStart,
  captureSessionEnd as captureAntigravityEnd,
} from "./auto_save/antigravity_capture.js";
import {
  captureSessionStart as captureHermesStart,
  captureSessionEnd as captureHermesEnd,
} from "./auto_save/hermes_capture.js";
import {
  captureSessionStart as captureOpencodeStart,
  captureSessionEnd as captureOpencodeEnd,
  isCaptureArmed as isOpencodeArmed,
} from "./auto_save/opencode_capture.js";
import { PACKAGE_VERSION } from "./version.js";
import fs from "fs";

const BRIEF_DB_TIMEOUT_MS = 5000;
// 조립된 instructions(STATIC + brief) 최대 char. 클라이언트(Claude Code 등)가
// instructions를 ~2KB(실측 ~2,054자)에서 절삭하므로, 그 안에 들어가도록 brief 예산을 역산한다.
const INSTRUCTIONS_MAX_CHARS = Number(process.env.INSTRUCTIONS_MAX_CHARS ?? 1900);
const INSTRUCTIONS_SEP = "\n\n---\n\n";

// OpenCode는 이 기기에서 capture가 armed일 때만 자동 저장 목록에 올린다 — v1(JSON storage)이나
// Node < 22.5처럼 capture가 못 뜨는 환경에서 "save_message 호출 금지"를 읽고 저장이 0건이 되는 것 방지.
// → runMcpServer가 captureOpencodeStart를 buildInstructions보다 먼저 await.
function staticInstructions(): string {
  const autoCaptured = "Claude Code / Codex CLI / Gemini CLI / Grok Build / Antigravity / Hermes" +
    (isOpencodeArmed() ? " / OpenCode" : "");
  return `Long-term memory MCP server (RESPEC v1).

▶ 세션 시작 시 \`memory_startup\`을 한 번 호출해 최근 대화·활성 프로젝트·상세 프로필 맥락을 이어받으세요.

Tools: memory_startup(시작 brief) · search_memory(과거 조회/검색) · manage_knowledge(저장/수정/삭제; 강제기억 is_pinned) · save_message(transcript 미지원 platform fallback).

자동 저장: ${autoCaptured}는 transcript 자동 캡처 — save_message 호출 금지(중복 row). 그 외 platform만 매 turn save_message.

능동 규칙(mandatory): named entity(프로젝트·repo·인물) 언급 시, 또는 과거 선호·결정을 가정하기 전 먼저 search_memory. 작업당 1-2회.

호출 시 agent_model 명시 (subagent면 subagent:true + subagent_model/role 동봉).`;
}

const STATIC_INSTRUCTIONS_BRIEF_UNAVAILABLE = `\n\n---\n\n⚠️ 시작 brief를 불러오지 못했습니다 (DB 연결 또는 쿼리 timeout). \`memory_startup\` tool을 명시 호출해 brief를 받으세요.`;

/**
 * DB connect + brief 쿼리 둘 다 5초 타임아웃 race로 감쌈. 실패 시 static + 안내.
 * MCP server는 instructions가 construct 시점 고정이라 DB pre-connect 필요.
 *
 * P2 fix (codex 지적): 이전엔 DB connect만 timeout 적용. brief 쿼리 자체는
 * 무한 대기 가능했음 (큰 데이터셋 + 느린 쿼리 시 startup hang). 이제 둘 다 race.
 */
/** boot 시점 env-based platform 감지 — clientInfo handshake 전에 brief 만들어야 해서.
 * Claude Code만 안정적 detect 가능 (env AI_AGENT="claude-code/..."). Gemini/Codex는
 * 표준 env 없어 null 반환 → cross-platform brief 폴백. */
function detectBootPlatformFromEnv(): string | null {
  const aiAgent = (process.env.AI_AGENT ?? "").toLowerCase();
  if (aiAgent.startsWith("claude-code") || process.env.CLAUDE_CODE_ENTRYPOINT) {
    return "claude-code";
  }
  return null;
}

async function buildInstructions(): Promise<string> {
  const STATIC_INSTRUCTIONS = staticInstructions();
  try {
    const work = (async () => {
      const { db } = await import("./db.js");
      await db.connect();
      const currentPlatform = detectBootPlatformFromEnv();
      const brief = await collectBrief({ currentPlatform });
      // 클라이언트 캡 안에서 살아남도록 inject 모드 + 역산한 예산으로.
      // brief 예산 = 전체 캡 − STATIC − 구분자. inject 모드가 이 예산 내에서
      // header+Core(보장) 후 Pinned→Active를 줄 단위로 채운다 (Sub·Recent는 lazy).
      const briefBudget = Math.max(
        0,
        INSTRUCTIONS_MAX_CHARS - STATIC_INSTRUCTIONS.length - INSTRUCTIONS_SEP.length
      );
      return formatBriefMarkdown(brief, { mode: "inject", maxChars: briefBudget });
    })();

    const briefMd = await Promise.race([
      work,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("buildInstructions timeout")), BRIEF_DB_TIMEOUT_MS)
      ),
    ]);

    const assembled = `${STATIC_INSTRUCTIONS}${INSTRUCTIONS_SEP}${briefMd}`;
    if (assembled.length > INSTRUCTIONS_MAX_CHARS) {
      // 예산을 역산했으므로 정상 경로에선 도달 불가. Core Profile 비대 등 예외 시만.
      console.error(
        `⚠️ instructions ${assembled.length}자 > cap ${INSTRUCTIONS_MAX_CHARS} — Core Profile 길이 점검 필요`
      );
    }
    return assembled;
  } catch (err) {
    console.error("⚠️ Brief 동적 주입 실패 (DB connect 또는 brief 쿼리 timeout):", err instanceof Error ? err.message : err);
    console.error("   static fallback + 'memory_startup 명시 호출 권장' 안내 포함.");
    return STATIC_INSTRUCTIONS + STATIC_INSTRUCTIONS_BRIEF_UNAVAILABLE;
  }
}

export let connectedClient: { name: string; version: string } | null = null;

let isShuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`🛑 Shutting down (${reason})...`);

  // 부모 죽은 게 의심되는 종료라도 watchdog 다시 trigger 안 되게 즉시 정지
  stopParentWatchdog();

  // 1. Final JSONL flush — INSERT raw rows. fs.watch 살아있는 동안 대부분
  //    이미 들어왔지만 마지막 1-2건 잡힘. cross-platform (Claude Code / Codex / Gemini / Grok / Antigravity / Hermes / OpenCode) 병렬.
  try {
    await Promise.race([
      Promise.allSettled([
        captureSessionEnd(),
        captureCodexEnd(),
        captureGeminiEnd(),
        captureGrokEnd(),
        captureAntigravityEnd(),
        captureHermesEnd(),
        captureOpencodeEnd(),
      ]),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch (err) {
    console.error("📝 capture error (non-blocking):", err);
  }

  // 2. Worker timer 먼저 정지 — 정기 tick이 drain 직전에 fire되면 running=true
  //    상태가 되어 drain의 첫 tick() 호출이 즉시 0 반환하고 break하는 race 방지.
  try { stopColdPathWorker(); } catch {}
  // Phase E will add: stopLibrarianWorker() here.

  // 3. Drain ColdPath — 방금 INSERT된 row + 기존 pending 모두 tag+embed.
  //    20s hard cap. Gemini tag (~1.5s/row) + OpenAI embed (~0.5s/row) +
  //    첫 batch API cold start 고려. 5 row 첫 batch ~10s + 후속 ~5s × 2.
  try {
    await Promise.race([
      drainColdPath(),
      new Promise<void>((resolve) => setTimeout(resolve, 20000)),
    ]);
  } catch (err) {
    console.error("🔵 [ColdPath] drain error (non-blocking):", err);
  }

  try {
    await Promise.race([
      db.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch (err) {
    console.error("Error during shutdown:", err);
  }

  process.exit(0);
}

// --- Parent watchdog ---
// Claude Code parent가 SIGKILL 등 비정상 종료되면 stdin close 이벤트가 fire
// 안 될 수 있음. ppid 변화로 부모 사망 감지 → 자동 shutdown. 이거 없으면
// 우리가 어젯밤 본 7시간 idle MCP 고아 프로세스 재발.
let _initialPpid: number | null = null;
let _parentWatchdog: NodeJS.Timeout | null = null;
const PARENT_CHECK_INTERVAL_MS = 30_000;

function startParentWatchdog(): void {
  _initialPpid = process.ppid;
  // ppid가 1 (init/launchd)이면 처음부터 부모 없음 — watchdog 무의미
  if (!_initialPpid || _initialPpid === 1) {
    console.error(`👻 [Watchdog] no parent to watch (ppid=${_initialPpid}) — skip`);
    return;
  }
  console.error(`👻 [Watchdog] parent ppid=${_initialPpid}, check every ${PARENT_CHECK_INTERVAL_MS / 1000}s`);
  _parentWatchdog = setInterval(() => {
    const current = process.ppid;
    if (current !== _initialPpid) {
      console.error(`👻 [Watchdog] parent died (ppid ${_initialPpid} → ${current}) — auto shutdown`);
      stopParentWatchdog();
      void shutdown("parent-died");
    }
  }, PARENT_CHECK_INTERVAL_MS);
  // setInterval만으로 process alive 유지 안 되도록 unref (event loop 마지막 작업이면 자연 exit)
  _parentWatchdog.unref();
}

function stopParentWatchdog(): void {
  if (_parentWatchdog) {
    clearInterval(_parentWatchdog);
    _parentWatchdog = null;
  }
}

function installShutdownHandlers(): void {
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT",  () => { void shutdown("SIGINT");  });
  process.on("SIGHUP",  () => { void shutdown("SIGHUP");  });

  // Parent closing stdin = parent process died (MCP stdio convention).
  process.stdin.on("end",   () => { void shutdown("stdin-end");   });
  process.stdin.on("close", () => { void shutdown("stdin-close"); });
}

function printHelp() {
  console.log(`mcp-agents-memory v${PACKAGE_VERSION}

Usage:
  mcp-agents-memory                 Run the MCP server (stdio).
  mcp-agents-memory coldpath        Run ONLY the cold-path worker as a standalone always-on daemon (no MCP server). For the processing/GPU machine via systemd.
  mcp-agents-memory setup           Interactive setup — write config to ~/.config/mcp-agents-memory/.env and run migrations.
  mcp-agents-memory migrate         Apply any pending DB migrations against the configured database.
  mcp-agents-memory buzz-ingest [--dry-run] [--max N] [--no-reclean]
                                    (Buzz only) Copy chat messages from the Buzz rooms the CLI identity is a member of
                                    into memory, one row per message, via the official \`buzz\` CLI. Oldest first, at most
                                    N per run (default 20). With the remaining budget it also strips the quoted history
                                    from captured Buzz turns once every quoted message exists as a row (original kept in
                                    raw_message), and fixes Buzz envelopes an older server stored uncleaned; --no-reclean skips both. Needs BUZZ_RELAY_URL, BUZZ_PRIVATE_KEY and BUZZ_INGEST_OWNER
                                    (the memory owner's pubkeys, comma-separated) in the environment of this command only —
                                    not in the shared .env; optional BUZZ_CLI.
  mcp-agents-memory retag-ptag [--count | --dry-run | --rollback] [--only stale|untagged | --venue buzz:<channel>] [--untagged-days N]
                               [--before ISO] [--max N] [--minutes N] [--concurrency N] [--sample] [--seed S]
                               [--log PATH] [--allow-fallback] [--hold-new <registry tag>[,...]] [--since ISO (with --rollback)]
                                    (Project registry only) Re-decide ONLY the project tag of already-tagged memories:
                                    (a) rows whose tag is outside the registry (pinned rows skipped), (b) untagged rows from
                                    the last N days (default 30) written before the registry existed. Same tagger as the
                                    cold path; d_tag, message, embedding are never touched. Every decision is appended to a
                                    JSONL log (default ~/.local/state/mcp-agents-memory/ptag-retag/decisions.jsonl) — the
                                    backup, the resume point (decided rows are skipped next run) and the source for
                                    --rollback. --count only counts; --dry-run decides without writing to a separate
                                    dryrun-*.jsonl next to the log — review that file before the real run (--sample mixes
                                    both targets instead of newest first). The grok fallback is off unless
                                    --allow-fallback: failed rows are logged and retried next run; 5 errors in a row stop it.
                                    --venue re-decides every row from one channel instead (registry tags included), e.g.
                                    after giving that channel a project hint with register_project channels.
                                    --hold-new <tag> leaves a row untouched when the tagger picks that tag (logged as
                                    "held" and re-decided next run) — for a tag the tagger is known to over-assign.
  mcp-agents-memory help            Show this message.

Configuration is loaded from (first hit wins):
  $MEMORY_CONFIG_PATH > ./.env > ~/.config/mcp-agents-memory/.env > <package>/../.env

Required settings:
  DATABASE_URL=postgres://user:pass@host:5432/db?sslmode=require   (or DB_HOST + DB_USER + DB_PASS + DB_NAME)
  OPENAI_API_KEY=sk-...                                            (embedding text-embedding-3-large)
  XAI_API_KEY=...                                                  (Cold Path tagger/librarian — grok-4-1-fast-non-reasoning default)`);
}

async function runMcpServer() {
  // OpenCode capture는 instructions의 자동 저장 목록을 좌우하므로 buildInstructions보다 먼저 arm.
  // (opencode.db 없는 기기는 existsSync 한 번으로 즉시 no-op)
  await captureOpencodeStart(process.cwd());

  // §1 fix: brief 동적 주입을 위해 DB 먼저 연결 (5s timeout). 실패 시 static 폴백.
  const instructions = await buildInstructions();

  const server = new McpServer(
    {
      name: "mcp-agents-memory",
      version: PACKAGE_VERSION,
    },
    { instructions }
  );

  const originalConnect = server.connect.bind(server);
  server.connect = async (transport: any) => {
    console.error("🚀 Memory server starting connection...");
    return originalConnect(transport);
  };

  registerTools(server);

  installShutdownHandlers();
  startParentWatchdog();

  // §4/§5 fix: cross-platform passive 캡처 arm. 각자 transcript 파일 dir 없으면 no-op.
  // - jsonl_capture: ~/.claude/projects/<slug>/*.jsonl
  // - codex_capture: ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl (recursive watch)
  // - gemini_capture: ~/.gemini/tmp/<projectKey>/chats/session-*.json
  // - grok_capture: ~/.grok/sessions/<urlencoded-cwd>/<sid>/chat_history.jsonl (recursive watch)
  // - antigravity_capture: ~/.gemini/antigravity-cli/brain/<sid>/.system_generated/logs/transcript_full.jsonl
  // - hermes_capture: ~/.hermes/state.db (SQLite messages 테이블, id 커서 폴링)
  // - opencode_capture: ~/.local/share/opencode/opencode.db (SQLite session_message, time_updated 커서 폴링)
  //   — instructions 목록 때문에 runMcpServer 맨 앞에서 이미 arm됨.
  captureSessionStart(process.cwd());
  captureCodexStart(process.cwd());
  captureGeminiStart(process.cwd());
  captureGrokStart(process.cwd());
  captureAntigravityStart(process.cwd());
  // Hermes만 async arm (node:sqlite lazy import). arm 완료 전 짧은 창에서는
  // isHermesArmed()=false라 "mcp" save_message가 정상 저장됨(중복 아님, 무해).
  void captureHermesStart(process.cwd());

  console.error("🚀 Starting Memory MCP Server...");

  if (process.env.SSH_ENABLED === "true" && !process.env.SSH_KEY_PATH) {
    throw new Error("❌ SSH_KEY_PATH is required when SSH is enabled");
  }
  if (process.env.SSH_KEY_PATH && !fs.existsSync(process.env.SSH_KEY_PATH)) {
    console.error(`⚠️ [WARNING] SSH key not found at: ${process.env.SSH_KEY_PATH}`);
  }

  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`🧠 Memory MCP Server (v${PACKAGE_VERSION}) running on stdio — RESPEC v1 fresh impl`);
    // DB는 buildInstructions()에서 이미 connect 시도. 실패해도 server는 떴음.
    // Hot Path / Cold Path / tools는 DB 필요할 때 db.connect() 자동 호출 (idempotent).
  } catch (err) {
    console.error("❌ Fatal error during startup:", err);
    process.exit(1);
  }

  void startColdPathWorker().catch((err) => console.error("❌ [ColdPath] start failed:", err));
  // Phase E will start Librarian (memory→user) worker here.
}

async function runColdPathDaemon() {
  // Standalone cold-path daemon — runs ONLY the cold-path worker, no MCP server.
  // Intended for an always-on systemd service on the processing/GPU machine, so
  // the cold-path is decoupled from any editor/MCP lifecycle. The daemon IS the
  // cold-path, so force it on regardless of COLD_PATH_ENABLED=false (which the
  // MCP servers on this same box use to stay thin clients).
  process.env.COLD_PATH_ENABLED = "true";

  // systemd stop = SIGTERM → clean shutdown (drain + advisory-lock release + exit).
  // No stdin handlers (daemon has no stdin pipe) and no parent watchdog (systemd supervises).
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT",  () => { void shutdown("SIGINT");  });
  process.on("SIGHUP",  () => { void shutdown("SIGHUP");  });

  // Connect DB up front so an unreachable DB / bad tunnel fails loudly → systemd retries.
  try {
    await db.connect();
  } catch (err) {
    console.error("❌ [ColdPathDaemon] DB connect failed — exiting (systemd will retry):", err);
    process.exit(1);
  }

  console.error(`🧊 Cold-path daemon (v${PACKAGE_VERSION}) started — no MCP server`);
  await startColdPathWorker();
  // If the lock was acquired, the cold-path interval keeps the process alive.
  // If another instance already holds the lock, this process has nothing to do
  // and exits cleanly (exit 0 → systemd won't restart-loop). Normal single-daemon
  // deployments always acquire the lock.
}

async function cli() {
  const cmd = process.argv[2];

  if (!cmd || cmd === "serve") {
    return runMcpServer();
  }

  if (cmd === "coldpath") {
    return runColdPathDaemon();
  }

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(PACKAGE_VERSION);
    return;
  }

  if (cmd === "setup") {
    const { runSetupWizard } = await import("./setup.js");
    await runSetupWizard();
    process.exit(0);
  }

  if (cmd === "buzz-ingest") {
    // buzz용 — Buzz 정본을 한 번 가져오고 끝난다 (타이머가 주기적으로 부름)
    const { runBuzzIngest, parseIngestArgs } = await import("./auto_save/buzz_ingest.js");
    const opts = parseIngestArgs(process.argv.slice(3));
    await db.connect();
    const report = await runBuzzIngest(opts);
    console.log(JSON.stringify({ dryRun: opts.dryRun ?? false, ...report }));
    await db.close();
    process.exit(0);
  }

  if (cmd === "retag-ptag") {
    // 프로젝트 태그만 명부 기준으로 다시 붙이는 일회성 운영 작업 (DEVLOG §24 L2)
    const { parseRetagArgs } = await import("./cold_path/ptag_retag_plan.js");
    const { runRetag } = await import("./cold_path/ptag_retag.js");
    const opts = parseRetagArgs(process.argv.slice(3));
    await db.connect();
    const report = await runRetag(opts);
    console.log(JSON.stringify(report));
    await db.close();
    process.exit(0);
  }

  if (cmd === "migrate") {
    const { runAllMigrations } = await import("./migrations/runner.js");
    await runAllMigrations();
    process.exit(0);
  }

  console.error(`❌ Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

cli().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
