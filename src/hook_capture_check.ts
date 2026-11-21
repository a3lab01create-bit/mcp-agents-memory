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
 * - 하나도 없으면, 그 줄들 중 같은 세션에 같은 내용(role·글)이 이미 저장된 줄은 뺀다 — 수집기는
 *   세션 안에서 같은 내용을 한 번만 넣는다(contentSeen). 40분 전에 넣은 글이 다른 uuid 로 다시
 *   쓰인 것은 정상이다(코디 리뷰 #45-1). 남은 줄 중 내용이 다른 줄이 2개 이상이면 "안 됨" → 경고.
 * - 그 밖(볼 줄이 없음·파일을 못 읽음·DB 오류)은 판정하지 않고 다음 말에서 다시 본다.
 *
 * 세션마다 한 번: 판정이 나면 상태 폴더에 <세션>.capture-check.json 을 남기고, 그 뒤로는 파일만 보고 넘어간다
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
  /** 같은 내용 구분용 (수집기의 contentSeen 과 같은 키 = role::글). */
  key: string;
  role: "user" | "assistant";
  message: string;
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
      role: parsed.role,
      message: parsed.message,
      ts,
    });
  }
  return out.slice(-50);
}

export interface CaptureVerdict {
  verdict: "ok" | "missing" | "undecided";
  eligible: number;
  found: number;
  /** 같은 세션에 같은 내용이 이미 있어 증거에서 뺀 줄 수. */
  dedup?: number;
  /** "안 됨" 의 근거가 된 줄 수 (eligible − dedup). */
  missing?: number;
  reason?: string;
}

/** uuid 로 하나도 못 찾았을 때만 storedKeys(같은 세션에 이미 있는 내용)를 본다. */
export function decideCapture(
  cands: CaptureCandidate[],
  found: ReadonlySet<string>,
  s: CaptureCheckSettings,
  storedKeys: ReadonlySet<string> = new Set(),
): CaptureVerdict {
  if (cands.length === 0) return { verdict: "undecided", eligible: 0, found: 0, reason: "no-eligible" };
  const hit = cands.filter((c) => found.has(c.externalUuid)).length;
  if (hit > 0) return { verdict: "ok", eligible: cands.length, found: hit };
  const unexplained = cands.filter((c) => !storedKeys.has(c.key));
  const dedup = cands.length - unexplained.length;
  const distinct = new Set(unexplained.map((c) => c.key)).size;
  if (distinct < s.minMissing) {
    return { verdict: "undecided", eligible: cands.length, found: 0, dedup, reason: dedup > 0 ? "dedup" : "too-few" };
  }
  return { verdict: "missing", eligible: cands.length, found: 0, dedup, missing: unexplained.length };
}

/** LIKE 패턴 안의 글자를 그대로 쓰게 (세션 id 의 _ 는 LIKE 에선 아무 글자). */
function likePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`) + "%";
}

/** 모델에게 보이는 경고. 서버처럼 단정하지 않고 잰 것을 그대로 말한다. */
export function formatCaptureCheckWarning(v: CaptureVerdict, s: CaptureCheckSettings, transcriptPath: string): string {
  const sec = Math.round(s.graceMs / 1000);
  return (
    `⚠️ mcp-agents-memory 수집 확인: 이 세션의 앞선 대화 ${v.missing ?? v.eligible}줄이 쓰인 지 ${sec}초가 지났는데 ` +
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
const MARKER_SUFFIX = ".capture-check.json";
const MARKER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.capture-check\.json$/;
const MARKER_TAG = "mcp-agents-memory/capture-check";

export function captureMarkerPath(dir: string, sessionId: string): string {
  return path.join(dir, sessionId + MARKER_SUFFIX);
}

export function hasCaptureMarker(dir: string, sessionId: string): boolean {
  try {
    return fs.lstatSync(captureMarkerPath(dir, sessionId)).isFile();
  } catch {
    return false;
  }
}

/** 우리가 쓴 표시인가 — 이름과 내용(작은 JSON, 우리 tag) 둘 다. 아니면 절대 안 지운다(코디 리뷰 #45-4). */
function isOurMarker(p: string, st: fs.Stats): boolean {
  if (!st.isFile() || st.size > 512) return false;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j?.tag === MARKER_TAG && (j.verdict === "ok" || j.verdict === "warned");
  } catch {
    return false;
  }
}

/** 판정을 남기고, 2주 넘은 우리 표시만 지운다. 실패해도 훅은 계속(다음 말에서 다시 볼 뿐). */
export function writeCaptureMarker(dir: string, sessionId: string, verdict: "ok" | "warned", nowMs = Date.now()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mine = captureMarkerPath(dir, sessionId);
  fs.writeFileSync(mine, JSON.stringify({ tag: MARKER_TAG, verdict, at: new Date(nowMs).toISOString() }) + "\n", { mode: 0o600 });
  try {
    for (const name of fs.readdirSync(dir).slice(0, 2000)) {
      if (!MARKER_NAME_RE.test(name)) continue;
      const p = path.join(dir, name);
      if (p === mine) continue;
      try {
        const st = fs.lstatSync(p);
        if (nowMs - st.mtimeMs > MARKER_KEEP_MS && isOurMarker(p, st)) fs.unlinkSync(p);
      } catch { /* 다른 훅이 먼저 지웠을 수 있다 */ }
    }
  } catch { /* 정리 실패는 무시 */ }
}

/**
 * 대화 파일 끝 maxBytes. 일반 파일이 아니거나 못 읽으면 null.
 * 여는 것 자체가 막히면 안 된다(FIFO 는 쓰는 쪽이 올 때까지 open 이 멈춘다 — 코디 리뷰 #45-3):
 * 먼저 stat 으로 일반 파일만 고르고, 그 사이 바뀌어도 O_NONBLOCK 으로 열어 fstat 으로 다시 본다.
 */
export function readTranscriptTail(file: string, maxBytes: number): { text: string; fromStart: boolean } | null {
  let fd: number | null = null;
  try {
    if (!fs.statSync(file).isFile()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
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

/**
 * 후보 중 같은 세션(external_uuid 접두 claude-code:<세션>:)에 같은 role·글이 이미 저장된 것의 key.
 * 버즈 봉투 같은 글은 정리본이 message, 원문이 raw_message 에 있다 → 둘 다 본다.
 * raw_message 칸이 없는 옛 DB 면 message 만.
 */
async function storedContentKeys(sessionId: string, cands: CaptureCandidate[]): Promise<Set<string>> {
  const roles = cands.map((c) => c.role);
  const msgs = cands.map((c) => c.message);
  const sql = (withRaw: boolean) =>
    `SELECT c.role, c.msg
       FROM unnest($2::text[], $3::text[]) AS c(role, msg)
      WHERE EXISTS (
        SELECT 1 FROM memory m
         WHERE m.external_uuid LIKE $1 ESCAPE '\\'
           AND m.role = c.role
           AND (m.message = c.msg${withRaw ? " OR m.raw_message = c.msg" : ""}))`;
  const params = [likePrefix(`claude-code:${sessionId}:`), roles, msgs];
  let r;
  try {
    r = await db.query(sql(true), params);
  } catch (err: any) {
    if (err?.code !== "42703") throw err; // undefined_column(raw_message) 만 봐준다
    r = await db.query(sql(false), params);
  }
  return new Set<string>(r.rows.map((row: any) => `${row.role}::${row.msg}`));
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
  // uuid 로 하나도 못 찾았을 때만: 같은 세션에 같은 내용이 이미 있나 (수집기의 세션 내 중복 제거)
  const storedKeys = found.size === 0 ? await storedContentKeys(sessionId, cands) : new Set<string>();
  const v = decideCapture(cands, found, s, storedKeys);
  const info: Record<string, unknown> = {
    capture: v.verdict, eligible: v.eligible, found: v.found,
    ...(v.dedup ? { dedup: v.dedup } : {}),
    ...(v.reason ? { reason: v.reason } : {}),
  };
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
