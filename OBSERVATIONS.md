# OBSERVATIONS — v0.9.0 Post-Ship Dogfood

> v0.9.0 (codex/gemini cross-platform passive capture) ship 직후 관찰 페이즈 로그.
> 형이 CLI + Claude Desktop + Codex Desktop 등을 직접 써보면서 발견한 이슈/관찰 사항을 적립.
> Phase: 관찰 (4-phase plan: 관찰 → 격리 R&D → 검증 → 통합)
> Start: 2026-05-01

---

## §1. Codex Desktop 앱 — 1턴 지연 저장 ✅ FIXED (v0.9.4, 2026-05-07)

**증상**
- Codex Desktop 앱에서 대화하면 메모리 저장이 1턴씩 늦게 들어감
- Codex CLI에서는 즉시 저장됨 (정상)

**해결**
- §10 멀티 프로세스 중복 저장 픽스(v0.9.4)와 함께 해소됨
- Mac Studio에서 Codex Desktop 재테스트 → 지연 없음 확인 (2026-05-07)

---

## §2. Claude Desktop 앱 — MCP 명시 호출 의존

**증상**
- Claude Desktop에서 MCP 서버는 정상 로드됨
- 그러나 툴을 명시적으로 호출해야만 동작 (자동 trigger 안 됨)
- CLI에서는 자동으로 작동하는 것과 대비

**추정 원인 (조사 필요)**
- Desktop 앱이 MCP 서버 instructions를 읽지 않거나, 자동 호출 trigger를 무시?
- Claude Desktop의 tool selection 로직이 CLI와 다를 가능성

**해결 방향**
- [ ] Desktop 앱이 server instructions를 어디까지 활용하는지 확인
- [ ] **HTTP connector 방식 검토** — Desktop 앱은 stdio MCP 대신 HTTP connector로 연결하는 대안 고민
- [ ] CLI와 Desktop의 MCP 동작 방식 차이 문서화

---

## 📋 향후 1주일 관찰 계획

- 형이 CLI + Desktop 양쪽 dogfood 지속
- 추가 발견 사항 이 파일에 누적
- 1주일 후 정리 → 수정할 부분 격리 R&D 페이즈로 넘김

## 🔭 장기 방향성 (post-observation)

- **Desktop 앱 통합 전략 재고**: stdio MCP 한계가 명확하면 HTTP connector 방식이 메인 진입점이 될 수도
  - Codex Desktop, Claude Desktop 둘 다 영향
  - CLI는 현재 passive transcript read 유지

----

## §3. Librarian 새로 만들기





-----------

## §4. ssh 키 / config 경로 문제

새로운 컴퓨터에서 설치시 ssh key 가 없으면 서버랑 연결을 못함 
일반사용자들이 사용 가능하게끔 setup 에서 같이 처리해 줘야할 듯
ssh key path 설정해주면서 절대경로 로 지정해줘야한다는 코멘트도 넣어줘야 할 듯

**2026-05-06 fix (v0.9.3)**
- `process.cwd()/.env`가 `~/.config/mcp-agents-memory/.env`보다 우선 탐색되어
  CLI 환경(T460 등)에서 claude 실행 디렉토리에 따라 SSH_ENABLED가 무시되는 문제 발견
- `configSearchPaths()` 순서를 XDG 경로 우선으로 변경 (commit f661b87)
- Mac Studio(dev 환경)는 `~/.config/mcp-agents-memory/.env` 없으면 `process.cwd()/.env`로 fallback → 기존 동작 유지

--------------

## §5. 접속기기 ✅ SHIPPED (v0.9.3)

동일 에이전트 동일모델로 다양한 기기에서 접속할때  기기명도 가져와서 대화내역이 정확히 어떤 기기에서 이루어 졌는지도 넣어주면 더 좋을듯

**구현 완료**
- `os.hostname()`으로 모듈 로드 시점에 기기명 캡처 (모든 캡처 모듈 공통)
- migration 022: `memory` 테이블에 `device_name TEXT` 컬럼 추가
- jsonl_capture / codex_capture / gemini_capture / save_message / manage_knowledge — 모두 `device_name` 주입
- briefing: `claude-code @ Mac-Studio` 형식으로 platform 헤더 + 개별 메시지 라인에 표시

--------------

## §6. p_tag 미등록 문제 — tag_processed 구조의 부작용

**현상**
- 새 프로젝트(예: yt-viral-signal-finder) 관련 메시지에 p_tag가 붙지 않음
- d_tag엔 관련 키워드(예: `yt-viral-signal`)가 정상 추출됨

**원인**
- cold path worker가 row당 tagger를 1번만 호출하고 `tag_processed = TRUE` 세팅
- Grok이 `p_tag: null` 판정하면 해당 row는 영구 재시도 없음
- 이 구조는 과금 폭탄 방어 목적 (v0.x 무한 retry → API 폭증 사고의 fix)

**아이디어 (초안)**

방향 A — AI 제약 강화
- 프롬프트에서 `only when clearly` 조건 완화 → 프로젝트 시그널 보이면 더 적극적으로 `NEW:` 반환
- 단점: P2 explosion 방어가 약해질 수 있음. 오판/tag 난립 위험

방향 B — d_tag 빈도 기반 자동 승급
- AI 없이 순수 통계: 동일 d_tag가 N회 이상 반복 → `project_tags` 자동 INSERT → 미태깅 row 소급 업데이트
- 과금 없음, 오판 없음. 단점: 첫 등장 때는 무조건 늦음

**권장 방향 — A + C 조합 ✅ SHIPPED (v0.9.3)**
- AI(Grok)는 지금처럼 보수적 유지 (explosion 방어)
- `src/cold_path/dtag_promoter.ts` 신설 — LLM 클러스터링 기반 승급
  - `clusterer` role 추가 (model_registry) — grok-4-1-fast-non-reasoning, ~100 토큰/회
  - 빈도 집계 후 LLM이 의미 유사 d_tag를 클러스터로 묶어 합산 (`yt-viral-signal` + `yt-signal-finder` → 합산)
  - `DTAG_PROMOTE_MIN_COUNT` (default **10**) — 클러스터 합산 기준이라 exact보다 높게 설정
  - `DTAG_PROMOTE_WINDOW_DAYS` (default 30)
  - `DTAG_PROMOTE_ENABLED=false` 로 disable
  - LLM 실패 시 단독 클러스터 fallback (non-blocking)
- worker.ts: 매 10 tick마다 promoter 실행
- 소급 업데이트: 클러스터 멤버 d_tag 보유 + `p_tag_id IS NULL` 인 row 전부 fill
- tagger candidate cache 즉시 무효화 → 다음 turn부터 새 tag가 candidate list에

--------------

## §10. 멀티 프로세스 중복 저장 ✅ FIXED (v0.9.4, 2026-05-07)

**현상**
- Gemini CLI + Claude Code 동시 사용 시 Gemini 메시지 2배 저장
- Claude Code에서 user 메시지만 2배 저장 (assistant는 1개)

**원인 1 — Gemini: sessionId 불일치로 ON CONFLICT 우회**
- Gemini MCP 프로세스 시작 시 chats 디렉토리에 이미 세션 파일 존재 → `captureSessionStart`에서 cursor=파일크기 설정
- `extractShortId` regex (`\.json$`)가 `.jsonl` 확장자에 미매칭 → sessionId에 파일명 전체(`"session-...-d5286079.jsonl"`) 저장
- 반면 Claude Code MCP 프로세스는 해당 파일을 "신규"로 감지 → cursor=0 → 헤더 라인 읽음 → 정확한 sessionId(`"d5286079-78d1-4512..."`) 사용
- 두 프로세스가 서로 다른 `external_uuid` 생성 → DB `ON CONFLICT` 우회 → 2개 INSERT

**원인 2 — Claude Code: 동일 user 메시지 다른 UUID로 재기록**
- Claude Code가 tool 호출 컨텍스트 재구성 시 동일 내용의 user 메시지를 다른 UUID로 재기록
- UUID 기반 `external_uuid`만으로는 dedup 불가

**픽스 (commit 792c4e0)**
1. `gemini_capture.ts` — `captureSessionStart`에서 `.jsonl` 기존 파일의 첫 512바이트 읽어 `sessionId` 직접 추출
2. `jsonl_capture.ts` — `FileState`에 `contentSeen: Set<string>` 추가, `role::message` 키로 content 기반 dedup

**진단 포인트**
- `search_memory` 결과에서 두 row의 `created_at`가 동일 millisecond → 동시 INSERT 증거
- assistant 메시지는 1개 (sessionId가 동일한 경우 ON CONFLICT 정상 작동)
- Gemini 닫으면 1개 프로세스 → 1x 저장 확인 → 멀티 프로세스 원인 확정

--------------

## §8. agent 능동적 자원 활용 부재

**현상**
- 메모리/웹/문서 등 자원이 연결돼 있어도 agent가 스스로 찾아보지 않음
- 업무 참고자료를 줘도 확인 안 하고 진행, memory 연결돼있어도 mid-session search 안 함
- Copilot처럼 웹페이지 연결돼있어도 페이지 내용을 안 보는 경우

**본질**
- LLM은 기본적으로 reactive(반응형) — "지금 이걸 봐야겠다"는 능동 판단 없음
- memory_startup 자동 주입처럼 강제로 넣어주지 않으면 있는 자원도 안 씀
- mcp-agents-memory만의 문제가 아닌 agent 설계 전반의 구조적 한계

**방향**
- [ ] mid-session에서 agent가 스스로 search_memory 호출하는 트리거 설계
- [ ] CLAUDE.md 또는 system prompt 레벨에서 "X 전에 반드시 Y 확인" 규칙 주입
- [ ] §7 역할별 mcp 아이디어와 연결 — 역할마다 "봐야 할 자원" 명시화

--------------

## §9. memory_startup brief 품질 문제

**현상**
- 새 세션에서 agent가 핵심 맥락(예: Claude 별명 "쿠름")을 모르는 경우 발생
- brief가 중간에 잘림: `N… [truncated]`
- 기기마다 기억이 다름 (t460 vs Mac Studio)

**원인 분석**

1. **brief 잘림**: `memory_startup`이 생성하는 brief가 MCP server instructions 허용 길이를 초과 → Claude Code가 truncate
2. **기기간 불일치**: 핵심 정보(별명, 선호 등)가 mcp-agents-memory DB에는 있어도 startup brief에 우선순위로 포함 안 될 수 있음. Claude Code auto-memory(MEMORY.md)는 로컬 파일이라 기기마다 다름
3. **요약 품질**: brief가 최근 프로젝트 상태 위주로 구성되어 "항상 알아야 할 것"이 밀려남

**방향 아이디어**
- [ ] brief 생성 시 "핵심 프로필 항목"을 최상단 고정 (잘려도 살아남게)
- [ ] brief 총 길이 상한 명시적 제어 (truncate 방지)
- [ ] Claude Code auto-memory(MEMORY.md)와 DB 기억 간 sync 전략 검토
- [ ] "항상 알아야 할 것" (is_pinned) 항목은 brief에서 절대 생략 안 하는 규칙

--------------

## §11. HTTP 서버 모드 — 웹 LLM / Desktop 앱 연결 (장기 로드맵)

**동기**
- ChatGPT Desktop, Claude Desktop 등 stdio MCP를 제대로 지원 안 하는 앱 대응
- 웹 기반 LLM (OpenAI, Gemini Web 등) 연결 가능성
- SSH 터널 제거 → Mac Pro 서버에서 DB 직접 접속

**로컬 HTTP 옵션 (코드 수정 최소)**
- `npx mcp-agents-memory http --port 3000` 로 로컬 HTTP 서버 모드 추가
- 클라이언트는 `url: "http://localhost:3000"` 으로 연결
- passive transcript capture는 로컬이라 cwd 그대로 사용 가능
- 현재 코드 구조 거의 그대로 유지

**원격 서버 옵션 (Mac Pro 배포)**
- Mac Pro에 설치 → nginx + 도메인 연결
- 장점: SSH 터널 불필요, 프로세스 1개, 어디서든 연결
- 단점: passive capture 재설계 필요 (서버가 원격 → transcript 파일 못 읽음)
  → `save_message` fallback 전용으로 운영하거나, session init 시 cwd 전달 방식 도입 필요

**우선순위**
- Desktop 앱 메모리 연결은 급하지 않음
- npm 패키지 안정화 후 검토
- 로컬 HTTP 옵션이 코드 변경 최소로 가장 현실적인 첫 단계

--------------

## §7. mcp-agents-memory 를 역할별로 다양하게 마드는게 가능할까? 

예를 들면 지금 처럼 일반 작업용 멀티에이전트 메모리
브랜드 마케팅 쇼핑몰용 하네스 멀티에이전트 에서 사용할 ai 오피스용 메모리
https://github.com/outworked/outworked --> 이런식으로 멀티에이전트로 작업을 할때 같은 모델을 여러게 쓸수도 있으니 모델의 별명? 도 지어줄 수 있음 좋을듯..(진짜 tiny office 처럼..ㅋㅋ;;)

