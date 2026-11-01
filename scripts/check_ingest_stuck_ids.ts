/**
 * 재정리에서 **막힌 행의 id·사유**가 보고에 담기는지 검사.
 *
 * 🔴 왜 필요한가: 2026-11-01 에 감시 알림이 "shape 3건"만 말해서 **어느 행인지 알 수 없었다.**
 *    집계만 내고 식별을 안 내면 사람이 집을 수 없다.
 *
 * ⚠️ 이 검사는 DB 를 쓴다(TRUNCATE 포함). **테스트 DB 가 아니면 건너뛴다** —
 *    운영 DB 에서 절대 돌지 않게 current_database() 로 먼저 확인한다.
 *    실행:  DB_NAME=<테스트DB> npx tsx scripts/check_ingest_stuck_ids.ts
 */
import assert from "node:assert/strict";
import { db } from "../src/db.js";
import { recleanEnvelopes } from "../src/auto_save/buzz_ingest.js";

const dbName = (await db.query("SELECT current_database() db")).rows[0].db as string;
if (!/test|scratch|tmp/i.test(dbName)) {
  console.log(`SKIP — 테스트 DB 가 아니다 (current_database=${dbName}). ` +
    `DB_NAME 으로 테스트 DB 를 지정해 실행하라.`);
  process.exit(0);
}
// getClient 경로도 같은 DB 인지 (풀의 다른 연결이 운영으로 가지 않게)
const cl = await db.getClient();
assert.equal((await cl.query("SELECT current_database() db")).rows[0].db, dbName, "두 경로가 같은 DB 여야 한다");
cl.release();

const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const HEX = "a".repeat(64);
const CTX = `<context>\nScope: thread\nChannel: t (#${UUID})\n</context>`;
// 이력 **안**에 턴 태그가 있는 봉투 → historyHidesTurn 이 의도적으로 거절한다 (shape)
const stuck = [CTX,
  '<thread-context included="1" total="1" truncated="false">',
  `[1] ${HEX} (2026-10-31T00:00:00.000Z): 인용`,
  '<buzz-events count="4">',
  "</thread-context>",
  '<buzz-event type="@mention">', "Content: 본문", "</buzz-event>"].join("\n");

await db.query("TRUNCATE memory");
await db.query(
  `INSERT INTO memory (user_id,agent_platform,role,message,raw_message,venue,created_at,is_active,is_pinned,tag_processed,d_tag,external_uuid)
   VALUES (1,'claude-code','user',$1,NULL,'buzz:t',now(),TRUE,FALSE,TRUE,'{}','cc:stuck')`, [stuck]);
const id = Number((await db.query("SELECT id FROM memory WHERE external_uuid='cc:stuck'")).rows[0].id);

// runBuzzIngest 는 BUZZ_INGEST_OWNER·릴레이를 요구하므로 재정리 함수를 직접 태운다
const rep = await recleanEnvelopes(1, 100, true);   // dryRun=true → 쓰기 없음
assert.ok(rep.stuck > 0, "막힌 행이 있어야 한다");
assert.ok(rep.stuckRows.length > 0, "🎯 막힌 행의 id 가 보고에 담겨야 한다");
assert.equal(rep.stuckRows.length, rep.stuck, "20건 미만이면 집계와 식별 건수가 같아야 한다");
const row = rep.stuckRows.find((r) => Number(r.id) === id);
assert.ok(row, "그 행의 id 가 목록에 있어야 한다");
assert.ok(["shape", "noRow", "textDiffers"].includes(row!.why), "사유가 분류돼야 한다");
assert.equal(row!.why, "shape", "이력 안의 턴 태그는 shape 로 분류된다 (의도된 거절)");

await db.query("TRUNCATE memory");
console.log("Ingest stuck-id checks passed");
process.exit(0);
