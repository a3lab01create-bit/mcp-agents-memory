/**
 * codex 플랫폼 라벨 검사 — `originator` 우선, `source` 폴백.
 *
 * 배경: codex 신버전은 CLI(codex-tui)·buzz-acp·codex-acp 를 전부 `source='vscode'` 로 쓴다.
 *       같은 originator 가 source 두 값으로 나오기도 한다. ⇒ 구분자는 `originator`.
 * 이 검사는 임시 sqlite 를 만들어 **실제 lookupPlatform 을 태운다** (순수 매핑만 보지 않는다).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { lookupPlatform, originatorToPlatform, sourceToPlatform } from "../src/auto_save/codex_capture.js";

// ── 순수 매핑
assert.equal(originatorToPlatform("codex-tui"), "codex-cli");
assert.equal(originatorToPlatform("codex_exec"), "codex-exec");
assert.equal(originatorToPlatform("buzz-acp"), "codex-acp");
assert.equal(originatorToPlatform("@agentclientprotocol/codex-acp"), "codex-acp");
assert.equal(originatorToPlatform(""), null, "빈 값은 폴백으로 넘긴다");
assert.equal(originatorToPlatform("   "), null, "공백만도 폴백");
assert.equal(originatorToPlatform("codex-brandnew-client"), null, "모르는 값은 폴백으로 넘긴다");
// 데스크톱 앱은 표기가 다르다 — `Codex Desktop` (공백·대문자). 2026-10-31 맥스튜디오 실측값
assert.equal(originatorToPlatform("Codex Desktop"), "codex-desktop", "데스크톱 앱 실측 표기");
assert.equal(originatorToPlatform("codex desktop"), "codex-desktop", "대소문자 무시");
assert.equal(originatorToPlatform("CODEX DESKTOP"), "codex-desktop", "대소문자 무시");
assert.equal(originatorToPlatform("Codex Desktop Beta"), null,
  "비슷하지만 다른 값은 억지로 분류하지 않는다 — 폴백으로 넘긴다");
assert.equal(sourceToPlatform("cli"), "codex-cli");
assert.equal(sourceToPlatform("vscode"), "codex-desktop");
assert.equal(sourceToPlatform('{"subagent":"review"}'), "codex-mcp-client",
  "미확인 source 를 desktop 으로 만들지 않는다");

// ── 실제 DB 를 태운다
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codexplat-"));
const mk = (home: string, withOriginator: boolean, rows: Array<[string, string, string | null]>) => {
  fs.mkdirSync(path.join(tmp, home), { recursive: true });
  const db = new DatabaseSync(path.join(tmp, home, "state_5.sqlite"));
  db.exec(withOriginator
    ? "CREATE TABLE threads (id TEXT, source TEXT, originator TEXT)"
    : "CREATE TABLE threads (id TEXT, source TEXT)");
  for (const [id, source, originator] of rows) {
    if (withOriginator) db.prepare("INSERT INTO threads VALUES (?,?,?)").run(id, source, originator);
    else db.prepare("INSERT INTO threads VALUES (?,?)").run(id, source);
  }
  db.close();
  return path.join(tmp, home);
};

// ① originator 칸이 있는 신형 DB
process.env.CODEX_HOME = mk("new", true, [
  ["s-tui-vscode", "vscode", "codex-tui"],
  ["s-tui-cli", "cli", "codex-tui"],
  ["s-exec", "exec", "codex_exec"],
  ["s-acp", "vscode", "buzz-acp"],
  ["s-acp2", "vscode", "@agentclientprotocol/codex-acp"],
  ["s-null-vscode", "vscode", null],
  ["s-null-cli", "cli", null],
  ["s-null-sub", '{"subagent":"review"}', null],
  ["s-unknown-orig", "vscode", "codex-brandnew-client"],
  ["s-desktop", "vscode", "Codex Desktop"],
]);
assert.equal(lookupPlatform("s-tui-vscode"), "codex-cli", "🎯 CLI 가 source=vscode 여도 cli 로 찍힌다");
assert.equal(lookupPlatform("s-tui-cli"), "codex-cli", "source 가 cli 여도 같은 결과");
assert.equal(lookupPlatform("s-exec"), "codex-exec");
assert.equal(lookupPlatform("s-acp"), "codex-acp", "🎯 에이전트 경로가 desktop 으로 안 찍힌다");
assert.equal(lookupPlatform("s-acp2"), "codex-acp");
assert.equal(lookupPlatform("s-null-vscode"), "codex-desktop", "originator 없으면 source 폴백");
assert.equal(lookupPlatform("s-null-cli"), "codex-cli", "originator 없으면 source 폴백");
assert.equal(lookupPlatform("s-null-sub"), "codex-mcp-client", "미확인 source → default (desktop 아님)");
assert.equal(lookupPlatform("s-unknown-orig"), "codex-desktop",
  "모르는 originator 는 source 폴백 — **호환 폴백이고 정확성 보장이 아니다**");
assert.equal(lookupPlatform("s-desktop"), "codex-desktop",
  "🎯 데스크톱은 **originator 로** 판정된다 (source 폴백에 의존하지 않는다)");
assert.equal(lookupPlatform("no-such-id"), "codex-mcp-client", "없는 세션은 default");

// ② originator 칸이 **없는** 구형 DB → source 만 조회해야 한다 (throw 금지)
process.env.CODEX_HOME = mk("old", false, [["o-cli", "cli", null], ["o-vscode", "vscode", null]]);
assert.equal(lookupPlatform("o-cli"), "codex-cli", "구형 스키마에서도 동작");
assert.equal(lookupPlatform("o-vscode"), "codex-desktop");

// ③ DB 가 아예 없을 때 → 캡처를 멈추지 않고 default
process.env.CODEX_HOME = path.join(tmp, "missing");
assert.equal(lookupPlatform("anything"), "codex-mcp-client", "DB 없으면 default, throw 하지 않는다");

// ④ 파일이 sqlite 가 아닐 때 (깨진 DB)
fs.mkdirSync(path.join(tmp, "broken"), { recursive: true });
fs.writeFileSync(path.join(tmp, "broken", "state_5.sqlite"), "not a sqlite file");
process.env.CODEX_HOME = path.join(tmp, "broken");
assert.equal(lookupPlatform("anything"), "codex-mcp-client", "깨진 DB 도 default 로 떨어진다");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("Codex platform label checks passed");
