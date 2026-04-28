import "dotenv/config";

// Force the gate ON before importing any module that reads the flag.
process.env.MEMORY_AUDIT_ENABLED = "true";

import { db } from "../build/db.js";
import { auditMemory } from "../build/memory_auditor.js";
import { processBatch, validationQueue } from "../build/librarian.js";
import { getOrCreateSubject } from "../build/subjects.js";

const SUFFIX = `_audit_${Date.now()}`;
const SUBJECT_KEY = `system_audit_test${SUFFIX}`;

async function drainValidationQueue(timeoutMs = 60000) {
  const start = Date.now();
  while (true) {
    const { active, queued } = validationQueue.stats();
    if (active === 0 && queued === 0) return;
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function cleanup(subjectId) {
  if (!subjectId) return;
  await db.query(
    `DELETE FROM fact_validations WHERE fact_id IN (SELECT id FROM memories WHERE subject_id = $1)`,
    [subjectId]
  );
  await db.query(`DELETE FROM memories WHERE subject_id = $1`, [subjectId]);
  await db.query(`DELETE FROM subjects WHERE id = $1`, [subjectId]);
}

let subjectId = null;
try {
  console.log("=== v5.0 Memory Auditor e2e test ===");
  subjectId = await getOrCreateSubject(SUBJECT_KEY, "system");

  // === Test 1: auditMemory direct call shape ===
  console.log("\n--- Test 1: auditMemory direct call ---");
  const direct = await auditMemory(
    "PostgreSQL 16 introduced support for logical replication from standby servers.",
    "learning"
  );
  console.log(`tier=${direct.validation_tier}`);
  console.log(`sources_count=${direct.sources.length}`);
  console.log(`reasoning="${(direct.audit_reasoning || "").slice(0, 100)}..."`);
  console.log(`reconciled_changed=${direct.reconciled_content !== "PostgreSQL 16 introduced support for logical replication from standby servers."}`);

  // === Test 2: processBatch with audit enabled + learning text ===
  console.log("\n--- Test 2: processBatch with MEMORY_AUDIT_ENABLED=true ---");
  const text2 = "I learned today that PostgreSQL 16 supports logical replication from standby servers, which is a significant improvement for high-availability setups. This is a critical technical fact worth remembering with high importance.";
  const r2 = await processBatch(text2, subjectId, null, text2, {
    author_model: "claude-opus-4-7",
    platform: "claude-code",
  });
  console.log(`extracted=${r2.extracted} saved=${r2.saved} audited=${r2.audited}`);
  if (r2.errors.length > 0) console.log(`errors: ${r2.errors.join(" | ")}`);

  // Verify fact_validations row exists for any audited fact.
  if (r2.audited > 0) {
    const validations = await db.query(
      `SELECT fv.fact_id, fv.status, fv.metadata
       FROM fact_validations fv
       JOIN memories m ON fv.fact_id = m.id
       WHERE m.subject_id = $1 AND fv.metadata->>'audit_path' = 'sync'`,
      [subjectId]
    );
    console.log(`sync_audit_rows=${validations.rowCount}`);
    validations.rows.forEach((row) => {
      const meta = row.metadata;
      const sourceCount = Array.isArray(meta?.sources) ? meta.sources.length : 0;
      const hasOriginal = typeof meta?.original_content === "string" && meta.original_content.length > 0;
      console.log(`  fact_id=${row.fact_id} status=${row.status} sources=${sourceCount} original_preserved=${hasOriginal}`);
    });
    const memCheck = await db.query(
      `SELECT id, validation_status FROM memories WHERE subject_id = $1 AND validation_status IN ('valid', 'contested')`,
      [subjectId]
    );
    console.log(`memories_with_synced_status=${memCheck.rowCount}`);
  } else {
    console.log("⚠️ no facts audited — LLM may not have classified text as learning+importance>7");
  }

  // === Test 3: gate — preference fact should NOT be audited ===
  console.log("\n--- Test 3: preference fact (gate should block) ---");
  const text3 = "This is critically important to remember: I strongly prefer using vim keybindings over emacs in all editors and IDEs.";
  const r3 = await processBatch(text3, subjectId, null, text3, {
    author_model: "claude-opus-4-7",
    platform: "claude-code",
  });
  console.log(`extracted=${r3.extracted} saved=${r3.saved} audited=${r3.audited}`);
  if (r3.audited === 0) {
    console.log("✅ preference correctly skipped audit");
  } else {
    console.log("⚠️ preference unexpectedly audited — check gate or fact_type misclassification");
  }

  // === Test 4: flag off — even learning text should not be audited ===
  console.log("\n--- Test 4: flag off ---");
  process.env.MEMORY_AUDIT_ENABLED = "false";
  const text4 = "I learned that Redis 7 added a new module API which is technically critical to remember.";
  const r4 = await processBatch(text4, subjectId, null, text4, {
    author_model: "claude-opus-4-7",
    platform: "claude-code",
  });
  console.log(`extracted=${r4.extracted} saved=${r4.saved} audited=${r4.audited}`);
  if (r4.audited === 0) {
    console.log("✅ flag off correctly skipped audit");
  } else {
    console.log("⚠️ audit ran with flag off — gate broken");
  }
  process.env.MEMORY_AUDIT_ENABLED = "true";

  console.log("\n⏳ draining validation queue...");
  await drainValidationQueue();
  await cleanup(subjectId);
  console.log("\n✅ test complete (cleanup done)");
} catch (err) {
  console.error("❌ test failed:", err);
  await cleanup(subjectId).catch(() => {});
  process.exitCode = 1;
} finally {
  await db.close().catch(() => {});
}
