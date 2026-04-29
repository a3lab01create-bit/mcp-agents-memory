#!/usr/bin/env node
// db.ts handles env loading via loadEnv() at module-import time —
// importing it first guarantees envs are populated before anything else reads them.
import { db } from "./db.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { startColdPathWorker, stopColdPathWorker } from "./cold_path/worker.js";
import { collectBrief, formatBriefMarkdown } from "./briefing.js";
import { PACKAGE_VERSION } from "./version.js";
import fs from "fs";

const BRIEF_DB_TIMEOUT_MS = 5000;

const STATIC_INSTRUCTIONS = `Long-term memory MCP server (RESPEC v1).

Tools:
  - memory_startup    : 시작 brief (user profile + 최근 활성 프로젝트 + 최근 메모리). 세션 시작 시 첫 호출 권장.
  - search_memory     : 과거 기억 조회/검색 통합 (의미 + 키워드 fallback)
  - manage_knowledge  : 명시 저장/수정/삭제 통합 (강제 기억은 is_pinned, archive 면제)

Hot Path (자동 저장)는 caller가 raw 메시지 발생 시 직접 호출 — 사람의 기억처럼 시간 순서로 raw 보존, Cold Path가 백그라운드에서 태깅+임베딩.

manage_knowledge 호출 시 caller convention:
  - agent_model: 명시 권장 (생략 시 'unknown' 저장)
  - subagent (optional): true면 subagent_model + subagent_role 함께 명시`;

/**
 * DB 5초 타임아웃 시도 → 성공 시 brief 포함 instructions, 실패 시 static.
 * MCP server는 instructions가 construct 시점 고정이라 DB pre-connect 필요.
 */
async function buildInstructions(): Promise<string> {
  try {
    const dbReady = Promise.race([
      (async () => {
        const { db } = await import("./db.js");
        await db.connect();
        return true;
      })(),
      new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error("DB connect timeout")), BRIEF_DB_TIMEOUT_MS)),
    ]);
    await dbReady;

    const brief = await collectBrief();
    const briefMd = formatBriefMarkdown(brief);
    return `${STATIC_INSTRUCTIONS}\n\n---\n\n${briefMd}`;
  } catch (err) {
    console.error("⚠️ Brief 동적 주입 실패 (DB 연결 timeout 또는 collect 오류):", err instanceof Error ? err.message : err);
    console.error("   instructions에 brief 없이 정적 안내만 포함. 세션 시작 시 memory_startup 호출 권장.");
    return STATIC_INSTRUCTIONS;
  }
}

export let connectedClient: { name: string; version: string } | null = null;

let isShuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`🛑 Shutting down (${reason})...`);

  try { stopColdPathWorker(); } catch {}
  // Phase E will add: stopLibrarianWorker() here.

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
  mcp-agents-memory             Run the MCP server (stdio).
  mcp-agents-memory setup       Interactive setup — write config to ~/.config/mcp-agents-memory/.env and run migrations.
  mcp-agents-memory migrate     Apply any pending DB migrations against the configured database.
  mcp-agents-memory help        Show this message.

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
