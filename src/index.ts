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
import { PACKAGE_VERSION } from "./version.js";
import fs from "fs";

const BRIEF_DB_TIMEOUT_MS = 5000;

const STATIC_INSTRUCTIONS = `Long-term memory MCP server (RESPEC v1).

Tools:
  - memory_startup    : 시작 brief (user profile + 최근 활성 프로젝트 + 최근 메모리). 세션 시작 시 첫 호출 권장.
  - search_memory     : 과거 기억 조회/검색 통합 (의미 + 키워드 fallback)
  - manage_knowledge  : 명시 저장/수정/삭제 통합 (강제 기억은 is_pinned, archive 면제)
  - save_message      : 매 user/assistant turn 끝나면 호출 — Hot Path 자동 저장

Hot Path (자동 저장)는 caller가 raw 메시지 발생 시 직접 호출 — 사람의 기억처럼 시간 순서로 raw 보존, Cold Path가 백그라운드에서 태깅+임베딩.

caller convention:
  - 매 user/assistant turn 끝나면 save_message 호출 (또는 Claude Code는 SessionEnd JSONL 자동 캡처)
  - manage_knowledge / save_message 호출 시 agent_model 명시 (생략 시 'unknown' 저장)
  - subagent context면 subagent: true + subagent_model + subagent_role 함께`;

const STATIC_INSTRUCTIONS_BRIEF_UNAVAILABLE = `\n\n---\n\n⚠️ 시작 brief를 불러오지 못했습니다 (DB 연결 또는 쿼리 timeout). \`memory_startup\` tool을 명시 호출해 brief를 받으세요.`;

/**
 * DB connect + brief 쿼리 둘 다 5초 타임아웃 race로 감쌈. 실패 시 static + 안내.
 * MCP server는 instructions가 construct 시점 고정이라 DB pre-connect 필요.
 *
 * P2 fix (codex 지적): 이전엔 DB connect만 timeout 적용. brief 쿼리 자체는
 * 무한 대기 가능했음 (큰 데이터셋 + 느린 쿼리 시 startup hang). 이제 둘 다 race.
 */
async function buildInstructions(): Promise<string> {
  try {
    const work = (async () => {
      const { db } = await import("./db.js");
      await db.connect();
      const brief = await collectBrief();
      return formatBriefMarkdown(brief);
    })();

    const briefMd = await Promise.race([
      work,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("buildInstructions timeout")), BRIEF_DB_TIMEOUT_MS)
      ),
    ]);

    return `${STATIC_INSTRUCTIONS}\n\n---\n\n${briefMd}`;
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
  //    이미 들어왔지만 마지막 1-2건 잡힘.
  try {
    await Promise.race([
      captureSessionEnd(),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch (err) {
    console.error("📝 [JSONL] capture error (non-blocking):", err);
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
  mcp-agents-memory setup           Interactive setup — write config to ~/.config/mcp-agents-memory/.env and run migrations.
  mcp-agents-memory migrate         Apply any pending DB migrations against the configured database.
  mcp-agents-memory help            Show this message.

Configuration is loaded from (first hit wins):
  $MEMORY_CONFIG_PATH > ./.env > ~/.config/mcp-agents-memory/.env > <package>/../.env

Required settings:
  DATABASE_URL=postgres://user:pass@host:5432/db?sslmode=require   (or DB_HOST + DB_USER + DB_PASS + DB_NAME)
  OPENAI_API_KEY=sk-...                                            (embedding text-embedding-3-large)
  GEMINI_API_KEY=...                                               (Cold Path tagger gemini-2.5-flash)`);
}

async function runMcpServer() {
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

  // §4 fix: Claude Code JSONL 캡처 cursor 기록 + fs.watch arm (real-time).
  // 비-Claude Code (Gemini CLI / Codex 등)는 jsonlPath 없으므로 no-op.
  captureSessionStart(process.cwd());

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

  startColdPathWorker();
  // Phase E will start Librarian (memory→user) worker here.
}

async function cli() {
  const cmd = process.argv[2];

  if (!cmd || cmd === "serve") {
    return runMcpServer();
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
