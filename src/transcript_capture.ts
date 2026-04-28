/**
 * Track 1 — Session-end transcript capture.
 *
 * Called from shutdown(): identifies the active Claude Code transcript jsonl
 * for the current cwd, then INSERTs (path + byte range) into transcript_queue.
 * No LLM call here — that runs in the background processor (transcript_processor.ts)
 * so shutdown stays under the db.close() 3s race.
 *
 * Strategy:
 *  1. cwd → slug → ~/.claude/projects/<slug>/  (Claude Code path convention:
 *     '/' → '-')
 *  2. Pick the highest-mtime *.jsonl in that directory as "current session"
 *  3. session_id = filename without .jsonl extension
 *  4. UNIQUE (session_id, source_path, byte_offset_end) blocks dup INSERTs
 *
 * Why no fs.watch:
 *   - macOS kqueue / Linux inotify behave differently for rename events
 *   - watch handles leak if not closed before process.exit
 *   - we only need the *final* state at shutdown, not live tracking
 *   - mtime scan at shutdown is O(jsonls in one dir), <1ms in practice
 *
 * Client gating:
 *   - Only fires when connectedClient.name === 'claude-code'. Other MCP clients
 *     (Cursor, Claude Desktop, generic) silently skip. Logged once at startup.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { db } from "./db.js";

interface SessionContext {
  cwd: string;
  startedAt: Date;
  clientName?: string | null;
  callerPlatform?: string;
  callerModel?: string;
  callerAgentKey?: string;
}

let sessionContext: SessionContext | null = null;

export function captureSessionStart(cwd: string): void {
  sessionContext = {
    cwd,
    startedAt: new Date(),
    callerPlatform: process.env.AGENT_PLATFORM,
    callerAgentKey: process.env.AGENT_KEY,
  };
}

export function setConnectedClientName(name: string | null | undefined): void {
  if (sessionContext) sessionContext.clientName = name ?? null;
}

function cwdToProjectDir(cwd: string): string {
  // Claude Code's slug rule: replace '/' with '-'. Empirically stable for
  // POSIX paths without spaces; verified against the live ~/.claude/projects/
  // layout on this machine before shipping.
  const slug = cwd.replace(/\//g, "-");
  return path.join(os.homedir(), ".claude", "projects", slug);
}

function findLatestJsonl(dir: string): { name: string; fullPath: string; mtime: Date; size: number } | null {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let latest: { name: string; fullPath: string; mtime: Date; size: number } | null = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const full = path.join(dir, entry.name);
    const stat = fs.statSync(full);
    if (!latest || stat.mtime > latest.mtime) {
      latest = { name: entry.name, fullPath: full, mtime: stat.mtime, size: stat.size };
    }
  }
  return latest;
}

/**
 * Called once at server start (after captureSessionStart). Walks every
 * *.jsonl in the project dir and INSERTs each into transcript_queue.
 * UNIQUE (session_id, source_path, byte_offset_end) makes this a safe
 * no-op for already-queued sessions; only genuinely new transcripts
 * (or transcripts that grew since last queue) become rows.
 *
 * Why we need this: captureSessionEnd only fires at *future* shutdowns.
 * Without backfill, every transcript that existed before the user upgraded
 * to the self-watch build is invisible to the system forever.
 */
export async function backfillExistingTranscripts(): Promise<void> {
  if (!sessionContext) return;
  const ctx = sessionContext;

  const projectDir = cwdToProjectDir(ctx.cwd);
  if (!fs.existsSync(projectDir)) {
    console.error(`📝 [Backfill] no project dir at ${projectDir} — skip`);
    return;
  }

  const entries = fs.readdirSync(projectDir, { withFileTypes: true });
  const jsonls = entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => {
      const fullPath = path.join(projectDir, e.name);
      const stat = fs.statSync(fullPath);
      return { name: e.name, fullPath, size: stat.size, mtime: stat.mtime };
    })
    .filter((j) => j.size > 0);

  if (jsonls.length === 0) {
    console.error(`📝 [Backfill] no jsonls in ${projectDir} — skip`);
    return;
  }

  let queued = 0;
  for (const j of jsonls) {
    const sessionId = j.name.replace(/\.jsonl$/, "");
    try {
      const res = await db.query(
        `INSERT INTO transcript_queue
           (session_id, source_path, byte_offset_start, byte_offset_end,
            cwd, client_name, caller_platform, caller_model, caller_agent_key)
         VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (session_id, source_path, byte_offset_end) DO NOTHING
         RETURNING id`,
        [
          sessionId,
          j.fullPath,
          j.size,
          ctx.cwd,
          ctx.clientName ?? null,
          ctx.callerPlatform ?? null,
          ctx.callerModel ?? null,
          ctx.callerAgentKey ?? null,
        ]
      );
      if (res.rows.length > 0) queued++;
    } catch (err) {
      console.error(`📝 [Backfill] INSERT failed for ${j.name}:`, err);
    }
  }

  console.error(
    `📝 [Backfill] ${queued} new / ${jsonls.length} total in ${projectDir}`
  );
}

/**
 * Called from shutdown(). Must complete in well under db.close()'s 3s race —
 * targets ~100ms (one stat + one INSERT). All errors are caught and logged;
 * this never blocks shutdown.
 */
export async function captureSessionEnd(): Promise<void> {
  if (!sessionContext) return;
  const ctx = sessionContext;

  // Client gate — only Claude Code has the jsonl convention we depend on.
  if (ctx.clientName && ctx.clientName !== "claude-code") {
    console.error(
      `📝 [Transcript] skipped — client '${ctx.clientName}' not supported (Claude Code only)`
    );
    return;
  }

  const projectDir = cwdToProjectDir(ctx.cwd);
  const latest = findLatestJsonl(projectDir);
  if (!latest) {
    console.error(`📝 [Transcript] no jsonl found in ${projectDir} — skip`);
    return;
  }

  // Sanity: jsonl mtime should be after this session started. If older, it's
  // likely a previous session's transcript — don't capture.
  if (latest.mtime.getTime() < ctx.startedAt.getTime() - 60_000 /* 60s slack */) {
    console.error(
      `📝 [Transcript] latest jsonl mtime predates session start — skip (likely stale: ${latest.name})`
    );
    return;
  }

  if (latest.size === 0) {
    console.error(`📝 [Transcript] empty jsonl — skip`);
    return;
  }

  const sessionId = latest.name.replace(/\.jsonl$/, "");

  try {
    await db.query(
      `INSERT INTO transcript_queue
         (session_id, source_path, byte_offset_start, byte_offset_end,
          cwd, client_name, caller_platform, caller_model, caller_agent_key)
       VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (session_id, source_path, byte_offset_end) DO NOTHING`,
      [
        sessionId,
        latest.fullPath,
        latest.size,
        ctx.cwd,
        ctx.clientName ?? null,
        ctx.callerPlatform ?? null,
        ctx.callerModel ?? null,
        ctx.callerAgentKey ?? null,
      ]
    );
    console.error(
      `📝 [Transcript] queued — session=${sessionId.slice(0, 8)}…, ${(latest.size / 1024).toFixed(1)}KB`
    );
  } catch (err) {
    console.error("📝 [Transcript] queue INSERT failed (non-blocking):", err);
  }
}
