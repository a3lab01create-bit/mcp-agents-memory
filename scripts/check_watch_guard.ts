/**
 * 감시 오류 처리(watch_guard.ts) 검사 — DB 없이 돈다. → 먼저 `npm run build`.
 *
 * 1) guardWatcher: 'error' 를 받아도 throw 하지 않고 감시기를 닫는다. 음성대조: 리스너가 없으면 throw.
 * 2) 실제 서버: 빌드된 서버를 띄워 그록·코덱스·안티그래비티 재귀 감시가 붙은 뒤, 감시 폴더 아래에
 *    읽을 수 없는 폴더를 만든다 → 재귀 감시가 그 폴더를 붙이다 EACCES 'error'. 서버가 살아 있어야 한다.
 *    (2026-11-21 몰타르는 같은 경로로 ENOSPC 를 맞아 메모리 서버가 전부 죽었다. ENOSPC 는 한도를 채워야
 *    해서 여기선 EACCES 로 같은 'error' 경로를 탄다. root 면 권한 검사가 안 되므로 건너뛴다.)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { guardWatcher } from "../src/auto_save/watch_guard.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mam-watchguard-"));

// ── 1. guardWatcher ──
{
  const d = path.join(tmp, "unit");
  fs.mkdirSync(d);
  let closed = 0;
  const w = guardWatcher(fs.watch(d, () => {}), "Unit", () => { closed++; });
  const err = Object.assign(new Error("ENOSPC: System limit for number of file watchers reached"), { code: "ENOSPC" });
  assert.doesNotThrow(() => w.emit("error", err), "리스너가 있으면 throw 하지 않는다");
  assert.equal(closed, 1, "닫힘 알림");
  assert.doesNotThrow(() => w.emit("error", err), "두 번째 오류도 조용히");
  const bare = fs.watch(d, () => {});
  assert.throws(() => bare.emit("error", err), /ENOSPC/, "음성대조: 리스너가 없으면 Node 가 throw 한다(= 서버가 죽는다)");
  bare.close();
}

// ── 2. 실제 서버 ──
const entry = path.resolve("build/index.js");
assert.ok(fs.existsSync(entry), "build/index.js 가 없다 — 먼저 `npm run build`");
if (process.getuid?.() === 0) {
  console.log("(root 로 돌아서 실제 서버 EACCES 검사는 건너뜀)");
} else {
  const home = path.join(tmp, "home");
  const roots = {
    Grok: path.join(home, ".grok", "sessions"),
    Codex: path.join(home, ".codex", "sessions"),
    Antigravity: path.join(home, ".gemini", "antigravity-cli", "brain"),
  };
  for (const r of Object.values(roots)) fs.mkdirSync(r, { recursive: true });
  const deadEnv = path.join(tmp, "dead.env");
  fs.writeFileSync(deadEnv, "DATABASE_URL=postgres://x:y@127.0.0.1:1/none\n");
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"], cwd: tmp,
    env: { PATH: process.env.PATH ?? "", HOME: home, MEMORY_CONFIG_PATH: deadEnv },
  });
  let stderr = "";
  child.stderr.on("data", (b) => { stderr += b.toString(); });
  child.stdout.on("data", () => {});
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const armed = (label: string) => new RegExp(`\\[${label}\\] dir watcher(s)? armed`).test(stderr);
  for (let i = 0; i < 50 && !(armed("Grok") && armed("Codex") && armed("Antigravity")); i++) await sleep(100);
  assert.ok(armed("Grok") && armed("Codex") && armed("Antigravity"), `세 재귀 감시가 붙어야 한다 (stderr 끝: ${stderr.slice(-600)})`);

  const locked: string[] = [];
  for (const r of Object.values(roots)) {
    const p = path.join(r, "locked-new-session");
    fs.mkdirSync(p);
    fs.chmodSync(p, 0o000);
    locked.push(p);
  }
  await sleep(2500);
  const alive = child.exitCode === null && child.signalCode === null;
  for (const p of locked) fs.chmodSync(p, 0o700);
  if (alive) {
    const exited = new Promise((r) => child.once("exit", r));
    child.stdin.end();
    child.kill("SIGTERM");
    await exited;
  }
  assert.ok(alive, `감시 오류로 서버가 죽으면 안 된다 (stderr 끝: ${stderr.slice(-800)})`);
  for (const label of Object.keys(roots)) {
    assert.ok(new RegExp(`\\[${label}\\] fs\\.watch error \\(EACCES\\)`).test(stderr),
      `${label}: 오류를 받아 감시기를 닫았다는 줄이 있어야 한다 (stderr 끝: ${stderr.slice(-800)})`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("watch guard checks passed");
