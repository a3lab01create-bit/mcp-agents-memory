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

export function getPrompt(name: string, fallback: string): string {
  const envDir = process.env.MEMORY_PROMPTS_DIR?.trim();
  const candidates = [
    envDir ? path.join(envDir, `${name}.md`) : null,
    path.join(PKG_ROOT, "prompts.local", `${name}.md`),
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    const body = tryRead(file);
    if (body != null && body.trim()) return body.replace(/\s+$/, "");
  }

  if (process.env.MEMORY_REQUIRE_CORE_PROMPTS) {
    throw new Error(
      `[prompts] required core prompt "${name}" not found (looked in: ${candidates.join(
        ", "
      )}). Provide MEMORY_PROMPTS_DIR or the prompts.local overlay, or unset MEMORY_REQUIRE_CORE_PROMPTS.`
    );
  }
  return fallback;
}
