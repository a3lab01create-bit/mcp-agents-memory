/** User-level installer regression checks. No real client config or database is read.
 * Build first. All fixture files live under TMPDIR; children inherit only a minimal test environment.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { InstallOptions, InstallClient } from "../src/hook_install.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mam-hook-install-"));
const config = path.join(tmp, "test.env");
fs.writeFileSync(config, "DATABASE_URL=postgres://test:test@127.0.0.1:1/hook_install_test\n");
// Defer db.ts's import-time config discovery until an explicit synthetic config is in place.
process.env.MEMORY_CONFIG_PATH = config;
process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:1/hook_install_test";
process.env.SSH_ENABLED = "false";
const { clientHome, installTarget, detectClients, installClient, mergeHookSettings,
  mergeGrokInstructions, promptHookInstall } = await import("../src/hook_install.js");
const { hookConfigSnippet } = await import("../src/hooks.js");
const entry = path.resolve("build/index.js");
assert.ok(fs.existsSync(entry), "Build first: npm run build");

function fixture(name: string): InstallOptions {
  return { home: path.join(tmp, name), env: { PATH: "" }, entry, configPath: config,
    stateDir: path.join(tmp, name, "state"), node: process.execPath };
}
function put(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}
function files(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : [];
}
function command(doc: any, client: "claude" | "codex" | "agy", event: string): string {
  const entries = client === "agy" ? doc["mcp-agents-memory"][event] : doc.hooks[event];
  return client === "agy" ? entries.at(-1).command : entries.at(-1).hooks[0].command;
}

try {
  // Preserve unrelated client settings, events, matcher groups and handlers.
  for (const client of ["claude", "codex", "agy"] as const) {
    const opts = fixture(client), target = installTarget(client, opts);
    const other = { type: "command", command: "echo another-plugin", timeout: 9 };
    const initial = client === "agy"
      ? { anotherPlugin: { SessionStart: [other] }, "mcp-agents-memory": { Stop: [other], SessionStart: [other] } }
      : { model: "preserve-me", hooks: { Stop: [{ hooks: [other] }], SessionStart: [{ matcher: "resume", custom: 4, hooks: [other] }] } };
    const before = JSON.stringify(initial);
    put(target, before);
    fs.chmodSync(target, 0o640);
    const result = installClient(client, opts);
    assert.equal(result.status, client === "codex" ? "trust-pending" : "configured");
    assert.equal(result.changed, true);
    assert.ok(result.backup?.startsWith(path.join(opts.stateDir!, "hook-backups") + path.sep));
    assert.equal(fs.readFileSync(result.backup!, "utf8"), before, "backup holds exact original bytes");
    assert.equal(fs.statSync(result.backup!).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(result.backup!)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(target).mode & 0o777, 0o640, "retain existing settings permissions");
    const after = fs.readFileSync(target, "utf8"), parsed = JSON.parse(after);
    if (client === "agy") {
      assert.deepEqual(parsed.anotherPlugin, initial.anotherPlugin);
      assert.deepEqual(parsed["mcp-agents-memory"].Stop, [other]);
      assert.deepEqual(parsed["mcp-agents-memory"].SessionStart[0], other);
      assert.equal(parsed["mcp-agents-memory"].PreInvocation[0].type, "command");
      assert.equal(parsed["mcp-agents-memory"].PreInvocation[0].timeout, 10);
      assert.ok(!("hooks" in parsed["mcp-agents-memory"].PreInvocation[0]), "agy uses a flat handler list");
    } else {
      assert.equal(parsed.model, "preserve-me");
      assert.deepEqual(parsed.hooks.Stop, initial.hooks!.Stop);
      assert.deepEqual(parsed.hooks.SessionStart[0], initial.hooks!.SessionStart[0]);
      assert.equal(parsed.hooks.SessionStart.at(-1).hooks[0].timeout, 15);
      assert.equal(parsed.hooks.UserPromptSubmit[0].hooks[0].timeout, 10);
    }
    const promptEvent = client === "agy" ? "PreInvocation" : "UserPromptSubmit";
    assert.ok(command(parsed, client, promptEvent).includes(`hook prompt --client ${client} || true`));
    const previousBackups = files(opts.stateDir!);
    const repeat = installClient(client, opts);
    assert.equal(repeat.changed, false);
    assert.equal(repeat.backup, undefined);
    assert.equal(fs.readFileSync(target, "utf8"), after, "repeat preserves bytes");
    assert.deepEqual(files(opts.stateDir!), previousBackups, "repeat creates no extra backup");

    // Ownership markers allow upgrades even when all executable/config paths change.
    const nextEntry = path.join(tmp, "new entry.js"), nextConfig = path.join(tmp, "next.env");
    put(nextEntry, "// installer fixture\n"); put(nextConfig, "DATABASE_URL=postgres://test:test@127.0.0.1:1/test\n");
    const next = { ...opts, entry: nextEntry, configPath: nextConfig, node: "/new/node" };
    assert.equal(installClient(client, next).changed, true);
    const upgraded = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.ok(command(upgraded, client, promptEvent).includes("'/new/node'"));
    assert.ok(command(upgraded, client, promptEvent).includes(nextConfig));
    const targetEvents = client === "agy" ? upgraded["mcp-agents-memory"] : upgraded.hooks;
    assert.equal(targetEvents.SessionStart.length, 2, "one unrelated and one owned group after upgrade");
    assert.equal(targetEvents[promptEvent].length, 1, "owned hook replaced, not duplicated");
    const compact = JSON.stringify(upgraded);
    fs.writeFileSync(target, compact);
    assert.equal(installClient(client, next).changed, false, "no rewrite just to change indentation");
    assert.equal(fs.readFileSync(target, "utf8"), compact);
    const latest = installClient(client, { ...next, node: "/third/node" });
    assert.ok(latest.backup && fs.existsSync(latest.backup), "most recent backup survives pruning");
    assert.equal(fs.readFileSync(latest.backup!, "utf8"), compact);
    assert.equal(files(path.join(opts.stateDir!, "hook-backups")).filter(name => name.endsWith(".bak")).length, 2,
      "retain only two backups for each target after three updates");
  }

  // Migrate exact 0.9.37 generator output, including shell-quoted apostrophes.
  const quotedOpts = { ...fixture("legacy"), entry: path.join(tmp, "it's a server", "index.js"), configPath: path.join(tmp, "user's config.env") };
  const old = hookConfigSnippet(quotedOpts.entry, quotedOpts.configPath, "/old/node").replaceAll(" --client claude", "");
  const migrated = JSON.parse(mergeHookSettings(old, "claude", quotedOpts));
  assert.equal(migrated.hooks.SessionStart.length, 1);
  assert.equal(migrated.hooks.UserPromptSubmit.length, 1);
  assert.ok(command(migrated, "claude", "SessionStart").includes("--client claude"));
  assert.ok(!command(migrated, "claude", "SessionStart").includes("'/old/node'"));
  // Commands that merely mention the package are not evidence of ownership.
  const lookalike = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo mcp-agents-memory hook session-start" }] }] } };
  const kept = JSON.parse(mergeHookSettings(JSON.stringify(lookalike), "claude", quotedOpts));
  assert.deepEqual(kept.hooks.SessionStart[0], lookalike.hooks.SessionStart[0]);

  // Reject invalid structures without making either a backup or a settings write.
  for (const client of ["claude", "codex", "agy"] as const) {
    const key = client === "agy" ? "mcp-agents-memory" : "hooks";
    const invalid = ["{broken", "[]", "null", JSON.stringify({ [key]: [] }),
      JSON.stringify({ [key]: { SessionStart: {} } }), JSON.stringify({ [key]: { SessionStart: null } }),
      JSON.stringify({ [key]: { SessionStart: [null] } })];
    if (client !== "agy") invalid.push(JSON.stringify({ hooks: { SessionStart: [{ hooks: {} }] } }));
    for (const [i, raw] of invalid.entries()) {
      const opts = fixture(`invalid-${client}-${i}`), target = installTarget(client, opts);
      put(target, raw);
      assert.throws(() => installClient(client, opts), undefined, `${client} rejects ${raw}`);
      assert.equal(fs.readFileSync(target, "utf8"), raw);
      assert.equal(fs.existsSync(opts.stateDir!), false);
    }
    const opts = fixture(`symlink-${client}`), target = installTarget(client, opts), real = path.join(tmp, `symlink-victim-${client}`);
    put(real, "{}"); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.symlinkSync(real, target);
    assert.throws(() => installClient(client, opts), /non-regular|symlink/i);
    assert.equal(fs.readFileSync(real, "utf8"), "{}");
    assert.ok(fs.lstatSync(target).isSymbolicLink());
  }

  const grok = fixture("grok"), grokFile = installTarget("grok", grok);
  const existing = "# Personal rules\nKeep this intact.\n";
  put(grokFile, existing);
  const gr = installClient("grok", grok), grokText = fs.readFileSync(grokFile, "utf8");
  assert.equal(gr.status, "unsupported");
  assert.ok(grokText.startsWith(existing));
  assert.match(grokText, /memory_startup/); assert.match(grokText, /search_memory/);
  assert.equal(mergeGrokInstructions(grokText), grokText);
  assert.equal(installClient("grok", grok).changed, false);
  const begin = "<!-- mcp-agents-memory:begin -->", end = "<!-- mcp-agents-memory:end -->";
  const replaced = mergeGrokInstructions(`prefix\n${begin}\nold\n${end}\nsuffix`);
  assert.ok(replaced.startsWith("prefix\n") && replaced.endsWith("\nsuffix"));
  assert.ok(!replaced.includes("\nold\n"));
  for (const raw of [begin, end, end + begin, begin + begin + end, begin + end + end]) {
    put(grokFile, raw);
    assert.throws(() => installClient("grok", grok), /markers/);
    assert.equal(fs.readFileSync(grokFile, "utf8"), raw);
  }

  const homes = fixture("homes");
  homes.env = { PATH: "", CODEX_HOME: path.join(tmp, "custom-codex"), CLAUDE_CONFIG_DIR: path.join(tmp, "custom-claude") };
  assert.equal(clientHome("codex", homes), homes.env.CODEX_HOME);
  assert.equal(clientHome("claude", homes), homes.env.CLAUDE_CONFIG_DIR);
  assert.equal(clientHome("codex", { ...homes, homes: { codex: path.join(tmp, "override-codex") } }), path.join(tmp, "override-codex"));
  assert.equal(clientHome("agy", homes), path.join(homes.home!, ".gemini", "config"));
  const bin = path.join(tmp, "bin");
  for (const [name, mode] of [["claude", 0o700], ["codex", 0o600], ["agy", 0o700]] as const) {
    put(path.join(bin, name), "#!/bin/sh\nexit 0\n"); fs.chmodSync(path.join(bin, name), mode);
  }
  fs.mkdirSync(path.join(bin, "grok")); // an executable directory is not a CLI
  assert.deepEqual(detectClients({ ...homes, env: { PATH: bin } }), ["claude", "agy"]);

  // Defaults opt out, including setup's detection path; no writes merely from discovery.
  const questions: string[] = [];
  await promptHookInstall(async (question, defaultValue) => { questions.push(question); return defaultValue!; }, () => {}, { ...homes, env: { PATH: bin } });
  assert.equal(questions.length, 2);
  assert.equal(fs.existsSync(homes.home!), false);
  for (const client of ["claude", "codex", "agy", "grok"] as InstallClient[]) {
    const opts = { ...fixture(`dry-${client}`), dryRun: true };
    assert.equal(installClient(client, opts).changed, true);
    assert.equal(fs.existsSync(opts.home!), false, "dry run creates no directories/settings/backups");
  }
  const refused = fixture("refused");
  assert.throws(() => installClient("claude", { ...refused, configPath: null }), /config/i);
  const ephemeral = path.join(tmp, "_npx", "123", "index.js");
  put(ephemeral, "// temporary package fixture\n");
  assert.throws(() => installClient("claude", { ...refused, entry: ephemeral }), /npx/i);
  assert.equal(fs.existsSync(refused.home!), false, "unsafe install target writes nothing");

  // End-to-end dispatch and consent contract. Never inherit production DB/client settings.
  const cliHome = path.join(tmp, "cli-home");
  const cliEnv = { PATH: process.env.PATH ?? "", HOME: cliHome, CODEX_HOME: path.join(cliHome, "codex-custom"), MEMORY_CONFIG_PATH: config, TMPDIR: tmp };
  const run = (args: string[]) => spawnSync(process.execPath, [entry, "hook", "install", ...args], {
    input: "", encoding: "utf8", timeout: 15_000, cwd: tmp, env: cliEnv,
  });
  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /--client/); assert.match(help.stdout, /--yes/);
  for (const args of [[], ["--client", "codex"], ["--yes"], ["--client", "unknown", "--yes"], ["--client"]]) {
    const result = run(args);
    assert.notEqual(result.status, 0, `non-interactive ${JSON.stringify(args)} must fail`);
    assert.equal(fs.existsSync(cliHome), false, "invalid/missing consent writes nothing");
  }
  const preview = run(["--client", "codex", "--dry-run"]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(fs.existsSync(cliHome), false);
  const applied = run(["--client", "codex", "--yes"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).status, "trust-pending");
  assert.ok(fs.existsSync(path.join(cliEnv.CODEX_HOME, "hooks.json")));
  assert.equal(fs.existsSync(path.join(cliHome, ".codex")), false);
  assert.equal(fs.statSync(path.join(cliEnv.CODEX_HOME, "hooks.json")).mode & 0o777, 0o600);

  console.log("hook installer checks passed (isolated filesystem; no DB)");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
