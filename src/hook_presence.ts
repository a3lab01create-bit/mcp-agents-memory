/**
 * 시작 브리핑이 두 번(세 번) 들어가는 것 줄이기.
 *
 * 0.9.37~ 클로드 코드 SessionStart 훅이 브리핑 전문을 넣는데, MCP instructions 도 압축 브리핑과
 * "세션 시작 시 memory_startup 을 호출하라"를 같이 보내서 겹쳤다(맥스튜디오 클로드 세션이 짚음).
 *
 * 원칙 (실패해도 브리핑을 잃지 않게):
 * - 줄이는 건 clientInfo 가 정확히 "claude-code" 이고, 그 사용자 설정에 우리 SessionStart 훅이 있을 때만.
 *   코덱스는 설치 직후 신뢰 대기가 보통이라(훅이 안 돎) 줄이면 브리핑이 아예 없어질 수 있고,
 *   데스크톱 앱·agy 는 아직 실물 확인이 없어서 건드리지 않는다.
 * - 줄인 안내에도 "시작 브리핑 글이 안 보이면 memory_startup 을 한 번" 이라는 조건부 대비책을 남긴다
 *   (--settings / 프로젝트 훅 / SDK 세션처럼 파일 검사로 못 보는 경우).
 * - 판단·치환이 하나라도 어긋나면 기본 instructions 그대로.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** ~/.claude/settings.json(CLAUDE_CONFIG_DIR 존중)의 SessionStart 에 우리 claude 훅이 있나. */
export function claudeSessionHookInstalled(
  opts: { home?: string; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const env = opts.env ?? process.env;
  if (env.MEMORY_HOOKS_OFF === "1") return false;
  const dir = env.CLAUDE_CONFIG_DIR || path.join(opts.home ?? os.homedir(), ".claude");
  let doc: any;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  } catch {
    return false;
  }
  const groups = doc?.hooks?.SessionStart;
  if (!Array.isArray(groups)) return false;
  for (const group of groups) {
    const handlers = Array.isArray(group?.hooks) ? group.hooks : [];
    for (const h of handlers) {
      const cmd = typeof h?.command === "string" ? h.command : "";
      // 0.9.37 print-config(--client 없음)과 0.9.38 설치기(--client claude) 둘 다. 다른 도구용은 제외.
      if (/\bhook session-start\b/.test(cmd) && !/--client (codex|agy)\b/.test(cmd)) return true;
    }
  }
  return false;
}

const STARTUP_LINE_RE = /^▶ 세션 시작 시 `memory_startup`을 한 번 호출해[^\n]*$/m;

export const HOOKED_STARTUP_LINE =
  "▶ 시작 브리핑은 SessionStart 훅이 대화 맨 앞에 넣는다(\"mcp-agents-memory 시작 브리핑\"으로 시작하는 글). " +
  "그 글이 보이지 않을 때만 `memory_startup`을 한 번 호출하세요.";

/**
 * 기본 안내문(브리핑 없는 static 부분) → 훅용 안내문. 시작 줄을 조건부 대비책으로 바꾸고 브리핑은 붙이지 않는다.
 * 시작 줄을 못 찾으면(문구가 바뀌었으면) null — 호출부는 기본 instructions 를 그대로 쓴다.
 */
export function hookedInstructionsFrom(staticText: string): string | null {
  if (!STARTUP_LINE_RE.test(staticText)) return null;
  return staticText.replace(STARTUP_LINE_RE, HOOKED_STARTUP_LINE);
}
