import { processBatch } from "../librarian.js";
import { db } from "../db.js";
async function run() {
    const subjectKey = "user_test_v3";
    try {
        // 0. Cleanup
        await db.query("DELETE FROM subjects WHERE subject_key = $1", [subjectKey]);
        // 1. Create Subject
        const subRes = await db.query("INSERT INTO subjects (subject_key, subject_type, display_name) VALUES ($1, 'person', $1) RETURNING id", [subjectKey]);
        const sid = subRes.rows[0].id;
        console.log(`\n🚀 Step 1: Adding '서울에 살고 있어' (Subject ID: ${sid})`);
        const res1 = await processBatch("내가 살고 있는 도시는 서울이야.", sid, null, "manual_test", { author_model: "sonnet" });
        console.log("Result 1:", JSON.stringify(res1.facts));
        console.log("\n🚀 Step 2: Adding '부산으로 이사 갔어' (Contradiction!)");
        const res2 = await processBatch("이제 부산으로 이사 갔어. 부산에 살고 있어.", sid, null, "manual_test", { author_model: "sonnet" });
        console.log("Result 2:", JSON.stringify(res2.facts));
        console.log(`👉 Contradictions Resolved: ${res2.contradictions_resolved}`);
        // 2. Verification SQL
        console.log("\n📊 Verification SQL Results:");
        const sqlRes = await db.query(`
      SELECT id, content, is_active, fact_type
      FROM memories
      WHERE subject_id = $1
      ORDER BY id ASC
    `, [sid]);
        console.table(sqlRes.rows);
    }
    catch (err) {
        console.error(err);
    }
    finally {
        await db.close();
    }
}
run();
