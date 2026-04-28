import "dotenv/config";
import { db } from "../build/db.js";
import { getOrCreateSubject } from "../build/subjects.js";
import {
  runForgettingPass,
  restoreMemories,
  RestoreInputError,
} from "../build/forgetting.js";

const SUFFIX = `_v50rs_${Date.now()}`;
const SUBJ_KEY = `user_restore${SUFFIX}`;

async function cleanup() {
  await db.query(
    `DELETE FROM memories
     WHERE subject_id IN (SELECT id FROM subjects WHERE subject_key = ANY($1::text[]))`,
    [[SUBJ_KEY]]
  );
  await db.query(`DELETE FROM subjects WHERE subject_key = ANY($1::text[])`, [[SUBJ_KEY]]);
}

async function insertStaleMemory(subjectId, content, ageDays = 60, importance = 4) {
  // state HL=14, importance=4 at 60 days → score = 4 * exp(-60/14) ≈ 0.054 (well below 0.5)
  const created = new Date(Date.now() - ageDays * 86400 * 1000);
  const r = await db.query(
    `INSERT INTO memories (
        subject_id, content, fact_type, confidence, importance,
        access_count, last_accessed_at, validation_status,
        source, created_at, updated_at, tags
     ) VALUES ($1, $2, 'state', 7, $3, 0, $4, 'valid', 'librarian', $4, $4, ARRAY['v50_restore_test'])
     RETURNING id`,
    [subjectId, content, importance, created.toISOString()]
  );
  return r.rows[0].id;
}

async function readRow(id) {
  const r = await db.query(`SELECT is_active, metadata FROM memories WHERE id = $1`, [id]);
  return r.rows[0];
}

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

try {
  console.log("=== v5.0 memory_restore e2e test ===");
  await cleanup();
  const subjId = await getOrCreateSubject(SUBJ_KEY, "person");

  // ─── Scenario 1: Single restore by id ───
  console.log("\n--- Scenario 1: single restore by memory_id ---");
  const id1 = await insertStaleMemory(subjId, "stale fact 1");
  await runForgettingPass({ threshold: 0.5 });
  const beforeRestore = await readRow(id1);
  check("forgotten by decay pass", beforeRestore.is_active === false);
  check("metadata.forgotten_at stamped", typeof beforeRestore.metadata?.forgotten_at === "string");

  const r1 = await restoreMemories({ memoryId: id1 });
  check("restoreMemories returned 1 row", r1.rows.length === 1, `got ${r1.rows.length}`);
  check("dry_run flag is false", r1.dry_run === false);
  const afterRestore = await readRow(id1);
  check("row is_active flipped to TRUE", afterRestore.is_active === true);
  check(
    "metadata.restored_at stamped",
    typeof afterRestore.metadata?.restored_at === "string",
    `metadata=${JSON.stringify(afterRestore.metadata)}`
  );
  check(
    "forgotten_at history preserved",
    typeof afterRestore.metadata?.forgotten_at === "string"
  );
  // Verify the restored row is now queryable like any active memory.
  // (Done here, before subsequent forgetting passes re-decay this row.)
  const visibleQuery = await db.query(
    `SELECT COUNT(*)::int AS c FROM memories
     WHERE tags && ARRAY['v50_restore_test']::text[] AND is_active = TRUE AND id = $1`,
    [id1]
  );
  check("restored row participates in active queries", visibleQuery.rows[0].c === 1);

  // ─── Scenario 2: since_minutes bulk restore ───
  console.log("\n--- Scenario 2: since_minutes bulk restore ---");
  const ids2 = [];
  for (let i = 0; i < 3; i++) {
    ids2.push(await insertStaleMemory(subjId, `bulk stale ${i}`));
  }
  await runForgettingPass({ threshold: 0.5 });
  // All 3 should now be inactive.
  const allInactive = await db.query(
    `SELECT COUNT(*)::int AS c FROM memories WHERE id = ANY($1::int[]) AND is_active = FALSE`,
    [ids2]
  );
  check("3 forgotten before bulk restore", allInactive.rows[0].c === 3);

  const r2 = await restoreMemories({ sinceMinutes: 5 });
  // With the last_accessed_at bump on restore, scenario-1's id1 isn't re-forgotten
  // by scenario 2's pass, so bulk only touches the 3 rows we just inserted.
  check("bulk restore touches exactly 3 rows", r2.rows.length === 3, `got ${r2.rows.length}`);
  const allActive = await db.query(
    `SELECT COUNT(*)::int AS c FROM memories WHERE id = ANY($1::int[]) AND is_active = TRUE`,
    [ids2]
  );
  check("all 3 bulk rows are active", allActive.rows[0].c === 3);

  // Race immunity: running another forget pass right now should NOT re-forget
  // the just-restored rows because last_accessed_at was bumped to NOW().
  const r2pass = await runForgettingPass({ threshold: 0.5 });
  const stillActive = await db.query(
    `SELECT COUNT(*)::int AS c FROM memories WHERE id = ANY($1::int[]) AND is_active = TRUE`,
    [ids2]
  );
  check(
    "restored rows survive immediate next forget pass",
    stillActive.rows[0].c === 3,
    `forgotten=${r2pass.forgotten}, still-active=${stillActive.rows[0].c}/3`
  );

  // ─── Scenario 3: dry_run preview ───
  console.log("\n--- Scenario 3: dry_run preview ---");
  const id3 = await insertStaleMemory(subjId, "dry-run candidate");
  await runForgettingPass({ threshold: 0.5 });
  const preDry = await readRow(id3);
  check("forgotten before dry-run", preDry.is_active === false);

  const r3 = await restoreMemories({ memoryId: id3, dryRun: true });
  check("dry_run reports the candidate", r3.rows.length === 1);
  check("dry_run flag is true", r3.dry_run === true);
  const postDry = await readRow(id3);
  check("row STILL inactive after dry-run", postDry.is_active === false);
  check("no restored_at stamp from dry-run", postDry.metadata?.restored_at === undefined);

  // ─── Scenario 4: already-active row → empty result, not error ───
  console.log("\n--- Scenario 4: already-active row ---");
  const r4 = await restoreMemories({ memoryId: id3 }); // first apply
  check("apply restore on dry-run candidate", r4.rows.length === 1);

  const r4b = await restoreMemories({ memoryId: id3 }); // second call, already active
  check("second restore on active row → 0 rows", r4b.rows.length === 0);

  // ─── Scenario 5: superseded rows are NOT restorable ───
  console.log("\n--- Scenario 5: superseded row immunity ---");
  const supersededInsert = await db.query(
    `INSERT INTO memories (
        subject_id, content, fact_type, confidence, importance,
        source, is_active, tags
     ) VALUES ($1, 'old superseded fact', 'state', 7, 5, 'librarian', FALSE, ARRAY['v50_restore_test'])
     RETURNING id`,
    [subjId]
  );
  const supersededId = supersededInsert.rows[0].id;
  // No metadata.forgotten_at — purely simulating supersession.
  const r5 = await restoreMemories({ memoryId: supersededId });
  check("superseded row → 0 rows (cannot restore)", r5.rows.length === 0);
  const supStatus = await readRow(supersededId);
  check("superseded row stays inactive", supStatus.is_active === false);

  // ─── Scenario 6: input validation ───
  console.log("\n--- Scenario 6: input validation ---");
  let neither = null;
  try {
    await restoreMemories({});
  } catch (err) {
    neither = err;
  }
  check("empty args throws RestoreInputError", neither instanceof RestoreInputError);

  let both = null;
  try {
    await restoreMemories({ memoryId: 1, sinceMinutes: 5 });
  } catch (err) {
    both = err;
  }
  check("both args throws RestoreInputError", both instanceof RestoreInputError);

  console.log(`\n=== Result: ${pass} pass / ${fail} fail ===`);
  await cleanup();
  if (fail > 0) process.exitCode = 1;
} catch (err) {
  console.error("❌ test failed:", err);
  await cleanup().catch(() => {});
  process.exitCode = 1;
} finally {
  await db.close().catch(() => {});
}
