# OBSERVATIONS — v0.9.0 Post-Ship Dogfood

> v0.9.0 (codex/gemini cross-platform passive capture) ship 직후 관찰 페이즈 로그.
> 형이 CLI + Claude Desktop + Codex Desktop 등을 직접 써보면서 발견한 이슈/관찰 사항을 적립.
> Phase: 관찰 (4-phase plan: 관찰 → 격리 R&D → 검증 → 통합)
> Start: 2026-05-01

---

## §1. Codex Desktop 앱 — 1턴 지연 저장

**증상**
- Codex Desktop 앱에서 대화하면 메모리 저장이 1턴씩 늦게 들어감
- Codex CLI에서는 즉시 저장됨 (정상)

**추정 원인 (조사 필요)**
- Desktop 앱과 CLI의 transcript 파일 flush 시점 차이?
- Desktop 앱은 turn 종료 시점에 디스크 write가 지연될 가능성
- passive read 루프의 polling 타이밍과 어긋남?

**해결 방향**
- [ ] Desktop 앱의 transcript 파일 위치 + flush 동작 확인
- [ ] CLI vs Desktop transcript 포맷/타이밍 diff
- [ ] 1턴 지연이 file write 지연인지, 우리 read 루프 지연인지 분리

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

## §5. 접속기기

동일 에이전트 동일모델로 다양한 기기에서 접속할때  기기명도 가져와서 대화내역이 정확히 어떤 기기에서 이루어 졌는지도 넣어주면 더 좋을듯

**구현 아이디어**
- `os.hostname()`으로 MCP 서버 시작 시점에 기기명 캡처 (Node.js 기본 제공)
- `memory` 테이블에 `device_name` 컬럼 추가 (migration) — row 단위로 기기 기록
- briefing에서 `claude-code @ Mac-Studio`, `claude-code @ t460-server` 식으로 표시 가능
- 별도 `devices` 테이블 정규화는 오버엔지니어링 — 컬럼 추가로 충분

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

**권장 방향 — A + B 조합**
- AI(Grok)는 지금처럼 보수적 유지 (explosion 방어)
- d_tag 빈도 기반 승급 레이어를 별도로 추가
- 첫 등장은 느리지만 안전, 반복되면 자동으로 p_tag 생성
- N 임계값, 기간 윈도우, 소급 업데이트 범위 등은 추가 설계 필요

--------------

## §7. mcp-agents-memory 를 역할별로 다양하게 마드는게 가능할까? 

예를 들면 지금 처럼 일반 작업용 멀티에이전트 메모리
브랜드 마케팅 쇼핑몰용 하네스 멀티에이전트 에서 사용할 ai 오피스용 메모리
https://github.com/outworked/outworked --> 이런식으로 멀티에이전트로 작업을 할때 같은 모델을 여러게 쓸수도 있으니 모델의 별명? 도 지어줄 수 있음 좋을듯..(진짜 tiny office 처럼..ㅋㅋ;;)

