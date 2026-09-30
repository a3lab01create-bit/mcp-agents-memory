/**
 * venue — 대화가 오간 자리 (migration 029 참고).
 *
 * 세션형 transcript(Claude Code 등)는 세션의 첫 user 턴으로 자리를 가른다:
 *   버즈 봉투         → "buzz"     (행마다 턴의 채널로 buzz:<채널>/buzz:dm)
 *   대화형 클라이언트 → "terminal" (사람과 1:1)
 *   슬랙 표식         → "slack"    (채널은 일부러 안 적음 — 버즈로 대체 예정)
 *   그 밖의 실행      → "auto"
 */
import fs from "fs";
import { looksLikeBuzzTurn, venueFromBuzzMessage } from "./buzz_envelope.js";

export type SessionVenueKind = "buzz" | "terminal" | "slack" | "auto";

/** 사람이 직접 대화하는 클라이언트의 entrypoint. */
const INTERACTIVE_ENTRYPOINTS = new Set(["cli", "claude-vscode"]);

export function classifySessionVenue(firstUserText: string, entrypoint?: string): SessionVenueKind | null {
  if (buzzTurnVenue(firstUserText)) return "buzz";
  if (entrypoint && INTERACTIVE_ENTRYPOINTS.has(entrypoint)) return "terminal";
  if (/\bslack\b/i.test(firstUserText.slice(0, 500))) return "slack";
  if (entrypoint) return "auto";
  return null;
}

/**
 * 버즈용: 한 user 턴의 venue. 버즈 턴이 아니면 null.
 * 봉투처럼 생겼는데 채널을 못 읽으면(형식 변화 등) 앞 턴 채널을 물려받지 않고 "buzz".
 */
export function buzzTurnVenue(message: string): string | null {
  return venueFromBuzzMessage(message) ?? (looksLikeBuzzTurn(message) ? "buzz" : null);
}

const TAIL_CHUNK = 4 * 1024 * 1024;
const TAIL_CAP = 64 * 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * 버즈용: 파일의 [0, uptoBytes) 안에서 가장 마지막 버즈 턴(user)의 venue.
 * 재시작 직후처럼 "직전 턴의 채널"을 아직 모를 때 한 번 쓴다. 뒤에서부터 4MB씩
 * 거꾸로 읽고(최대 64MB), 청크 경계의 잘린 줄은 바이트째 다음 청크에 이어 붙인다.
 */
export function lastBuzzVenueInFile(
  jsonlPath: string,
  uptoBytes: number,
  userText: (line: string) => string | null
): string | null {
  const fd = fs.openSync(jsonlPath, "r");
  try {
    let end = uptoBytes;
    let carry = Buffer.alloc(0); // 뒤 청크 맨 앞의 잘린 줄 조각
    while (end > 0 && uptoBytes - end < TAIL_CAP) {
      const start = Math.max(0, end - TAIL_CHUNK);
      const chunk = Buffer.allocUnsafe(end - start);
      fs.readSync(fd, chunk, 0, chunk.length, start);
      const buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      // 맨 앞 줄은 더 앞 청크에서 시작했을 수 있다 → 다음 청크로 넘긴다
      const firstNl = start > 0 ? buf.indexOf(NEWLINE) : -1;
      carry = firstNl >= 0 ? buf.subarray(0, firstNl) : start > 0 ? buf : Buffer.alloc(0);
      const whole = firstNl >= 0 ? buf.subarray(firstNl + 1) : start > 0 ? Buffer.alloc(0) : buf;
      const lines = whole.toString("utf-8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const text = lines[i] ? userText(lines[i]) : null;
        const venue = text ? buzzTurnVenue(text) : null;
        if (venue) return venue;
      }
      end = start;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
