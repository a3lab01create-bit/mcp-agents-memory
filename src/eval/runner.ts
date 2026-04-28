/**
 * Skill injection eval harness — scenario runner.
 *
 * Spec: scratch/v081_eval_harness_spec.md
 *
 * Tests `getInjectableSkills` filter behavior under multi-axis applicable_to
 * scopes. NOT a full memory_startup briefing test — wrapping in tools.ts is
 * out of scope for v0.8.1.
 *
 * Cleanup uses `applicable_to.eval_run_id` metadata tag rather than title
 * prefix — the insert helper enforces the tag, so fixtures are impossible
 * to leak into the live skills table even on mid-run crash.
 */
import { db } from "../db.js";
import { generateEmbedding, vectorToSql } from "../embeddings.js";
import { getInjectableSkills, type InjectorContext } from "../skills.js";
import type { SkillApplicability } from "../skill_auditor.js";

export interface SkillFixture {
  id: string;                          // local-only fixture id (mapped to real DB id at run time)
  title: string;
  content: string;
  applicable_to: SkillApplicability;
  status?: 'active' | 'inactive' | 'deprecated';
}

export interface Scenario {
  id: string;
  description: string;
  setup: SkillFixture[];
  call: InjectorContext;
  expect: {
    must_include: string[];
    must_exclude: string[];
  };
}

export interface ScenarioResult {
  id: string;
  description: string;
  passed: boolean;
  errors: string[];
  injectedFixtureIds: string[];
}

const RUN_ID = `eval_${Date.now()}`;

async function insertFixture(fixture: SkillFixture): Promise<number> {
  const tagged = { ...fixture.applicable_to, eval_run_id: RUN_ID };
  const emb = await generateEmbedding(`${fixture.title}\n\n${fixture.content}`);
  const r = await db.query(
    `INSERT INTO skills (title, content, embedding, applicable_to, validation_tier, status)
     VALUES ($1, $2, $3, $4::jsonb, 'unvalidated', $5)
     RETURNING id`,
    [
      fixture.title,
      fixture.content,
      emb ? vectorToSql(emb) : null,
      JSON.stringify(tagged),
      fixture.status ?? 'active',
    ]
  );
  return Number(r.rows[0].id);
}

async function cleanup(): Promise<void> {
  const params = [RUN_ID];
  await db.query(
    `DELETE FROM skill_changelog WHERE skill_id IN (
       SELECT id FROM skills WHERE applicable_to->>'eval_run_id' = $1
     )`,
    params
  );
  await db.query(
    `DELETE FROM skills WHERE applicable_to->>'eval_run_id' = $1`,
    params
  );
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const fixtureToDbId = new Map<string, number>();
  const errors: string[] = [];

  // Insert fixtures
  for (const f of scenario.setup) {
    const dbId = await insertFixture(f);
    fixtureToDbId.set(f.id, dbId);
  }

  // Need a generous limit so the small fixture set isn't crowded out by production rows
  const callLimit = scenario.call.limit ?? Math.max(50, scenario.setup.length + 10);
  const injected = await getInjectableSkills({ ...scenario.call, limit: callLimit });

  const dbToFixture = new Map<number, string>();
  for (const [fid, dbId] of fixtureToDbId.entries()) dbToFixture.set(dbId, fid);
  const injectedFixtureIds = injected
    .map((s) => dbToFixture.get(s.id))
    .filter((x): x is string => Boolean(x));

  for (const required of scenario.expect.must_include) {
    if (!injectedFixtureIds.includes(required)) {
      errors.push(`expected fixture "${required}" in injection output but it was missing`);
    }
  }
  for (const forbidden of scenario.expect.must_exclude) {
    if (injectedFixtureIds.includes(forbidden)) {
      errors.push(`fixture "${forbidden}" should NOT have been injected but was`);
    }
  }

  return {
    id: scenario.id,
    description: scenario.description,
    passed: errors.length === 0,
    errors,
    injectedFixtureIds,
  };
}

export async function runAll(scenarios: Scenario[]): Promise<{
  passed: number;
  failed: number;
  results: ScenarioResult[];
}> {
  console.log(`🧪 Eval harness — run id: ${RUN_ID}`);
  console.log(`📋 ${scenarios.length} scenarios queued.\n`);

  const results: ScenarioResult[] = [];
  let passed = 0;
  let failed = 0;

  try {
    for (const scenario of scenarios) {
      const result = await runScenario(scenario);
      results.push(result);
      if (result.passed) {
        passed++;
        console.log(`✅ ${scenario.id} — ${scenario.description}`);
      } else {
        failed++;
        console.log(`❌ ${scenario.id} — ${scenario.description}`);
        result.errors.forEach((e) => console.log(`     · ${e}`));
        console.log(`     · injected fixture ids: [${result.injectedFixtureIds.join(', ')}]`);
      }
    }
  } finally {
    await cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed (${scenarios.length} total)`);
  return { passed, failed, results };
}
