/**
 * Track 1 — Background processor for transcript_queue.
 *
 * Drains rows that captureSessionEnd() inserted at shutdown:
 *   pending → processing → done | failed
 *
 * For each row: read jsonl byte range → extract message text →
 * Librarian processBatch (fact extraction + persist to memories) →
 * mark done. Errors stamp status='failed' with the message — never
 * lost, manually re-runnable later.
 *
 * Default-on (TRANSCRIPT_PROCESSOR_ENABLED=false to disable). The user's
 * vision is "MCP install = it just works"; an opt-in flag would re-introduce
 * the setup step Track 1 exists to remove.
 */

import * as fs from "fs";
import { db } from "./db.js";
import { processBatch, ProvenanceInfo } from "./librarian.js";
import { getOrCreateSubject } from "./subjects.js";

let warmupTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;
let running = false;

const DEFAULT_WARMUP_SEC = 30;
const DEFAULT_INTERVAL_SEC = 120;
const DEFAULT_BATCH_LIMIT = 3;

interface QueueRow {
  id: number;
  session_id: string;
  source_path: string;
  byte_offset_start: number;
  byte_offset_end: number;
  cwd: string | null;
  client_name: string | null;
  caller_platform: string | null;
  caller_model: string | null;
  caller_agent_key: string | null;
}

function parseSeconds(raw: string | undefined, fallback: number, label: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    if (raw !== undefined) {
      console.error(`📝 [Processor] invalid ${label}=${raw}; using default ${fallback}s`);
    }
    return fallback;
  }
  return parsed;
}

/**
 * Read a byte range from a jsonl file and pull out user/assistant text.
 * Skips permission-mode / snapshot lines and partial trailing lines (these
 * happen when shutdown captures size mid-write).
 */
function extractTextFromJsonl(filePath: string, startByte: number, endByte: number): string {
  // pg returns BIGINT columns as strings; coerce so fs.readSync's `position`
  // arg gets a real number (it throws on string).
  const start = Number(startByte);
  const end = Number(endByte);
  const fd = fs.openSync(filePath, "r");
  try {
    const length = Math.max(0, end - start);
    if (length === 0) return "";
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    const raw = buf.toString("utf-8");
    const lines = raw.split("\n");

    const parts: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: any;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        // Partial line (last one truncated mid-write) — skip silently.
        continue;
      }
      if (entry.type !== "user" && entry.type !== "assistant") continue;
      const text = stringifyMessageContent(entry.message?.content);
      if (text) {
        const role = entry.type === "user" ? "User" : "Assistant";
        parts.push(`${role}: ${text}`);
      }
    }
    return parts.join("\n\n");
  } finally {
    fs.closeSync(fd);
  }
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as any;
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
    // Tool uses / tool results are skipped — they're protocol noise that
    // bloats fact extraction without adding semantic content.
  }
  return out.join("\n");
}

function deriveProjectKey(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || null;
}

async function processOneInternal(row: QueueRow): Promise<void> {
  if (!fs.existsSync(row.source_path)) {
    await db.query(
      `UPDATE transcript_queue SET status='failed', error=$2, processed_at=NOW() WHERE id=$1`,
      [row.id, "source jsonl no longer exists"]
    );
    return;
  }

  const text = extractTextFromJsonl(row.source_path, row.byte_offset_start, row.byte_offset_end);
  if (!text.trim()) {
    await db.query(
      `UPDATE transcript_queue SET status='done', processed_at=NOW(), error=$2 WHERE id=$1`,
      [row.id, "empty after extraction"]
    );
    return;
  }

  const subjectKey = process.env.MEMORY_DEFAULT_SUBJECT || "default_user";
  const subjectId = await getOrCreateSubject(subjectKey, "person");
  const projectKey = deriveProjectKey(row.cwd);
  const projectId = projectKey ? await getOrCreateSubject(projectKey, "project") : null;

  const agentCuratorId = row.caller_agent_key
    ? await getOrCreateSubject(row.caller_agent_key, "agent")
    : null;

  const provenance: ProvenanceInfo = {
    author_model: row.caller_model ?? undefined,
    platform: row.client_name ?? row.caller_platform ?? undefined,
    agent_platform: row.caller_platform ?? row.client_name ?? undefined,
    agent_model: row.caller_model ?? undefined,
    agent_curator_id: agentCuratorId,
    session_id: row.session_id,
    source: "transcript",
  };

  const result = await processBatch(text, subjectId, projectId, "transcript", provenance);

  // Fail-loud: don't let the queue claim 'done' when Librarian extracted nothing
  // from a non-trivial transcript. triageTranscript / extractFacts swallow LLM
  // errors gracefully, so without this check zero-fact rows would be invisible.
  if (result.extracted === 0 && text.length >= 200) {
    const errMsg = `Librarian produced 0 facts from ${text.length} chars (errors: ${result.errors.join("; ").slice(0, 400) || "none recorded — likely silent triage/extract failure"})`;
    await db.query(
      `UPDATE transcript_queue SET status='failed', error=$2, processed_at=NOW() WHERE id=$1`,
      [row.id, errMsg.slice(0, 500)]
    );
    return;
  }

  await db.query(
    `UPDATE transcript_queue SET status='done', processed_at=NOW() WHERE id=$1`,
    [row.id]
  );
}

async function tick(batchLimit: number): Promise<void> {
  if (running) return;
  running = true;

  try {
    const claimed = await db.query(
      `UPDATE transcript_queue
       SET status='processing'
       WHERE id IN (
         SELECT id FROM transcript_queue
         WHERE status='pending'
         ORDER BY captured_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, session_id, source_path, byte_offset_start, byte_offset_end,
                 cwd, client_name, caller_platform, caller_model, caller_agent_key`,
      [batchLimit]
    );

    if (claimed.rows.length === 0) return;

    console.error(`📝 [Processor] tick — ${claimed.rows.length} pending`);
    for (const row of claimed.rows as QueueRow[]) {
      try {
        await processOneInternal(row);
        console.error(`📝 [Processor] processed session=${row.session_id.slice(0, 8)}…`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`📝 [Processor] failed session=${row.session_id.slice(0, 8)}… — ${msg}`);
        await db.query(
          `UPDATE transcript_queue SET status='failed', error=$2, processed_at=NOW() WHERE id=$1`,
          [row.id, msg.slice(0, 500)]
        );
      }
    }
  } catch (err) {
    console.error("📝 [Processor] tick error:", err);
  } finally {
    running = false;
  }
}

export function maybeStartTranscriptProcessor(): void {
  if (process.env.TRANSCRIPT_PROCESSOR_ENABLED === "false") {
    console.error("📝 [Processor] disabled (TRANSCRIPT_PROCESSOR_ENABLED=false)");
    return;
  }
  if (warmupTimer || intervalTimer) return;

  const warmupSec = parseSeconds(process.env.TRANSCRIPT_PROCESSOR_WARMUP_SEC, DEFAULT_WARMUP_SEC, "warmup");
  const intervalSec = parseSeconds(process.env.TRANSCRIPT_PROCESSOR_INTERVAL_SEC, DEFAULT_INTERVAL_SEC, "interval");
  const batchLimit = parseSeconds(process.env.TRANSCRIPT_PROCESSOR_BATCH, DEFAULT_BATCH_LIMIT, "batch");

  warmupTimer = setTimeout(() => {
    warmupTimer = null;
    void tick(batchLimit);
    intervalTimer = setInterval(() => { void tick(batchLimit); }, intervalSec * 1000);
  }, warmupSec * 1000);

  console.error(
    `📝 [Processor] scheduled: warmup=${warmupSec}s, interval=${intervalSec}s, batch=${batchLimit}`
  );
}

/**
 * Synchronous on-demand processing. Called from memory_startup so the
 * briefing reflects the most-recently-ended session before returning.
 * Background tick walks oldest-first; this picks newest-first and races
 * via FOR UPDATE SKIP LOCKED, so the two loops don't fight over rows.
 *
 * Errors are caught per-row — startup never fails because a single
 * transcript fails to parse.
 */
export interface SyncProcessResult {
  processed: number;
  failed: number;
  remaining_pending: number;
}

export async function processMostRecentPending(
  limit: number = 1
): Promise<SyncProcessResult> {
  let processed = 0;
  let failed = 0;

  try {
    const claimed = await db.query(
      `UPDATE transcript_queue
       SET status='processing'
       WHERE id IN (
         SELECT id FROM transcript_queue
         WHERE status='pending'
         ORDER BY captured_at DESC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, session_id, source_path, byte_offset_start, byte_offset_end,
                 cwd, client_name, caller_platform, caller_model, caller_agent_key`,
      [limit]
    );

    for (const row of claimed.rows as QueueRow[]) {
      try {
        await processOneInternal(row);
        processed++;
        console.error(`📝 [Sync] processed session=${row.session_id.slice(0, 8)}…`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`📝 [Sync] failed session=${row.session_id.slice(0, 8)}… — ${msg}`);
        await db.query(
          `UPDATE transcript_queue SET status='failed', error=$2, processed_at=NOW() WHERE id=$1`,
          [row.id, msg.slice(0, 500)]
        );
        failed++;
      }
    }
  } catch (err) {
    console.error("📝 [Sync] claim error (non-blocking):", err);
  }

  let remaining = 0;
  try {
    const rem = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM transcript_queue WHERE status='pending'`
    );
    remaining = rem.rows[0]?.cnt ?? 0;
  } catch {
    // ignore — best-effort count
  }

  return { processed, failed, remaining_pending: remaining };
}

export function stopTranscriptProcessor(): void {
  if (warmupTimer) {
    clearTimeout(warmupTimer);
    warmupTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}
