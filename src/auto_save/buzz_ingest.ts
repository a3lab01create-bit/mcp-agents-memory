/**
 * buzz용 — Buzz 정본 가져오기 (메시지 1건 = 메모리 1행).
 *
 * 왜: 버즈 방 대화는 에이전트가 받은 봉투(이전 대화 인용 창)로만 메모리에 남았고,
 * 에이전트가 방에 올린 답글은 도구 호출로 나가서 자기 캡처엔 본문이 없다. 버즈가 가진
 * 원본(채팅 이벤트)을 한 건씩 가져와 누가·어디서·언제 한 말인지 그대로 남긴다.
 *
 * 경로: 공식 `buzz` CLI(channels list --member / messages get / users get)만 쓴다 — 버즈 DB를
 * 직접 읽지 않는다. CLI 신원(BUZZ_PRIVATE_KEY)이 **멤버인 방만** 가져오므로 버즈의 접근
 * 규칙이 곧 가져오는 범위다. 버즈 자체는 아무것도 바뀌지 않는다.
 *
 * 행 모양:
 *   external_uuid  buzz:<event id>   — 몇 번을 다시 돌려도 같은 행 (중복 없음)
 *   agent_platform buzz, role = user(BUZZ_INGEST_OWNER = 이 메모리 주인의 pubkey) / assistant(그 밖)
 *   created_at     이벤트 시각, venue = buzz:<채널> / buzz:dm
 *   message        `[표시이름] 본문`, raw_message = 본문 그대로
 *
 * 진행(상태 파일 없음): 방마다 최신부터 거꾸로 넘기다 이미 가진 글이 나오면, 그 글보다
 * 48시간 앞까지만 더 보고 멈춘다(시계가 늦은 기기가 뒤늦게 올린 글도 줍는다).
 * 새 글은 오래된 것부터 한 번에 최대 N건만 넣는다 — 옛 기록 채우기가 콜드패스 줄을 막지
 * 않게. 오래된 쪽부터 채우므로 가진 글은 늘 "처음부터 어디까지"라, 다음 실행이 그 뒤를 잇는다.
 * 쪽 넘김이 이상하면(이어지는 쪽이 비었거나, 앞으로 가지 않거나) 추측하지 않고 멈춘다 —
 * 틈을 남긴 채 성공으로 끝나는 일이 없게.
 *
 * 수정(kind 40003)은 최신 수정본으로 본문을 바꾸고 태깅·임베딩을 다시 하게 한다.
 * 삭제(kind 5 / 9005)는 행을 지우지 않고 숨긴다(is_active=false).
 * 원본 행이 쌓이면 설명서 없는 봉투(<context>부터)의 이력(인용)을 걷어낸다 — 인용 글이 전부
 * 원본 행(같은 초·같은 본문)으로 있을 때만. 실행당 새 글을 넣고 남은 예산만큼.
 * 모든 CLI 호출이 첫 쓰기 전에 끝난다 — 출력 모양이 예상과 다르면 아무것도 쓰지 않고
 * 에러로 끝난다. 버즈가 바뀐 것이니 감시 쪽이 알아채고 그때 맞춘다.
 *
 * 알려진 한계: 수정본이 나중에 지워져도 원래 글로 되돌리지 않는다. 같은 초의 수정 두 개는
 * id 순으로 고른다. raw_message 칸이 생기기 전(028 전)에 들어간 행은 수정이 반영되지 않는다.
 * 프로필이 아직 없던 작성자는 pubkey 앞 8자리로 남는다(워크플로처럼 relay 키로 서명된 글도 그렇다).
 * 한 방의 쪽 넘김이 계속 이상하면 모든 방이 멈춘다(틈을 남기는 것보다 낫다고 봄). 매 실행이
 * 방마다 최근 48시간을 읽으므로, 하루 수천 건 오가는 방이면 실행 간격을 늘려야 한다.
 */

import { execFile } from "node:child_process";
import { db } from "../db.js";
import { insertRawMemory } from "../hot_path.js";
import { buzzQuotedMessages, cleanBuzzEnvelope, looksLikeBuzzTurn, venueFromBuzzMessage } from "./buzz_envelope.js";
import { getDefaultUserId } from "../users.js";

const KIND_CHAT = 9;
const KIND_EDIT = 40003;
const DELETE_KINDS = [5, 9005];
/** 버즈에 있지만 아직 가져오지 않는 글 종류 (V2 메시지·diff·포럼) — 보이면 감시가 알린다. */
const UNSUPPORTED_KINDS = [40002, 40008, 45001, 45003];
const PAGE = 200; // relay가 한 번에 주는 최대치
const MAX_PAGES_PER_CHANNEL = 500;
const LOOKBACK_SEC = 48 * 3600;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** CLI에 넘길 환경 — DB 접속 정보·API 키는 넘기지 않는다. */
const CHILD_ENV =
  /^(PATH|PATHEXT|HOME|USER|LANG|LC_[A-Z]+|TZ|TMPDIR|TEMP|TMP|SSL_CERT_(FILE|DIR)|NODE_EXTRA_CA_CERTS|(HTTPS?|ALL|NO)_PROXY|SYSTEMROOT|WINDIR|COMSPEC|APPDATA|LOCALAPPDATA|USERPROFILE|BUZZ_[A-Z0-9_]+)$/i;

export interface BuzzEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: string[][];
}

export interface BuzzChannel {
  id: string;
  name: string;
  private: boolean;
}

export interface BuzzIngestOptions {
  dryRun?: boolean;
  /** 한 번에 넣을 새 글 최대 건수 (오래된 것부터). 봉투 정리도 남은 몫 안에서 한다. */
  max?: number;
  /** 설명서 없는 봉투 정리 단계를 끈다. */
  noReclean?: boolean;
}

export interface BuzzIngestReport {
  channels: number;
  pending: number;
  inserted: number;
  edited: number;
  hidden: number;
  byVenue: Record<string, number>;
  /** 이력을 걷어낸 설명서 없는 봉투 수 */
  recleaned: number;
  /** 정리할 수 있지만 이번 예산을 넘어 다음 실행으로 미룬 봉투 수 */
  envelopesReady: number;
  /** 이력이 있는데 이 단계로는 못 정리하는 버즈 봉투 수 (인용 글이 같은 방 원본 행으로 다 있지 않거나 모양을 모름) */
  envelopesStuck: number;
  /** --dry-run 때만: 아직 가져오지 않는 종류의 글 수 (최신 한 쪽 기준). */
  unsupported?: number;
}

class BuzzShapeError extends Error {}

function cliPath(): string {
  return process.env.BUZZ_CLI || "buzz";
}

function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => CHILD_ENV.test(k)));
}

function runCli(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      cliPath(),
      args,
      { maxBuffer: 256 * 1024 * 1024, timeout: 120_000, env: childEnv() },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`buzz ${args.slice(0, 2).join(" ")} 실패: ${String(stderr || err.message).trim().slice(0, 500)}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new BuzzShapeError(`buzz ${args.slice(0, 2).join(" ")}: JSON이 아닌 출력`));
        }
      }
    );
  });
}

function asEvent(v: unknown): BuzzEvent {
  const e = v as Record<string, unknown>;
  const ok =
    e && typeof e === "object" &&
    typeof e.id === "string" && HEX64.test(e.id) &&
    typeof e.pubkey === "string" && HEX64.test(e.pubkey) &&
    Number.isInteger(e.created_at) &&
    Number.isInteger(e.kind) &&
    typeof e.content === "string" &&
    Array.isArray(e.tags) && e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"));
  if (!ok) throw new BuzzShapeError(`예상과 다른 이벤트 모양: ${JSON.stringify(v).slice(0, 200)}`);
  return e as unknown as BuzzEvent;
}

function asArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new BuzzShapeError(`${what}: 배열이 아닌 출력`);
  return v;
}

export async function listChannels(): Promise<BuzzChannel[]> {
  const parse = (v: unknown) =>
    asArray(v, "channels list").map((c) => {
      const ch = c as Record<string, unknown>;
      if (typeof ch?.channel_id !== "string" || !UUID.test(ch.channel_id) || typeof ch.name !== "string") {
        throw new BuzzShapeError(`예상과 다른 채널 모양: ${JSON.stringify(c).slice(0, 200)}`);
      }
      return { id: ch.channel_id, name: ch.name };
    });
  const all = parse(await runCli(["channels", "list", "--member"]));
  // 멤버십 조회가 비면 CLI는 [] 를 낸다 — 방에서 빠진 것과 한가한 것을 구분하려면 멈춰야 한다
  if (all.length === 0) throw new BuzzShapeError("channels list --member: CLI 신원이 멤버인 방이 하나도 없음");
  const priv = new Set(parse(await runCli(["channels", "list", "--member", "--visibility", "private"])).map((c) => c.id));
  return all.map((c) => ({ ...c, private: priv.has(c.id) }));
}

/** 버즈는 1:1 대화를 "DM"이라는 이름의 비공개 방으로 둔다. */
export function channelVenue(ch: BuzzChannel): string {
  const name = ch.name.trim();
  if (!name) return "buzz";
  return ch.private && name === "DM" ? "buzz:dm" : `buzz:${name}`;
}

/** `--before`는 그 초를 포함한다(created_at <= before). */
async function getPage(channelId: string, kinds: number[], before?: number): Promise<BuzzEvent[]> {
  const args = ["messages", "get", "--channel", channelId, "--limit", String(PAGE), "--kinds", kinds.join(",")];
  if (before !== undefined) args.push("--before", String(before));
  return asArray(await runCli(args), "messages get").map(asEvent);
}

async function knownIds(eventIds: string[]): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();
  const r = await db.query(
    `SELECT external_uuid FROM memory WHERE external_uuid = ANY($1::text[])`,
    [eventIds.map((id) => `buzz:${id}`)]
  );
  return new Set(r.rows.map((row: any) => String(row.external_uuid).slice("buzz:".length)));
}

/**
 * 최신부터 한 쪽씩 거꾸로. `visit`가 false면 멈춘다. 다음 쪽은 앞 쪽의 가장 오래된 초를 겹쳐 받으므로
 * (같은 초에 여러 글이 있을 수 있어서, id로 중복 제거) 이어지는 쪽은 비어 있을 수 없다 — 비었거나
 * 앞으로 가지 않으면 버즈 응답이 이상한 것이라, 틈을 남기고 성공하는 대신 멈춘다.
 * 겹친 글만 든 짧은 쪽이 오면 기록의 처음이다.
 */
async function pageBack(
  channelId: string,
  kinds: number[],
  visit: (page: BuzzEvent[], unseen: BuzzEvent[]) => Promise<boolean>
): Promise<void> {
  const seen = new Set<string>();
  let before: number | undefined;
  for (let pages = 0; ; pages++) {
    if (pages >= MAX_PAGES_PER_CHANNEL) {
      throw new BuzzShapeError(`${channelId}: ${MAX_PAGES_PER_CHANNEL}쪽을 넘겨도 끝나지 않음`);
    }
    const page = await getPage(channelId, kinds, before);
    if (page.length === 0) {
      if (before === undefined) return; // 빈 방
      throw new BuzzShapeError(`${channelId}: 이어지는 쪽이 비어 있음`);
    }
    const unseen = page.filter((e) => !seen.has(e.id));
    if (unseen.length === 0) {
      if (page.length >= PAGE) throw new BuzzShapeError(`${channelId}: 쪽 넘김이 앞으로 가지 않음`);
      return;
    }
    for (const e of unseen) seen.add(e.id);
    if (!(await visit(page, unseen))) return;
    before = Math.min(...page.map((e) => e.created_at)) + 1;
  }
}

/**
 * 한 방에서 아직 없는 채팅 글. 가진 글이 나오면 그보다 LOOKBACK 앞까지만 더 본다
 * (미래 시각 글이 기준을 밀어내지 않게 기준은 지금을 넘지 않는다).
 */
export async function newChatEvents(channelId: string): Promise<BuzzEvent[]> {
  const fresh = new Map<string, BuzzEvent>();
  const nowSec = Math.floor(Date.now() / 1000);
  let stopBelow: number | undefined;
  await pageBack(channelId, [KIND_CHAT], async (page, unseen) => {
    const chats = unseen.filter((e) => e.kind === KIND_CHAT);
    const known = await knownIds(chats.map((e) => e.id));
    for (const e of chats) if (!known.has(e.id)) fresh.set(e.id, e);
    if (known.size > 0 && stopBelow === undefined) {
      const newestKnown = Math.max(...chats.filter((e) => known.has(e.id)).map((e) => e.created_at));
      stopBelow = Math.min(newestKnown, nowSec) - LOOKBACK_SEC;
    }
    return !(stopBelow !== undefined && Math.min(...page.map((e) => e.created_at)) < stopBelow);
  });
  return [...fresh.values()];
}

/** 최신부터 `floor`보다 오래된 글이 나올 때까지 (floor 없으면 최신 한 쪽). 수정 이벤트용. */
async function recentEvents(channelId: string, kinds: number[], floor?: number): Promise<BuzzEvent[]> {
  const out: BuzzEvent[] = [];
  await pageBack(channelId, kinds, async (page, unseen) => {
    out.push(...unseen.filter((e) => kinds.includes(e.kind)));
    return floor !== undefined && Math.min(...page.map((e) => e.created_at)) >= floor;
  });
  return out;
}

/**
 * 표시이름 (display_name, 없으면 name). CLI는 이상한 응답을 빈 배열로 감추므로, 자기 프로필을
 * 같이 물어서 그게 빠진 응답이면 멈춘다 — 이름 대신 pubkey 앞자리가 영구히 박히지 않게.
 */
async function displayNames(pubkeys: string[]): Promise<Map<string, string>> {
  const self = asArray(await runCli(["users", "get"]), "users get")
    .map((u) => (u as Record<string, unknown>)?.pubkey)
    .find((pk): pk is string => typeof pk === "string" && HEX64.test(pk));
  if (!self) {
    throw new BuzzShapeError("users get: CLI 신원의 프로필이 안 보임 — 이름 응답을 확인할 수 없음 (신원에 프로필을 넣어 주세요)");
  }
  const names = new Map<string, string>();
  for (let i = 0; i < pubkeys.length; i += 20) {
    const chunk = pubkeys.slice(i, i + 20);
    const ask = chunk.includes(self) ? chunk : [...chunk, self];
    const out = asArray(await runCli(["users", "get", ...ask.flatMap((pk) => ["--pubkey", pk])]), "users get");
    const profiles = out.map((u) => u as Record<string, unknown>);
    if (!profiles.some((p) => p?.pubkey === self)) {
      throw new BuzzShapeError("users get: 자기 프로필이 빠진 응답 — 이름을 믿을 수 없음");
    }
    for (const p of profiles) {
      const label = [p?.display_name, p?.name].find((v): v is string => typeof v === "string" && v.trim() !== "");
      if (typeof p?.pubkey === "string" && label) names.set(p.pubkey, label.trim());
    }
  }
  return names;
}

/** 이 메모리 주인의 버즈 pubkey들 — 이 사람 말만 role=user (librarian이 주인 프로필을 여기서 만든다). */
export function ownerPubkeys(): Set<string> {
  const raw = process.env.BUZZ_INGEST_OWNER ?? "";
  const keys = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (keys.length === 0 || !keys.every((k) => HEX64.test(k))) {
    throw new Error(
      "BUZZ_INGEST_OWNER: 이 메모리 주인의 버즈 pubkey(64자리 hex)를 쉼표로 적어야 합니다 — 그 밖의 작성자는 assistant로 저장됩니다"
    );
  }
  return new Set(keys);
}

export function authorLabel(pubkey: string, names: Map<string, string>): string {
  return names.get(pubkey) ?? pubkey.slice(0, 8);
}

export function chatMessage(e: BuzzEvent, names: Map<string, string>): string {
  return `[${authorLabel(e.pubkey, names)}] ${e.content}`;
}

/** 이벤트가 가리키는 대상 글(첫 번째 e 태그 — relay의 수정 대상 규칙과 같다). */
function targetOf(e: BuzzEvent): string | null {
  const t = e.tags.find((tag) => tag[0] === "e" && HEX64.test(tag[1] ?? ""));
  return t ? t[1] : null;
}

/** 대상 글별 가장 최근 수정본. */
export function latestEdits(events: BuzzEvent[]): Map<string, BuzzEvent> {
  const latest = new Map<string, BuzzEvent>();
  for (const e of events) {
    if (e.kind !== KIND_EDIT) continue;
    const target = targetOf(e);
    if (!target) continue;
    const cur = latest.get(target);
    if (!cur || e.created_at > cur.created_at || (e.created_at === cur.created_at && e.id > cur.id)) {
      latest.set(target, e);
    }
  }
  return latest;
}

/**
 * 수정본으로 본문 교체. 작성자 표시는 원래 행 것을 그대로 쓴다 — 버즈는 에이전트 주인(사람)이
 * 에이전트 글을 고치는 것도 허용해서, 수정 이벤트의 작성자가 원래 작성자가 아닐 수 있다.
 */
async function applyEdits(edits: Map<string, BuzzEvent>, dryRun: boolean): Promise<number> {
  if (edits.size === 0) return 0;
  const r = await db.query(
    `SELECT external_uuid, message, raw_message FROM memory
      WHERE external_uuid = ANY($1::text[]) AND agent_platform = 'buzz' AND raw_message IS NOT NULL`,
    [[...edits.keys()].map((id) => `buzz:${id}`)]
  );
  let n = 0;
  for (const row of r.rows) {
    const edit = edits.get(String(row.external_uuid).slice("buzz:".length))!;
    const raw: string = row.raw_message;
    const msg: string = row.message;
    if (raw === edit.content || !msg.endsWith(raw)) continue;
    n++;
    if (dryRun) continue;
    await db.query(
      `UPDATE memory
          SET message = $2, raw_message = $3,
              tag_processed = FALSE, embedding = NULL, cold_error = NULL
        WHERE external_uuid = $1`,
      [row.external_uuid, msg.slice(0, msg.length - raw.length) + edit.content, edit.content]
    );
  }
  return n;
}

async function hideDeleted(targets: string[], dryRun: boolean): Promise<number> {
  if (targets.length === 0) return 0;
  const uuids = targets.map((id) => `buzz:${id}`);
  const sql = dryRun
    ? `SELECT count(*)::int AS n FROM memory
        WHERE external_uuid = ANY($1::text[]) AND agent_platform = 'buzz' AND is_active AND NOT is_pinned`
    : `WITH h AS (
         UPDATE memory SET is_active = FALSE, archived_at = NOW()
          WHERE external_uuid = ANY($1::text[]) AND agent_platform = 'buzz' AND is_active AND NOT is_pinned
          RETURNING 1)
       SELECT count(*)::int AS n FROM h`;
  const r = await db.query(sql, [uuids]);
  return Number(r.rows[0]?.n ?? 0);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * 설명서 없는 봉투 정리. 봉투의 이력(인용)이 에이전트 버즈 답글의 유일한 사본일 수 있어서 저장
 * 순간엔 정리하지 않고, 인용 글이 전부 같은 방·같은 초·같은 본문의 버즈 원본 행으로 있을 때만
 * message=정리본, raw_message=원문으로 바꾸고 태깅·임베딩을 다시 하게 한다. 나중에 고친 글을
 * 인용한 봉투(인용엔 고치기 전 문장)나 CLI 신원이 못 보는 방의 봉투는 그대로 둔다.
 * 원본 행이 숨겨진 글(버즈에서 지움)도 확인된 것으로 친다 — 버즈의 최신 상태를 따른다.
 * 콜드패스 워커가 그 행을 잡고 있으면 2초만 기다리고, 넘으면 다음 실행에 한다.
 */
async function recleanEnvelopes(
  userId: number,
  budget: number,
  dryRun: boolean
): Promise<{ recleaned: number; ready: number; stuck: number }> {
  const rows = (await db.query(
    `SELECT id, message, venue FROM memory
      WHERE user_id = $1 AND role = 'user' AND raw_message IS NULL AND message LIKE '<context>%'
        AND agent_platform <> 'buzz' AND is_active AND NOT is_pinned
      ORDER BY created_at, id`,
    [userId]
  )).rows;
  type Cand = { id: number; message: string; cleaned: string; venue: string; quotes: Array<{ ms: number; text: string }> };
  const cands: Cand[] = [];
  let stuck = 0; // 버즈 봉투인데 걷어낼 이력이 있고(또는 모양을 몰라) 이번 단계로는 못 정리하는 것
  for (const r of rows) {
    const cleaned = cleanBuzzEnvelope(r.message, { baseless: true });
    const quotes = buzzQuotedMessages(r.message);
    if (cleaned === null && quotes !== null && quotes.length === 0) continue; // 걷어낼 게 없음
    // 버즈 자리만 (terminal/slack/auto 같은 다른 자리는 버즈 봉투가 아님)
    const venue =
      [r.venue, venueFromBuzzMessage(r.message)].find((v): v is string => typeof v === "string" && v.startsWith("buzz")) ?? null;
    const q = (quotes ?? []).map((x) => ({ ms: Date.parse(x.time), text: norm(x.content) }));
    if (cleaned === null || quotes === null || !venue || q.some((x) => !Number.isFinite(x.ms))) {
      if (venue || looksLikeBuzzTurn(r.message)) stuck++;
      continue;
    }
    cands.push({ id: Number(r.id), message: r.message, cleaned, venue, quotes: q });
  }
  const times = [...new Set(cands.flatMap((c) => c.quotes.map((x) => x.ms)))];
  const have = new Set<string>(); // venue \0 ms \0 본문
  if (times.length) {
    const r = await db.query(
      `SELECT venue, created_at, raw_message FROM memory
        WHERE user_id = $1 AND agent_platform = 'buzz' AND external_uuid LIKE 'buzz:%'
          AND raw_message IS NOT NULL AND created_at = ANY($2::timestamptz[])`,
      [userId, times.map((ms) => new Date(ms).toISOString())]
    );
    for (const row of r.rows) have.add(`${row.venue}\0${new Date(row.created_at).getTime()}\0${norm(row.raw_message)}`);
  }
  const ready = cands.filter((c) => c.quotes.every((x) => have.has(`${c.venue}\0${x.ms}\0${x.text}`)));
  stuck += cands.length - ready.length;
  let n = 0;
  for (const c of ready.slice(0, Math.max(0, budget))) {
    if (dryRun) {
      n++;
      continue;
    }
    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '2s'");
      const r = await client.query(
        `UPDATE memory
            SET message = $2, raw_message = $3, tag_processed = FALSE, embedding = NULL, cold_error = NULL
          WHERE id = $1 AND raw_message IS NULL AND message = $3`,
        [c.id, c.cleaned, c.message]
      );
      await client.query("COMMIT");
      n += r.rowCount ?? 0;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if ((err as { code?: string }).code !== "55P03") throw err; // 잠금 대기 초과 → 다음 실행에
    } finally {
      client.release();
    }
  }
  return { recleaned: n, ready: ready.length - n, stuck };
}

export async function runBuzzIngest(opts: BuzzIngestOptions = {}): Promise<BuzzIngestReport> {
  const dryRun = opts.dryRun ?? false;
  const max = opts.max ?? 20;
  const owner = ownerPubkeys();
  const channels = await listChannels();

  // 1) 방마다 아직 없는 글
  const pending: Array<{ e: BuzzEvent; ch: BuzzChannel; venue: string }> = [];
  for (const ch of channels) {
    const venue = channelVenue(ch);
    for (const e of await newChatEvents(ch.id)) pending.push({ e, ch, venue });
  }
  pending.sort((a, b) => a.e.created_at - b.e.created_at || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0));

  // 2) 수정·삭제 — 이번에 넣을 글 이후의 수정까지 (기기 시계 차이를 감안해 LOOKBACK만큼 더)
  const deleteTargets = new Set<string>();
  const edits: BuzzEvent[] = [];
  let unsupported = 0;
  for (const ch of channels) {
    for (const d of await getPage(ch.id, DELETE_KINDS)) {
      const t = DELETE_KINDS.includes(d.kind) ? targetOf(d) : null;
      if (t) deleteTargets.add(t);
    }
  }
  // 지워진 글은 넣지 않는다 (relay가 이미 빼고 주지만, 삭제가 가져오는 사이에 올 수 있다)
  const batch = pending.filter(({ e }) => !deleteTargets.has(e.id)).slice(0, Math.max(0, max));
  for (const ch of channels) {
    const mine = batch.filter((b) => b.ch.id === ch.id).map((b) => b.e.created_at);
    edits.push(...(await recentEvents(ch.id, [KIND_EDIT], mine.length ? Math.min(...mine) - LOOKBACK_SEC : undefined)));
    if (dryRun) unsupported += (await getPage(ch.id, UNSUPPORTED_KINDS)).filter((e) => UNSUPPORTED_KINDS.includes(e.kind)).length;
  }

  // 3) 이름 (쓰기 전 마지막 CLI 호출)
  const pubkeys = [...new Set(batch.map(({ e }) => e.pubkey))];
  const names = pubkeys.length ? await displayNames(pubkeys) : new Map<string, string>();

  // 4) 쓰기
  const report: BuzzIngestReport = {
    channels: channels.length,
    pending: pending.length,
    inserted: 0,
    edited: 0,
    hidden: 0,
    recleaned: 0,
    envelopesReady: 0,
    envelopesStuck: 0,
    byVenue: {},
    ...(dryRun ? { unsupported } : {}),
  };
  // --dry-run은 아무것도 쓰지 않는다 — 기본 사용자가 아직 없으면 만들지 않고 봉투 단계를 건너뛴다
  const userId = dryRun
    ? Number((await db.query(`SELECT user_id FROM users WHERE user_name = $1`, [process.env.USER_NAME ?? "hoon"])).rows[0]?.user_id ?? 0)
    : await getDefaultUserId();
  for (const { e, venue } of batch) {
    report.byVenue[venue] = (report.byVenue[venue] ?? 0) + 1;
    if (dryRun) {
      report.inserted++;
      continue;
    }
    let res;
    try {
      res = await insertRawMemory({
        user_id: userId,
        agent_platform: "buzz",
        agent_model: null,
        role: owner.has(e.pubkey) ? "user" : "assistant",
        message: chatMessage(e, names),
        raw_message: e.content,
        external_uuid: `buzz:${e.id}`,
        device_name: null,
        venue,
        created_at: new Date(e.created_at * 1000),
      });
    } catch (err) {
      throw new Error(`buzz:${e.id} 저장 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.inserted) report.inserted++;
  }
  report.edited = await applyEdits(latestEdits(edits), dryRun);
  report.hidden = await hideDeleted([...deleteTargets], dryRun);
  // 5) 새 글을 넣고 남은 예산만큼 봉투 이력 걷어내기 (DB만). 실제 실행은 새 원본 행이 들어간 뒤라
  //    방금 인용도 확인된다; --dry-run은 이번 새 글을 안 넣으므로 그만큼 적게 센다.
  if (!opts.noReclean && userId > 0) {
    const env = await recleanEnvelopes(userId, max - batch.length, dryRun);
    report.recleaned = env.recleaned;
    report.envelopesReady = env.ready;
    report.envelopesStuck = env.stuck;
  }
  return report;
}

export function parseIngestArgs(argv: string[]): BuzzIngestOptions {
  const opts: BuzzIngestOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-reclean") opts.noReclean = true;
    else if (a === "--max") {
      const v = argv[++i];
      if (v === undefined || !/^\d+$/.test(v)) throw new Error("--max: 0 이상의 정수");
      opts.max = Number(v);
    } else throw new Error(`buzz-ingest: 모르는 옵션 ${a}`);
  }
  return opts;
}
