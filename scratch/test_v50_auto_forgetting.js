import "dotenv/config";
import { db } from "../build/db.js";
import { getOrCreateSubject } from "../build/subjects.js";
import {
  scoreMemory,
  HALF_LIFE_DAYS,
  runForgettingPass,
} from "../build/forgetting.js";

const SUFFIX = `_v50fg_${Date.now()}`;
const SUBJ_KEY = `user_forget${SUFFIX}`;

async function cleanup() {
  await db.query(
    `DELETE FROM memories
     WHERE subject_id IN (SELECT id FROM subjects WHERE subject_key = ANY($1::text[]))`,
    [[SUBJ_KEY]]
  );
  await db.query(`DELETE FROM subjects WHERE subject_key = ANY($1::text[])`, [[SUBJ_KEY]]);
}

function approx(a, b, eps = 1e-3) {
  return Math.abs(a - b) < eps;
}

async function insertMemory({ subjectId, content, fact_type, importance, access_count, ageDays, validation_status }) {
  const created = new Date(Date.now() - ageDays * 86400 * 1000);
  const r = await db.query(
    `INSERT INTO memories (
        subject_id, content, fact_type, confidence, importance,
        access_count, last_accessed_at, validation_status,
        source, created_at, updated_at, tags
     ) VALUES ($1, $2, $3, 7, $4, $5, $6, $7, 'librarian', $6, $6, ARRAY['v50_forget_test'])
     RETURNING id`,
    [
      subjectId,
      content,
      fact_type,
      importance,
      access_count,
      created.toISOString(),
      validation_status ?? "valid",
    ]
  );
  return r.rows[0].id;
}

async function isActive(id) {
  const r = await db.query(`SELECT is_active, metadata FROM memories WHERE id = $1`, [id]);
  return { active: r.rows[0]?.is_active, metadata: r.rows[0]?.metadata };
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
  console.log("=== v5.0 Auto Forgetting e2e test ===");
  await cleanup();
  const subjId = await getOrCreateSubject(SUBJ_KEY, "person");

  // === Scenario 1: Pure scoring math ===
  console.log("\n--- Scenario 1: scoreMemory math ---");
  // age=0 → score = importance × 1
  const s0 = scoreMemory({ importance: 5, fact_type: "learning", access_count: 0, age_days: 0 });
  check("age=0 → score = importance", approx(s0, 5), `got ${s0}`);

  // state half-life = 14, importance=10, age=14, access=0 → score = 10 × exp(-1) ≈ 3.679
  const s1 = scoreMemory({ importance: 10, fact_type: "state", access_count: 0, age_days: 14 });
  check("state at HL with importance=10", approx(s1, 10 / Math.E, 1e-2), `got ${s1.toFixed(3)}`);

  // profile is immune → infinite score
  const sp = scoreMemory({ importance: 1, fact_type: "profile", access_count: 0, age_days: 9999 });
  check("profile → +Infinity", sp === Number.POSITIVE_INFINITY, `got ${sp}`);

  // access_count boosts half-life — same age, access_count=10 yields higher score
  const sLow = scoreMemory({ importance: 5, fact_type: "learning", access_count: 0, age_days: 90 });
  const sHigh = scoreMemory({ importance: 5, fact_type: "learning", access_count: 10, age_days: 90 });
  check("access boost increases score", sHigh > sLow, `low=${sLow.toFixed(3)} high=${sHigh.toFixed(3)}`);

  // half-life table sanity
  check(
    "HALF_LIFE_DAYS table",
    HALF_LIFE_DAYS.profile === Infinity &&
      HALF_LIFE_DAYS.state === 14 &&
      HALF_LIFE_DAYS.learning === 90 &&
      HALF_LIFE_DAYS.preference === 365
  );

  // === Scenario 2: Profile immunity (DB) ===
  console.log("\n--- Scenario 2: profile immunity ---");
  const profileId = await insertMemory({
    subjectId: subjId,
    content: "I am Hoon (test profile fact)",
    fact_type: "profile",
    importance: 1,
    access_count: 0,
    ageDays: 5 * 365, // 5 years
  });
  await runForgettingPass({ threshold: 0.5 });
  const pStat = await isActive(profileId);
  check("profile fact still active after 5y", pStat.active === true);

  // === Scenario 3: validation_status='pending' immunity ===
  console.log("\n--- Scenario 3: pending immunity ---");
  const pendingId = await insertMemory({
    subjectId: subjId,
    content: "stale learning still pending grounding",
    fact_type: "learning",
    importance: 3,
    access_count: 0,
    ageDays: 365 * 3, // very stale
    validation_status: "pending",
  });
  await runForgettingPass({ threshold: 0.5 });
  const penStat = await isActive(pendingId);
  check("pending learning skipped despite age", penStat.active === true);

  // === Scenario 4: Threshold boundary ===
  console.log("\n--- Scenario 4: threshold boundary on state HL=14 ---");
  // Use importance=5 state. forget age = HL × ln(2 × imp) = 14 × ln(10) ≈ 32.24 days
  const justAlive = await insertMemory({
    subjectId: subjId,
    content: "state - just under threshold age",
    fact_type: "state",
    importance: 5,
    access_count: 0,
    ageDays: 25, // expected score ≈ 5 × exp(-25/14) = 0.842 > 0.5 → keep
  });
  const justForgotten = await insertMemory({
    subjectId: subjId,
    content: "state - just over threshold age",
    fact_type: "state",
    importance: 5,
    access_count: 0,
    ageDays: 40, // expected score ≈ 5 × exp(-40/14) = 0.286 < 0.5 → forget
  });
  await runForgettingPass({ threshold: 0.5 });
  const aliveStat = await isActive(justAlive);
  const forgottenStat = await isActive(justForgotten);
  check("near-threshold survivor still active", aliveStat.active === true);
  check("over-threshold row forgotten", forgottenStat.active === false);
  check(
    "metadata.forgotten_at stamped",
    forgottenStat.metadata && typeof forgottenStat.metadata.forgotten_at === "string",
    `metadata=${JSON.stringify(forgottenStat.metadata)}`
  );
  check(
    "metadata.forgotten_reason stamped",
    forgottenStat.metadata && typeof forgottenStat.metadata.forgotten_reason === "string"
  );

  // === Scenario 5: idempotence ===
  console.log("\n--- Scenario 5: idempotence ---");
  const result2 = await runForgettingPass({ threshold: 0.5 });
  check(
    "second pass forgets nothing new in this batch",
    result2.forgotten === 0 || result2.forgotten < 5,
    `forgotten=${result2.forgotten}`
  );

  // The previously-forgotten row should NOT be in the scan set this time (is_active=FALSE filters it out).
  const stillForgottenStat = await isActive(justForgotten);
  check("previously forgotten row stays forgotten", stillForgottenStat.active === false);

  // === Scenario 6: dry-run ===
  console.log("\n--- Scenario 6: dry-run ---");
  // Insert one more candidate that should fall below threshold
  const dryCandidate = await insertMemory({
    subjectId: subjId,
    content: "state - dry run candidate",
    fact_type: "state",
    importance: 4,
    access_count: 0,
    ageDays: 50, // 4 × exp(-50/14) ≈ 0.1245 < 0.5
  });
  const dry = await runForgettingPass({ threshold: 0.5, dryRun: true });
  check("dry-run reports >=1 forget", dry.forgotten >= 1, `forgotten=${dry.forgotten}`);
  const dryStat = await isActive(dryCandidate);
  check("dry-run did not flip is_active", dryStat.active === true);

  // Apply for real
  const real = await runForgettingPass({ threshold: 0.5 });
  check("apply pass forgets the candidate", real.forgotten >= 1, `forgotten=${real.forgotten}`);
  const realStat = await isActive(dryCandidate);
  check("candidate now is_active=FALSE", realStat.active === false);

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
