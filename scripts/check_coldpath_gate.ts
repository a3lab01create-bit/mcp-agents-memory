/**
 * 콜드패스 게이트 검사 — **명시적으로 켠 기기에서만 돈다(opt-in)**.
 *
 * 이 검사가 있는 이유: 전에는 `=== 'false'` 비교라서 **키가 없으면 돌았다**. 메모리 DB 는 한 대에만
 * 있고 advisory lock 을 여러 기기가 공유하므로, 기본값이 '켜짐'이면 GPU 없는 기기가 락을 잡아
 * 태깅을 멈출 수 있다. 되돌아가면 조용히 깨지는 자리라 값 하나하나를 못으로 박아 둔다.
 *
 *   npm run check:coldpath-gate
 */
import assert from "node:assert/strict";
import { coldPathEnabled } from "../src/cold_path/worker.ts";

let fails = 0;
function ck(input: string | undefined, want: boolean, why: string) {
  const got = coldPathEnabled(input);
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${JSON.stringify(input)} → ${got} (기대 ${want})  ${why}`);
}

// 켜지는 값 — 켜야 하는 그 한 대에서 조용히 꺼지면 태깅이 멈춘다
ck("true", true, "표준 표기");
ck("TRUE", true, "대문자도 켠다 — 오타로 조용히 꺼지는 쪽이 더 위험하다");
ck(" true ", true, "앞뒤 공백 흡수");
ck("True", true, "섞인 대소문자");

// 꺼지는 값 — 여기 하나라도 true 가 되면 GPU 없는 기기가 락을 잡는다
ck(undefined, false, "🔴 키가 없으면 꺼짐 (옛 동작은 '켜짐' 이었다)");
ck("", false, "빈 값");
ck("false", false, "명시적 false");
ck("FALSE", false, "대문자 false");
ck("0", false, "0 은 켜지 않는다");
ck("1", false, "1 도 켜지 않는다 — 'true' 하나만 켠다");
ck("yes", false, "yes 도 아니다");
ck("truthy", false, "부분 일치 금지");
ck("true false", false, "두 값이 섞이면 켜지 않는다");

// 전용 데몬 경로의 전제: index.ts 가 "true" 를 넣고 부른다 → 그 값이 켜져야 한다
assert.equal(coldPathEnabled("true"), true, "전용 데몬이 넣는 값이 켜지지 않으면 태깅이 멈춘다");

console.log(fails === 0 ? "\nall checks passed" : `\nFAIL: ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
