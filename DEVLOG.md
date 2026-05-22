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
클라이언트 실주입 end-to-end 확정. Phase 2(brief CLI + SessionStart 훅)는 별도.

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
