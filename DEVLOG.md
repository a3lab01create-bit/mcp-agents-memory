# DEVLOG — 운영 이슈 & 관찰 로그

> 직접 사용하면서 catch한 버그, 관찰 사항, 설계 결정, 미해결 아이디어를 적립.
> 솔루션 단정 X. 증상 + 원인 + 시도 결과 + 조심할 패턴.
> 상태: ✅ FIXED / 🔵 SHIPPED / ⏳ 보류 / 📌 아이디어

---

## §1. 시작 시 메모리 자동주입 ✅ FIXED (memory_startup tool, v0.9.x)

**증상**
- Gemini CLI 새 세션 시작 → 빈 컨텍스트로 시작
- `core_profile` / `sub_profile`이 user 테이블에 있어도 자동 주입 안 됨
- 에이전트가 직접 `search_memory` 호출해야만 가져올 수 있음

**원인**
- RESPEC v1 fresh impl에서 옛 `memory_startup` MCP tool 폐기됨 (Phase A에서 wrong-axis로 분류)
- 새 시퀀스 다이어그램에 첫 접속 자동 brief 로드 흐름 없음

**해결**: `memory_startup` tool 재도입 (3번째 tool). server connect 시 brief 자동 주입.

---

## §2. agent_platform / agent_model 식별 오류 ✅ FIXED (agent_identity.ts, v0.9.x)

**증상**
- Gemini CLI에서 `manage_knowledge` 호출 → `agent_platform='claude-code'`, `agent_model='opus-4-7'`로 잘못 박힘
- `.env` 하드코딩 폴백이 어떤 caller든 같은 값으로 박히는 사고

**해결**
- `clientInfo.name`으로 platform 자동 감지 (claude-code / gemini-cli / codex)
- `.env` `AGENT_PLATFORM` / `AGENT_MODEL` 폐기. caller args 우선, 없으면 'unknown'

---

## §3. Cold Path tagger 비용 폭증 (4-29 drain 사고)

**증상**
- 4-29 드레인 작업 (3582 row 일괄 처리) 동안 Gemini 2.5 Flash에 ₩23,033 소비
- 일일 quota 10K req/day 초과 → 마지막 37 row tagger 실패 (429)

**비용 분해** (Gemini 2.5 Flash: input $0.30/M, output $2.50/M)

| 항목 | 토큰 | 비용 |
|---|---|---|
| Input (4K × 9729 calls) | ~39M | $11.7 |
| Output (200 × 9729) | ~2M | $5.0 |
| **합계** | | **~$17 ≈ ₩23K** |

→ Input이 주범. `FOR UPDATE SKIP LOCKED` 누락으로 같은 row 2.7x 재처리.

**잘못 잡혔던 가설**: ~~thinking mode default-on이 output 단가 10x 폭증~~ → 무효. output 단가는 thinking 포함 단일 단가.

**Fix 후보 (미적용)**

| # | Fix | 효과 |
|---|---|---|
| 1 | Tagger → `gemini-2.5-flash-lite` | ~5x 절감 |
| 2 | SKIP LOCKED drain script 강제 | 2.7x → 1x |
| 3 | Tagger prompt slim (4K → 1.5K) | input 비용 감소 |

**조심**: 가격 가정 직접 확인 필요 — 쿠가 인용한 가격 자주 outdated.

---

## §4. 매 대화 자동 저장 미구현 🔵 SHIPPED (v0.9.0)

**증상**: 일반 대화 흐름 휘발. `manage_knowledge` 명시 호출 시만 저장됨.

**원인**: JSONL 캡처 메커니즘을 wrong-axis로 잘못 폐기 (librarian fact_type layer만 wrong-axis였음).

**해결 (A+B 조합 채택)**
- Claude Code: `jsonl_capture.ts` (passive read, settings 안 건드림)
- 그 외 platform: `save_message` tool — fallback/escape hatch

**조심**: 캡처 시점 = server shutdown. real-time per-turn 아님.

---

## §5. Cross-platform passive capture 🔵 SHIPPED (v0.9.0)

**발견**: Codex / Gemini CLI도 transcript 파일 보유 → passive 캡처 가능.

| Platform | 경로 | 포맷 |
|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/<sid>.jsonl` | JSONL flat |
| Codex | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<sid>.jsonl` | JSONL nested |
| Gemini CLI | `~/.gemini/tmp/<hash>/chats/session-<ts>-<short>.json` | 단일 JSON |

**구현**: `codex_capture.ts` (~370 lines) + `gemini_capture.ts` (~280 lines). 세 platform 병렬 startup arm + shutdown drain.

---

## §6. p_tag 미등록 — tag_processed 부작용 🔵 SHIPPED (v0.9.3, dtag_promoter)

**현상**: 새 프로젝트 메시지에 p_tag 안 붙음. cold path가 1회만 tagger 호출 후 영구 재시도 없음.

**해결**: `dtag_promoter.ts` — d_tag 빈도 기반 + LLM 클러스터링으로 p_tag 자동 승급. 매 10 tick마다 실행.

---

## §7. mcp-agents-memory 역할별 분화 📌 아이디어

- 일반 작업용 멀티에이전트 메모리 (현재)
- 브랜드/마케팅용 멀티에이전트 메모리 (별도 인스턴스?)
- Tiny Office처럼 모델마다 별명 부여 가능성 ([outworked](https://github.com/outworked/outworked) 참고)

---

## §8. Agent 능동적 자원 활용 부재 🔵 SHIPPED (v0.9.8)

**현상**: 메모리/웹/문서 연결돼있어도 agent가 스스로 찾아보지 않음.

**본질**: LLM은 기본적으로 reactive — 강제 주입 아니면 있는 자원도 안 씀.

**해결 옵션**

| 옵션 | 적용 범위 |
|---|---|
| A. MCP server instructions 강화 | 이 MCP 연결된 모든 플랫폼 (가장 넓음) |
| B. memory_startup brief 개선 | 모든 플랫폼 (startup 시점) |
| C. CLAUDE.md (global) | Claude Code 전용 |

**방향**: Option A 우선 — server instructions에 mid-session search_memory 트리거 규칙 추가.

---

## §9. memory_startup brief 품질 🔵 SHIPPED (v0.9.8)

**현상**: 핵심 맥락이 잘리거나 기기마다 달라짐. `N… [truncated]` 발생.

**방향 아이디어**
- [x] 핵심 프로필 항목 최상단 고정 (inject 모드: Core 보장 + Pinned를 Sub 앞으로 재정렬)
- [x] is_pinned 항목 절대 생략 안 하는 규칙 (inject 예산 1순위 fill)
- [x] brief 총 길이 명시적 제어 (`INSTRUCTIONS_MAX_CHARS`)

**Follow-up (2026-05-22)**: 위 v0.9.8 SHIPPED는 **서버측 brief budget cap**만 다뤘음.
실제 증상("이전 대화내역 startup 미주입")의 근인은 **클라이언트(Claude Code)가 MCP `instructions`
블록을 ~2,054자에서 절삭**하는 것 — 별건. fresh 세션 실측으로 확정(Sub Profile 중간 `[truncated]`,
Pinned/Recent 도달 못 함).
→ 해결: STATIC_INSTRUCTIONS 다이어트(1,436→565자) + `formatBriefMarkdown` **inject 모드**
(header+Core+Pinned+Active만 캡 안에 보장, Sub Profile·Recent는 `memory_startup` lazy load)
+ `INSTRUCTIONS_MAX_CHARS`(기본 1900)에서 brief 예산 역산. 조립 실측 1,827자.
✅ fresh 재시작 테스트 PASS (2026-05-22): 새 세션 instructions에 Core → Pinned(4개) → Active가
`[truncated]` 없이 주입됨, Sub Profile·Recent는 의도된 drop 확인 (inject vs full 대조로 검증).
클라이언트 실주입 end-to-end 확정.

**Phase 2 (2026-05-22) — 연속성 채널 분리, 표준 경로로 확정**: Phase 1은 instructions(캡)에서
Recent를 드롭했으므로 "직전 대화 연속성"은 아직 자동 주입 안 됨. 첫 시도는 Claude Code `SessionStart`
훅(+ `session-brief` CLI)으로 캡을 우회하는 것 — 구현·검증까지 했으나 **폐기**: 훅은 (a) Claude Code 전용
(b) 클라 settings.json 수동 등록 필요 = "표준 MCP 환경 zero-config" 원칙 위반(cf. 핀 메모리 id 60006,
`feedback_no_settings_json_writes`).
→ **확정 해결(표준·전 플랫폼·zero-config)**: 연속성을 캡 없는 **`memory_startup` 툴 응답**에 싣는다.
  - `recent_messages_current`를 **현재 기기(`device_name = os.hostname()`)로 스코프** — "이 기기에서 뭐 하다 끊겼나".
  - 미리보기를 캡과 **디커플** — `rowToMsg`는 `MAX_PREVIEW_STORE`(500)까지 저장, full-mode Recent만
    `PREVIEW_RECENT`(300), pinned·whispers·**inject는 `PREVIEW_COMPACT`(100) 유지**(inject 캡 불변).
  - full brief 캡 `BRIEF_MAX_CHARS` 3000→8000 (두꺼운 Recent가 optional-fill에서 드롭되지 않게).
  instructions의 pointer("세션 시작 시 memory_startup 호출")가 전 플랫폼(Claude/Codex/Gemini)에서
  이 풍부한 연속성을 끌어옴 — 클라 설정 0. 로컬 덤프 검증: Recent device=현재기기 단일·미리보기 두꺼움·pinned 100자 유지.
**Phase 2b (2026-05-23) — `search_memory` device 스코프 + 부수 버그 2건**: "찾을 땐 넓게,
이어받을 땐 좁게" 원칙을 검색 툴에도 적용. Phase 2 검증 중 발견한 버그 2건을 함께 픽스.
- **device_scope 추가**: `device_scope: 'local'|'global'`(기본 `global`). `local`이면 현재 기기
  (`os.hostname()`, briefing.ts:79 미러)로 `AND device_name = $N` 한정. main `filters`(vector·recency)
  + `ilikeFilters`(fallback) 양쪽에 동일 적용. `device_name` NULL인 옛 행(migration 022 이전)은
  local에서 제외 — 의도된 동작.
- **버그 #1**: `agent_platform: "*"`가 리터럴 `= '*'` 매칭이라 0건 반환(brief가 "*"=cross-platform이라
  안내하는데 실제론 안 먹힘). → `args.agent_platform !== '*'` 가드로 "*"=no-filter 처리.
- **버그 #2**: search 결과에 `device_name` 미노출(brief는 `@hostname` 렌더하는데). → `SearchRow` +
  3개 SELECT + 3개 mapper에 `device_name` 추가.
- **zero-config 유지**: hostname을 서버가 해석(클라가 device id 안 넘김). `briefing.ts`는 안 건드림.
✅ 임시 `dump-search` 하네스(fake-server stub으로 실제 핸들러 클로저 호출)로 검증·제거·재빌드:
  `"*"` 0→count>0, 모든 결과에 device_name, **GLOBAL 4기기 vs LOCAL 1기기(현재) 배제 실증**
  (DB 분포: Mac-Studio 3428·null 1424·MS-Mortar 641·Mac-Pro 597·t460 420·MacBook 46),
  predicate proof `device_name='호스트' 641행 vs '없는기기' 0행`. tsc --noEmit clean.

---

## §10. 멀티 프로세스 중복 저장 ✅ FIXED (v0.9.4, 2026-05-07)

**현상**: Gemini CLI + Claude Code 동시 사용 시 메시지 2배 저장.

**원인 1 (Gemini)**: sessionId 불일치 → ON CONFLICT 우회 → 두 프로세스가 서로 다른 external_uuid 생성.

**원인 2 (Claude Code)**: tool 호출 컨텍스트 재구성 시 동일 user 메시지를 다른 UUID로 재기록.

**픽스**
1. `gemini_capture.ts` — captureSessionStart에서 기존 파일 첫 512바이트 읽어 sessionId 직접 추출
2. `jsonl_capture.ts` — `contentSeen: Set<string>` 추가, `role::message` 키로 content 기반 dedup

---

## §11. HTTP 서버 모드 📌 장기 로드맵

**동기**: Claude Desktop / ChatGPT Desktop 등 stdio MCP 미지원 앱 대응.

**로컬 HTTP 옵션**: `npx mcp-agents-memory http --port 3000` 추가. 현재 코드 거의 유지.

**원격 서버 옵션**: Mac Pro 배포 + nginx. passive capture 재설계 필요.

**우선순위**: npm 패키지 안정화 후 검토.

---

## §12. Tagger 비용 점프 관찰 중 (2026-05-07~)

**현상**: d_tag only 시절 $0.01~0.03/일 → v0.9.3 이후 $0.4~0.5/일.

**진단**: v0.9.0 크로스플랫폼 캡처 이후 메시지 볼륨 3~5배 증가가 주 원인 (p_tag candidates 추가는 1.4x 토큰 증가뿐).

**관찰 계획**
- [ ] DB 일별 메시지 수 실측: `SELECT DATE(created_at), COUNT(*) FROM memory GROUP BY 1 ORDER BY 1`
- [ ] 원인 확정 후 tagger 최적화 결정

---

## §13. Codex Desktop 1턴 지연 저장 ✅ FIXED (v0.9.4, 2026-05-07)

**증상**: Codex Desktop 앱에서 메모리 저장이 1턴씩 늦게 들어감 (CLI는 정상).

**해결**: §10 멀티 프로세스 픽스와 함께 해소됨.

---

## §14. Claude Desktop — MCP 명시 호출 의존 ⏳ 미해결

**증상**: Claude Desktop에서 tool을 명시적으로 호출해야만 동작. CLI와 달리 자동 trigger 안 됨.

**방향**
- [ ] Desktop 앱이 server instructions 얼마나 활용하는지 확인
- [ ] HTTP connector 방식 검토 (§11 연결)

---

## §15. SSH 키 / config 경로 문제 ✅ FIXED (v0.9.3)

**증상**: 새 컴퓨터 설치 시 SSH key 없으면 서버 연결 불가. `process.cwd()/.env`가 XDG 경로보다 우선되어 SSH_ENABLED 무시.

**해결**: `configSearchPaths()` 순서를 XDG 우선으로 변경. SSH key 절대경로 지정 코멘트 추가.

---

## §16. 접속 기기 추적 🔵 SHIPPED (v0.9.3)

**아이디어**: 동일 에이전트가 여러 기기에서 접속할 때 기기명도 기록.

**구현**: `os.hostname()` 캡처 + migration 022 (`device_name TEXT` 컬럼) + 모든 캡처 모듈에 주입.

---

## §17. Librarian v2 🔵 SHIPPED (v0.9.7, 2026-05-22)

**배경**: RESPEC v1 이후 librarian.ts dead code. core_profile / sub_profile 자동 업데이트 경로 없음.

**구현 결정**
- 모델: `qwen3.6:35b-a3b` (local/ollama, Q4_K_M) — max_tokens=32768
- 게이트: 30 새 메시지 + 24h 쿨다운 + LIBRARIAN_ENABLED=true
- hammer 방지: attempt 시 last_run_at 즉시 기록
- null guard + JSON-in-string guard (prose 강제)

---

## §18. 프로젝트 alias lifecycle — read-time canonical projection 🔵 SHIPPED (PoC, 2026-05-24)

**증상**
- `market_collectors` 프로젝트가 세션 brief "Active Projects"에 안 뜸. 사용자가 직접 언급하기 전까지 존재를 모름.
- 관련 메모리가 p_tag별로 흩어짐: `mcp-agents-memory`(5), `advertising`(2), `null`(1) — **`market_collectors` p_tag 자체가 없음**.
- 과거 `market_analysis` → `market_collectors` 개명(DB수집/분석 분리). 대화에선 "마케팅db"/"마케팅 분석" 구어체로도 부름.

**원인** (3-way 설계회의: Codex gpt-5.5 xhigh + Gemini 3 + advisor)
- `project_tags.alias_of` 컬럼은 있으나 **채우는 주체가 없음**.
- 더 근본: brief `active_p_tags`가 `GROUP BY pt.name`(= `m.p_tag_id` 원본 태그)이라 alias 메모리가 canonical로 안 묶임. search는 입력 p_tag만 canonical resolve(저장측 누락).
- 태거의 "explosion 방어"(기존 후보 강선호)가 오히려 오태깅 유발 — market_collectors 작업을 가까운 `mcp-agents-memory`로 흡수하거나 `null` 처리.

**"alias"는 한 문제가 아니라 셋** (분해 — 메커니즘 다름)
- **A. 개명(rename)**: market_analysis→market_collectors. → `alias_of` (증거 = user 발언/git 흔적)
- **B. 구어체 동의어**: 마케팅db, 마케팅 분석. → p_tag 아님. 태거가 write 시점에 canonical 매핑할 문제
- **C. 오태깅(misfiling)**: mcp-agents-memory/advertising/null로 잘못 들어감. → 본문 벡터로 재배치(alias_of로는 못 고침)

**설계 합의** (셋 다 독립 수렴 = 높은 신뢰도)
- 벡터(pgvector) = **후보 발굴(recall)만**, LLM = 엔티티 동일성 판단, `alias_of` = ground truth. **벡터 단독 병합 금지** (market_collectors↔market_analysis는 임베딩 가깝지만 의도적으로 다른 프로젝트 = false merge 위험; 반대로 마케팅db↔market_collectors는 언어 달라 false miss).
- **read-time(query-time) canonical projection = soft aliasing**: 히스토리 재태깅 안 함. 병합 취소 = `alias_of` 링크만 끊기 → **가역적**. (write-time 해소였으면 되돌리기 = 히스토리 재태깅 = 고위험)
- p_tag 병합 게이트 ≫ d_tag 게이트: 자동 = 명시적 user 개명/등가 발언 + LLM confidence ≥ 0.98 + 충돌 evidence 없음. 애매 = pending + 다음 brief에서 사용자 확인. 금지 = 벡터 유사도 단독.
- 프로젝트 요약은 `users.sub_profile`과 분리(`project_summaries`), canonical 키, alias 합쳐지면 summary도 merge.

**alias lifecycle 파이프라인** (레이어 — 의존순)
1. Tagger: p_tag/d_tag 부여 + **기존 alias resolve만**(alias 생성 X)
2. `project_alias_promoter`(dtag_promoter와 **별도**): 벡터 후보 → evidence-bound LLM(`same_project`/`rename`/`alias`/`different`/`confidence`/`evidence_row_ids`) → 고확신 자동 / 나머지 pending
3. brief 확인 게이트: "X와 Y 같은 프로젝트?"
4. 태거 완화: 억지 매칭↓ + new-project flag (오태깅 차단)
5. Project Librarian(별도 레이어): canonical 기준 `project_summaries` 생성/갱신
6. (고급) 요약본 임베딩 → promoter가 새 태그를 **요약본 벡터**와 비교(메모리 N개 대신 요약 1개 — Gemini 제안)

**해결 — #1 keystone (PoC ✅ SHIPPED)**
- migration `024_canonical_project_tag_projection`: `canonical_project_tag_id(BIGINT)` STABLE 함수 — `alias_of` 체인을 root까지 resolve(사이클 방어 path 배열), NULL→NULL, 미존재 id→입력값 반환.
- `briefing.ts` active_p_tags: `JOIN project_tags cpt ON cpt.id = canonical_project_tag_id(m.p_tag_id)` + `GROUP BY cpt.name`.
- `search_memory.ts`: p_tag 필터 `canonical_project_tag_id(m.p_tag_id) = $id` + vector/ILIKE/recency 3개 SELECT 모두 p_tag_name canonical projection.
- 구현 = Codex gpt-5.5 xhigh, 검증 = Claude.

**PoC 검증** (실데이터, 트랜잭션 ROLLBACK — 프로덕션 무손상)
- 시나리오: `project-claude-code-v0.4`(252) → 임시 `alias_of` → `mcp-agents-memory`(3161)
- brief 집계: NEW에서 v0.4 사라지고 `mcp-agents-memory`=3413 (= 3161+252) ✅
- search 필터(canonical=target)에 source 메모리 포함(3413) ✅
- 가역성: ROLLBACK으로 원복, DB 변경 0 ✅
- 검증 스크립트: `scratch/poc_verify.ts` (gitignore, 로컬 전용)

**남은 작업**: 파이프라인 2~6단계(promoter / 게이트 / 태거 완화 / Project Librarian / 요약 벡터 루프). 라이브 brief·search 반영 시 **MCP 서버 재시작** 필요(현재 실행 프로세스는 옛 코드).

**조심할 패턴**
- read 경로 추가/수정 시 `canonical_project_tag_id` 일관 적용 — 누락하면 그 경로만 alias 안 풀림.
- 함수가 per-row 호출 → 대량 집계 시 STABLE 최적화에 의존. 성능 이슈 시 인덱싱/머티리얼라이즈 검토.
- ⏳ backlog: search 결과 `p_tag_name`이 canonical로 표시되는 건 diff상 명백하나 런타임 row 미검증 — `poc_verify.ts`에 alias 후 한 줄 assert 추가 예정.
- cross-ref: `feedback_fundamental_standard_solution.md`(근본·표준 해결), `feedback_root_cause_not_eyeball_fix.md`(narrow-first 반사 경계).

---

## §19. project_alias_promoter (Stage 2) 설계 확정 📌 설계 (구현 전, 2026-05-24)

3-way 회의(Codex gpt-5.5 xhigh + Gemini 3 council-high + Opus 종합). §18 keystone 위에 "누가/어떻게 `alias_of`를 채우나".

**합의(셋 다 독립 수렴)**: 별도 테이블 / 벡터=recall만·LLM=엔티티 판단 / 로컬 qwen3.6:35b per-pair evidence-bound / 하이브리드 스케줄(이벤트+daily) / 제안 적극·auto-apply 보수 / dtag_promoter와 별도 worker(helper만 공유).

**Opus 종합 판단 (갈린 지점)**
- **저장**: 1테이블 `project_tag_alias_suggestions` + relation enum(`rename`/`alias`/`same_project`/`different`/`misfile_suspected`/`insufficient`) + open-pair 부분 유니크 인덱스(`WHERE status='pending'`, `LEAST/GREATEST`로 방향무관 dedupe + reject 후 재제안 허용) + `signals JSONB`. (Codex의 정규화 evidence 테이블은 v1 YAGNI — 후일.)
- **확인 UX**: **새 MCP tool `manage_project_tags`**(`list_suggestions`/`confirm_alias`/`reject_alias`/`set_alias`/`unset_alias`). manage_knowledge 재사용은 도메인 불일치(메모리 CRUD vs 태그그래프 mutate, `memory_id=suggestion_id` 혼동)로 기각. 새 *서버* tool = 여전히 client zero-config(원칙 위배 아님).
- **범위 교정(중요)**: 오태깅(C)은 alias 축이 아니라 **개별 메모리 retag** 축 — tag A→B alias하면 A의 *모든* 메모리가 끌려감. 따라서 **Stage 2 = 태그레벨 A(개명)+B(동의어)만.** C(개별 misfile retag)는 별도 backlog.
- **벡터**: v1=대표 메모리 근접. 태그/요약 벡터 임베딩은 Stage 6(요약 벡터 루프)으로.

**설계 요약**
```
project_alias_promoter.ts (별도 worker)
├─ 후보생성: canonical root 태그만. 신호 우선순위 = user 개명발언(ILIKE) > 신규/저빈도 태그 > 벡터근접 메모리 > d_tag overlap > 이름유사. 벡터=지명만(판단 X).
├─ LLM(qwen3.6:35b, 신규 role 'project_alias_judge'): per-pair → {relation, confidence, evidence_memory_ids, rationale}
├─ 게이트: auto-apply(기본 OFF) = 명시적 user rename + relation∈{rename,alias,same_project} + conf≥0.98 + 충돌0 + 양쪽 canonical root + 최근 reject 아님 + ENABLE 플래그
│           pending = conf 0.85~0.97 → brief 노출 → 사용자 confirm
├─ 스케줄: rename 스캐너 ~10 cold-path tick + full pass daily/cooldown + 신규태그 "다음 run 우선" 플래그
└─ 저장: project_tag_alias_suggestions(1테이블)
write-side cycle guard: project_tags CHECK(alias_of <> id) + confirm 트랜잭션에서 multi-hop cycle check (§18 함수는 read 방어일 뿐)
초기 배포: auto-apply OFF → pending 쌓고 수동 confirm 10~20건 관찰 후 ON
```

**남은 backlog**: C(개별 메모리 retag 기능), 그리고 lifecycle 4~6단계(태거 완화 / Project Librarian `project_summaries` / 요약 벡터 루프).

---

## 가격 참고 (2026-05 기준)

| 모델 | Input | Output |
|---|---|---|
| grok-4-1-fast-non-reasoning | $0.20/M | $0.50/M (cached $0.05/M) |
| claude-sonnet-4-6 | $3/M | $15/M |
| qwen3.6:35b-a3b | local | local |

---

## 반복 검출 패턴 (memory cross-ref)

- `feedback_root_cause_not_eyeball_fix.md` — narrow-first reflex
- `feedback_drift_via_narrow_fix.md` — 작은 목표가 큰 틀 깨는 drift
- `feedback_no_settings_json_writes.md` — host config 자동 등록 금지 원칙
- `feedback_phase_enforcement_recheck.md` — 매 ship 시 Phase 1 재검증
