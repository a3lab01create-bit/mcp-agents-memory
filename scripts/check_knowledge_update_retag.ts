/**
 * manage_knowledge update → 콜드패스 재태깅 대기열로 돌아가는지 검사.
 *
 * 배경(2026-11-12): update 가 p_tag_id·d_tag 를 비우면서 `tag_processed = FALSE` 를 안 켰다.
 * 콜드패스(worker.ts)는 `NOT tag_processed` 인 행만 태깅하므로, 고친 글은 태그가 지워진 채
 * 영영 다시 안 붙었다(#127217 실측). migration 020 때 이 자리만 빠졌다.
 *
 * 🔴 실제 DB 에 쓴다 → **버리는 시험용 DB 에서만** 돈다. 이름에 "test" 가 없으면 아무것도 안 하고 멈춘다.
 *
 *   MEMORY_CONFIG_PATH=<시험용 .env> npm run check:knowledge-retag
 *
 * 음성대조: 고치기 전 SQL 로 돌리면 "tag_processed 가 FALSE 로 돌아가야 한다" 에서 실패한다(2026-11-14 확인).
 */
import assert from "node:assert/strict";

if (!process.env.MEMORY_CONFIG_PATH) {
  console.error("MEMORY_CONFIG_PATH 로 시험용 DB 설정 파일을 지정해야 한다 (운영 DB 보호).");
  process.exit(2);
}

const { db } = await import("../src/db.ts");
const { getDefaultUserId } = await import("../src/users.ts");
const { registerManageKnowledge } = await import("../src/tools/manage_knowledge.ts");

const who = await db.query(`SELECT current_database() AS name`);
const dbName: string = who.rows[0].name;
if (!/test/i.test(dbName)) {
  console.error(`시험용 DB 가 아니다: ${dbName} — 멈춘다.`);
  await db.close();
  process.exit(2);
}

// registerTool 로 넘어오는 핸들러만 붙잡는 가짜 서버
let handler: ((args: any) => Promise<any>) | null = null;
const fakeServer: any = {
  registerTool(name: string, _schema: unknown, fn: (args: any) => Promise<any>) {
    if (name === "manage_knowledge") handler = fn;
  },
};
registerManageKnowledge(fakeServer);
assert.ok(handler, "manage_knowledge 핸들러가 등록돼야 한다");

const userId = await getDefaultUserId();
const ins = await db.query(
  `INSERT INTO memory (user_id, agent_platform, agent_model, role, message, d_tag, tag_processed, is_pinned)
   VALUES ($1, 'check', 'check', 'user', '고치기 전 본문', ARRAY['old-tag'], TRUE, TRUE)
   RETURNING id`,
  [userId],
);
const id = Number(ins.rows[0].id);

try {
  const res = await handler!({ action: "update", target: "memory", memory_id: id, content: "고친 본문" });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.stored, true, `update 응답: ${res.content[0].text}`);

  const row = (await db.query(
    `SELECT message, p_tag_id, d_tag, tag_processed, embedding IS NULL AS no_emb FROM memory WHERE id = $1`,
    [id],
  )).rows[0];
  assert.equal(row.message, "고친 본문");
  assert.equal(row.p_tag_id, null);
  assert.deepEqual(row.d_tag, []);
  assert.equal(row.no_emb, true);
  assert.equal(row.tag_processed, false, "tag_processed 가 FALSE 로 돌아가야 한다 — 아니면 콜드패스가 다시 안 본다");

  // 콜드패스가 집는 조건(worker.ts 의 WHERE) 그대로 다시 확인
  const picked = await db.query(
    `SELECT (NOT tag_processed) AS needs_tag FROM memory WHERE id = $1 AND (embedding IS NULL OR NOT tag_processed)`,
    [id],
  );
  assert.equal(picked.rows.length, 1);
  assert.equal(picked.rows[0].needs_tag, true);

  console.log(`✅ check:knowledge-retag — update 뒤 tag_processed=FALSE, 콜드패스 재태깅 대상 (db=${dbName})`);
} finally {
  await db.query(`DELETE FROM memory WHERE id = $1`, [id]);
  await db.close();
}
