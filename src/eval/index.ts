/**
 * Skill injection eval harness — entry point.
 *
 * Run via: npm run eval
 *
 * Spec: scratch/v081_eval_harness_spec.md
 */
import "dotenv/config";

import { db } from "../db.js";
import { runAll } from "./runner.js";
import { SCENARIOS } from "./scenarios.js";

async function main(): Promise<void> {
  try {
    const summary = await runAll(SCENARIOS);
    if (summary.failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error("Eval harness crashed:", err);
    process.exit(1);
  } finally {
    await db.close();
  }
}

main();
