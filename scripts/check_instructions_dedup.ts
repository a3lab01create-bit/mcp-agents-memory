/**
 * 시작 브리핑 중복 줄이기(src/hook_presence.ts + index.ts applyHookAwareInstructions) 검사. DB 없이 돈다.
 *
 * 빌드된 서버(build/index.js)를 가짜 HOME 으로 실제로 띄워 initialize 를 보내고 instructions 를 본다.
 * → 먼저 `npm run build`. SDK 를 올렸을 때 initialize 감싸기가 깨지는지 알려 주는 경보 역할도 한다.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeSessionHookInstalled, hookedInstructionsFrom, HOOKED_STARTUP_LINE, isOurClaudeSessionStartCommand } from "../src/hook_presence.js";

const DEFAULT_LINE = "세션 시작 시 `memory_startup`을 한 번 호출해";

// ── 1. 순수 함수 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mam-dedup-"));
const withHook = path.join(tmp, "with"), without = path.join(tmp, "without"), codexOnly = path.join(tmp, "codex");
for (const d of [withHook, without, codexOnly]) fs.mkdirSync(path.join(d, ".claude"), { recursive: true });
const settings = (cmd: string) => JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: cmd, timeout: 15 }] }] } });
fs.writeFileSync(path.join(withHook, ".claude", "settings.json"),
  settings("MEMORY_CONFIG_PATH='/x/.env' '/usr/bin/node' '/x/index.js' hook session-start --client claude || true # mcp-agents-memory:claude:session-start"));
fs.writeFileSync(path.join(without, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
fs.writeFileSync(path.join(codexOnly, ".claude", "settings.json"),
  settings("'/usr/bin/node' '/x/index.js' hook session-start --client codex || true"));

assert.equal(claudeSessionHookInstalled({ home: withHook, env: {} }), true);
assert.equal(claudeSessionHookInstalled({ home: without, env: {} }), false);
assert.equal(claudeSessionHookInstalled({ home: codexOnly, env: {} }), false, "다른 도구용 명령은 아님");
assert.equal(claudeSessionHookInstalled({ home: path.join(tmp, "missing"), env: {} }), false, "파일이 없으면 아님");
assert.equal(claudeSessionHookInstalled({ home: withHook, env: { MEMORY_HOOKS_OFF: "1" } }), false, "꺼짐 스위치면 훅 없음으로 본다");
assert.equal(claudeSessionHookInstalled({ home: without, env: { CLAUDE_CONFIG_DIR: path.join(withHook, ".claude") } }), true,
  "CLAUDE_CONFIG_DIR 존중");
fs.mkdirSync(path.join(tmp, "broken", ".claude"), { recursive: true });
fs.writeFileSync(path.join(tmp, "broken", ".claude", "settings.json"), "{not json");
assert.equal(claudeSessionHookInstalled({ home: path.join(tmp, "broken"), env: {} }), false, "깨진 JSON 이면 아님");

// 코디 리뷰 #44: 우리 훅이 아니거나 새 세션에서 안 도는 경우는 "훅 없음"으로 본다
const OURS = "MEMORY_CONFIG_PATH='/x/.env' '/usr/bin/node' '/x/index.js' hook session-start --client claude || true # mcp-agents-memory:claude:session-start";
const mk = (name: string, doc: unknown, local?: unknown) => {
  const d = path.join(tmp, name, ".claude");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify(doc));
  if (local !== undefined) fs.writeFileSync(path.join(d, "settings.local.json"), JSON.stringify(local));
  return path.join(tmp, name);
};
const group = (cmd: string, extra: Record<string, unknown> = {}) => ({ hooks: { SessionStart: [{ ...extra, hooks: [{ type: "command", command: cmd }] }] } });
assert.equal(claudeSessionHookInstalled({ home: mk("echo", group("echo hook session-start")), env: {} }), false, "남의 명령(echo …)은 아님");
assert.equal(claudeSessionHookInstalled({ home: mk("disabled", { ...group(OURS), disableAllHooks: true }), env: {} }), false, "disableAllHooks 면 아님");
assert.equal(claudeSessionHookInstalled({ home: mk("localdisabled", group(OURS), { disableAllHooks: true }), env: {} }), false,
  "settings.local.json 의 disableAllHooks 도 본다");
assert.equal(claudeSessionHookInstalled({ home: mk("resume", group(OURS, { matcher: "resume" })), env: {} }), false, "resume 전용이면 새 세션에서 안 돎");
assert.equal(claudeSessionHookInstalled({ home: mk("regexm", group(OURS, { matcher: "^(start|resume)" })), env: {} }), false,
  "정규식 matcher 는 확신할 수 없으니 기본 유지");
assert.equal(claudeSessionHookInstalled({ home: mk("startupm", group(OURS, { matcher: "startup|resume" })), env: {} }), true, "startup 이 목록에 있으면 인정");
assert.equal(claudeSessionHookInstalled({ home: mk("star", group(OURS, { matcher: "*" })), env: {} }), true);
assert.equal(claudeSessionHookInstalled({ home: mk("http", { hooks: { SessionStart: [{ hooks: [{ type: "http", command: OURS }] }] } }), env: {} }), false,
  "command 형식이 아니면 아님");
assert.equal(isOurClaudeSessionStartCommand("MEMORY_CONFIG_PATH='/a b/.env' '/n' '/e/index.js' hook session-start || true"), true, "0.9.37 print-config");
assert.equal(isOurClaudeSessionStartCommand("'/n' '/e/index.js' hook session-start --client claude || true"), true, "0.9.38 print-config(설정 경로 없음)");
assert.equal(isOurClaudeSessionStartCommand("'/n' '/e/index.js' hook session-start --client codex || true"), false);
assert.equal(isOurClaudeSessionStartCommand("mcp-agents-memory hook session-start"), false, "손으로 쓴 다른 꼴은 확신 못 함 → 기본");

const sample = "Long-term memory MCP server.\n\n▶ 세션 시작 시 `memory_startup`을 한 번 호출해 최근 대화를 이어받으세요.\n\nTools: …";
const hooked = hookedInstructionsFrom(sample);
assert.ok(hooked && hooked.includes(HOOKED_STARTUP_LINE) && !hooked.includes(DEFAULT_LINE));
assert.equal(hookedInstructionsFrom("시작 줄이 없는 안내문"), null, "문구가 바뀌어 못 찾으면 null → 기본 유지");

// ── 2. 실제 서버 initialize ──
const entry = path.resolve("build/index.js");
assert.ok(fs.existsSync(entry), "build/index.js 가 없다 — 먼저 `npm run build`");
const deadEnv = path.join(tmp, "dead.env");
fs.writeFileSync(deadEnv, "DATABASE_URL=postgres://x:y@127.0.0.1:1/none\n");

async function handshake(home: string, clientName: string, extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [entry], {
    cwd: tmp, stdio: ["pipe", "pipe", "ignore"],
    env: { PATH: process.env.PATH ?? "", HOME: home, MEMORY_CONFIG_PATH: deadEnv, ...extraEnv },
  });
  let buf = "";
  const responses: any[] = [];
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { responses.push(JSON.parse(line)); } catch { /* not json */ }
    }
  });
  const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n");
  const waitFor = async (id: number) => {
    for (let t = 0; t < 200; t++) {
      const r = responses.find((x) => x.id === id);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`no response for id ${id}`);
  };
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "check" } } });
    const init = await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = await waitFor(2);
    return { instructions: String(init.result?.instructions ?? ""), tools: (tools.result?.tools ?? []).map((t: any) => t.name) };
  } finally {
    child.kill("SIGTERM");
  }
}

const a = await handshake(withHook, "claude-code");
assert.ok(a.instructions.includes(HOOKED_STARTUP_LINE), "훅이 있는 클로드 코드 → 조건부 대비책 줄");
assert.ok(!a.instructions.includes(DEFAULT_LINE), "무조건 memory_startup 호출 안내는 빠진다");
assert.ok(!a.instructions.includes("시작 brief를 불러오지 못했습니다"), "브리핑(또는 실패 안내)도 안 붙는다");
assert.ok(a.tools.includes("memory_startup") && a.tools.includes("search_memory"), "initialize 뒤 tools/list 정상");

const b = await handshake(without, "claude-code");
assert.ok(b.instructions.includes(DEFAULT_LINE), "훅 없는 클로드 코드 → 기본 그대로");

const c = await handshake(withHook, "codex-mcp-client");
assert.ok(c.instructions.includes(DEFAULT_LINE), "클로드 코드가 아니면 기본 그대로(코덱스는 신뢰 대기일 수 있음)");

const d = await handshake(withHook, "local-agent-mode-mcp-agents-memory");
assert.ok(d.instructions.includes(DEFAULT_LINE), "데스크톱 앱은 아직 실물 확인 전이라 기본 그대로");

const f = await handshake(path.join(tmp, "echo"), "claude-code");
assert.ok(f.instructions.includes(DEFAULT_LINE), "남의 명령만 있으면 기본 그대로(코디 재현 1)");
const g = await handshake(path.join(tmp, "resume"), "claude-code");
assert.ok(g.instructions.includes(DEFAULT_LINE), "resume 전용 훅이면 기본 그대로(코디 재현 3)");

const e = await handshake(withHook, "claude-code", { MEMORY_HOOKS_OFF: "1" });
assert.ok(e.instructions.includes(DEFAULT_LINE), "꺼짐 스위치면 기본 그대로");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("instructions dedup checks passed");
