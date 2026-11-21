/**
 * 훅 회상 후보 굶음 검사 (DB 필요, 선택). → 먼저 `npm run build` (migrate 를 build/index.js 로 돌린다).
 *
 * CHECK_RECALL_DATABASE_URL 이 있으면 그 일회용 DB 를 마이그레이션하고(센티널 표 `__disposable_test_db__`
 * 가 없으면 멈춘다), 가장 가까운 줄이 전부 `<` 로 시작하는 상황을 만든다 — 운영에서 본 모양
 * (11-21 실측: HNSW 상위 40 중 39개가 `<context>` 로 시작하는 에이전트 수집 행 → 후보 0~1개).
 *
 * - 음성대조: 예전 쿼리(색인 + 사후 필터, 반복 검색 없음)는 후보를 거의 못 찾는다.
 * - fetchRecallCandidates(반복 검색)는 걸러진 뒤에도 남는 줄을 limit 까지 찾고, 유사도 순으로 돌려준다.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchRecallCandidates, type RecallSettings } from "../src/hooks.js";

const dbUrl = process.env.CHECK_RECALL_DATABASE_URL;
if (!dbUrl) {
  console.log("(CHECK_RECALL_DATABASE_URL 없음 — DB 검사는 건너뜀)");
  process.exit(0);
}

const S: RecallSettings = {
  minSimilarity: 0.5, limit: 3, minPromptChars: 8, minBuzzContentChars: 20, minMemoryChars: 40, minUserMemoryChars: 40, recentMinutes: 30, snippetChars: 50,
};
const DIM = 3072;
const TAG = `recallcheck:${process.pid}:${Date.now()}`;

/** 기준축 e0 에 다른 축 하나를 섞은 단위 벡터 → e0 과의 코사인 = a. */
function vec(a: number, axis: number): string {
  const v = new Array<number>(DIM).fill(0);
  v[0] = a;
  v[axis] = Math.sqrt(1 - a * a);
  return `[${v.join(",")}]`;
}

const pg = (await import("pg")).default;
const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
try {
  const sentinel = (await client.query(`SELECT to_regclass('public.__disposable_test_db__') IS NOT NULL AS ok`)).rows[0].ok;
  if (!sentinel) {
    throw new Error("센티널 표 __disposable_test_db__ 가 없다 — 일회용 DB 가 아니면 쓰지 않는다. 일회용 DB 에서 CREATE TABLE IF NOT EXISTS __disposable_test_db__ () 뒤 실행.");
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mam-recall-"));
  const envFile = path.join(tmp, "db.env");
  fs.writeFileSync(envFile, `DATABASE_URL=${dbUrl}\n`);
  const entry = path.resolve("build/index.js");
  const mig = spawnSync(process.execPath, [entry, "migrate"], {
    encoding: "utf8", timeout: 120_000, cwd: tmp, env: { PATH: process.env.PATH ?? "", HOME: tmp, MEMORY_CONFIG_PATH: envFile },
  });
  assert.equal(mig.status, 0, `migrate: ${mig.stderr.slice(-400)}`);
  const pgv = (await client.query(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`)).rows[0]?.extversion;
  await client.query(`INSERT INTO users (user_name) SELECT 'recallcheck' WHERE NOT EXISTS (SELECT 1 FROM users)`);
  const userId = Number((await client.query(`SELECT user_id FROM users ORDER BY user_id LIMIT 1`)).rows[0].user_id);

  // 가장 가까운 20줄: `<context>` 로 시작 (코사인 0.995) → 훅 쿼리가 거른다
  // 남는 6줄: 사람 말 (코사인 0.970 … 0.965) — 21~26번째로 가깝다. ef_search 를 10 으로 낮춰
  // "색인이 돌려준 가까운 줄이 다 걸러진다"를 작은 표에서 만든다(운영: 기본 40, 상위 40 중 39개가 `<`).
  // 합성 데이터 주의: 거의 같은 벡터를 이웃 상한(층0 = 32)보다 많이 넣거나 남는 줄을 맨 뒤에 몰아 넣으면
  // HNSW 가 그 줄로 들어오는 연결을 잘라 어떤 검색으로도 안 닿는다 → 20줄 · 섞어 넣기
  // (운영 40개에선 반복 검색이 12개씩 찾았다).
  const ins = `INSERT INTO memory (user_id, agent_platform, agent_model, role, message, embedding, external_uuid, created_at)
               VALUES ($1, 'claude-code', 'check', $2, $3, $4::halfvec, $5, now() - interval '2 days') RETURNING id`;
  const keep: number[] = [];
  for (let i = 0; i < 20; i++) {
    await client.query(ins, [userId, "user", `<context>\nScope: thread\nChannel: x\n</context>\n봉투째 저장된 에이전트 수집 행 ${i} — 충분히 길게`, vec(0.995, 1 + i), `${TAG}:env:${i}`]);
    if (i % 3 === 1 && keep.length < 6) {
      const k = keep.length;
      const r = await client.query(ins, [userId, "assistant", `남아야 하는 사람 말 기록 ${k} — 검색 후보로 나와야 한다, 충분히 길게 쓴다`, vec(0.97 - k * 0.001, 200 + k), `${TAG}:keep:${k}`]);
      keep.push(Number(r.rows[0].id));
    }
  }
  assert.equal(keep.length, 6);
  await client.query("ANALYZE memory");
  // 작은 표라 기획기가 순차 읽기·user_id 색인 + 정렬을 고르면 HNSW 경로를 못 본다 → 이 연결에서만 끈다
  // (운영 표는 커서 기획기가 스스로 HNSW 를 고른다 — 11-21 실측 후보 굶음이 그 증거)
  await client.query("SET enable_seqscan = off");
  await client.query("SET enable_bitmapscan = off");
  await client.query("SET enable_sort = off");
  await client.query("SET hnsw.ef_search = 10");
  const q = vec(1, 1);
  const plan = (await client.query(
    `EXPLAIN SELECT m.id FROM memory m WHERE m.user_id = $1 AND m.embedding IS NOT NULL ORDER BY m.embedding <=> $2::halfvec LIMIT 12`,
    [userId, q],
  )).rows.map((r: any) => String(r["QUERY PLAN"]).replace(/'\[[^\]]*\]'/g, "'[…]'")).join("\n");
  assert.match(plan, /memory_embedding_idx/, `색인 경로여야 음성대조가 의미 있다:\n${plan}`);

  // 음성대조: 예전 쿼리 (반복 검색 없이 같은 WHERE)
  const old = await client.query(
    `SELECT m.id FROM memory m
      WHERE m.user_id = $1 AND m.is_active = TRUE AND m.entry_type = 'memory' AND m.embedding IS NOT NULL
        AND m.created_at < now() - make_interval(mins => 30) AND length(m.message) >= 40
        AND left(ltrim(m.message), 1) <> '<'
      ORDER BY m.embedding <=> $2::halfvec LIMIT 12`,
    [userId, q],
  );
  assert.ok(old.rows.length < S.limit, `예전 쿼리는 후보가 굶어야 한다 (got ${old.rows.length})`);

  const got = await fetchRecallCandidates(client, userId, q, S);
  const ours = got.rows.filter((r) => keep.includes(r.id));
  if (pgv && pgv.localeCompare("0.8.0", undefined, { numeric: true }) >= 0) {
    assert.equal(got.scan, "iterative", `pgvector ${pgv}`);
    assert.equal(ours.length, keep.length, `걸러진 뒤 남는 6줄을 다 찾는다 (got ${got.rows.length}, scan ${got.scan})`);
  } else {
    assert.equal(got.scan, "plain", `pgvector ${pgv} 는 반복 검색이 없다 → 예전처럼`);
  }
  assert.ok(got.rows.every((r) => !r.message.trimStart().startsWith("<")), "봉투째 행은 안 나온다");
  for (let i = 1; i < got.rows.length; i++) assert.ok(got.rows[i - 1].similarity >= got.rows[i].similarity, "유사도 내림차순");
  // 트랜잭션이 깨끗이 끝났다 (SET LOCAL 이 연결에 안 남는다)
  assert.equal((await client.query(`SELECT current_setting('hnsw.iterative_scan', true) AS v`)).rows[0].v === "relaxed_order", false,
    "반복 검색 설정은 그 트랜잭션에서만");
  console.log(`hook recall db checks passed (pgvector ${pgv}, old ${old.rows.length} → new ${got.rows.length}, scan ${got.scan})`);
} finally {
  await client.query(`DELETE FROM memory WHERE external_uuid LIKE $1`, [`${TAG}:%`]).catch(() => {});
  await client.end();
}
