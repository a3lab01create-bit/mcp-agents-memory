/**
 * 재정리에서 **막힌 행의 id·사유**가 보고에 담기는지 검사.
 *
 * 🔴 왜 필요한가: 2026-11-01 에 감시 알림이 "shape 3건"만 말해서 어느 행인지 알 수 없었다.
 *    집계만 내고 식별을 안 내면 사람이 집을 수 없다.
 *
 * 🔴🔴 안전·격리 설계 (Codi 리뷰 2026-11-01 로 두 번 고쳤다)
 *   ① **이름 패턴으로 테스트 DB 를 판별하지 않는다.** `/test|scratch|tmp/i` 는 부분일치라
 *      `contest_production`·`latest_prod`·`PRODUCTION_tmpdata` 가 전부 통과했다(실측).
 *      ⇒ 센티널 표 `__disposable_test_db__` 가 없으면 SKIP. 운영 DB 엔 그 표가 없다.
 *      ⚠️ `DATABASE_URL` 이 `DB_NAME` 보다 우선이다(`src/db.ts:52`) — 접속 DB 를 눈으로 확인하라.
 *   ② **TRUNCATE 하지 않는다.** 실행별 UUID 접두사 fixture 만 지운다.
 *   ③ **실행별 사용자로 조회 범위를 가른다.** 고정 user_id 를 쓰면 기존 noRow 가 8건만 있어도
 *      새 fixture 가 표본에서 밀려 **정상 코드가 실패**한다.
 *      사용자는 `INSERT INTO users (user_name) RETURNING user_id` 로 **DB 가 배정**한다 —
 *      무작위 숫자 + `ON CONFLICT DO NOTHING` 은 기존 사용자와 충돌할 수 있어 쓰지 않는다.
 *      ⚠️ 앞선 판에서 `INSERT INTO users (user_id)` 를 썼는데 정식 스키마는
 *         `user_name TEXT NOT NULL UNIQUE`(019_respec_fresh_v1) 라서 **실패**했고 예외를 삼켰다.
 *         결과적으로 **정식 스키마에서 SKIP, 불완전한 복제 DB 에서 PASS** 가 됐다 —
 *         내가 주장한 것과 정반대였다(Codi 지적).
 *   ⑤ **cleanup 은 user_id 로 지우지 않는다.** 그 사용자의 모든 행을 지우면 충돌 시 남의 행도
 *      지운다. fixture 의 UUID 접두사로만 지우고, 사용자는 **이 실행이 만든 id** 만 지운다.
 *   ④ **try/finally** — assert 가 실패해도 그 실행의 fixture 를 지운다(앞선 판에서 27건이 남았다).
 *
 * 준비:  psql <일회용DB> -c 'CREATE TABLE IF NOT EXISTS __disposable_test_db__ ()'
 * 실행:  DB_NAME=<일회용DB> npm run check:stuck-ids
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../src/db.js";
import { recleanEnvelopes, type StuckRow } from "../src/auto_save/buzz_ingest.js";

const dbName = (await db.query("SELECT current_database() db")).rows[0].db as string;
const sentinel = (await db.query(
  "SELECT to_regclass('public.__disposable_test_db__') IS NOT NULL AS ok")).rows[0].ok as boolean;
if (!sentinel) {
  console.log(`SKIP — 센티널 표가 없다 (current_database=${dbName}).\n` +
    `  일회용 DB 에서  CREATE TABLE IF NOT EXISTS __disposable_test_db__ ()  를 만든 뒤 실행하라.\n` +
    `  ⚠️ DATABASE_URL 이 DB_NAME 보다 우선이다 — 접속 DB 를 반드시 확인하라.`);
  process.exit(0);
}
const cl = await db.getClient();
assert.equal((await cl.query("SELECT current_database() db")).rows[0].db, dbName,
  "db.query 와 getClient 가 다른 DB 를 본다 — 중단");
cl.release();

const RUN = randomUUID().slice(0, 8);
const PREFIX = `chk:stuck:${RUN}:`;
const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const HEX = "a".repeat(64);
const CTX = `<context>\nScope: thread\nChannel: t (#${UUID})\n</context>`;
const QT_SHAPE = "2026-10-31T00:00:00.000Z";
const QT_NOROW = "2026-10-31T01:00:00.000Z";   // 이 자리엔 원본을 만들지 않는다
const QT_DIFF  = "2026-10-31T02:00:00.000Z";   // 이 자리에 **본문이 다른** 원본을 만든다
const VENUE = `buzz:t-${RUN}`;
const cleanup = async (uid: number | null) => {
  // fixture 는 UUID 접두사로만 — user_id 로 싹 지우면 충돌 시 남의 행까지 지운다
  await db.query("DELETE FROM memory WHERE external_uuid LIKE $1 OR external_uuid LIKE $2",
    [`${PREFIX}%`, `buzz:${PREFIX}%`]);
  // 사용자는 **이 실행이 만든 id** 만
  if (uid !== null) await db.query("DELETE FROM users WHERE user_id = $1", [uid]);
};

// 준비 미완료 DB(users 표 없음)는 **명확히 SKIP** 한다 — 불완전한 스키마로 통과시키지 않는다
const hasUsers = (await db.query("SELECT to_regclass('public.users') IS NOT NULL AS ok")).rows[0].ok as boolean;
if (!hasUsers) {
  console.log(`SKIP — users 표가 없다 (current_database=${dbName}). 정식 스키마의 일회용 DB 가 필요하다.\n` +
    `  users · project_tags · memory 를 FK 까지 복제한 DB 에서 실행하라.`);
  process.exit(0);
}
// DB 가 user_id 를 배정한다. 예기치 않은 오류는 **삼키지 않는다**
const UID = Number((await db.query(
  "INSERT INTO users (user_name) VALUES ($1) RETURNING user_id",
  [`__chk_stuck_${RUN}`])).rows[0].user_id);

const ins = async (suffix: string, message: string, platform = "claude-code", venue = VENUE) =>
  Number((await db.query(
    `INSERT INTO memory (user_id,agent_platform,role,message,raw_message,venue,created_at,is_active,is_pinned,tag_processed,d_tag,external_uuid)
     VALUES ($1,$2,'user',$3,NULL,$4,now(),TRUE,FALSE,TRUE,'{}',$5) RETURNING id`,
    [UID, platform, message, venue, PREFIX + suffix])).rows[0].id);

// 🔴 인용 **시각**이 사유를 가른다 — 원본 유무는 (venue, 시각) 자리로 판정된다.
//    noRow 와 textDiffers fixture 가 같은 시각을 쓰면 원본 하나가 둘 다에 걸려 **둘 다
//    textDiffers 가 된다**(실측으로 걸렸다). 그래서 fixture 마다 시각을 다르게 준다.
const envelope = (quoteText: string, time: string, extra: string[] = []) => [CTX,
  '<thread-context included="1" total="1" truncated="false">',
  `[1] ${HEX} (${time}): ${quoteText}`, ...extra, "</thread-context>",
  '<buzz-event type="@mention">', "Content: 본문", "</buzz-event>"].join("\n");

try {
  // ① shape — 턴 태그가 이력 **안**에 (historyHidesTurn 의 의도된 거절)
  const shapeIds = [await ins("shape", envelope("인용", QT_SHAPE, ['<buzz-events count="4">']))];
  // 사유별 한도(8)를 넘겨 전역 상한과 **판별**되게 25건 더
  for (let i = 0; i < 25; i++)
    shapeIds.push(await ins(`shape${i}`, envelope("인용", QT_SHAPE, ['<buzz-events count="4">'])));
  // ② noRow — 인용은 정상인데 그 자리·시각의 원본 행이 없다
  const noRowId = await ins("norow", envelope("원본 없는 인용", QT_NOROW));
  // ③ textDiffers — 원본 행은 **있는데 본문이 다르다**
  const diffId = await ins("textdiff", envelope("원본과 다른 본문", QT_DIFF));
  await db.query(
    `INSERT INTO memory (user_id,agent_platform,role,message,raw_message,venue,created_at,is_active,is_pinned,tag_processed,d_tag,external_uuid)
     VALUES ($1,'buzz','user','[x] 다른 본문','다른 본문',$2,$3,TRUE,FALSE,TRUE,'{}',$4)`,
    // 🔴 원본 조회는 `external_uuid LIKE 'buzz:%'` 를 요구한다 — 접두사를 buzz: 로 시작해야
    //    slots 에 잡힌다. 안 그러면 textDiffers 가 아니라 **noRow** 로 떨어진다(실측으로 걸렸다).
    [UID, VENUE, QT_DIFF, `buzz:${PREFIX}origin`]);

  const rep = await recleanEnvelopes(UID, 1000, true);   // dryRun → 쓰기 없음
  const sample = (why: StuckRow["why"]) => rep.stuckRows.filter((r) => r.why === why);
  console.log(`  DB=${dbName} run=${RUN} uid=${UID}`);
  console.log(`  stuck=${rep.stuck} by=${JSON.stringify(rep.by)}`);
  console.log(`  표본=${rep.stuckRows.length} 생략=${JSON.stringify(rep.stuckOmitted)}`);

  // 🔴 사유별 불변식 — 총합만 보면 textDiffers 0 건이어도 통과한다
  for (const why of ["shape", "noRow", "textDiffers"] as const) {
    assert.ok(sample(why).length <= 8, `${why} 표본이 사유별 한도(8) 이하`);
    assert.equal(sample(why).length + rep.stuckOmitted[why], rep.by[why],
      `${why}: 표본+생략 = 집계 여야 한다`);
  }
  // 🎯 전역 상한이면 첫 루프(shape)가 슬롯을 다 먹어 뒤 사유가 표본에서 사라진다
  assert.ok(sample("noRow").length > 0, "🎯 shape 26건이어도 noRow 가 표본에 남는다");
  assert.ok(sample("textDiffers").length > 0, "🎯 textDiffers 도 표본에 남는다");
  assert.ok(rep.stuckOmitted.shape > 0, "shape 는 한도를 넘겼으니 생략 수가 있어야 한다");
  // fixture 가 제 사유로 분류됐는가
  const by = new Map(rep.stuckRows.map((r) => [Number(r.id), r.why]));
  assert.equal(by.get(noRowId), "noRow", "noRow fixture 의 사유");
  assert.equal(by.get(diffId), "textDiffers", "textDiffers fixture 의 사유");
  assert.ok(shapeIds.some((i) => by.get(i) === "shape"), "shape fixture 중 하나는 표본에");
  // 격리 확인 — 이 실행의 행만 집계됐는가
  assert.equal(rep.by.shape, shapeIds.length, `shape 집계가 이 실행의 fixture 수(${shapeIds.length})와 같아야 한다`);
  assert.equal(rep.by.noRow, 1, "noRow 집계가 1 이어야 한다 (격리 확인)");
  assert.equal(rep.by.textDiffers, 1, "textDiffers 집계가 1 이어야 한다 (격리 확인)");
  console.log("Ingest stuck-id checks passed");
} finally {
  await cleanup(UID);   // assert 실패해도 이 실행이 만든 것만 지운다
}
process.exit(0);
