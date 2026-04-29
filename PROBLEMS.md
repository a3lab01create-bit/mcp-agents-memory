# Current Problems — read at session start

> Form 명시: "다음 세션 시작할 때 PROBLEMS.md 먼저 읽어"로 driving.
> 솔루션 단정 X. 증상 + 원인 후보 + 시도 결과 + 조심할 패턴.
> 예측 빗나갔을 때 원인 추적 가능하도록 작성.

---

## 🚧 ACTIVE — 기본 메모리 정합성 회복 (4-29~)

**Spec**: `spec.md` §11. 모드(B) layered cleanup. Embedding 외 정합성만 fix. 안 되면 폐기.

**현재 상태**: scope/acceptance 명문화 완료. 단계 0 (윗 layer 격리) 진입 대기 중 — form 확인 후 시작 예정.

**단계 진행** (각 commit 분리, 안 되면 멈춤):
- [ ] **Step 0** — 윗 layer 호출 path 격리 (env flag)
- [ ] **Step 1** — transcript source 분리 (User만, system/skill/slash 텍스트 거름)
- [ ] **Step 2** — EXTRACTION_SYSTEM_PROMPT 정합성
- [ ] **Step 3** — TRIAGE_SYSTEM_PROMPT 정합성
- [ ] **Step 4** — Brief 필터 정합성
- [ ] **Step 5** — 기존 hallucination row cleanup (form 직접 검토)

**Exit**: form이 다음 세션 직접 사용 후 평가. 쿠 self-test 통과 ≠ closure.

---

## 1. 비용 폭증 (4-29 진단)

### 증상
- 1년치 $10-20 예상이 2-3일에 약 $10 (xai grok)
- 곱셈 폭증: 단가(50×) × 호출수(50-100×) × 토큰(5×) × reasoning_tokens(3-5×)

### 원인 후보
- **메인**: `auditFacts` (librarian.ts:549) — 모든 transcript fact의 top-5를 grok-4.20-reasoning으로 audit
- **증폭**: 4-29 이번 세션 chunking이 `processBatch` 호출수 N배 증폭 → audit 호출수 N배 (uncommitted, scratch에만)
- **부수**: `validateFact` (scheduleValidation, librarian.ts:663) — high-importance learning fact마다 grok+Tavily+Exa
- **silent**: VALIDATOR_MODEL이 .env에서 사라진 채 (`070ded7` schema migration). validator.ts:94 AUDIT_MODEL fallback → 4.20-reasoning. Form 의도는 4.1-fast.

### 시도 결과
- chunking 40K → 15K + defer-large 500KB (4-29) — drain 일부 진행하다 비용 amplifier 발견하고 **revert** (uncommitted, 다음 진행 시 위험)
- env CONTRADICTION_MODEL: grok-4.20 → 4.1-fast (form 직접) — contradiction path만 cheaper. audit/validator는 4.20 그대로
- **audit path 끊기 (librarian.ts:549, 663) — commit `0fdd0cd`로 적용 완료** (4-29). transcript pipeline에서 grok 호출 0. dead code 잔존, 다시 호출 X.
- **검증 완료 (4-29 13:03 KST, MCP restart 후)**:
  - `transcript_queue` pending = 0 (큐 다 풀림)
  - cutoff `2026-04-29T03:53:59Z` 이후 새 memory 39개 중 grok-4.20-reasoning author = 0건
  - 4 rows 'processing' 남았으나 captured_at 03:59 (commit 직후) — drain 진행 중
  - sub-finding: 새 fact 39개 전부 `author_model = null` — cost_attribution.ts의 "1595 null" 패턴과 동일, audit cut 무관해 보임. 2번 진단 시 같이 살펴볼 신호.
  - validator_model column이 schema에서 사라진 상태 확인 (070ded7 마이그레이션 흔적)
- → 1번 **closing**. 비용 폭증 root는 차단됨.

### 조심
- 모델 단가만 보고 진단 멈추면 호출수 폭증 root 놓침. 단가 × 호출수 × 토큰 × reasoning 곱셈으로 봐야.
- chunking 같은 narrow fix가 비용 곡선 가속 가능. ship 전 "호출수 영향 어떻게 변하나?" 검증 필수.

---

## 2. memory_add silent fail (어제부터)

### 증상
- `memory_add` 호출 → 응답 OK
- 새 세션 `memory_search` / `memory_startup` brief에 안 나옴
- 반복적으로 "된다고 하고 재시작해서 불러오라고 하면 비어있고 못불러오고" (form 4-29)

### 원인 후보 (미진단)
- `1be2c5b fix(librarian): atomic supersede + INSERT in single transaction` — supersede UPDATE가 새 fact를 즉시 superseded시키는 버그?
- `fba498c feat(librarian): Phase A — exact-content cosine precheck dedup` — dedup이 모든 새 fact를 silent skip시키는 임계값 버그?
- 또는 author_model = null 1595개(cost_attribution.ts 4-29)와 연관 가능

### 시도 결과
- 직접 진단 안 함. 우회 path만 시도 (Claude Code native auto-memory `.md`로 lesson 저장 — mcp memory_add와 별개)
- **4-29 13:08 KST 1차 진단**: 직접 memory_add 호출 (token XJ7K9, session=silent-fail-diagnostic-XJ7K9) → 응답 `Saved: 2 | Deduped: 0` → DB 확인 #2780/#2781 `is_active=true valid author_model=claude-opus-4-7` → memory_search 100% sim retrieve. **단순 silent fail 재현 안 됨.**
- 추가 발견 (재진단 필요):
  - **brief 필터링 가설 (가장 유력)**: memory_startup brief는 `profile/preference` fact_type만 표시. Librarian이 form 입력을 `state/decision/learning`으로 분류하면 DB 저장돼도 새 세션 brief에서 invisible. form 증언 "새 세션 brief에 안 나옴"과 정확히 부합.
  - **brief noise**: profile로 분류된 hallucination/system advice ("User is a Staff Engineer", "Adding routing rules to CLAUDE.md is recommended", "gstack works best...") 다수. transcript drain 자동추출의 분류 정확도 문제.
  - **fact extractor 압축**: 원문 token "XJ7K9"는 추출 시 떨어져나감. 추출 fact는 "memory_add is silently failing"으로 압축. 식별 키워드 search 시 retrieve 안 될 위험.

### 조심
- mcp `memory_add` broken과 native auto-memory 별개임을 매 세션 인지. 우회 가능하지만 진짜 fix 아님.
- form의 "silent fail" 증상은 **write 실패가 아니라 brief 필터링**일 가능성 높음. 다음 세션에 startup brief vs memory_search 재현 테스트 필요 (probe #2780/#2781이 새 세션 brief에 나오는지).

### 4-29 13:15 KST 가설 확정
**memory_startup 실호출 + tools.ts:28-219 코드 read로 확정**:

Brief 필터 (tools.ts:72-204):
- `USER PROFILE`: fact_type IN (`profile`,`preference`) + tag `profile_static`, LIMIT 8 (subject 필터: user_key)
- `CURRENT CONTEXT`: fact_type IN (`profile`,`preference`) + tag `profile_dynamic`, LIMIT 6 (subject 필터: user_key)
- `KEY DECISIONS & LEARNINGS`: fact_type IN (`decision`,`learning`), LIMIT 5, **subject 필터 없음** (전역)
- `ACTIVE SKILLS`: skills table (별도 시스템)
- `SKILLS & TECH STACK`: fact_type=`skill`, LIMIT 6 (전역)

→ `state` / `relationship` fact_type은 **어느 섹션에도 등장 불가**.
→ Probe #2780/#2781 (state) memory_startup 호출에서 실제로 brief에 안 나옴 — 가설 확정.

부수 발견 (brief noise):
- USER PROFILE에 hallucination/오분류: "User is a Staff Engineer reading a colleague's meticulous session notes" (form vision 위반: form은 frontend hobbyist), "Adding routing rules to CLAUDE.md is recommended" (system advice를 user preference로 분류)
- CURRENT CONTEXT에 ephemeral OS 설정: "Switched to visual bell", "Enabled 'Use Option as Meta key'", "User can request help with laptop setup by saying '노트북 셋업 도와줘'" (gstack skill trigger 문구)
- transcript drain 자동 추출 + librarian 분류 정확도 + brief 필터 단순함의 합성 결과

---

## 3. Hook (self-watch) 효과 미체감

### 증상
- Form 시점: "hook 안 됨"
- 실제: `transcript_queue`에 95+ pending — `captureSessionEnd` INSERT는 작동
- drain이 막혀서 form 시점에 처리 결과 안 보임

### 원인 후보
- INSERT는 OK (큐 row 수가 evidence)
- drain 막힘은 audit cost 폭증과 같은 root (1번 항목)
- 즉 1번 fix하면 hook도 자연스레 동작 체감 (가설)

### 시도 결과
- `dbc049d` Phase B hook installer 만듦 → `d63fb1f`에서 revert + self-watch (track 1)로 대체
- 그 후 매 세션 "hook이 답인지 self-watch가 답인지" ~5번 뒤집음 (form 4-29 패턴 보고)

### 조심
- "hook 안 됨" 인지하면 INSERT vs drain 어느 쪽 막힘인지 먼저 확인. 묻지 말고 `transcript_queue` 직접 query.
- self-watch (track 1) vs Phase B installer 결정 commit돼 있음 (d63fb1f). 또 뒤집지 말 것. 뒤집어야 한다면 form 명시적 confirm.

---

## 4. 짬뽕 코드 — v0.7보다 regression 많음

### 증상 (form 4-29 진단)
- "0.7보다 안되는 부분이 더 많고 오류난 부분도 더 많음"
- "작은 목표가 큰 틀을 다 망가뜨려서 그 작은 목표만 완성"
- audit 시스템 4개로 증식 (form vision은 1개 — skill 후보군에만)

### 원인 후보
- v0.7 (commit `ab4cc32`) 이후 narrow fix 누적:
  - v0.8 project scoping (b20e37c)
  - v0.8.1 eval harness (23f6514)
  - librarian Phase A dedup (fba498c)
  - librarian atomic supersede (1be2c5b)
  - Track 1 self-watch (d63fb1f)
  - transcript pipeline fix (38c65d8)
- 매 commit이 큰 틀의 가정 침식 (예: VALIDATOR_MODEL 잃어버림, audit 4개로 증식)
- 매 ship 전 "큰 틀의 어떤 가정이 유지되나? Form vision 침범하나?" 검증 부재

### 시도 결과
- v0.6 hardening, v4.5 skill closure 등은 form 의도대로 진행됐음
- v0.7 이후는 narrow fix가 dominate

### 조심
- 새 fix가 매력적일수록 ("큐 빨리 풀려고", "비용 빨리 줄이려고") drift 위험 큼
- ship 보류가 더 안전. Form vision 명확하지 않으면 진행 X.

---

## Form Vision (4-29 명시, drift 검출 기준)

> "Librarian의 본래 역할 = 대화 패턴 자동 감지 → skill 후보로 promote.
> Audit/fact-check는 skill 후보군에만 (skill_auditor)."

> "AI는 implementation translator. Form은 frontend hobbyist (vision provider).
> 결정 어렵다고 form에게 떠넘기는 것 = role 침범."

> "솔루션 단정 X. 증상/원인/시도 결과 기록. 예측 빗나갈 때 원인 추적 가능해야."

---

## 미진단 사항 (다음 세션 pickup 후보)

- **현재 진행 (4-29 13:03 KST 진입)**: memory_add silent fail 진단 (Phase A dedup `fba498c` vs atomic supersede `1be2c5b` 어느 쪽이 silent fail 원인인지). 직접 호출 + DB query로 새 fact INSERT 추적. 검증 시 같이 본 author_model=null 39건도 단서일 가능성.
- self-watch hook이 captureSessionEnd 시 정상 INSERT하는지 라이브 검증 (drain 풀린 후)
- librarian이 "패턴 감지 → skill 후보 promote" 본래 vision대로 작동하는지
- 짬뽕 코드 cleanup 방향 (form vision 재확인 필요)
- audit/validate 함수 dead code 정리 (auditFacts, validateFact, auditMemory 함수 자체 제거할지 — 별도 architectural decision)

---

## 반복 검출된 패턴 (메모리 cross-ref)

- `feedback_root_cause_not_eyeball_fix.md` — narrow-first reflex
- `feedback_drift_via_narrow_fix.md` — 작은 목표가 큰 틀 깨는 drift (4-29 신규)
- `project_audit_only_for_skills.md` — Form vision 명문화 (4-29)
- `feedback_phase_enforcement_recheck.md` — 매 ship 시 Phase 1 재검증
- decision flip-flop — hook vs self-watch ~5번 뒤집음 (어제~오늘)
