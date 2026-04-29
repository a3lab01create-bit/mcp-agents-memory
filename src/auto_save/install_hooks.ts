/**
 * install-hooks / uninstall-hooks CLI — RESPEC PROBLEMS.md §4 (B1).
 *
 * ~/.claude/settings.json의 hooks.Stop[]에 우리 entry 자동 등록 / 제거.
 * idempotent: 여러 번 실행해도 entry 1개. magic-string `MARKER`로 우리 entry 식별.
 *
 * Claude Code 한정 — 다른 platform (Gemini CLI, Codex)은 별도 path
 * (save_message tool + instructions, PROBLEMS.md §4 (C) 합의).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
/** entry 식별용 substring — uninstall + idempotent install이 command 안에서 본 substring 검사. */
const COMMAND_SUBSTRING = "mcp-agents-memory";
const SUBCMD = "capture-session";

interface HookEntry {
  type: "command";
  command: string;
  timeout?: number;
}

interface ClaudeSettings {
  hooks?: {
    Stop?: HookEntry[];
    [event: string]: HookEntry[] | undefined;
  };
  [k: string]: unknown;
}

function readSettings(): ClaudeSettings {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as ClaudeSettings;
  } catch (err) {
    throw new Error(
      `~/.claude/settings.json 파싱 실패. 수동 점검 필요: ${err instanceof Error ? err.message : err}`
    );
  }
}

function writeSettings(settings: ClaudeSettings): void {
  const dir = path.dirname(SETTINGS_PATH);
  fs.mkdirSync(dir, { recursive: true });

  // 백업: 기존 파일 있으면 .bak 1회 보존 (덮어쓰기 사고 방지)
  if (fs.existsSync(SETTINGS_PATH)) {
    const backup = `${SETTINGS_PATH}.bak`;
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(SETTINGS_PATH, backup);
    }
  }

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

/** 현재 실행 중인 binary 경로로 hook command 결정 — npm global / npx / local dev 모두 cover.
 *
 * advisor catch: process.argv[1]이 'build/index.js' 같은 relative일 수 있어 양쪽
 * branch 모두 path.resolve()로 절대화. relative 박히면 Stop hook이 다른 cwd에서
 * fire 시 silent no-op (capture-session이 exit 0이라 에러조차 안 보임). */
function resolveHookCommand(): string {
  const argv1 = process.argv[1] ?? "";
  const absArgv1 = argv1 ? path.resolve(argv1) : "";
  if (absArgv1.endsWith("mcp-agents-memory") || absArgv1.endsWith("mcp-agents-memory.js")) {
    // bin shim 경로 (예: /usr/local/bin/mcp-agents-memory) — 직접 실행 가능
    return `${absArgv1} capture-session`;
  }
  // build/index.js / src/index.ts 직접 실행 — node + 절대경로
  return `${process.execPath} ${absArgv1} capture-session`;
}

function isOurEntry(e: any): boolean {
  return typeof e?.command === "string"
    && e.command.includes(COMMAND_SUBSTRING)
    && e.command.includes(SUBCMD);
}

/** dead `memory_add` hook (옛 v0.x 잔재) 검출 — 자동 제거 X, 경고만. */
function detectLegacyHook(settings: ClaudeSettings): string | null {
  const sessionEnd = settings.hooks?.SessionEnd;
  if (!Array.isArray(sessionEnd)) return null;
  for (const group of sessionEnd) {
    const inner = (group as any)?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (h?.type === "mcp_tool" && h?.server === "mcp-agents-memory" && h?.tool === "memory_add") {
        return "SessionEnd → mcp_tool/memory_add (RESPEC v1에서 폐기된 tool)";
      }
    }
  }
  return null;
}

export function installHooks(): void {
  const settings = readSettings();
  settings.hooks ??= {};
  settings.hooks.Stop ??= [];

  const stop = settings.hooks.Stop;
  const existingIdx = stop.findIndex(isOurEntry);

  const command = resolveHookCommand();
  const newEntry: HookEntry = {
    type: "command",
    command,
    timeout: 30,
  };

  if (existingIdx >= 0) {
    stop[existingIdx] = newEntry;
    writeSettings(settings);
    console.log(`✅ Stop hook 갱신: ${command}`);
  } else {
    stop.push(newEntry);
    writeSettings(settings);
    console.log(`✅ Stop hook 등록 완료: ${command}`);
    console.log(`   매 assistant turn 종료 시 capture-session이 호출되어 JSONL delta를 자동 저장합니다.`);
  }
  console.log(`   (${SETTINGS_PATH})`);

  const legacy = detectLegacyHook(settings);
  if (legacy) {
    console.log(``);
    console.log(`⚠️  옛 hook 감지 — 자동 제거 안 함, 별도 정리 권장:`);
    console.log(`     ${legacy}`);
    console.log(`     (수동으로 settings.json 편집 필요)`);
  }

  console.log(``);
  console.log(`   uninstall: mcp-agents-memory uninstall-hooks`);
}

export function uninstallHooks(): void {
  const settings = readSettings();
  const stop = settings.hooks?.Stop;
  if (!stop || stop.length === 0) {
    console.log(`ℹ️  Stop hook 등록된 게 없습니다. (${SETTINGS_PATH})`);
    return;
  }

  const before = stop.length;
  const filtered = stop.filter((e) => !isOurEntry(e));

  if (filtered.length === before) {
    console.log(`ℹ️  mcp-agents-memory hook 못 찾았습니다.`);
    return;
  }

  if (filtered.length === 0) {
    delete settings.hooks!.Stop;
    if (Object.keys(settings.hooks!).length === 0) {
      delete settings.hooks;
    }
  } else {
    settings.hooks!.Stop = filtered;
  }

  writeSettings(settings);
  console.log(`✅ Stop hook 제거 완료. (${before - filtered.length}개)`);
}
