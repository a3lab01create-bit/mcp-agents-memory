import { db } from "../src/db.js";
import { getOrCreateSubject } from "../src/tools.js";

async function run() {
  console.log("Testing getOrCreateSubject...");
  
  // Test 1: Omitted key
  const id1 = await getOrCreateSubject(undefined, 'system');
  console.log("ID for omitted (system_global):", id1);

  // Test 2: New project key
  const id2 = await getOrCreateSubject("project_secret_test", "system");
  console.log("ID for new project (project_secret_test):", id2);

  // Verify in DB
  const res = await db.query("SELECT * FROM subjects WHERE id IN ($1, $2)", [id1, id2]);
  console.log("Subjects in DB:", res.rows);
  
  await db.close();
  process.exit(0);
}

run();
