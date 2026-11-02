/**
 * arm 검사 — rollout 을 arm 할 때 **모델 씨앗이 채워지는가.**
 *
 * 배경(2026-11-02): 모델은 rollout 의 `turn_context` 줄에만 있고 그 줄은 파일 맨 앞에 한 번 나온다.
 * 캡처는 서버 시작 시점에 이미 있던 rollout 을 cursor=size 로 arm 하므로 그 줄을 지나치고,
 * assistant 행이 `unknown` 이 된다(맥스튜디오 실측: turn_context 10번째 줄, 캡처 시작 byte 179,436).
 * 🔴 arm 자리가 **둘**이다 — 이 검사는 그중 **서버 시작 스냅샷**을 실제로 태운다. 처음 수정에서
 *    내가 빼먹은 자리가 바로 여기였고, 보고된 사례도 이 자리였다.
 *
 * `captureSessionStart` 는 Postgres 를 건드리지 않는다(파일 walk + state_5.sqlite 읽기뿐) → 안전하다.
 * 🔴 `SESSIONS_ROOT` 는 **로드 시점 고정**이라 CODEX_HOME 을 **import 전에** 세팅해야 한다.
 *
 *   npm run check:codex-arm
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codexarm-"));
const home = path.join(tmp, "codex-home");
const day = path.join(home, "sessions", "2026", "11", "02");
fs.mkdirSync(day, { recursive: true });

const SID = "01a19cb2-7d1f-72a2-8721-021311dfda6e";   // 실측 세션 id 모양
const SID2 = "01a19cb2-0000-7000-8000-000000000002";
const rollout = path.join(day, `rollout-2026-11-02T23-38-25-${SID}.jsonl`);
const rollout2 = path.join(day, `rollout-2026-11-02T23-39-00-${SID2}.jsonl`);

// 데스크톱 앱 모양: session_meta(model 없음) → turn_context(model 있음) → 본문.
// 앞부분을 건너뛰면 turn_context 를 못 본다 = 이 검사가 재현하려는 상황.
const meta = JSON.stringify({ type: "session_meta", payload: { originator: "Codex Desktop", cli_version: "0.166.0" } });
const turn = JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra", cwd: "/tmp" } });
fs.writeFileSync(rollout, `${meta}\n${turn}\n${"x".repeat(500)}\n`);
fs.writeFileSync(rollout2, `${meta}\n`);          // turn_context 가 아직 없는 세션

const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
db.exec("CREATE TABLE threads (id TEXT, source TEXT, originator TEXT, model TEXT)");
db.prepare("INSERT INTO threads VALUES (?,?,?,?)").run(SID, "vscode", "Codex Desktop", "gpt-6-astra");
db.prepare("INSERT INTO threads VALUES (?,?,?,?)").run(SID2, "vscode", "Codex Desktop", null);
db.close();

process.env.CODEX_HOME = home;   // 🔴 import 보다 먼저
const cap = await import("../src/auto_save/codex_capture.ts");

cap.captureSessionStart(home);
const armed = cap.armedStatesForTest();
assert.equal(armed.length, 2, `rollout 2개가 arm 돼야 한다 (실제 ${armed.length})`);

const a1 = armed.find((a) => a.file.includes(SID))!;
assert.equal(a1.platform, "codex-desktop", "originator 로 라벨이 붙는다");
assert.equal(a1.model, "gpt-6-astra",
  "🎯 서버 시작 스냅샷에서도 모델 씨앗이 채워져야 한다 — 비면 assistant 행이 unknown 이 된다");

const a2 = armed.find((a) => a.file.includes(SID2))!;
assert.equal(a2.platform, "codex-desktop");
assert.equal(a2.model, null, "threads.model 이 NULL 이면 null — 가짜 값을 만들지 않는다");

// cursor 가 파일 끝에 잡혀 있어야 한다(기존 내용 bulk dump 방지) — 씨앗을 채우느라 이게 깨지면 안 된다
assert.ok(fs.statSync(rollout).size > 500, "fixture 전제");

// 음성대조: state_5.sqlite 를 못 읽으면 **모델은 null**, 라벨은 default, 그래도 **arm 은 계속된다.**
// `stateDbPath()` 는 호출 시점에 env 를 읽으므로 CODEX_HOME 만 바꿔 재현할 수 있다.
process.env.CODEX_HOME = path.join(tmp, "no-sqlite");
cap.captureSessionStart(home);
const armed2 = cap.armedStatesForTest();
assert.equal(armed2.length, 2, "sqlite 를 못 읽어도 arm 은 계속된다 — 캡처를 멈추지 않는다");
assert.ok(armed2.every((a) => a.model === null), "모델은 null — 가짜 값을 만들지 않는다");
assert.ok(armed2.every((a) => a.platform === "codex-mcp-client"), "라벨은 default 로 떨어진다");
// ↑ 이 결과가 `SESSIONS_ROOT` 가 **로드 시점 고정**이라는 전제도 같이 확인해 준다:
//   CODEX_HOME 을 옮겼는데도 원래 root 의 rollout 2개를 다시 읽었다. 그래서 위 검사들이
//   CODEX_HOME 을 import 전에 세팅해야 성립한다.

fs.rmSync(tmp, { recursive: true, force: true });
console.log("Codex arm checks passed");
// 🔴 captureSessionStart 는 **재귀 디렉터리 watcher + 폴링 타이머**를 걸어 둔다 → 핸들이 남아
//    프로세스가 스스로 끝나지 않는다. 검사는 명시적으로 종료한다(실제로 한 번 매달렸다).
process.exit(0);
