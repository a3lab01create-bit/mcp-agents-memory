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

## §20. Stage 2 구현 + judge 모델 결정 + 35b num_gpu 인프라 수정 🔵 SHIPPED (2026-05-24)

§19 설계를 구현. 구현 = Codex gpt-5.5 xhigh, 검증 = Claude.

**구현물** (브랜치 `feat/project-alias-lifecycle`)
- migration 025: `project_tag_alias_suggestions`(제안 큐, 21컬럼, open-pair 부분 유니크) + `project_tags` CHECK(alias_of<>id) write-side cycle guard.
- `src/cold_path/project_alias_promoter.ts`: 후보생성(개명발언 ILIKE / 신규·저빈도 / 벡터근접(기존 임베딩) / d_tag Jaccard / 이름유사) → per-pair LLM judge(evidence-bound JSON) → pending upsert(ON CONFLICT) + `applyAliasSuggestion()`(트랜잭션·FOR UPDATE·canonical resolve·재귀 cycle guard·supersede·tagger cache invalidate). 자동적용 기본 OFF.
- `src/model_registry.ts`: role `project_alias_judge` 추가.

**검증**: apply 트랜잭션 결정론 테스트(alias set+status+supersede+되돌림) ✅ / 후보→judge→파싱 스모크 errors=0 ✅. (실데이터엔 실제 중복 프로젝트가 없어 insert는 결정론 테스트로 커버.)

**judge 모델 결정 (7b→35b→gemma4 여정)**
- 처음 35b(qwen3.6:35b-a3b) 선택 → CPU에서 **판정 1건 232초**(너무 느림).
- 7b(qwen2.5) 검토 → 빠르나(1-2s) sloppy: `relation`에 enum 통째 덤프, rationale 중국어 혼입. "되긴 되나 거침."
- **최종: `gemma4:26b-a4b-it-q4_K_M`(17GB MoE, 4B active)** — 판정 ~20-50s(부분 offload), 한/영 개명 정확, 깔끔 JSON. 단 **추론(reasoning) 모델** — content 외 `reasoning` 필드 별도, max_tokens 넉넉히 줘야(예산 짧으면 content 빈 채 length 종료). promoter 기본 8192라 OK. 약점: confidence 항상 1.0(과신) — 게이트가 explicit 발언+무충돌 요구해 상쇄.

**⚠️ 인프라 수정 (repo 밖, 유실 주의)**: ollama `qwen3.6:35b-a3b` Modelfile에 `num_gpu 99`(전체 GPU 강제)가 박혀 있어 16GB VRAM에 **로드 자체가 불가**(promoter+Librarian 둘 다 영향). `FROM <model> + PARAMETER num_gpu 0`로 재생성해 CPU offload로 수정(권한상 blob-path FROM 불가 → 모델명 FROM 사용). 이후 35b는 CPU(느림)지만 로드는 됨. **Librarian이 이 모델 쓰면 느려짐 — 필요시 Librarian도 gemma4 검토.**

---

## §21. Librarian 모델 선택 + recency-bias 취약점 📌 설계/실험 (구현 전, 2026-05-24)

judge=gemma4 확정 후, Librarian용 모델을 광범위 비교(동일 처방: 강한 프롬프트 + ollama grammar schema `format={core_profile:string, sub_profile:string}`):

| 모델 | 계열 | 속도 | 결과 |
|---|---|---|---|
| **qwen2.5:7b** | 비-thinking | 14s | ✅ valid JSON prose |
| qwen2.5:14b | 비-thinking | 15s | ✅ valid JSON |
| qwen3.5:9b | thinking | 65s | ❌ schema 하 빈 응답 (추론이 토큰 소진) |
| gemma4:26b-a4b | reasoning | 91s | ❌ core 한국어 정확하나 sub 반복-degeneration |
| qwen3.6:35b-a3b / qwen3.5:27b | thinking·>VRAM | >5분 | ❌ 타임아웃 (CPU/partial offload) |

**format 결론(확정)**: **비-thinking(qwen2.5 계열) + ollama grammar schema = JSON 100% 안정.** thinking/reasoning 모델은 grammar schema 하에서 빈응답/붕괴(추론 토큰이 출력을 잠식). 큰 모델(27b/35b)은 16GB VRAM 초과 → CPU offload → 너무 느림(>5분).

**content 결론(중요 — 모델 문제 아님)**: 입력 윈도우(최근 50 user msg)가 **당일 메타-대화(모델사냥/붙여넣은 추천표)로 오염**되면 7b·14b **둘 다** 사용자 정체성 대신 그 주제를 프로필함. = **Librarian의 recency-bias 취약점.** (깨끗한 윈도우에선 7b가 정체성 정확히 추출했었음.)

**선택**: Librarian = **qwen2.5:7b + grammar schema + 강한 프롬프트** (비-thinking·이미 로드·VRAM 0). 14b 품질 우위는 **깨끗한 윈도우에서 재검증**(현재 오염 상태론 비교 무효).

**구현 TODO (다음 세션)**:
1. `LIBRARIAN_MODEL=qwen2.5:7b` (.env)
2. `callSpec`/`callRole`에 **ollama grammar schema(`format`) 지원 추가** — 7b는 schema 없으면 마크다운이라 필수. (35b는 schema 없이도 JSON 따랐지만 7b는 schema 의존)
3. system prompt 강화: **저장된 core_profile을 anchor로 최우선**, 최근 메시지는 보조, 일시적 주제(모델테스트/기술실험)를 정체성으로 오해 금지.
4. (선택) recency-bias 완화: 최근50만이 아니라 넓은 샘플 / 메타·시스템성 메시지 de-weight.

**주의(설계 정정)**: core_profile **영속화는 이미 존재**(users.core_profile + 프롬프트에 기존 프로필 전달). 새 persistence infra 불필요 — **anchor 가중치 강화(#3)가 핵심.**

협업: 모델 추천 그록(외부 LLM), 실험·검증 Claude, 방향 결정 사용자. 그록 추천(작은 qwen)은 방향 맞았으나 VRAM 수치(70B "12-14GB")·qwen3.5:14b 존재 등 부정확 → 실측으로 교정.

---

## §22. Cross-platform 캡처 확장 — Grok + Antigravity 🔵 SHIPPED (v0.9.10, 2026-05-25)

codex/gemini에 이어 **Grok Build·Antigravity** passive capture 추가 → 자동캡처 5종 완성(claude-code / codex / gemini / grok / antigravity). 원칙은 §5와 동일 — 호스트 transcript를 passive read(설정 오염 0), `save_message`는 fallback.

**Grok** (`src/auto_save/grok_capture.ts`): `~/.grok/sessions/<urlenc-cwd>/<sid>/chat_history.jsonl`.
- 함정: `~/.grok/logs/unified.jsonl`은 앱 디버그 로그(미끼). 실제 transcript는 chat_history.jsonl.
- 캡처: user=`<user_query>` 안쪽만(메타/synthetic skip), assistant=비어있지 않은 content(`model_id`=grok-build).
- **버그→교훈**: grok이 세션 초기 system-reminder를 *in-place rewrite*해 뒤 줄들의 byte offset이 밀림(+837) → byte-offset cursor/uuid면 첫 메시지가 2번 INSERT됨. → **line-index cursor + `grok:<sid>:<lineIndex>` uuid + size-gate**로 전환(줄 순서 보존 → dedup 정확).

**Antigravity** (`src/auto_save/antigravity_capture.ts`): 3변종(antigravity / antigravity-cli / antigravity-ide) 각 `~/.gemini/<variant>/brain/<sid>/.system_generated/logs/transcript_full.jsonl`. watch root 3개(없는 변종 no-op), 변종별 agent_platform.
- 함정: `conversations/*.pb`는 **암호화**(엔트로피 8.0, gzip/zlib/zstd 아님). transcript_full.jsonl만 사용.
- 캡처: `USER_INPUT`(`<USER_REQUEST>` 안쪽) + `PLANNER_RESPONSE`(content 있음). 그 외 type(CONVERSATION_HISTORY/tool 결과) skip.
- **dedup 키 = `step_index`**(엔트리 내재 정수 → rewrite/byte-shift 무관, grok 버그 원천 회피).
- 모델: per-entry 필드 없음 → user의 `<USER_SETTINGS_CHANGE>`("Model Selection … to X")에서 추출해 file-state(currentModel) 추적, 이후 assistant에 매핑(codex 방식). 없으면 unknown.

**공통**:
- 이중삽입 가드: passive 활성 platform은 `save_message`가 skip 반환(gemini=정확매칭, grok·antigravity=`startsWith` prefix — clientInfo 변형 대비). STATIC_INSTRUCTIONS 자동캡처 목록에 Grok·Antigravity 추가.
- timestamp 안 넘김(DB `now()`). hot path 실시간 read라 정합.
- 검증: parseEntry 실측 + 라이브 DB(중복 0, model 정상, NULL uuid 0 = 가드 작동).

협업: recon·설계·검증·`grok_capture` 작성 = Claude. `antigravity_capture` = Grok이 가이드(구 `docs/_wip/antigravity_capture_guide.md`, 본 §22로 통합 후 삭제) 따라 구현, Claude가 체크포인트 검증·모델 fix·multi-root 확장·소방수. 배포 = v0.9.10 (`reference_npm_publish.md`: 2FA bypass 토큰 필요).

---

## 가격 참고 (2026-05 기준)

| 모델 | Input | Output |
|---|---|---|
| grok-4-1-fast-non-reasoning | $0.20/M | $0.50/M (cached $0.05/M) |
| claude-sonnet-4-6 | $3/M | $15/M |
| qwen3.6:35b-a3b | local | local |

---

## §23. 콜드패스 로컬 통합 — llama.cpp Qwen3-14B 단일 모델 🔵 구성 staged (2026-05-27)

**배경**: §21에서 recency-bias는 "입력 문제(모델 무관)"로 진단됐으나, 실제 배포는 `LIBRARIAN_MODEL=qwen3.6:35b-a3b`(16GB 초과 → CPU offload/타임아웃 → 잦은 실패) + `LOCAL_GROK_FALLBACK=true` 조합이라 **로컬 실패 시 grok fallback이 떠서 $10-15/월** 발생. 즉 "grok 태거 비용"의 정체 = 미스사이즈 로컬 모델의 fallback.

**결정 (오퍼스 2차 회의 + grok 독립 검수 + 실측)**:
- 하네스: ollama → **llama.cpp(llama-server)**. 사유: 6800 XT = **gfx1030(RDNA2)**, vLLM/SGLang은 gfx1100 타깃이고 그들의 배칭 이점은 1-QPS 콜드패스엔 무의미. 단일유저엔 llama.cpp가 정답.
- 모델: **Qwen3-14B Q5_K_M** (9.8GB GGUF, 로드시 VRAM **11.8GB** — 16GB에 통째 상주). 8b는 카드 낭비, 35b-a3b MoE는 16GB 초과 스필. 14b dense가 sweet spot.
- 출력: **thinking OFF + json_schema 문법 = valid JSON 보장**(기본 빠른경로, ~6s). thinking ON + json_schema는 grammar 무시 버그(llama.cpp #20345)라 **금지** → thinking은 2-pass deep 모드(`LIBRARIAN_DEEP_THINKING`)에서만 opt-in.

**큐레이션(grok이 짚은 recency-오염 갭 — §21 line 379 재확인)**:
- SYSTEM_PROMPT 강화: core=DURABLE 정체성 only / sub=현재 작업, "주제를 다루는 것 ≠ 정체성" 명시, **null-preserve 규칙**(새 정체성 없으면 core=null로 보존).
- 입력 윈도우: 최근50 단일 → **최근25 + 과거25 블렌드**(단일 세션 지배 희석, 과거=정체성 앵커 라벨).
- cadence: 검증 전까지 보수적(30msg/24h) → **실측 통과 후 .env에서 15msg/2h**. 코드 기본값은 보수적 유지(npm zero-config 안전).
- 토큰캡 32768 → 2048(8192 ctx 대비 과대 방지). 프롬프트 예시는 실제 유저 정체성 하드코딩 제거 → fictional.

**실측 검증 (오염 테스트 = 바로 이 "모델사냥" 세션 윈도우)**:
- qwen2.5:14b@ollama AND Qwen3-14B@llama.cpp **둘 다 PASS**: core_profile = "트리플에이랩 대표…" 보존, sub_profile = "vLLM/Qwen3/ROCm 빌드/태깅…" 포착. §21이 "옛 프롬프트엔 14b도 오염"이라 한 조건에서 새 프롬프트가 막아냄.

**인프라 함정 (gfx1030 + ROCm 7.1 + LLVM21, 다음에 또 헤매지 말 것)**:
- cmake 없음 + PEP668 → `pip install --user --break-system-packages cmake`.
- HIP configure 실패 "cannot find ROCm device library" → device libs는 `/usr/lib/llvm-21/lib/clang/21/amdgcn/bitcode`에 있음. `cmake -DGGML_HIP=ON -DAMDGPU_TARGETS=gfx1030 -DCMAKE_HIP_FLAGS="--rocm-device-lib-path=$DLP"`.
- **flash-attention 필수 OFF**: `-fa off`. 안 끄면 gfx1030 FA 커널(`ggml_cuda_flash_attn_ext_tile_case<128,128>`, head_dim 128)이 `ggml_abort`로 크래시. (ollama는 자체 FA라 무관)
- 서버 기동: `llama-server -m Qwen3-14B-Q5_K_M.gguf --jinja -fa off --ctx-size 8192 -ngl 99 --port 8080`. 로딩 6s.
- codex(MCP)는 자체 샌드박스로 네트워크·파일쓰기 차단 → 빌드 불가, 직접 수행함.

**VRAM 통합 (16GB 강제)**: gemma4:26b(judge, 19GB) + Qwen3-14B 동시 상주 불가가 실증됨. 임베딩은 OpenAI 클라우드(text-embedding-3-large)라 ollama 독립 → **tagger+librarian+judge 전부 `LOCAL_LLM_BASE_URL=:8080`(Qwen3-14B)로 통합, ollama 은퇴**. clusterer만 grok-cloud 잔류. → 콜드패스 클라우드 비용 ≈ $0.

**전 역할 로컬 배선 + 실측 검증 완료 (2026-05-27)**: tagger/clusterer/project_alias_judge 모두 `enableThinking:false`(+tagger·judge는 jsonSchema) 적용. 라이브 Qwen3-14B@8080에 실제 프롬프트로 검증 → 4종 전부 valid shaped JSON, `<think>` 누출 0:
- tagger: `{p_tag:"centragens", d_tag:["schema-migration","bug-fix","index-rebuild"]}` (후보 매칭 정확)
- clusterer: root-array(json_object) 4클러스터 정상 (schema/schema-migration 등 병합)
- judge: `relation:"rename"` (centragens↔센트라젠 한/영 변형 판별), enum 문법 강제 동작
- 주의: judge는 local일 때 기존엔 JSON 제약 0이었음(자유텍스트) → 이제 jsonSchema+thinking off로 신뢰성 확보. clusterer는 root-array라 jsonSchema 대신 json_object 사용.

**콜드패스 = 독립 데몬 (2026-05-28, 프론티어 3모델 회의 결론)**: Codex(gpt-5.5)+Grok+Gemini 만장일치로 "다중 MCP 인스턴스가 콜드패스를 중복 실행"→advisory lock 권고. Grok+Gemini는 더 근본적으로 "백그라운드 LLM 워커를 ephemeral MCP 수명에 묶은 게 미스매치, 독립 서비스로 빼라"고 수렴. 단 systemd 데몬은 npm zero-config를 깨므로 **패키지엔 안 넣고**, Mortar(헤드리스 처리서버) 전용 인프라로만 둠. (다른 npm 유저는 자기 db·자기 머신 → editor MCP가 콜드패스 돌림, 영향 무관.) 핵심 통찰: 다른 사람은 *내 db를 안 씀* → "zero-config for others"는 내 멀티머신 선택을 제약 안 함.

구현 (shipped):
- `coldpath` 서브커맨드(index.ts): MCP 없이 콜드패스만 도는 데몬. `COLD_PATH_ENABLED=true` 내부 override(공유 .env의 false는 MCP 단말용). SIGTERM/INT/HUP 핸들러만(stdin 핸들러·watchdog 없음 — 데몬엔 stdin 파이프 없음). DB 명시 connect로 실패 시 exit 1→systemd 재시도.
- **advisory lock 싱글톤**(worker.ts): `startColdPathWorker`가 전용 PoolClient에서 `pg_try_advisory_lock(4242000017)` 획득; 못 잡으면 콜드패스 skip. 세션레벨(Codex 주의: row 처리 안 감쌈), 프로세스 사망 시 커넥션 드롭→자동 해제. `stopColdPathWorker`가 unlock+release.
- Mortar systemd 유닛 2개 LIVE: `llama-server`(Qwen3-14B) + `mcp-agents-memory-coldpath`(데몬). 둘 다 enabled(부팅 자동). 데몬 검증: DB connect✅ 락 획득✅ SIGTERM 클린종료✅.
- 모든 MCP `.env` `COLD_PATH_ENABLED=false` → editor MCP는 순수 단말(save/search), 데몬이 유일 처리기.

**남은 일**: ① 옛 코드 MCP 좀비 정리(락 없어 데몬과 중복 처리; pkill 시 데몬 MainPID 제외 필수 — 데몬도 `build/index.js coldpath`라 매칭됨) ② Claude 재시작→새 MCP는 단말로 뜸 ③ grok fallback 발생률 2~3주 모니터(≈0이면 보험으로 유지) ④ Codex 지적 semantic-drift 하드닝(core 변경 versioned/auditable, sub보다 엄격 게이트) ⑤ (선택) setup-server.sh 이식성 스크립트.

---

## 반복 검출 패턴 (memory cross-ref)

- `feedback_root_cause_not_eyeball_fix.md` — narrow-first reflex
- `feedback_drift_via_narrow_fix.md` — 작은 목표가 큰 틀 깨는 drift
- `feedback_no_settings_json_writes.md` — host config 자동 등록 금지 원칙
- `feedback_phase_enforcement_recheck.md` — 매 ship 시 Phase 1 재검증
