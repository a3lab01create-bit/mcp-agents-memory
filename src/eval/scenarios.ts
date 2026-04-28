/**
 * Initial multi-axis scenarios.
 *
 * Spec: scratch/v081_eval_harness_spec.md (§"Initial scenarios").
 *
 * Single-axis filter behavior is already covered by scratch/test_v08_project_scoping.ts;
 * the harness focuses on intersections — what happens when projects + models + platforms
 * are all set on the same skill and the call partially matches.
 */
import type { Scenario } from "./runner.js";

const PROJ_A = "eval_proj_a";
const PROJ_B = "eval_proj_b";
const PROJ_C = "eval_proj_c";
const MODEL = "claude-opus-4-7";
const PLATFORM = "claude-code";

export const SCENARIOS: Scenario[] = [
  {
    id: "all_axes_match",
    description: "skill scoped to (projects+models+platforms) — all three axes match",
    setup: [{
      id: "f1",
      title: "all_axes_match probe",
      content: "Probe content for all-axes-match scenario.",
      applicable_to: { projects: [PROJ_A], models: [MODEL], platforms: [PLATFORM] },
    }],
    call: { project_key: PROJ_A, author_model: MODEL, platform: PLATFORM },
    expect: { must_include: ["f1"], must_exclude: [] },
  },
  {
    id: "all_axes_set_one_mismatched",
    description: "skill scoped to all three axes; one mismatched (platform) → exclusion via intersection",
    setup: [{
      id: "f1",
      title: "all_axes_set_one_mismatched probe",
      content: "Probe content where platform mismatch should break intersection.",
      applicable_to: { projects: [PROJ_A], models: [MODEL], platforms: [PLATFORM] },
    }],
    call: { project_key: PROJ_A, author_model: MODEL, platform: "cursor" },
    expect: { must_include: [], must_exclude: ["f1"] },
  },
  {
    id: "null_args_pass_through",
    description: "skill scoped to all axes; call sets only project_key (model/platform NULL) → match (NULL = no filter on those axes)",
    setup: [{
      id: "f1",
      title: "null_args_pass_through probe",
      content: "Probe content. NULL args are no-filter, not exclusion.",
      applicable_to: { projects: [PROJ_A], models: [MODEL], platforms: [PLATFORM] },
    }],
    call: { project_key: PROJ_A },
    expect: { must_include: ["f1"], must_exclude: [] },
  },
  {
    id: "multi_project_union_match",
    description: "skill applicable_to.projects=[A,B] (post-accumulate union); call(project_key=B) → match",
    setup: [{
      id: "f1",
      title: "multi_project_union_match probe",
      content: "Probe content for union semantics validation.",
      applicable_to: { projects: [PROJ_A, PROJ_B] },
    }],
    call: { project_key: PROJ_B },
    expect: { must_include: ["f1"], must_exclude: [] },
  },
  {
    id: "multi_project_union_miss",
    description: "skill applicable_to.projects=[A,B]; call(project_key=C) → exclusion",
    setup: [{
      id: "f1",
      title: "multi_project_union_miss probe",
      content: "Probe content. Project C not in union → exclude.",
      applicable_to: { projects: [PROJ_A, PROJ_B] },
    }],
    call: { project_key: PROJ_C },
    expect: { must_include: [], must_exclude: ["f1"] },
  },
  {
    id: "inactive_blocks_match",
    description: "skill scoped to project A but status=inactive; call(project_key=A) → exclusion (status filter wins)",
    setup: [{
      id: "f1",
      title: "inactive_blocks_match probe",
      content: "Probe content. Status=inactive must override matching applicable_to.",
      applicable_to: { projects: [PROJ_A] },
      status: "inactive",
    }],
    call: { project_key: PROJ_A },
    expect: { must_include: [], must_exclude: ["f1"] },
  },
];
