import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Runtime prompt loader.
 *
 * The public/npm build ships only the GENERIC fallback prompts that callers
 * pass in — those are the ones compiled into the esbuild bundle. The tuned
 * production prompts live OUTSIDE the bundle as plain `.md` files and are read
 * at runtime via `fs`, which esbuild does not follow. So the tuned prompts are
 * never inlined into `build/index.js` and never published to npm.
 *
 * Resolution order for a prompt named "<name>":
 *   1. $MEMORY_PROMPTS_DIR/<name>.md          — explicit private prompt dir
 *   2. <package-root>/prompts.local/<name>.md — gitignored local overlay
 *   3. the generic `fallback` the caller passes — bundled, public
 *
 * If MEMORY_REQUIRE_CORE_PROMPTS is set and no overlay file is found, throw at
 * load time — so production fails loudly instead of silently degrading to the
 * generic prompt. Public users leave it unset and get the generic fallback.
 */

// In the bundle this file is build/index.js (HERE = build/); in source it is
// src/prompts/index.ts (HERE = src/prompts/). Both resolve to the package root.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = HERE.endsWith(path.join("src", "prompts"))
  ? path.resolve(HERE, "..", "..")
  : path.resolve(HERE, "..");

function tryRead(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function promptCandidates(name: string): Array<{ source: "env" | "local"; file: string }> {
  const envDir = process.env.MEMORY_PROMPTS_DIR?.trim();
  const out: Array<{ source: "env" | "local"; file: string }> = [];
  if (envDir) out.push({ source: "env", file: path.join(envDir, `${name}.md`) });
  out.push({ source: "local", file: path.join(PKG_ROOT, "prompts.local", `${name}.md`) });
  return out;
}

function findPrompt(name: string): { source: "env" | "local"; body: string } | null {
  for (const c of promptCandidates(name)) {
    const body = tryRead(c.file);
    if (body != null && body.trim()) return { source: c.source, body: body.replace(/\s+$/, "") };
  }
  return null;
}

/**
 * 이 이름의 안내문이 어디서 오는지 — 운영 작업이 공개용 기본 안내문으로 조용히 돌지 않았는지 보고에 남길 때 쓴다
 * (예: gitignored prompts.local이 없는 작업 폴더에서 돌린 retag-ptag 시험).
 */
export function promptSource(name: string): "env" | "local" | "generic" {
  return findPrompt(name)?.source ?? "generic";
}

export function getPrompt(name: string, fallback: string): string {
  const found = findPrompt(name);
  if (found) return found.body;

  if (process.env.MEMORY_REQUIRE_CORE_PROMPTS) {
    const candidates = promptCandidates(name).map((c) => c.file);
    throw new Error(
      `[prompts] required core prompt "${name}" not found (looked in: ${candidates.join(
        ", "
      )}). Provide MEMORY_PROMPTS_DIR or the prompts.local overlay, or unset MEMORY_REQUIRE_CORE_PROMPTS.`
    );
  }
  return fallback;
}
