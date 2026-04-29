# PROBLEMS — historical reference

> **본 파일은 v0.x 시리즈 운영 중 발견된 문제 + cleanup 진행 기록.**
> **2026-04-29 RESPEC v1 fresh impl로 superseded.** 모든 v0.x cleanup 항목은 fresh impl이 폐기/재구현으로 해결.
>
> 현재 active 문서:
>   - [`RESPEC.md`](./RESPEC.md) — 단일 진실 원천 (vision + 결정사항 + 구현 detail)
>   - [`README.md`](./README.md) — 사용자 진입점
>
> 본 파일은 archive로 유지 (drift 사고 history reference).

---

## 🟢 4-29 RESPEC v1 fresh impl 완료 (Phase A-G)

| Phase | 결과 | Commit |
|---|---|---|
| A — wrong-axis 폐기 | ✓ | a1-a4 (commits 90ce154 / b77ac53 / d715e9b / d44fbad) |
| B — 새 schema (migration 019) | ✓ | b41064d |
| C — Hot Path + manage_knowledge | ✓ | 0a5398c |
| D — Cold Path (tagger/embedder/worker) | ✓ | 3bf6b2d |
| E — search_memory + Librarian | ✓ | 18b95e9 |
| F — Migration (legacy ~3582 row → archive 보존) | ✓ | (data only, no code commit) |
| G — End-to-end + 문서 closure | ✓ | (this commit) |

**최종 시스템 상태**:
- 옛 schema (subjects/memories/skills 등 11 테이블) → `_legacy_*`로 rename 보존
- 새 schema (users/memory/project_tags 3 테이블) 운영
- legacy ~3582 row → 새 memory에 archive 상태 + 3-large 재임베딩 + p_tag 재태깅 완료
- form 핵심 정체성 → user_id=1 'hoon'의 core_profile / sub_profile에 promote (Librarian draft + form review)

**legacy `_legacy_*` 테이블**: rename만, DROP 안 함. 1-2주 운영 후 form 결정 시 DROP 가능.

---

## 📜 Historical (v0.x 시리즈) — archive

이하는 v0.x 운영 중 발견된 문제 history. RESPEC v1로 superseded됐지만 **drift 사고 evidence + lesson** 보존을 위해 keep.

### 1. 비용 폭증 (4-29 진단)

#### 증상
- 1년치 $10-20 예상이 2-3일에 약 $10 (xai grok)
- 곱셈 폭증: 단가(50×) × 호출수(50-100×) × 토큰(5×) × reasoning_tokens(3-5×)

#### 원인 후보
- **메인**: `auditFacts` (librarian.ts:549) — 모든 transcript fact의 top-5를 grok-4.20-reasoning으로 audit
- **silent**: VALIDATOR_MODEL이 .env에서 사라진 채 (`070ded7` schema migration). validator.ts:94 AUDIT_MODEL fallback → 4.20-reasoning. Form 의도는 4.1-fast.

#### 조심 (lesson)
- 모델 단가만 보고 진단 멈추면 호출수 폭증 root 놓침. **단가 × 호출수 × 토큰 × reasoning 곱셈으로 봐야**.
- chunking 같은 narrow fix가 비용 곡선 가속 가능. ship 전 "호출수 영향 어떻게 변하나?" 검증 필수.

**RESPEC v1 해결**: audit/validator/contradiction LLM path 전부 폐기. Cold Path는 gemini-2.5-flash (저렴) + openai 3-large embedding만.

---

### 2. memory_add silent fail

#### 증상
- `memory_add` 호출 → 응답 OK
- 새 세션 `memory_search` / `memory_startup` brief에 안 나옴

#### 원인 (4-29 13:15 KST 진단)
**brief 필터링이 root** — write 실패 아님:
- USER PROFILE 섹션 = `profile/preference + profile_static` 필터, LIMIT 8
- CURRENT CONTEXT 섹션 = `profile/preference + profile_dynamic` 필터, LIMIT 6
- `state` / `relationship` fact_type은 어느 섹션에도 등장 불가
- form 입력이 librarian에 의해 `state`로 분류되면 → DB 저장 정상이지만 brief 안 보임 (이번 세션 probe #2780/#2781로 재현)

**RESPEC v1 해결**: fact_type 폐기. memory 테이블에 모든 발화 raw 저장 + tag/embedding으로 검색. brief 필터 자체를 시간/태그 기반 redesign.

---

### 3. Hook (self-watch) 효과 미체감

#### 증상
- Form 시점: "hook 안 됨"
- 실제: `transcript_queue`에 95+ pending — `captureSessionEnd` INSERT는 작동
- drain이 막혀서 form 시점에 처리 결과 안 보임

**RESPEC v1 해결**: transcript queue / captureSessionEnd 메커니즘 자체 폐기. Hot Path가 caller로부터 직접 INSERT 받음.

---

### 4. 짬뽕 코드 — v0.7보다 regression 많음

#### 증상 (form 4-29 진단)
- "0.7보다 안되는 부분이 더 많고 오류난 부분도 더 많음"
- "작은 목표가 큰 틀을 다 망가뜨려서 그 작은 목표만 완성"
- audit 시스템 4개로 증식 (form vision은 1개 — skill 후보군에만)

#### 원인
- v0.7 (commit `ab4cc32`) 이후 narrow fix 누적이 큰 틀의 가정 침식

**RESPEC v1 해결**: cleanup-in-place 포기, fresh impl로 전환. wrong-axis 코드 (librarian fact_type 분류, audit, validators, skills 시스템 등) 전부 폐기. 새 vision (시간 + 태그 + embedding) 기반 새 구조.

---

## 반복 검출된 패턴 (메모리 cross-ref)

- `feedback_root_cause_not_eyeball_fix.md` — narrow-first reflex
- `feedback_drift_via_narrow_fix.md` — 작은 목표가 큰 틀 깨는 drift (4-29 신규)
- `project_audit_only_for_skills.md` — Form vision 명문화 (4-29)
- `feedback_phase_enforcement_recheck.md` — 매 ship 시 Phase 1 재검증
- `feedback_fact_type_axis_drift.md` — 4-29 fact_type axis catch
- `feedback_structure_over_local_fix.md` — 4-29 form 가이드 원칙
- `project_basic_memory_real_vision.md` — RESPEC vision ground truth
