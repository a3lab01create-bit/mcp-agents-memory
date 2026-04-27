import "dotenv/config";
import { db } from "../build/db.js";
import { processBatch, validationQueue } from "../build/librarian.js";
import { getOrCreateSubject } from "../build/subjects.js";

async function drainValidationQueue(timeoutMs = 60000) {
  const start = Date.now();
  while (true) {
    const { active, queued } = validationQueue.stats();
    if (active === 0 && queued === 0) return;
    if (Date.now() - start > timeoutMs) {
      console.log(`⚠️ validation queue did not drain (active=${active}, queued=${queued})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const SUFFIX = `_v50_${Date.now()}`;
const FROM_KEY = `user_alice${SUFFIX}`;
const TO_KEY = `project_acme${SUFFIX}`;
const NEIGHBOR_KEY = `project_bob_collab${SUFFIX}`;

async function cleanup() {
  // Best-effort cleanup of test rows.
  await db.query(
    `DELETE FROM memories WHERE subject_id IN (SELECT id FROM subjects WHERE subject_key = ANY($1::text[]))`,
    [[FROM_KEY, TO_KEY, NEIGHBOR_KEY]]
  );
  await db.query(
    `DELETE FROM subject_relationships
     WHERE from_subject_id IN (SELECT id FROM subjects WHERE subject_key = ANY($1::text[]))
        OR to_subject_id IN (SELECT id FROM subjects WHERE subject_key = ANY($1::text[]))`,
    [[FROM_KEY, TO_KEY, NEIGHBOR_KEY]]
  );
  await db.query(
    `DELETE FROM subjects WHERE subject_key = ANY($1::text[])`,
    [[FROM_KEY, TO_KEY, NEIGHBOR_KEY]]
  );
}

try {
  console.log("=== v5.0 Memory Graph e2e test ===");
  await cleanup();

  // Pre-create the from/to subjects so the Librarian's edge resolution finds them.
  const fromId = await getOrCreateSubject(FROM_KEY, "person");
  const toId = await getOrCreateSubject(TO_KEY, "project");
  console.log(`prepared subjects: from=${fromId} to=${toId}`);

  // === Scenario 1: Direct edge upsert path ===
  // We exercise upsertSubjectEdge indirectly through processBatch by feeding
  // text that should produce a fact_type='relationship' with a clean edge.
  console.log("\n--- Scenario 1: Librarian relationship extraction ---");
  const text1 = `Alice (subject_key user_alice${SUFFIX}) owns the Acme project (subject_key project_acme${SUFFIX}). She is the primary stakeholder.`;
  const r1 = await processBatch(text1, fromId, toId, text1, {
    author_model: "claude-sonnet-4-6",
    platform: "claude-code",
  });
  console.log(`extracted=${r1.extracted} saved=${r1.saved} edges_saved=${r1.edges_saved}`);
  if (r1.errors.length > 0) console.log(`errors: ${r1.errors.join(" | ")}`);

  // Verify subject_relationships row exists.
  const edgeCheck = await db.query(
    `SELECT relationship_type FROM subject_relationships
     WHERE from_subject_id = $1 AND to_subject_id = $2`,
    [fromId, toId]
  );
  console.log(`edge rows in DB: ${edgeCheck.rowCount}`);
  edgeCheck.rows.forEach((r) => console.log(`  type=${r.relationship_type}`));

  // === Scenario 2: Direct edge upsert via SQL (bypass LLM, deterministic) ===
  console.log("\n--- Scenario 2: Direct subject_relationships seed for graph expansion ---");
  const neighborId = await getOrCreateSubject(NEIGHBOR_KEY, "project");
  await db.query(
    `INSERT INTO subject_relationships (from_subject_id, to_subject_id, relationship_type)
     VALUES ($1, $2, 'collaborates') ON CONFLICT DO NOTHING`,
    [fromId, neighborId]
  );

  // Insert a memory owned by neighbor only.
  await db.query(
    `INSERT INTO memories (subject_id, content, fact_type, confidence, importance, tags)
     VALUES ($1, 'neighbor-only fact about acme bob collab', 'state', 8, 5, ARRAY['v50_test'])`,
    [neighborId]
  );

  // === Scenario 3: memory_search expand_via_graph ===
  console.log("\n--- Scenario 3: graph expansion query ---");
  const noExpand = await db.query(
    `SELECT COUNT(*)::int AS count FROM memories
     WHERE subject_id = $1 AND tags && ARRAY['v50_test']::text[]`,
    [fromId]
  );
  console.log(`memories on FROM only (no expand): ${noExpand.rows[0].count}`);

  const expanded = await db.query(
    `WITH neighbors AS (
       SELECT $1::int AS id
       UNION
       SELECT to_subject_id FROM subject_relationships WHERE from_subject_id = $1
       UNION
       SELECT from_subject_id FROM subject_relationships WHERE to_subject_id = $1
     )
     SELECT COUNT(*)::int AS count FROM memories
     WHERE subject_id IN (SELECT id FROM neighbors) AND tags && ARRAY['v50_test']::text[]`,
    [fromId]
  );
  console.log(`memories with 1-hop expand: ${expanded.rows[0].count}`);

  if (expanded.rows[0].count > noExpand.rows[0].count) {
    console.log("✅ graph expansion increased result set");
  } else {
    console.log("⚠️ graph expansion did not increase result set — check seed data");
  }

  // === Scenario 4: memory_status edge stats ===
  console.log("\n--- Scenario 4: memory_status edge counts ---");
  const stats = await db.query(
    `SELECT relationship_type, COUNT(*)::int AS count
     FROM subject_relationships GROUP BY relationship_type ORDER BY count DESC`
  );
  stats.rows.forEach((r) => console.log(`  ${r.relationship_type}: ${r.count}`));

  console.log("\n⏳ draining validation queue before cleanup...");
  await drainValidationQueue();
  await cleanup();
  console.log("\n✅ test complete (cleanup done)");
} catch (err) {
  console.error("❌ test failed:", err);
  await cleanup().catch(() => {});
  process.exitCode = 1;
} finally {
  await db.close().catch(() => {});
}
