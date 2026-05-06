import { db } from "../src/db.js";

async function main() {
  await db.connect();

  const r = await db.query(`
    SELECT role, device_name,
           LEFT(message, 70) AS preview,
           created_at
    FROM memory
    WHERE agent_platform = 'codex-mcp-client'
      AND created_at >= NOW() - INTERVAL '2 hours'
    ORDER BY created_at DESC
    LIMIT 30
  `);

  console.log(`\n=== 최근 2시간 Codex 메시지 (${r.rows.length}건) ===`);
  for (const row of r.rows) {
    const dt = new Date(row.created_at).toISOString().slice(11, 19);
    console.log(`[${dt}] ${String(row.role).padEnd(9)} | ${row.preview}`);
  }

  const dist = await db.query(`
    SELECT role, COUNT(*)::int AS cnt
    FROM memory
    WHERE agent_platform = 'codex-mcp-client'
      AND created_at >= NOW() - INTERVAL '2 hours'
    GROUP BY role
    ORDER BY role
  `);
  console.log(`\n--- role 분포 ---`);
  for (const row of dist.rows) {
    console.log(`  ${row.role}: ${row.cnt}건`);
  }

  await db.close();
}

main().catch(console.error);
