/**
 * Jev (TypeSafe System One) second opinion for existing memory project tags.
 *
 * Jev only selects an existing p_tag candidate or no-match. It never creates a
 * project tag and it never produces free-form d_tags. The feature is opt-in so
 * a missing key or an unavailable TypeSafe API cannot affect normal tagging.
 */

import fs from "fs";

const API_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const TYPESAFE_KEY_PATH = "/home/admin_3alab/.config/typesafe/api_key";
const NO_MATCH_CHOICE = "__no_matching_project__";
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_ATTEMPTS = 2;
const MAX_CONSECUTIVE_FAILURES = 3;

export interface ProjectTagCandidate {
  name: string;
  description: string | null;
}

export interface JevTagInput {
  message: string;
  role: "user" | "assistant";
  agent_platform: string;
  agent_model: string;
  candidates: ProjectTagCandidate[];
}

export interface JevTagJudgment {
  /** An existing candidate name, or null when Jev selected no-match. */
  choice: string | null;
  confidence: number | null;
}

let failureStreak = 0;
let disabledForRun = false;

/**
 * The cold-path daemon has no natural process-level "run" boundary. A worker
 * tick is its bounded batch, so reset the breaker before each tick.
 */
export function beginJevRun(): void {
  failureStreak = 0;
  disabledForRun = false;
}

export function isJevEnabled(): boolean {
  return process.env.JEV_ENABLED === "true";
}

/**
 * A missing or malformed threshold is deliberately fail-closed. This keeps an
 * opt-in Jev request in shadow mode until an evaluated confidence baseline is
 * explicitly configured.
 */
export function shouldApplyJevJudgment(judgment: JevTagJudgment): boolean {
  const configuredThreshold = process.env.JEV_MIN_CONFIDENCE?.trim();
  const minConfidence = configuredThreshold ? Number(configuredThreshold) : Infinity;
  return (
    Number.isFinite(minConfidence)
    && typeof judgment.confidence === "number"
    && Number.isFinite(judgment.confidence)
    && judgment.confidence >= minConfidence
  );
}

/**
 * Read only the TypeSafe key, without loading another application's .env.
 * Environment injection takes priority for managed deployments and tests.
 */
export function loadJevApiKey(): string | null {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  try {
    return fs.readFileSync(TYPESAFE_KEY_PATH, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function buildQuestions(candidates: ProjectTagCandidate[]): Record<string, unknown> {
  const criteria: Record<string, string> = {
    [NO_MATCH_CHOICE]: "Use this only when none of the existing project-tag candidates fits the message.",
  };

  for (const candidate of candidates) {
    criteria[candidate.name] = candidate.description?.trim()
      || `Existing project tag: ${candidate.name}`;
  }

  return {
    p_tag: {
      type: "choice",
      instructions:
        "Choose exactly one existing project tag that best matches this memory message. " +
        "Do not invent, rename, or combine tags. Choose __no_matching_project__ when no candidate fits.",
      criteria,
    },
  };
}

function parseJudgment(payload: unknown, candidates: ProjectTagCandidate[]): JevTagJudgment {
  const answer = (payload as { answers?: Record<string, unknown> })?.answers?.p_tag;
  if (!answer || typeof answer !== "object") {
    throw new Error("Jev response missing p_tag answer");
  }

  const record = answer as Record<string, unknown>;
  const rawChoice = record.choice;
  if (rawChoice === NO_MATCH_CHOICE) {
    return { choice: null, confidence: typeof record.confidence === "number" ? record.confidence : null };
  }
  if (typeof rawChoice !== "string" || !candidates.some((candidate) => candidate.name === rawChoice)) {
    throw new Error("Jev returned a p_tag outside the provided candidates");
  }

  return { choice: rawChoice, confidence: typeof record.confidence === "number" ? record.confidence : null };
}

function retryableStatus(status: number): boolean {
  return [429, 500, 502, 503, 529].includes(status);
}

async function requestJev(input: JevTagInput, key: string): Promise<JevTagJudgment> {
  const body = JSON.stringify({
    state: {
      message: input.message,
      role: input.role,
      agent_platform: input.agent_platform,
      agent_model: input.agent_model,
    },
    model: MODEL,
    questions: buildQuestions(input.candidates),
  });

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt + 1 < REQUEST_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
      }
      continue;
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) {
      return parseJudgment(await response.json(), input.candidates);
    }

    const error = new Error(`Jev request failed with HTTP ${response.status}`);
    if (!retryableStatus(response.status)) {
      throw error;
    }
    lastError = error;
    if (attempt + 1 < REQUEST_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
    }
  }
  throw lastError ?? new Error("Jev request failed");
}

/**
 * Return null whenever Jev is disabled, unavailable, or has failed. Callers
 * must preserve the Qwen result in all of those cases.
 */
export async function judgeProjectTag(input: JevTagInput): Promise<JevTagJudgment | null> {
  if (!isJevEnabled() || disabledForRun) return null;
  const key = loadJevApiKey();
  if (!key) return null;

  try {
    const judgment = await requestJev(input, key);
    failureStreak = 0;
    return judgment;
  } catch (err) {
    failureStreak++;
    if (failureStreak >= MAX_CONSECUTIVE_FAILURES) {
      disabledForRun = true;
      console.warn("⚠️ [Jev] disabled for this cold-path run after 3 consecutive failures");
    } else {
      console.warn(`⚠️ [Jev] unavailable; preserving Qwen tag (${failureStreak}/${MAX_CONSECUTIVE_FAILURES})`);
    }
    return null;
  }
}
