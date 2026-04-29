/**
 * Claude Code Stop hook 진입점 — 매 assistant turn 종료 시 호출.
 *
 * RESPEC PROBLEMS.md §4 (B1) — form catch "SessionEnd만 = real-time 아님" 해결.
 * Stop hook은 매 turn fire → 실시간 (0초 event-driven). server-shutdown 시점만
 * 의존하던 기존 jsonl_capture.ts path는 hook 미등록 환경 fallback으로 유지.
 *
 * 호출 형태:
 *   $ mcp-agents-memory capture-session  (stdin으로 JSON payload)
 *
 * stdin payload (Claude Code Stop hook):
 *   { session_id, transcript_path, cwd, hook_event_name, ... }
 *
 * 동작:
 *   1. stdin 읽기 → session_id + transcript_path 추출
 *   2. ~/.cache/mcp-agents-memory/cursors/<session_id>.cursor 에서 byte offset 로드
 *      (없으면 0)
 *   3. transcript_path를 cursor부터 끝까지 읽고 parseEntry → insertRawMemory
 *      (external_uuid `claude-code:<sid>:<entry-uuid>`로 dedup — server-shutdown
 *      path와 동시 활성이어도 안전)
 *   4. 새 byte size를 cursor 파일에 저장
 *   5. exit 0 (hook timeout/blocking 안 걸리게 best-effort)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseEntry } from "./jsonl_capture.js";
import { insertRawMemory } from "../hot_path.js";
import { getDefaultUserId } from "../users.js";

const CLIENT_PLATFORM = "claude-code";

interface StopHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  model?: string;
}

function cursorDir(): string {
  const base = process.env.XDG_CACHE_HOME
    ? path.join(process.env.XDG_CACHE_HOME, "mcp-agents-memory")
    : path.join(os.homedir(), ".cache", "mcp-agents-memory");
  return path.join(base, "cursors");
}

function cursorPath(sessionId: string): string {
  // 화이트리스트 정제: session_id에 path-traversal 문자 들어오면 reject
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(cursorDir(), `${safe}.cursor`);
}

function readCursor(sessionId: string): number {
  try {
    const raw = fs.readFileSync(cursorPath(sessionId), "utf-8").trim();
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeCursor(sessionId: string, byteOffset: number): void {
  const dir = cursorDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cursorPath(sessionId), String(byteOffset), "utf-8");
}

async function readStdin(): Promise<string> {
  // stdin 데이터 없을 때 무한 대기 막기 위해 timeout (5s).
  return new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => {
      reject(new Error("stdin read timeout (5s)"));
    }, 5000);
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Stop hook 진입점. throw 안 함 — 실패도 stderr 로그만 + exit 0. */
export async function runCaptureSession(): Promise<void> {
  let payload: StopHookPayload = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) {
      payload = JSON.parse(raw) as StopHookPayload;
    }
  } catch (err) {
    console.error(`📝 [capture-session] stdin parse 실패 (non-blocking):`, err instanceof Error ? err.message : err);
    return;
  }

  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;

  if (!sessionId || !transcriptPath) {
    console.error(`📝 [capture-session] session_id 또는 transcript_path 누락 — skip`);
    return;
  }

  if (!fs.existsSync(transcriptPath)) {
    console.error(`📝 [capture-session] transcript missing: ${transcriptPath}`);
    return;
  }

  const stat = fs.statSync(transcriptPath);
  const startByte = readCursor(sessionId);

  if (stat.size <= startByte) {
    // 새 entry 없음 (Stop hook이 빈 turn에 fire하는 경우 등)
    return;
  }

  // delta range만 read
  const fd = fs.openSync(transcriptPath, "r");
  let raw: string;
  try {
    const length = stat.size - startByte;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, startByte);
    raw = buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }

  const lines = raw.split("\n");
  let userId: number;
  try {
    userId = await getDefaultUserId();
  } catch (err) {
    console.error(`📝 [capture-session] DB connect 실패:`, err instanceof Error ? err.message : err);
    return;
  }

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
    const externalUuid = `claude-code:${sessionId}:${parsed.uuid}`;
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
      else dedup++;
    } catch (err) {
      console.error(`⚠️ [capture-session] insert 실패 entry=${parsed.uuid}:`, err instanceof Error ? err.message : err);
      skipped++;
    }
  }

  // cursor advance — 부분 실패해도 advance (재시도하면 dedup으로 안전, 무한 retry 방지)
  writeCursor(sessionId, stat.size);

  console.error(
    `📝 [capture-session] session=${sessionId} inserted=${inserted} dedup=${dedup} skipped=${skipped} cursor=${startByte}→${stat.size}`
  );
}
