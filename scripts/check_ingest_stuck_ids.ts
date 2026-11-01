/**
 * 재정리에서 **막힌 행의 id·사유**가 보고에 담기는지 검사.
 *
 * 🔴 왜 필요한가: 2026-11-01 에 감시 알림이 "shape 3건"만 말해서 어느 행인지 알 수 없었다.
 *    집계만 내고 식별을 안 내면 사람이 집을 수 없다.
 *
 * 🔴🔴 **안전 설계 — 이름 패턴으로 테스트 DB 를 판별하지 않는다.**
 *    처음엔 `/test|scratch|tmp/i` 를 썼는데 `contest_production`·`latest_prod`·
 *    `PRODUCTION_tmpdata` 가 **전부 통과**했다(Codi 지적, 실측 확인). 게다가
 *    `DATABASE_URL` 이 `DB_NAME` 보다 우선이라(`src/db.ts:52`) DB_NAME 안내만으로는
 *    접속 DB 가 안 바뀔 수도 있다.
 *    ⇒ **센티널 표**를 요구한다: `__disposable_test_db__` 가 없으면 **SKIP**.
 *       운영 DB 에는 그 표가 없으므로 이름을 추측할 필요가 없다.
 *    ⇒ **TRUNCATE 하지 않는다.** 이 실행이 만든 fixture(external_uuid 접두사)만 지운다.
 *
 * 준비:  psql <일회용DB> -c 'CREATE TABLE IF NOT EXISTS __disposable_test_db__ ()'
 * 실행:  DB_NAME=<일회용DB> npm run check:stuck-ids      (DATABASE_URL 이 있으면 그쪽이 우선)
 */
import assert from "node:assert/strict";
import { db } from "../src/db.js";
import { recleanEnvelopes, type StuckRow } from "../src/auto_save/buzz_ingest.js";

const PREFIX = "chk:stuck:";
const dbName = (await db.query("SELECT current_database() db")).rows[0].db as string;
const sentinel = (await db.query(
  "SELECT to_regclass('public.__disposable_test_db__') IS NOT NULL AS ok",
)).rows[0].ok as boolean;
if (!sentinel) {
  console.log(
    `SKIP — 센티널 표가 없다 (current_database=${dbName}).\n` +
    `  일회용 DB 에서  CREATE TABLE IF NOT EXISTS __disposable_test_db__ ()  를 만든 뒤 실행하라.\n` +
    `  ⚠️ DATABASE_URL 이 DB_NAME 보다 우선이다 — 접속 DB 를 반드시 위 이름으로 확인하라.`,
  );
  process.exit(0);
}
// 풀의 다른 연결도 같은 DB 인지 (getClient 경로가 운영으로 가지 않게)
const cl = await db.getClient();
assert.equal((await cl.query("SELECT current_database() db")).rows[0].db, dbName,
  "db.query 와 getClient 가 다른 DB 를 본다 — 중단");
cl.release();
console.log(`  대상 DB=${dbName} · 센티널 확인 · fixture 접두사 '${PREFIX}'`);

const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const HEX = "a".repeat(64);
const CTX = `<context>\nScope: thread\nChannel: t (#${UUID})\n</context>`;
const QT = "2026-10-31T00:00:00.000Z";
const cleanup = async () =>
  void (await db.query("DELETE FROM memory WHERE external_uuid LIKE $1", [`${PREFIX}%`]));
await cleanup();   // 앞선 실행 잔재 제거 (멱등)

const ins = async (uuid: string, message: string, platform = "claude-code", venue = "buzz:t") =>
  Number((await db.query(
    `INSERT INTO memory (user_id,agent_platform,role,message,raw_message,venue,created_at,is_active,is_pinned,tag_processed,d_tag,external_uuid)
     VALUES (1,$1,'user',$2,NULL,$3,now(),TRUE,FALSE,TRUE,'{}',$4) RETURNING id`,
    [platform, message, venue, uuid])).rows[0].id);

// ① shape — 턴 태그가 이력 **안**에 있다 (historyHidesTurn 의 의도된 거절)
const shapeMsg = [CTX,
  '<thread-context included="1" total="1" truncated="false">',
  `[1] ${HEX} (${QT}): 인용`, '<buzz-events count="4">', "</thread-context>",
  '<buzz-event type="@mention">', "Content: 본문", "</buzz-event>"].join("\n");
// ② noRow — 인용은 정상이지만 그 자리·시각의 원본 행이 없다
const noRowMsg = [CTX,
  '<thread-context included="1" total="1" truncated="false">',
  `[1] ${HEX} (${QT}): 원본이 없는 인용`, "</thread-context>",
  '<buzz-event type="@mention">', "Content: 본문", "</buzz-event>"].join("\n");

const shapeId = await ins(`${PREFIX}shape`, shapeMsg);
const noRowId = await ins(`${PREFIX}norow`, noRowMsg);
// 사유별 한도(8) 초과를 만들기 위해 shape 를 더 넣는다
const extra: number[] = [];
// 🎯 25건 — **전역 상한(옛 20)이면 첫 루프의 shape 가 슬롯을 다 먹고 noRow 가 밀린다.**
//    사유별 한도여야 noRow 가 표본에 남는다. 이 숫자가 그 둘을 가르는 판별선이다.
for (let i = 0; i < 25; i++) extra.push(await ins(`${PREFIX}shape${i}`, shapeMsg));

const rep = await recleanEnvelopes(1, 1000, true);   // dryRun → 쓰기 없음
const sample = (why: StuckRow["why"]) => rep.stuckRows.filter((r) => r.why === why);
console.log(`  stuck=${rep.stuck} by=${JSON.stringify(rep.by)}`);
console.log(`  표본=${rep.stuckRows.length} 생략=${JSON.stringify(rep.stuckOmitted)}`);

assert.ok(rep.stuckRows.length > 0, "막힌 행의 id 가 보고에 담겨야 한다");
// 사유별 한도가 지켜지는가
for (const why of ["shape", "noRow", "textDiffers"] as const)
  assert.ok(sample(why).length <= 8, `${why} 표본이 사유별 한도(8) 이하여야 한다`);
// 🎯 전체 상한이면 뒤 루프 사유가 밀린다 — 사유별이므로 noRow 도 표본에 있어야 한다
assert.ok(sample("noRow").length > 0, "🎯 shape 가 10건이어도 noRow 가 표본에서 밀리지 않는다");
assert.ok(sample("shape").length > 0, "shape 도 표본에 있어야 한다");
// 집계 = 표본 + 생략 (분모가 맞는가)
const omitted = Object.values(rep.stuckOmitted).reduce((a, b) => a + b, 0);
assert.equal(rep.stuckRows.length + omitted, rep.stuck, "표본+생략 = 집계여야 한다");
assert.ok(omitted > 0, "한도를 넘겼으니 생략 수가 0 보다 커야 한다");
// 내가 넣은 행이 실제로 분류됐는가
const ids = new Set(rep.stuckRows.map((r) => Number(r.id)));
assert.ok(ids.has(noRowId), "noRow fixture 가 표본에 있어야 한다");
assert.equal(rep.stuckRows.find((r) => Number(r.id) === noRowId)!.why, "noRow", "사유가 noRow 여야 한다");
assert.ok([shapeId, ...extra].some((i) => ids.has(i)), "shape fixture 중 하나는 표본에 있어야 한다");

await cleanup();
console.log("Ingest stuck-id checks passed");
process.exit(0);
