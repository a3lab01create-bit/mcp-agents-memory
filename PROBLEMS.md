# PROBLEMS — RESPEC v1 운영 이슈 (4-29~)

> RESPEC v1 fresh impl 후 form 직접 사용해보면서 catch한 항목들.
> 솔루션 단정 X. 증상 + 원인 후보 + 시도 결과 + 조심할 패턴.

---

## 1. 시작 시 메모리 자동주입 (form vision missing)

### 증상
- Gemini CLI 새 세션 시작 → 빈 컨텍스트로 시작
- 형 정체성 (Isaac CEO / frontend hobbyist / 쿠름 호칭 등)이 user 테이블에 박혀 있어도 자동 주입 안 됨
- 최근 2-3일 raw 메모리도 자동 로드 안 됨
- 에이전트가 직접 `search_memory({ include_archived: true })` 호출해야 가져올 수 있음

### 원인
- RESPEC v1 fresh impl에서 옛 `memory_startup` MCP tool 폐기됨 (Phase A에서 wrong-axis 코드로 분류)
- 새 시퀀스 다이어그램에 **첫 접속 자동 brief 로드** 흐름 없음
- 현재 흐름: caller (Gemini/Claude/Codex)가 첫 turn에 명시적으로 `search_memory` 호출하도록 instructions에만 의존

### form vision (4-29 명시)
- 단기 메모리 = 최근 2-3일 (또는 8000 토큰 limit) raw 자동 로드
- user 테이블의 `core_profile` / `sub_profile` 자동 주입
- 활성 p_tag 통계 등 brief에 포함

### 시도 결과
- 미진행. 새 entry point 설계 단계.

### 후보 옵션
| 옵션 | 장단 |
|---|---|
| (a) 새 MCP tool `memory_startup` (3번째 tool) | caller가 첫 turn에 명시 호출. instructions에 "MUST call first" 명시. RESPEC tool 2개 원칙엔 위배지만 entry point 1개라 수용 가능 |
| (b) MCP `instructions` 필드에 동적 주입 | server connect 시 brief 작성해서 instructions 에 포함. caller가 system prompt로 자동 받음. 단 connect 1회 시점이라 update 어려움 |
| (c) MCP `Prompts` endpoint (`/briefing` slash) | 사용자가 수동 호출. 자동 X |

### 조심
- "session 시작 시 자동 brief"는 SPEC.md §3.4 Memory Tier vision에 있던 것이 RESPEC.md로 명시 이동 안 됨. RESPEC §메모리 로드 룰 절은 query/필터 룰만 정의. **자동 주입 흐름은 RESPEC에 누락된 vision**. 이번 라운드에서 RESPEC.md 보완 필요.

---

## 2. agent_platform / agent_model / subagent 식별 — 자동 캡처 미완

### 증상
- Gemini CLI에서 `manage_knowledge` 호출 → 저장된 row의 `agent_platform='claude-code'`, `agent_model='opus-4-7'`로 잘못 박힘
- 실제 호출자는 Gemini CLI인데 attribution이 잘못됨
- subagent 컬럼은 default `false`로만 박힘 (실제 subagent context 식별 불가)

### 원인
- `.env`에 `AGENT_PLATFORM=claude-code` / `AGENT_MODEL=opus-4-7` 하드코딩
- 서버 코드 (`tools/manage_knowledge.ts`): `args.agent_platform ?? process.env.AGENT_PLATFORM ?? 'unknown'` → caller가 args 안 넘기면 env 폴백 → 어떤 caller가 호출하든 .env 값으로 박힘
- caller가 args 명시 안 한 게 1차 원인이지만, 서버가 `.env` 폴백을 default로 두는 것이 구조적 문제

### MCP 프로토콜 한계
- `clientInfo: {name, version}` 자동 교환 → `agent_platform` 자동 캡처 가능 (claude-code / gemini-cli / codex)
- `model` 정보는 clientInfo에 **없음** → caller가 args로 명시 필요
- `subagent` 컨텍스트는 MCP가 모름 → caller convention 필요

### 후보 fix
- (a) **MCP clientInfo 자동 감지** — server가 connect 시 client name 캡처 → `agent_platform` default. caller가 args.agent_platform로 override 가능.
- (b) **`agent_model` args 필수화** — 명시 안 하면 'unknown' 저장 (env 폴백 폐기)
- (c) **caller convention 정의** — claude-code main: `agent_model='opus-4-7'`. claude-code Task subagent: `subagent=true, subagent_model=...` 등 명시.
- (d) `.env`의 `AGENT_PLATFORM` / `AGENT_MODEL` 폐기 (USER_NAME만 keep)

### 조심
- subagent 자동 감지 불가능 — caller가 책임. claude-code의 Task tool 사용 시 sub-context에서 어떻게 자동 명시될지 별도 설계 필요.

---

## 3. Cold Path tagger 비용 폭증 (4-29 drain 사고)

### 증상
- 4-29 드레인 작업 (3582 row 일괄 처리) 동안 Gemini 2.5 Flash에 ₩23,033 소비
- 일일 quota 10K req/day 초과 → 마지막 37 row tagger 실패 (429 Quota Exceeded)
- 예상 ($0.25)보다 ~70배 비싼 결과

### 비용 분해 (form 가격표 기준 재계산)

Gemini 2.5 Flash 가격: input $0.30/M, output $2.50/M (thinking 포함 단일 단가)

| 항목 | 토큰 | 비용 |
|---|---|---|
| Input (4K × 9729 calls) | ~39M | $11.7 |
| Output (200 × 9729) | ~2M | $5.0 |
| **합계** | | **~$17 ≈ ₩23K** (form 결제액 일치) |

→ Input 70%, Output 30%. **Input이 주범.**

### 원인 후보
- (a) **F.6b drain script에 `FOR UPDATE SKIP LOCKED` 빠짐** — 같은 row 여러 batch가 재 fetch해서 9729 calls (3582 rows × 2.7x). production `worker.ts`엔 박혀있는데 일회용 script에서 누락.
- (b) **Tagger prompt 비대** — 시스템 프롬프트 + 기존 project_tags 후보 list (alias_of 그룹 대표 50개) 매 call 주입. 짧은 메시지에도 base 토큰 큼 (~4K input/call).
- (c) **모델 선택** — 단순 분류 task에 `gemini-2.5-flash` 사용. `flash-lite`는 input $0.10/M / output $0.40/M로 ~5x 저렴.
- (d) **Drain volume 자체** — 일회성 마이그레이션이라 평소 운영 비용과 무관.

### 잘못 잡혔던 가설 (4-29 정정)
- ~~Thinking mode default-on이 output 단가 10x 폭증~~ — **무효**. form 가격표 보니 output은 thinking 포함 단일 단가. thinking 차단해도 cost 변화 없음. 쿠가 outdated 가격 인용한 잘못된 추정이었음.

### 시도 결과
- 미적용. 다음 라운드 fix 후보.

### 조심
- 마이그레이션 같은 일회성 batch 작업은 운영 cost와 분리 측정 필요. 평소 1분당 5건 운영은 일일 ~7K calls.
- 가격 가정 검증 — model 가격표 정기적으로 직접 확인 (쿠가 인용한 가격 자주 outdated).

### Fix 후보 (우선순위)

| # | Fix | 효과 |
|---|---|---|
| 1 | **Tagger 모델 → `gemini-2.5-flash-lite`** | ~5x 절감 (input 3x + output 6x) |
| 2 | **SKIP LOCKED** drain script 강제 | 호출 2.7x → 1x |
| 3 | **Tagger prompt slim** (system 짧게 + 후보 list cache + 최소 예시) | input 4K → 1.5K 목표 |
| 4 | **cost telemetry** (call/token/cost 누적 → memory_status 노출) | 실시간 모니터링 |
| **합쳐서** | drain ₩23K → ~₩1.7K (13x), 운영 ~$3/year |

운영 cost projection (일일 form ~30 + assistant ~30 = 60 메시지 가정):
- 현재 (flash) → ~$18/year
- flash-lite + slim → ~$3/year (form 예상치 $10-20/year 안)

---

## 4. 매 대화 자동 저장 미구현 (form 4-30 catch)

### 증상
- form: "일단 대화 하나하나가 memory 테이블에 저장돼야 하는 거 아니야?"
- Gemini CLI 새 세션 → 일반 대화 흐름은 휘발. `manage_knowledge` 명시 호출했을 때만 저장됨.
- 어제 저장된 row #3602는 form이 직접 "기억해" 호출한 케이스 1건뿐.

### 원인 (쿠 drift catch)
- RESPEC.md 시퀀스 다이어그램 #1 (Hot Path)는 **매 메시지 발생 시 자동 raw 저장**이 vision.
- 그러나 RESPEC v1 fresh impl Phase A에서 `transcript_capture` + `transcript_processor` (Claude Code SessionEnd 시 JSONL 자동 캡처 → INSERT)를 wrong-axis로 폐기.
- 사실 그 위 librarian fact_type 추출 layer만 wrong-axis였고 **JSONL 캡처 메커니즘 자체는 form vision 정합**. 쿠가 함께 묶어서 제거 = drift catch 미흡.
- 현재 구현된 path:
  - `manage_knowledge` (명시 강제 저장 only)
  - `insertRawMemory` (function exists in `src/hot_path.ts`, but **MCP tool로 노출 안 됨**)

### 영향
- form vision (모든 대화 시간 순서 raw 자동 저장) **0% 구현**
- Cold Path / search_memory / Librarian 다 정상이지만 **저장된 raw가 없어서 의미 없음**
- 유일한 데이터 소스: 명시 manage_knowledge + Phase F 마이그레이션된 archive 3582 row

### Fix 후보 (4-30 합의된 (C) 조합)

#### (A) Claude Code JSONL 자동 캡처 부활
- v0.x `transcript_capture` 패턴 재도입. 단 **새 `memory` 테이블에 직접 INSERT** (legacy `transcript_queue` X, librarian extract X).
- SessionEnd 시 cwd → `~/.claude/projects/<slug>/<session_id>.jsonl` 식별 → 새 entry만 캡처 → `insertRawMemory`로 raw 저장.
- 캡처 cursor: `captureSessionStart(cwd)`로 server 시작 시점의 byte size 기록 → `captureSessionEnd()`에서 그 이후 byte range만 처리.
- **Claude Code 한정**. Gemini CLI / Codex는 JSONL 같은 convention 없음.

#### (B) `save_message` MCP tool (cross-platform)
- 새 4번째 tool. Caller agent가 매 turn 끝나고 호출.
- args: `{ role, message, agent_model?, subagent?, subagent_model?, subagent_role? }`
- 내부: `insertRawMemory()` 호출 (기존 함수 그대로 사용)
- caller convention 의존 — agent가 instructions 보고 호출. 신뢰성은 100%는 아님 (agent가 잊을 수 있음).

#### (C) (A) + (B) 조합 — 채택
- **Claude Code**: JSONL 캡처 자동 (form 주력 platform, 신뢰성 ↑)
- **그 외 platform**: `save_message` tool + instructions 안내
- 두 path 같은 `insertRawMemory` 호출 → 코드 중복 X

### 영향 범위 (form 명시: "전체 영향 안 미치게")
- 새 파일만 추가:
  - `src/auto_save/save_message_tool.ts` — MCP tool
  - `src/auto_save/jsonl_capture.ts` — Claude Code JSONL 캡처
- 기존 파일 수정 최소:
  - `src/tools.ts` — registerSaveMessage 1줄 추가
  - `src/index.ts` — captureSessionStart/End hook 재도입 (shutdown 블록 1개)
- DB schema **변경 없음**. `insertRawMemory` 함수 **변경 없음**.
- 기존 tools (search/manage/memory_startup) **변경 없음**.

### 시도 결과
- 4-30 1차 ship — `save_message` tool + `captureSessionEnd` (server-shutdown 시점). 단 form catch: Gemini CLI는 매 turn save_message 자동 호출 안 함. 또 SessionEnd-시점 캡처는 real-time 아님.
- **4-30 2차 ship (B1) — 롤백됨**: Claude Code Stop hook 실시간 캡처 도입했으나, 호스트 `~/.claude/settings.json`에 자동 등록하는 방식이 form 비전 위반 (`feedback_no_settings_json_writes.md`). 4-30 폐기:
  - 제거: `src/auto_save/install_hooks.ts`, `src/auto_save/capture_session.ts`, CLI subcommand 3종 (`install-hooks` / `uninstall-hooks` / `capture-session`)
  - form 머신 `~/.claude/settings.json`은 form이 직접 uninstall-hooks 돌려 정리 (제거 직전 상태)
  - 교훈: hot path 자동성 ≠ host config 자동 등록. host transcript 파일 passive 읽기로 "자동 + 설정 안 건드림" 둘 다 만족해야 함.
- **현 active path = (A) + (B) 조합 (기존 ship 유지)**:
  - Claude Code: `jsonl_capture.ts` (server start cursor + shutdown delta flush) — passive, settings 안 건드림
  - 그 외 platform: `save_message` tool — fallback/escape hatch

### 조심
- JSONL 캡처는 form 머신에 누적된 옛 JSONL 파일들 backfill 안 하도록 cursor (서버 시작 시점 byte) 명시.
- 본 path의 캡처 시점 = server shutdown. real-time per-turn 아님. real-time 원하면 **호스트 settings 안 건드리는 다른 메커니즘** 찾아야 함 (예: 외부 watcher 프로세스, OS file-watch, MCP notification convention 등 — 미정).
- 다른 플랫폼 (Codex, Gemini CLI, Cursor 등) 자동 캡처 추가 = 각자 transcript 위치 파악해서 jsonl_capture 패턴 복제. 우리 코드 안에서만 일어남, 사용자 settings 안 건드림.
- save_message tool은 instructions에 호출 convention 명시했을 때만 신뢰. fallback 위치 — primary 아님.

---

## 반복 검출된 패턴 (메모리 cross-ref)

- `feedback_root_cause_not_eyeball_fix.md` — narrow-first reflex
- `feedback_drift_via_narrow_fix.md` — 작은 목표가 큰 틀 깨는 drift
- `project_audit_only_for_skills.md` — Form vision 명문화
- `feedback_phase_enforcement_recheck.md` — 매 ship 시 Phase 1 재검증
- `feedback_fact_type_axis_drift.md` — 4-29 fact_type axis catch
- `feedback_structure_over_local_fix.md` — 4-29 form 가이드 원칙
- `project_basic_memory_real_vision.md` — RESPEC vision ground truth
- `project_respec_v1_complete.md` — 4-29 RESPEC v1 fresh impl 완료 closure







### cold_error 메세지 d_tag 관련



tag: [GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: [429 Too Many Requests] You exceeded your current quota, pleas



### grok-4-1-fast-reasoning / grok-4-1-fast-non-reasoning

#### Input


Tokens $0.20/ 1M tokens Cached tokens $0.05/ 1M tokens

#### Output

Tokens $0.50/ 1M tokens



### claude-sonnet-4-6

#### Input

$3 / input MTok   

#### Output

$15 / output MTok
