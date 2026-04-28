/**
 * SessionEnd auto-save hook installer.
 *
 * Writes a Claude Code `mcp_tool` hook config to either the project's
 * `.claude/settings.json` (default) or the user-global `~/.claude/settings.json`.
 * The hook fires at session end and routes the transcript through `memory_add`,
 * relying on Phase A's exact-content cosine precheck (similarity ≥ 0.95) to
 * absorb identical re-extractions as access_count signals instead of clutter.
 *
 * Why a wizard and not "paste this snippet": the v3.1 Stop hook silently
 * disappeared from a hand-edited settings.json. advisor's review of Phase B
 * was explicit — automated setup persistence is the actual fix; the hook
 * code is just transport.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";

interface HookEntry {
  matcher: string;
  hooks: Array<{
    type: string;
    server?: string;
    tool?: string;
    input?: Record<string, unknown>;
  }>;
}

function buildHookEntry(opts: { subjectKey: string; projectKey: string | null }): HookEntry {
  const input: Record<string, unknown> = {
    text: "${TRANSCRIPT}",
    subject_key: opts.subjectKey,
    source: "agent",
  };
  if (opts.projectKey) input.project_key = opts.projectKey;

  return {
    matcher: "*",
    hooks: [
      {
        type: "mcp_tool",
        server: "mcp-agents-memory",
        tool: "memory_add",
        input,
      },
    ],
  };
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function isOurHook(entry: any): boolean {
  return (
    Array.isArray(entry?.hooks) &&
    entry.hooks.some(
      (sub: any) =>
        sub?.type === "mcp_tool" &&
        sub?.server === "mcp-agents-memory" &&
        sub?.tool === "memory_add",
    )
  );
}

export async function runSetupHookWizard(): Promise<void> {
  console.log("🪝 mcp-agents-memory — SessionEnd auto-save hook installer\n");

  const cwd = process.cwd();
  const projectName = path.basename(cwd);
  const projectSettingsPath = path.join(cwd, ".claude", "settings.json");
  const userSettingsPath = path.join(os.homedir(), ".claude", "settings.json");

  console.log(`Detected cwd: ${cwd}`);
  console.log(`Default project_key: ${projectName}\n`);

  console.log("Install scope:");
  console.log(`  1) Project-only — ${projectSettingsPath}`);
  console.log(`  2) User-global  — ${userSettingsPath}`);
  console.log(`     (project-only locks project_key to "${projectName}";`);
  console.log(`      user-global leaves project_key blank and applies to every Claude Code session)\n`);

  const scopeAns = (await ask("Choose [1/2] (default 1): ")) || "1";
  const useUserGlobal = scopeAns === "2";
  const targetPath = useUserGlobal ? userSettingsPath : projectSettingsPath;

  const subjectAns = await ask("subject_key [Hoon]: ");
  const subjectKey = subjectAns || "Hoon";

  let projectKey: string | null = null;
  if (!useUserGlobal) {
    const projectAns = await ask(`project_key [${projectName}]: `);
    projectKey = projectAns || projectName;
  }

  const newEntry = buildHookEntry({ subjectKey, projectKey });

  // Load existing settings (preserve everything else — model, plugins, permissions, etc.)
  let existing: any = {};
  if (fs.existsSync(targetPath)) {
    try {
      const raw = fs.readFileSync(targetPath, "utf-8");
      existing = JSON.parse(raw);
    } catch (err) {
      console.error(`\n❌ Could not parse existing ${targetPath}:`);
      console.error(`   ${(err as Error).message}`);
      console.error(`   Aborting to avoid clobbering valid settings. Fix the JSON and re-run.`);
      process.exit(1);
    }
  }

  if (!existing.hooks) existing.hooks = {};
  if (!Array.isArray(existing.hooks.SessionEnd)) existing.hooks.SessionEnd = [];

  // Find existing mcp-agents-memory SessionEnd hook and replace; otherwise append.
  const existingIdx = existing.hooks.SessionEnd.findIndex(isOurHook);
  let action: "appending" | "replacing";
  if (existingIdx >= 0) {
    existing.hooks.SessionEnd[existingIdx] = newEntry;
    action = "replacing";
  } else {
    existing.hooks.SessionEnd.push(newEntry);
    action = "appending";
  }

  console.log(`\nAction: ${action} mcp-agents-memory SessionEnd hook in ${targetPath}\n`);
  console.log("New hook entry:");
  console.log(JSON.stringify(newEntry, null, 2));

  console.log("\nNote: ${TRANSCRIPT} is substituted by Claude Code at hook fire time.");
  console.log("      memory_add → Librarian → Phase A dedup → memories.\n");

  const confirm = await ask("Write to settings? [y/N]: ");
  if (confirm.toLowerCase() !== "y") {
    console.log("Cancelled. No changes written.");
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(existing, null, 2));
  console.log(`\n✅ Wrote ${targetPath}`);
  console.log("\nNext steps:");
  console.log("  1. Restart your Claude Code session (close and reopen).");
  console.log("  2. End the session normally; the hook fires and auto-saves transcript.");
  console.log("  3. Check the pool: `mcp-agents-memory` MCP tool memory_status — count should grow.");
  console.log("\nTo uninstall: re-run setup-hook and decline write, or remove the entry manually.");
}
