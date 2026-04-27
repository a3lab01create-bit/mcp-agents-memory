/**
 * Notion connector e2e.
 *
 * Self-skips when NOTION_API_KEY or NOTION_TEST_PAGE_ID isn't set, so the
 * test stays green in environments without Notion credentials. Provide both
 * to run for real:
 *
 *   NOTION_API_KEY=secret_xxx \
 *   NOTION_TEST_PAGE_ID=abcd-... \
 *     node scratch/test_notion_connector.js
 *
 * The test page must be shared with the integration that owns the API key.
 */

import "dotenv/config";
import { db } from "../build/db.js";
import { runConnectorSync } from "../build/connectors/sync.js";

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_TEST_PAGE_ID = process.env.NOTION_TEST_PAGE_ID;

if (!NOTION_API_KEY || !NOTION_TEST_PAGE_ID) {
  console.log("ℹ️  Skipping notion connector e2e — set NOTION_API_KEY and NOTION_TEST_PAGE_ID to run.");
  console.log("    (NOTION_API_KEY: " + (NOTION_API_KEY ? "set" : "MISSING") + ", NOTION_TEST_PAGE_ID: " + (NOTION_TEST_PAGE_ID ? "set" : "MISSING") + ")");
  process.exit(0);
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

async function readSourceRow(pageId) {
  const r = await db.query(
    `SELECT content_hash, facts_added, last_synced_at, title
     FROM memory_sources WHERE provider='notion' AND external_id=$1`,
    [pageId]
  );
  return r.rows[0] ?? null;
}

async function countNotionMemories() {
  const r = await db.query(
    `SELECT COUNT(*)::int AS c FROM memories
     WHERE source = 'connector' AND is_active = TRUE`
  );
  return r.rows[0].c;
}

try {
  console.log("=== Notion connector e2e ===");
  console.log(`   page_id: ${NOTION_TEST_PAGE_ID}`);

  // ─── Scenario 1: First sync ───
  console.log("\n--- Scenario 1: first sync (page should be ingested) ---");
  const beforeCount = await countNotionMemories();
  const r1 = await runConnectorSync({
    provider: "notion",
    external_id: NOTION_TEST_PAGE_ID,
    resource_type: "page",
  });
  check("pages_seen=1", r1.pages_seen === 1, `got ${r1.pages_seen}`);
  // pages_synced is 1 if NEW or HASH-CHANGED, 0 if unchanged.
  // For the very first sync it should be 1 unless we somehow run this twice.
  check("synced or unchanged", r1.pages_synced + r1.pages_skipped_unchanged === 1);

  const sourceAfter = await readSourceRow(NOTION_TEST_PAGE_ID);
  check("memory_sources row written", sourceAfter !== null);
  check(
    "content_hash recorded (64 hex)",
    sourceAfter && /^[0-9a-f]{64}$/.test(sourceAfter.content_hash),
    sourceAfter ? `hash=${sourceAfter.content_hash.slice(0, 16)}…` : ""
  );
  if (r1.pages_synced === 1) {
    const afterCount = await countNotionMemories();
    check("at least one memory inserted with source='connector'", afterCount > beforeCount, `before=${beforeCount}, after=${afterCount}`);
  } else {
    console.log(`  ℹ️  page was already synced previously — skipping insert assertion`);
  }

  // ─── Scenario 2: Second sync — idempotent ───
  console.log("\n--- Scenario 2: second sync (no content change → no work) ---");
  const beforeIdempotent = await countNotionMemories();
  const r2 = await runConnectorSync({
    provider: "notion",
    external_id: NOTION_TEST_PAGE_ID,
    resource_type: "page",
  });
  check("re-sync skips (unchanged)", r2.pages_skipped_unchanged === 1, `synced=${r2.pages_synced} skipped=${r2.pages_skipped_unchanged}`);
  check("no new memories on idempotent re-sync", (await countNotionMemories()) === beforeIdempotent);

  // ─── Scenario 3: Errors are surfaced via result.errors, not thrown ───
  console.log("\n--- Scenario 3: bogus page id → graceful error in result ---");
  const r3 = await runConnectorSync({
    provider: "notion",
    external_id: "00000000-0000-0000-0000-000000000000",
    resource_type: "page",
  });
  check("bogus id surfaces error in result.errors[]", r3.errors.length === 1, `errors=${JSON.stringify(r3.errors)}`);
  check("no facts added for failed sync", r3.facts_added === 0);
  check("no rows synced for failed sync", r3.pages_synced === 0);

  console.log(`\n=== Result: ${pass} pass / ${fail} fail ===`);
  if (fail > 0) process.exitCode = 1;
} catch (err) {
  console.error("❌ test failed:", err);
  process.exitCode = 1;
} finally {
  await db.close().catch(() => {});
}
