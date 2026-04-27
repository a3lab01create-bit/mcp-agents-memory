import { processBatch } from "../librarian.js";
import { db } from "../db.js";
async function run() {
    try {
        const scenarios = [
            { name: "① 별칭 매칭", model: "sonnet" },
            { name: "② 정확 매칭", model: "claude-3-opus-20240229" },
            { name: "③ 알 수 없음", model: "made-up-model-xyz" },
            { name: "④ 미입력", model: undefined }
        ];
        for (const s of scenarios) {
            console.log(`\n🚀 Testing: ${s.name} (${s.model || 'none'})`);
            await processBatch(`This is a test fact for ${s.name}.`, 1, // subject_id
            null, // project_id
            "manual_test", { author_model: s.model, platform: "terminal", session_id: "test_session" });
        }
        // 검증 SQL 실행
        console.log("\n📊 Verification SQL Results:");
        const res = await db.query(`
      SELECT f.id, f.content, f.confidence, f.effective_confidence,
             f.author_model AS legacy_text, f.author_model_id,
             m.model_name AS resolved_via_fk
      FROM memories f
      LEFT JOIN models m ON f.author_model_id = m.id
      ORDER BY f.id DESC
      LIMIT 4;
    `);
        console.table(res.rows);
    }
    catch (err) {
        console.error(err);
    }
    finally {
        await db.close();
    }
}
run();
