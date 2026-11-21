/**
 * 클로드 코드 훅에서 "이 세션 대화가 메모리 DB 에 들어가고 있나" 를 세션마다 한 번 확인한다 (0.9.40).
 *
 * 왜: 수집 상태는 메모리 서버만 안다. memory_startup 은 수집이 안 붙었으면 맨 위에 경고를 붙이는데,
 * 0.9.39 부터 클로드 코드는 훅이 시작 브리핑을 넣으니 memory_startup 을 잘 안 부른다 → 그 경고가
 * 안 보이게 됐다. 훅은 서버 밖 프로그램이라 서버 상태는 모르지만, 대화 파일(transcript_path)은
 * 읽을 수 있다. 그래서 결과로 본다: 앞선 대화 줄이 정말 DB 에 있나.
 *
 * 판정 (거짓 경고가 제일 나쁘다 — 모르면 조용히):
 * - 대화 파일 꼬리에서 수집기(jsonl_capture.parseEntry)가 넣을 줄만 고른다. 그중
 *   유예(기본 60초)보다 오래되고 창(기본 30분)보다 새것만 본다. 창이 있는 이유: 이어 연 세션의
 *   옛 부분은 예전 수집 구멍(0.9.36 전)으로 빠졌을 수 있다 — 그걸로 지금을 판정하면 안 된다.
 * - 그 줄들의 external_uuid(`claude-code:<세션>:<줄 uuid>`) 중 하나라도 DB 에 있으면 "됨".
 * - 하나도 없고, 내용이 다른 줄이 2개 이상이면 "안 됨" → 경고. (수집기는 같은 내용을 한 번만
 *   넣으므로 한 줄짜리 부재는 증거가 못 된다.)
 * - 그 밖(볼 줄이 없음·파일을 못 읽음·DB 오류)은 판정하지 않고 다음 말에서 다시 본다.
 *
 * 세션마다 한 번: 판정이 나면 상태 폴더에 세션 표시 파일을 남기고, 그 뒤로는 파일만 보고 넘어간다
 * (DB 에 안 붙는다). 표시는 훅 출력을 내보내기 직전에만 쓴다(commit) — 시간이 넘어 경고가 못 나가면
 * 다음 말에서 다시 본다.
 *
 * 클로드(--client claude)만. 코덱스도 transcript_path 를 주지만 수집 형식이 다르다.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "./db.js";
import { parseEntry } from "./auto_save/jsonl_capture.js";

export interface CaptureCheckSettings {
  /** 줄이 쓰이고 이만큼 지나야 "DB 에 있어야 한다" 고 본다. */
  graceMs: number;
  /** 이보다 오래된 줄은 안 본다 (이어 연 세션의 옛 부분 제외). */
  windowMs: number;
  /** 대화 파일 끝에서 읽는 양. */
  tailBytes: number;
  /** DB 에 하나도 없을 때 "안 됨" 으로 볼 최소 줄 수 (내용이 다른 줄). */
  minMissing: number;
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function captureCheckSettings(): CaptureCheckSettings {
  return {
    graceMs: numEnv("MEMORY_CAPTURE_CHECK_GRACE_SEC", 60) * 1000,
    windowMs: numEnv("MEMORY_CAPTURE_CHECK_WINDOW_MIN", 30) * 60_000,
    tailBytes: 2 * 1024 * 1024,
    minMissing: 2,
  };
}

export interface CaptureCandidate {
  externalUuid: string;
  /** 같은 내용 구분용 (수집기의 contentSeen 과 같은 키). */
  key: string;
  ts: number;
}

/** 대화 파일 이름 → 수집기가 쓰는 세션 id. 표시 파일 이름으로도 쓰니 안전한 글자만. */
export function transcriptSessionId(transcriptPath: string): string | null {
  const base = path.basename(transcriptPath);
  if (!base.endsWith(".jsonl")) return null;
  const sid = base.slice(0, -".jsonl".length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sid) ? sid : null;
}

/**
 * 대화 파일 꼬리 글 → 판정에 쓸 줄들 (최근 것 최대 50개).
 * fromStart=false 면 첫 줄은 중간부터 잘렸을 수 있어 버린다. 줄 uuid 가 없는 줄은 안 본다
 * (수집기는 그런 줄에 임의 값을 붙인다 — DB 에서 찾을 수 없다).
 */
export function captureCandidates(
  tailText: string,
  sessionId: string,
  nowMs: number,
  s: CaptureCheckSettings,
  fromStart: boolean,
): CaptureCandidate[] {
  const lines = tailText.split("\n");
  if (!fromStart) lines.shift();
  const out: CaptureCandidate[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: any;
    try { raw = JSON.parse(trimmed); } catch { continue; }
    if (!raw || (raw.type !== "user" && raw.type !== "assistant")) continue;
    if (typeof raw.uuid !== "string" || !raw.uuid) continue;
    const parsed = parseEntry(trimmed);
    if (!parsed) continue;
    const ts = Date.parse(parsed.timestamp ?? "");
    if (!Number.isFinite(ts)) continue;
    const age = nowMs - ts;
    if (age < s.graceMs || age > s.windowMs) continue;
    out.push({
      externalUuid: `claude-code:${sessionId}:${raw.uuid}`,
      key: `${parsed.role}::${parsed.message}`,
      ts,
    });
  }
  return out.slice(-50);
}

export interface CaptureVerdict {
  verdict: "ok" | "missing" | "undecided";
  eligible: number;
  found: number;
  reason?: string;
}

export function decideCapture(cands: CaptureCandidate[], found: ReadonlySet<string>, s: CaptureCheckSettings): CaptureVerdict {
  if (cands.length === 0) return { verdict: "undecided", eligible: 0, found: 0, reason: "no-eligible" };
  const hit = cands.filter((c) => found.has(c.externalUuid)).length;
  if (hit > 0) return { verdict: "ok", eligible: cands.length, found: hit };
  const distinct = new Set(cands.map((c) => c.key)).size;
  if (distinct < s.minMissing) return { verdict: "undecided", eligible: cands.length, found: 0, reason: "too-few" };
  return { verdict: "missing", eligible: cands.length, found: 0 };
}

/** 모델에게 보이는 경고. 서버처럼 단정하지 않고 잰 것을 그대로 말한다. */
export function formatCaptureCheckWarning(v: CaptureVerdict, s: CaptureCheckSettings, transcriptPath: string): string {
  const sec = Math.round(s.graceMs / 1000);
  return (
    `⚠️ mcp-agents-memory 수집 확인: 이 세션의 앞선 대화 ${v.eligible}줄이 쓰인 지 ${sec}초가 지났는데 ` +
    `메모리 DB 에 하나도 없다. 이 세션 대화는 자동 저장되지 않고 있을 가능성이 크다.\n` +
    `- 이번 답의 맨 앞에서 사용자에게 이 사실을 한 번 짧게 알려라(다음 말부터는 반복하지 않는다).\n` +
    `- 꼭 남길 결정·사실은 memory 도구(manage_knowledge)가 있으면 그걸로 직접 저장한다.\n` +
    `- 이 세션은 나중에 이 기기에서 \`mcp-agents-memory backfill-claude "${transcriptPath}"\` 로 다시 채울 수 있다.`
  );
}

// ── 세션 표시 파일 ──

export function captureMarkerDir(): string {
  return process.env.MEMORY_CAPTURE_CHECK_DIR
    ?? path.join(os.homedir(), ".local", "state", "mcp-agents-memory", "capture-check");
}

const MARKER_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

export function hasCaptureMarker(dir: string, sessionId: string): boolean {
  try {
    return fs.statSync(path.join(dir, sessionId)).isFile();
  } catch {
    return false;
  }
}

/** 판정을 남기고, 2주 넘은 표시는 지운다. 실패해도 훅은 계속(다음 말에서 다시 볼 뿐). */
export function writeCaptureMarker(dir: string, sessionId: string, verdict: "ok" | "warned", nowMs = Date.now()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, sessionId), JSON.stringify({ verdict, at: new Date(nowMs).toISOString() }) + "\n", { mode: 0o600 });
  try {
    for (const name of fs.readdirSync(dir).slice(0, 2000)) {
      if (name === sessionId) continue;
      const p = path.join(dir, name);
      try {
        const st = fs.lstatSync(p);
        if (st.isFile() && nowMs - st.mtimeMs > MARKER_KEEP_MS) fs.unlinkSync(p);
      } catch { /* 다른 훅이 먼저 지웠을 수 있다 */ }
    }
  } catch { /* 정리 실패는 무시 */ }
}

/** 대화 파일 끝 maxBytes. 일반 파일이 아니거나 못 읽으면 null. */
export function readTranscriptTail(file: string, maxBytes: number): { text: string; fromStart: boolean } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    return { text: buf.subarray(0, n).toString("utf8"), fromStart: start === 0 };
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

export interface CaptureCheckResult {
  context: string;
  info: Record<string, unknown>;
  /** 출력을 내보내기 직전에 부른다 — 판정을 표시 파일로 남긴다. */
  commit?: () => void;
}

/** UserPromptSubmit 에서 부른다. 클로드가 아니면 아무것도 안 하고 로그도 안 늘린다. */
export async function captureCheckContext(input: any, client: string, nowMs = Date.now()): Promise<CaptureCheckResult> {
  if (client !== "claude") return { context: "", info: {} };
  if (process.env.MEMORY_CAPTURE_CHECK === "0") return { context: "", info: { capture: "off" } };
  const transcriptPath = typeof input?.transcript_path === "string" ? input.transcript_path : "";
  if (!transcriptPath || !path.isAbsolute(transcriptPath)) return { context: "", info: { capture: "no-transcript" } };
  const sessionId = transcriptSessionId(transcriptPath);
  if (!sessionId) return { context: "", info: { capture: "bad-transcript-name" } };

  // 이미 판정한 세션은 파일 하나만 보고 끝 (DB 에 안 붙는다)
  const dir = captureMarkerDir();
  if (hasCaptureMarker(dir, sessionId)) return { context: "", info: { capture: "done" } };

  const s = captureCheckSettings();
  const tail = readTranscriptTail(transcriptPath, s.tailBytes);
  if (!tail) return { context: "", info: { capture: "unreadable" } };
  const cands = captureCandidates(tail.text, sessionId, nowMs, s, tail.fromStart);
  if (cands.length === 0) return { context: "", info: { capture: "undecided", reason: "no-eligible" } };

  await db.connect();
  const r = await db.query(
    `SELECT external_uuid FROM memory WHERE external_uuid = ANY($1::text[])`,
    [cands.map((c) => c.externalUuid)],
  );
  const found = new Set<string>(r.rows.map((row: any) => String(row.external_uuid)));
  const v = decideCapture(cands, found, s);
  const info: Record<string, unknown> = { capture: v.verdict, eligible: v.eligible, found: v.found, ...(v.reason ? { reason: v.reason } : {}) };
  if (v.verdict === "ok") {
    return { context: "", info, commit: () => writeCaptureMarker(dir, sessionId, "ok", nowMs) };
  }
  if (v.verdict === "missing") {
    return {
      context: formatCaptureCheckWarning(v, s, transcriptPath),
      info,
      commit: () => writeCaptureMarker(dir, sessionId, "warned", nowMs),
    };
  }
  return { context: "", info };
}
