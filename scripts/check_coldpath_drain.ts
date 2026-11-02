/**
 * 종료 드레인 검사 — **콜드패스 주인만** 드레인한다.
 *
 * 배경(2026-11-03): `drainColdPath()` 는 MCP 서버 **종료 때마다** 불리는데 advisory lock 도
 * `COLD_PATH_ENABLED` 도 보지 않았다. 그래서 형이 맥스튜디오에서 codex 를 끄자 **그 기기가** 밀린 행을
 * 집어 태깅을 시도했고(몰타르에서 캡처된 행 포함), llama-server 가 없어 local 실패 → grok 폴백 →
 * `XAI_API_KEY` 없음 → `cold_error = "tag: XAI_API_KEY missing"` 가 찍혔다.
 * 🔴 그 기기 `.env` 엔 `COLD_PATH_ENABLED=false` 가 **이미** 있었다 — opt-in 게이트(0.9.32)로는 안 막힌다.
 * 🔴 `lockClient` 로 판정하면 안 된다: 종료 순서가 락 해제 → 드레인이라 **전용 데몬도 그 시점엔 null** 이다.
 *    그래서 "한 번 잡았으면 유지"되는 소유권 플래그로 판정한다.
 *
 * 판별 방법(결정적): **닿지 않는 DB** 를 설정해 두고 부른다.
 *   게이트 있음 → `0` 을 돌려주고 **DB 를 건드리지 않는다**
 *   게이트 없음 → `connect ECONNREFUSED …` 로 **throw** (실측으로 확인한 음성대조)
 *
 *   npm run check:coldpath-drain
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "colddrain-"));
const envFile = path.join(tmp, ".env");
// DB_HOST 가 있어야 loadEnv 가 이 파일을 채택한다. 포트는 아무도 듣지 않는 자리.
fs.writeFileSync(
  envFile,
  ["DB_HOST=127.0.0.1", "DB_PORT=59999", "DB_USER=nobody", "DB_PASS=nothing", "DB_NAME=nodb",
   "COLD_PATH_ENABLED=false"].join("\n") + "\n",
);
process.env.MEMORY_CONFIG_PATH = envFile;   // 🔴 import 보다 먼저 (db.ts 가 로드 시점에 읽는다)

const w = await import("../src/cold_path/worker.ts");

assert.equal(w.ownsColdPath(), false, "새 프로세스는 콜드패스 주인이 아니다");

let threw: string | null = null;
let n = -1;
try {
  n = await w.drainColdPath();
} catch (err) {
  threw = (err as Error).message.slice(0, 60);
}
assert.equal(threw, null,
  `🎯 주인이 아니면 드레인은 DB 를 건드리지 않는다 — 게이트가 없으면 여기서 throw 한다 (관측: ${threw})`);
assert.equal(n, 0, "주인이 아니면 0 행");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ColdPath drain ownership checks passed");
// db 모듈이 pool 핸들을 잡을 수 있어 명시 종료한다
process.exit(0);
