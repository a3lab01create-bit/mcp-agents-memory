# mcp-agents-memory — 기획서 (v0.x archive)

> ⚠️ **2026-04-29: 본 SPEC.md는 archive로 전환됨.**
>
> v0.x 시리즈의 fact_type 분류 axis가 form vision (시간 기반 + 태그 + embedding)과
> wrong axis임이 4-29 catch됨. fresh impl로 전환 (RESPEC v1).
>
> **현재 active 단일 진실 원천**: [`RESPEC.md`](./RESPEC.md)
>
> 본 SPEC.md는 v0.x 운영 중의 기록 + drift 사고 evidence 보존을 위해 keep.
> §3.4 Memory Tier (short_term / long_term / archive 무손실 캐시 계층)는
> RESPEC v1에서 정확히 같은 vision으로 부활.

---

> 이 문서는 README와 별도로 유지되는 **단일 진실 원천(Single Source of Truth)** 기획서입니다.
> AI 협업 중 비전이 표류하지 않도록 모든 작업은 이 문서를 기준점으로 삼습니다.

---

## 1. 프로젝트 정체성

**Multi-agent Shared Long-term Memory MCP Server.**

여러 AI 에이전트(Claude, Gemini, GPT 등)가 **세션을 넘어 동일한 메모리 풀을 공유**하며 자율적으로 기억을 축적·회상·학습할 수 있게 하는 MCP 서버.

단순한 "메모리 DB"가 아니라, 학습된 패턴이 **운영 규칙(Skill)으로 진화**하고, 외부 권위 있는 지식과 **통합·정합되어** 저장되는 자율적 기억 시스템.

기본 메모리 저장 방향 : 사람의 기억을 예로들면 단기기억과 장기기억 이 존재한다
접속시 최초로 불러들이는 메모리는 예를 들어 최근 1달 정도로 제한하고 (리소스절약 등의 문제로),
오래된 기억들은 중요한 부분들만 로드하는 방식

특정 업무의 노하우 정리 : 대화 속에 마무리된 프로젝트나 끝난 업무들은 노하우를 별도로 저장해줘서 관련업무시
바로바로 활용할 수 있는 구조 (skill 같은 형태로 혹은 더 효율적인 방법이 있을까? 아마 글로벌하게 쓰기에는 skill 방식이 제일 좋을것 같음) *노하우도 시간에따라 업데이트되거나 수정이 되어야 하기 때문에 이 부분도 고려해 줘야함*

---

## 2. 참조 프로젝트

| 프로젝트 | 역할 | URL |
|---|---|---|
| **supermemory** | 시맨틱 그래프 기반 보편적 메모리 레이어 | https://github.com/supermemoryai/supermemory |
| **Hermes Agent** | MEMORY.md 스타일 자동 갱신 스킬/규칙 시스템 | https://github.com/NousResearch/hermes-agent |

이 두 프로젝트의 핵심 가치를 결합한 형태가 본 프로젝트의 목표.

---

## 3. 핵심 비전 (사용자 정의)

### 3.1 Provenance — "어떤 모델이 어디서 말했나"

같은 Gemini라도 CLI와 Antigravity에서 동작이 다르다. 즉 모든 fact는 다음 튜플로 기록되어야 함:

```
fact = (content, author_model, platform, session, timestamp)
```

(model, platform) 페어가 정확히 추적되어야 더 정밀한 신뢰도/재현성 분석이 가능.

### 3.2 Trust Weight — "외부 권위 소스의 신뢰도"

`trust_weight`는 **외부 권위 소스(논문, 공식 문서, 권위 도메인)의 가중치**를 의미.
사후에 "어느 모델이 말했냐"를 가중하는 게 아니라, **저장 시점에 외부 지식과 비교·통합·정합하여 reconciled 버전을 기록**하는 데 쓰임.
직접 진행했던 프로젝트 기록들과 비슷한 외부 기록이나 관련 논문등을 검색하여 skill로 만들기 전에 신뢰도를 검증하고 보충할 내용을 얻는 과정으로 생각하면 좋을듯.

### 3.3 Skill — "기억이 행동 규칙으로 진화"

반복 학습 패턴이 일정 threshold를 넘으면 자동으로 **스킬**로 승격. 스킬은 저장 시 외부 지식(논문/웹)과 비교·통합되어 정확도가 검증됨. `memory_startup` 호출 시 활성 프로젝트의 관련 스킬이 시스템 프롬프트에 자동 주입됨.

### 3.4 Memory Tier — 무손실 캐시 계층

사람의 망각을 모방하지 않음. 모든 기억은 보존되되 **로딩 거리만 조정**.

```
저장               일정 기간 후              필요 시
────              ──────────────            ──────
short_term  ──→   long_term         ──→     full retrieval
(최근 1달)        (우선순위 ↓, 보존)         (시맨틱 매칭 시 풀 디테일)
풀 디테일         메타만 평소 로드            즉시 호출
```

- **저장**: 모두 무손실 (DELETE 없음)
- **세션 시작 로딩**: 최근 short_term + 오래된 것의 메타만
- **검색 매칭**: long_term이 시맨틱 검색에 적중하면 풀 디테일 즉시 호출
- **Consolidation Worker**: 주기적으로 시간/access_count/importance 기반 tier 전환

### 3.5 Skill System — Versioning + Validation Tier

#### 3.5.1 Versioning 정책 (유사도 기반 분기)

| 유사도 | 처리 | 형태 |
|---|---|---|
| **≥ 90%** | (II) 누적 | 한 스킬 안에 `[날짜, 출처]` 주석 형태로 변경 이력 추가 |
| **< 90%** | (III) 새 버전 분기 | 옛 버전 `inactive` 보존, 새 버전 `active`, `parent_skill_id`로 연결 |

#### 3.5.2 Validation Tier (검증 자료 부족 현실 대응)

| 등급 | 의미 |
|---|---|
| `validated_external` | 외부 권위 소스 인용 가능 (논문/공식문서) |
| `validated_internal` | 외부 자료 부족하나 내부 반복 패턴으로 충분히 검증됨 |
| `unvalidated` | 일단 저장, 검증 미완 |
| `contested` | 외부 ↔ 내부 충돌 |
| `pending_revalidation` | 시간 지나 재검증 대기 |

스킬은 모든 등급에서 사용되되 **신뢰 배지가 다름**. Skill Auditor가 주기적으로 `internal`/`unvalidated` 스킬을 재검증하여 등급 업그레이드 시도.

### 3.6 전담 에이전트 (Librarian Pattern Extension)

스킬 영역도 Librarian 스타일로 책임 분리. 각자 적정 비용 모델 사용.

| 에이전트 | 책임 | 적정 모델 |
|---|---|---|
| **Skill Curator** | 메모리 클러스터 감시, 스킬 후보 식별 | Flash/Haiku (백그라운드) |
| **Skill Auditor** | 외부 grounding + reconcile + 등급 부여 | Sonnet/Gemini Pro |
| **Skill Updater** | 유사도 측정 → 누적 vs 분기 판단 | Flash + 임베딩 |
| **Skill Injector** | memory_startup에서 활성 스킬 큐레이션·주입 | Flash |

ModelRegistry에 4 role 추가로 통합 (`skill_curator`, `skill_auditor`, `skill_updater`, `skill_injector`).

---

## 4. 전체 아키텍처 흐름도

```
┌────────────────────────────────────────────────────────────────────┐
│        memory_add(text, author_model, platform, session_id)       │
└─────────────────────────────────┬──────────────────────────────────┘
                                  ▼
                    ┌──────────────────────────┐
                    │   Librarian Engine       │
                    │   Triage → Extract →     │  ⚙ Gemini + OpenAI
                    │   Audit                  │    (+ xAI/Anthropic 선택)
                    └────────────┬─────────────┘
                                 ▼
                    ┌──────────────────────────┐
                    │  Contradiction Resolver  │  ⚙ OpenAI (callRole)
                    └────────────┬─────────────┘
                                 ▼
              ┌─────────────────────────────────────┐
              │  memories (tier='short_term')       │
              │  partition: (author_model, platform)│  ⚙ Postgres + pgvector
              └────────────────┬────────────────────┘
                               │ time/access/importance
                               ▼
              ┌─────────────────────────────────────┐
              │  Consolidation Worker (주기 실행)    │
              │  short_term → long_term (무손실)     │
              └─────────────────────────────────────┘

═══════════════ Skill Track (직교축, 모든 model/platform 공유) ════════════════

         memories ──┐
                    ▼
              ┌──────────────────┐
              │  Skill Curator   │  ⚙ Flash (백그라운드)
              │  클러스터 감시  │
              └─────────┬────────┘
                        ▼
              ┌──────────────────┐
              │  Skill Auditor   │  ⚙ Tavily (현재성)
              │  외부 grounding  │  ⚙ Exa (권위)
              │  + reconcile     │  ⚙ Sonnet/Gemini Pro (Reconciler)
              └─────────┬────────┘
                        ▼
       ┌────────────────────────────────────────────┐
       │  skills table                              │
       │  validation_tier, parent_skill_id, history │  ⚙ Postgres
       └────────┬─────────────────────┬─────────────┘
                ▼                     ▼
       ┌──────────────┐      ┌────────────────────┐
       │ Updater      │      │ Injector           │  ⚙ Flash
       │ 누적/분기    │      │ memory_startup     │
       └──────────────┘      └────────────────────┘
```

### 4.1 API 매핑 표

| 파이프라인 단계 | 사용 API/모델 | 필수/선택 | 비고 |
|---|---|---|---|
| Embeddings | OpenAI `text-embedding-3-small` | **필수** | 모든 시맨틱 작업의 기반 |
| Triage | Gemini (e.g., gemini-3-flash) | 선택 | 미설정 시 원문 그대로 |
| Extract | OpenAI (gpt-5.x/o-series) | **필수** | Fact 추출의 핵심 |
| Audit | xAI Grok or Anthropic Claude | 선택 | 미설정 시 Audit 단계 스킵 |
| Contradiction | OpenAI (callRole) | **필수** | 모순 해결 |
| Skill Curator | Flash/Haiku | 선택 | 미설정 시 명시적 호출만 |
| **Skill Auditor — 현재성** | **Tavily** | **필수** | Skill grounding 핵심 |
| **Skill Auditor — 권위** | **Exa** | **필수** | Skill grounding 핵심 |
| Skill Auditor — Reconciler | Sonnet/Gemini Pro | 선택 | 미설정 시 단순 합성 |
| Skill Updater | Flash + 임베딩 | 선택 | 미설정 시 매번 새 버전 |
| Skill Injector | Flash | 선택 | 미설정 시 importance 기반 단순 매칭 |

> **Tavily + Exa는 둘 다 필수**로 격상됨. Skill grounding의 직무 분담(Tavily=현재성/최신 동향, Exa=권위/학술 인용)이 본 시스템의 차별 가치이기 때문. 둘 다 사용자가 이미 충전한 상태임을 가정.

---

## 5. 단계별 기능 로드맵

### Phase 1: v4.0 — Auto-Extract Engine
> "에이전트가 직접 안 불러도 알아서 기억이 쌓인다"

- [x] **Fact Extractor** — Librarian pipeline (triage → extract → audit). v0.5+에서 출하
- [x] **Contradiction Resolver** — `resolveContradiction` (callRole) 자동 모순 처리
- [x] **Auto User Profile** — `profile_static`(장기) + `profile_dynamic`(현재 맥락) tag 기반 분리 (commit `4821c6e`)
- [ ] **Tool Consolidation** — 현재 ~12 tool → 3~4개로 통합 (`memory_save`, `memory_search`, `memory_status` + startup). Phase 1 마지막 미완 항목

### Phase 2: v4.5 — Skill System
> "기억이 행동 규칙으로 진화" (Hermes MEMORY.md 스타일) — 핵심 라인 출하 완료, Project Rules는 Phase 1까지만

- [x] **Skill Promotion Engine** — Curator + Auditor 자동 결합, `PROMOTION_ENABLED` 백그라운드 루프 (project_v45_skill_promotion)
- [x] **External Knowledge Grounding** — `auditSkill` (Tavily+Exa→Sonnet 4.6 reconcile) + memory 영역은 `memory_auditor` (SYNC, `MEMORY_AUDIT_ENABLED`, fact_type='learning' 게이트)
- [x] **Skill Injection** — `memory_startup`에서 활성 스킬 top 5 ACTIVE SKILLS 섹션으로 주입 + applicable_to 필터링 (model/platform/project)
- [~] **Project Rules Engine** — **Phase 1 출하** (`applicable_to.projects` + curator propagation + accumulate union, v0.8). Phase 2 (프로젝트 규칙 자동 추출/갱신, CLAUDE.md 동기화 등)는 미시작

### Phase 3: v5.0 — Autonomous Memory
> "사람처럼 기억하고, 잊고, 연결한다"

- [x] **Auto Forgetting** — 지수 감쇠 루프 (commit `037954f`) + `memory_restore` kill-switch (commit `197cc94`)
- [x] **Memory Graph (Phase 1)** — `subject_relationships` 부활 + edge extraction + 1-hop `expand_via_graph` (commit `396c124`). Multi-hop / 본격 traversal API는 Phase 2로 이월
- [x] **MCP Prompts Endpoint** — slash commands (`/briefing` `/recall` `/save`)로 출하
- [~] **Connectors** — **Notion v1 출하** (page-only sync, commit `f2f904e`). GitHub / Google Drive / Notion DB 미시작

---

## 6. 데이터 모델 (목표 상태)

> 현재 스키마와 다를 수 있음. 본 절은 **목표** 상태를 정의.

### 6.1 핵심 엔티티

| 테이블 | 역할 |
|---|---|
| `subjects` | 사람/프로젝트/에이전트/팀/카테고리 등 주체 |
| `subject_relationships` | 주체 간 관계 (Memory Graph 토대) — v5.0 Phase 1에서 부활 (commit `396c124`), 1-hop `expand_via_graph` 와이어됨 |
| `memories` | 통합 메모리 (was `facts`). tier 컬럼 + (author_model_id, platform_id) 파티션 |
| `skills` | 스킬 본체. validation_tier, parent_skill_id로 버전 체인 |
| `skill_changelog` | 스킬 누적 변경 이력 (II 패턴 시 [날짜, 출처, 본문 변경분] 누적) |
| `fact_provenances` | (옵션) 정규화된 provenance — memories 텍스트 컬럼으로 갈음 가능 |
| `fact_validations` | 외부 소스 기반 검증 결과 (skill audit와 메모리 audit 양쪽) |
| `models` | 모델 카탈로그 (자동 등록, provenance 보존 전용 — trust 계산은 미사용) |
| `platforms` | 플랫폼 카탈로그 (자동 등록, e.g. claude-code/antigravity/cli) |
| `migration_history` | 적용된 마이그레이션 기록 |

### 6.2 memories 테이블 핵심 컬럼

```
id, content, fact_type, embedding, tags, importance
subject_id, project_subject_id          (스코프)
author_model_id  FK → models.id          ★ provenance
platform_id      FK → platforms.id       ★ 신규 (현재 누락)
session_id                               ★ provenance
tier             ENUM('short_term','long_term')   ★ 신규
consolidated_at  TIMESTAMPTZ                       ★ 신규
access_count, last_accessed_at           (consolidation 신호)
created_at, updated_at
```

### 6.3 skills 테이블 핵심 컬럼

```
id, title, content (frontmatter + body)
status            ENUM('active','inactive','deprecated')
validation_tier   ENUM('validated_external','validated_internal',
                       'unvalidated','contested','pending_revalidation')
parent_skill_id   FK → skills.id (NULL이면 최초 버전)
origin_model_ids   INTEGER[]    (어떤 모델들에서 추출됐나)
origin_platform_ids INTEGER[]   (어떤 플랫폼들에서)
sources           JSONB         (Tavily/Exa 인용 정보)
applicable_to     JSONB         (어떤 model/platform에 주입할지 — null=모든)
created_at, updated_at, last_used_at, use_count
```

### 6.4 Provenance FK 와이어

`memories` 테이블 FK 채워짐 상태:
- `author_model_id` → `models.id` (✓ 와이어됨, v0.7에서 prefix-known 자동 등록 추가)
- `platform_id` → `platforms.id` (✓ 와이어됨, librarian.ts:554 / skills.ts INSERT 경로)
- Producer/Curator split: `agent_curator_id` → `models.id` (✓ v0.6.1+에서 와이어, per-call 동적 캡처)
- Skill 트랙도 동일 (`skills.author_model_id`, `skills.platform_id`, `skills.agent_curator_id`)

`fact_provenances` 별도 테이블은 여전히 고아 — 폐기 vs 와이어 결정 필요 (§9.2).

### 6.5 모델/플랫폼 등록 정책

- **자동 등록**: 미등록 모델/플랫폼은 INSERT 시점에 자동 생성. 손수 시드 마이그레이션 금지.
- **버전 보존**: 구버전 모델은 절대 DELETE 금지 (provenance 기록). alias만 신버전에 양도(demote).

---

## 7. 외부 의존성 정책

> 4.1절 API 매핑 표가 단계별 상세. 본 절은 운영 정책.

### 7.1 필수 (Required)
- **PostgreSQL + pgvector** — 자체 호스팅
- **OpenAI** — 임베딩 + Fact Extraction + Contradiction Resolver (callRole)
- **Tavily** — Skill Auditor 현재성 채널 (Skill grounding의 절반)
- **Exa** — Skill Auditor 권위 채널 (Skill grounding의 나머지 절반)

### 7.2 선택 (Optional, graceful fallback 필수)
- **Anthropic / xAI / Google** — Audit, Reconciler, Triage 등 보조 역할. 미설정 시 OpenAI 단독으로 동작
- 보조 LLM이 있으면 비용/품질 분산 가능, 없어도 핵심 기능 동작

### 7.3 운영 원칙

- 신규 외부 의존성 추가 시 **반드시 graceful fallback 구현** (없어도 시스템 핵심 기능 동작)
- README에 **"최소 셋업"**(필수 4종)과 **"풀 셋업"**(필수+선택) 명확히 분리 표기
- 환경 변수 누락 시 즉시 throw하지 말고 경고 + 기능 비활성화
- Tavily/Exa는 Skill grounding의 정체성이라 graceful 비활성 시 **"unvalidated" 등급으로 자동 강등**

### 7.4 외부 MCP 연동 인터페이스 (Forward Compatibility Hook)

본 메모리 MCP는 향후 다른 MCP(Vision MCP, Audio MCP 등)와 같은 사용자/세션 컨텍스트를 공유할 수 있어야 함. **멀티모달 데이터(스크린샷, 표정, 음성 등) 자체는 본 프로젝트 범위 외**이며 각 MCP가 자체적으로 책임. 다만 cross-MCP 협력을 위한 다음 hook은 미리 정의해 둠.

#### 7.4.1 공유 식별자 표준

모든 외부 MCP가 다음 식별자를 동일하게 사용:

| 식별자 | 의미 |
|---|---|
| `subject_key` | 사용자/프로젝트 식별자 (cross-MCP reference 가능) |
| `session_id` | 단일 작업 세션의 시간 경계 |
| `platform` | 클라이언트 식별 (claude-code, antigravity, cli, vision-mcp 등) |

각 MCP는 자기 도메인 데이터를 자체 저장소에 두되, 위 식별자로 상호 참조 가능.

#### 7.4.2 Skill Injector — 외부 컨텍스트 신호 수신 (Optional)

`memory_startup` 또는 전용 endpoint에서 `external_context` 인자 수신:

```ts
external_context?: {
  affect?: Array<{ signal: string, probability: number }>  // 예: Vision MCP에서 전달
  current_task?: string
  active_app?: string
  // ...자유 확장 가능
}
```

Skill Injector는 이 신호를 **ranking 입력으로만** 활용 (스킬 본문 수정 X, 메모리 저장 X). 외부 MCP 미구현 시 인자 자체가 없거나 무시되고, 본 MCP는 정상 작동.

#### 7.4.3 데이터 격리 원칙

- **시각/오디오 등 raw 데이터는 본 메모리 MCP에 절대 저장 안 함**
- 그러한 데이터의 영구 저장 정책 결정은 각 도메인 MCP의 책임
- Memory MCP는 텍스트 중심 메모리만 책임 (provenance의 `platform` 필드에 `vision-mcp` 같은 라벨이 들어올 수는 있음)

---

## 8. 현재 구현 현황 (사실 기준)

### 8.1 구현됨

| 기능 | 비고 |
|---|---|
| MCP Server (stdio) + 4 tools | memory_startup/add/search/status |
| MCP Prompts (slash commands) | /briefing /recall /save |
| PostgreSQL + pgvector 스키마 | **memories**, subjects, models, platforms, fact_validations, fact_provenances, migration_history |
| **Schema Realignment (008)** | facts→memories rename + tier/platform_id/consolidated_at 컬럼 + 인덱스 + CHECK 제약 |
| **Platform 자동 등록 (`resolvePlatform`)** | librarian.ts, ON CONFLICT 기반, 캐싱 |
| **Skills 테이블 (009)** | skills + skill_changelog, embedding 인덱스, parent_skill_id 체인 |
| **Skill Updater (`updateOrCreateSkill`)** | src/skills.ts. 임베딩 유사도 ≥0.9 누적, 0.7-0.9 분기(부모 inactive), <0.7 신규 |
| **`memory_save_skill` MCP tool** | 명시적 스킬 저장 endpoint |
| **Skill Injector (`memory_startup` 통합)** | 활성 스킬 top 5를 ACTIVE SKILLS 섹션으로 자동 노출. tier 배지, 200자 미리보기, use_count 기반 정렬 |
| **Skill Injector applicable_to 필터링 + 노출 시 last_used_at 자동 갱신** | `getInjectableSkills`, `recordSkillExposure`로 model/platform 컨텍스트 필터링 + 노출 시각 추적 |
| **Skill Curator (`runCurator` + `memory_curator_run`)** | src/curator.ts (377줄). 임베딩 기반 그리디 클러스터링, LLM(`skill_curator` role)이 cluster→skill 추출, dryRun 옵션, 이미 커버된 클러스터 50% 중복 검사로 차단 |
| **Skill Auditor (`auditSkill`)** | Tavily + Exa parallel search → Sonnet 4.6 reconcile → validation_tier classification + applicable_to 추론 (models/platforms), integrated into memory_save_skill (default on) |
| **Auto User Profile (static/dynamic)** | Librarian이 추출 시 `profile_static` / `profile_dynamic` tag 부여 + normalizer로 단일화. memory_startup이 두 섹션(`👤 USER PROFILE` + `🌊 CURRENT CONTEXT`) 분리 노출. 레거시 미태깅 데이터는 static 섹션에 표시 |
| **Skill Promotion Engine (`maybeStartPromotionLoop`)** | Curator + Auditor 자동 결합, env 기반 opt-in 백그라운드 루프 (PROMOTION_ENABLED, PROMOTION_INTERVAL_MIN, PROMOTION_WARMUP_MIN) |
| **Memory Auditor (SYNC pre-save grounding)** | `memory_auditor.ts`. fact_type='learning' && importance≥7 게이트, Tavily+Exa+Sonnet reconcile, opt-in via `MEMORY_AUDIT_ENABLED`. validateFact 사후 태그와 별개 — 저장 전 통합 (commit `396c124`) |
| **Auto Forgetting (지수 감쇠 루프)** | 시간·access_count 기반 importance/confidence 자연 감쇠, 임계 미달 시 `is_active=false` (commit `037954f`) |
| **`memory_restore` MCP tool** | Auto Forgetting kill-switch — soft-delete된 메모리 복원 (commit `197cc94`) |
| **Memory Graph Phase 1 (subject_relationships 부활)** | edge extraction + 1-hop `expand_via_graph` 검색. Multi-hop traversal은 Phase 2 이월 (commit `396c124`) |
| **Notion Connector v1** | page-only passive sync, raw_memory → memories 파이프라인 통과. Notion DB iteration은 v2 이월 (commit `f2f904e`) |
| **npx packaging + cross-machine cloud Postgres** | esbuild 단일 번들 (런타임 deps 0), npm publish 0.6.0, fresh-DB schema convergence (Neon 검증). MacBook cross-machine 검증 (commit `e2c9c73`, `982f979`, `a49d818`) |
| **Producer / Curator provenance split** | `author_model` (Producer, 원문 모델) vs `agent_curator_id` / `agent_platform` (Curator, 처리 모델) 분리. v0.6.1~0.6.3에서 per-call 동적 캡처로 강화 (multi-persona 호환) |
| **Author model 자동 등록 (`resolveModel`)** | prefix-known 모델은 INSERT + FK 자동 채움, prefix-unknown은 NULL 폴백. trust_weight 폐기와 함께 v0.7에서 출하 (commit `ab4cc32`) |
| **Project scoping for skills (`applicable_to.projects`)** | JSONB 키 추가 — 프로젝트별 스킬 격리. curator propagation + accumulate union 포함. 기존 match-all 스킬은 backward compat (commit `b20e37c`) |
| **Skill injection eval harness (dev tool)** | `npm run eval` — 6개 multi-axis 시나리오로 `getInjectableSkills` 필터 동작 검증. `applicable_to.eval_run_id` cleanup tag (commit `23f6514`) |
| Librarian extraction pipeline | triage(Gemini) → extract(GPT) → audit(Grok/Claude) |
| Contradiction resolver | Round 2에서 Provider mismatch 버그 수정 |
| Migration system | migration_history 추적 + 트랜잭션 (017까지 적용) |
| ModelRegistry + assertModelProvider | provider-mismatch 컴파일 차단 |
| BoundedQueue | validateFact 동시성 제어 |
| getAuthority (URL hostname-based) | .gov/.edu/docs.* high, .org/wikipedia/mozilla medium |
| validateFact (Tavily + Exa + Grok) | 비동기 사후 태그 (Skill Auditor / Memory Auditor의 SYNC pre-save 경로와 별개) |

### 8.2 미구현 또는 미연결

| 항목 | 상태 |
|---|---|
| **Tool Consolidation** | 현재 ~12 tool. Phase 1 v4.0의 마지막 미완 항목. 3~4개로 통합 예정 (`memory_save`, `memory_search`, `memory_status` + startup) |
| **Project Rules Engine — Phase 2** | Phase 1(`applicable_to.projects` 스코핑)은 v0.8 출하. Phase 2 (프로젝트 규칙 자동 추출/갱신, CLAUDE.md 동기화 등) 미시작 |
| **Connectors — GitHub / Drive / Notion DB** | Notion 페이지 sync(v1)는 출하. 나머지 미구현 |
| **Memory Graph — Phase 2** | Phase 1 (subject_relationships + 1-hop expand)은 v5.0 출하. Multi-hop traversal / 본격 그래프 API 미구현 |
| `fact_provenances` 테이블 와이어 | 고아 (INSERT 한 번도 안 됨). 폐기 vs 와이어 결정 필요 (§9.2) |
| Consolidation Worker | 미구현 (`tier`/`consolidated_at` 컬럼만 준비됨) |
| Skill Injector — use_count 자동 갱신 | 미구현 (exposure 시 last_used_at 갱신은 구현됨; use_count 증가는 명시적 reference 추적 메커니즘 필요) |

### 8.3 진행되었으나 비전 외

| 항목 | 비고 |
|---|---|
| Selective Audit (top-5 ranker) | 비전 외 부가 기능 |
| Source Weighting in validateFact | Phase 2 Grounding의 일부로 재활용 가능 |

### 8.4 폐기됨 (Retired)

| 항목 | 상태 |
|---|---|
| **모델별 trust_weight 시스템 (effective_confidence)** | **v0.7에서 retired** (commit `ab4cc32`). `models.trust_weight`, `platforms.trust_weight`, `memories.effective_confidence` 컬럼 + `computeEffectiveConfidence` 함수 제거. 3-way design review (Codex+Gemini+advisor) 만장일치 deprecate 결론. 핵심 사유: (1) effective_confidence는 write-time freeze라 모델 demote 후 재계산 불가, (2) unknown 모델 0.8 폴백이 SOTA Penalty 야기. 향후 누가 trust 와이어를 다시 제안하면 본 항목 + commit message + project_v07_shipped 메모리 참조할 것 |

---

## 9. 결정 필요 항목 (Open Questions)

다음은 **사용자 결정**이 필요한 사항. AI는 임의로 진행하지 않음.

### 9.1 합의 완료 (대화로 결정됨)

- ✅ Memory Tier: 무손실 캐시(short_term/long_term), 망각 없음
- ✅ Skill versioning: 유사도 ≥ 90% 누적, < 90% 분기 (II + III 하이브리드)
- ✅ Validation Tier: 5단계 (external/internal/unvalidated/contested/pending_revalidation)
- ✅ 전담 에이전트 4종 (Curator/Auditor/Updater/Injector)
- ✅ Tavily + Exa 둘 다 필수 + 직무 분담 (현재성 / 권위)
- ✅ Skill Auditor 기본 모델: claude-sonnet-4-6 (env SKILL_AUDITOR_MODEL로 override)
- ✅ Skill Promotion: opt-in (PROMOTION_ENABLED=false 기본), 60분 주기 기본값, 5분 warmup
- ✅ applicable_to default = {} (matches all); pattern matching = exact string (no glob); models/platforms 키 누락 시 해당 차원 무제한
- ✅ Skill Auditor가 applicable_to를 자동 추론 (모호하면 {} 선호 — over-narrow가 over-broad보다 나쁨)
- ✅ Profile axis: tags 기반 (`profile_static` / `profile_dynamic`); 분류 모호 시 static 기본 (over-stable < over-current 비용)
- ✅ 모델/플랫폼 자동 등록 (손수 시드 폐기)
- ✅ 구버전 모델 보존 (alias만 demote)
- ✅ **Memory Auditor (memory 영역 SYNC pre-save)**: opt-in via `MEMORY_AUDIT_ENABLED`, fact_type='learning' && importance≥7 게이트만 — preference/profile/project/decision은 외부 grounding 불가능하므로 audit 확장 안 함 (v0.7 합의)
- ✅ **trust_weight 시스템 retire**: v0.7에서 컬럼 + 함수 전부 제거 (3-way review 만장일치). §8.4 참조
- ✅ **Memory Graph 부활 시점**: Phase 3 (v5.0)로 결정, Phase 1 (subject_relationships + 1-hop expand) 출하 완료
- ✅ **Project Rules Engine Phase 1**: `applicable_to.projects` JSONB 키 + curator propagation + accumulate union (v0.8)
- ✅ **Auto Forgetting 전략**: 지수 감쇠 + soft-delete (`is_active=false`) + `memory_restore` kill-switch — DELETE는 절대 안 함 (Memory Tier 무손실 원칙 준수)

### 9.2 미결정

1. **`fact_provenances` 처리**: 와이어 깔기 vs 폐기하고 memories 텍스트 컬럼만 사용 (현재 고아 상태)
2. **Skill 트리거 임계값**: 검증 자료 부족 판정을 LLM judgment 1차 + 보조 신호 (결과 개수/평균 권위) 조합으로 하기로 했는데, 구체 수식은 구현 단계에서 결정
3. **Consolidation Worker 주기**: 1일 / 1주 / 1달 / 사용자 설정 — 컬럼은 준비됨, 실제 worker 미구현
4. **Project Rules Engine Phase 2 범위**: 자동 규칙 추출 / CLAUDE.md 동기화 / 수동 vs 자동 / scope 등 — 다음 라운드 spec에서 결정
5. **Tool Consolidation 인터페이스**: 12 → 3~4개 통합 시 backward-compat shim 유지 기간, 인자 통합 방식 등 — Phase 1 마무리 라운드에서 결정

---

## 10. AI 협업 규칙

향후 본 프로젝트에서 AI(Claude, Gemini, GPT 등)와 협업 시:

1. **본 SPEC.md를 항상 먼저 읽고** 비전과 현황을 파악할 것
2. SPEC.md에 기재되지 않은 **새 기능을 임의로 도입하지 말 것**
3. AI의 평가/제안은 **사용자 결정 대기**로 표시. 임의 진행 금지
4. **새 외부 API 의존성 도입은 명시적 합의 필요**
5. 라운드 결과는 항상 **SPEC.md 8절(현재 현황)을 갱신**할 것
6. 라운드 중 **새 합의가 발생하면 SPEC.md 9.1절에 추가**할 것 (대화 휘발 방지)

---

*마지막 갱신: 2026-04-28 (v0.8.1 ship 시점 status sync)*
*본 문서는 사용자가 직접 편집·승인하기 전까지 초안 상태입니다.*

---

## 11. 기본 메모리 정합성 회복 (Active Cleanup, 4-29~)

> Form vision (4-29 명시): "embedding 제외 나머지 정합성 회복. 우선 메모리저장 + 자동저장만 잘되게. 안 되면 폐기."
>
> 본 cleanup은 v0.7 이후 narrow fix 누적이 form vision에서 drift시킨 부분(skill_auditor 외 audit 증식, transcript source 미분리, brief 필터 mismatch 등)을 좁혀 잡는 작업. 진행 중 단계 / 결과 / 의외사항은 **PROBLEMS.md**에 단계별 기록.

### 11.1 작업 모드

**(B) layered cleanup**. 코드 새로 쓰지 않음. 현재 파일 안에서 정합성 fix.
- 윗 layer (skills, audit/validators, connectors, relationship graph) — 호출 path 격리, 코드 삭제 X
- 기본 layer (memory_add, 자동저장, 단기/장기 brief, search) — vision 정합성 회복
- embedding (생성, 검색, dedup, contradiction lookup) — **그대로 유지**
- DB schema, subjects 관리, INSERT atomic 처리 — **그대로 유지**

### 11.2 Scope

**IN**: memory_add, 자동저장(transcript drain), 단기 메모리(profile_dynamic), 장기 메모리(profile_static), memory_search

**OUT**: skills 시스템 전체, memory_auditor / fact_validator (web grounding), subject_relationships graph, 모든 connectors, embedding 모델/threshold, DB schema 변경

### 11.3 Acceptance Criteria

**A. 자동저장**
- A1. transcript drain이 form 발화만 추출. assistant 답변 / system reminder / slash command 결과 / skill description은 fact source로 사용 안 함.
- A2. 새 세션 brief에 명백한 hallucination 신규 유입 0건.
- A3. drain 1회당 추출 fact 수가 cleanup 전 대비 줄거나 비슷. 폭증 X.

**B. memory_add**
- B1. form이 명확히 profile/preference 의도로 입력한 내용은 profile/preference로 분류 (state로 떨어지지 않음)
- B2. memory_add 응답 `Saved: N` 일 때 DB 실제 N row 들어감 (regression 방지)
- B3. memory_search로 저장한 키워드 retrieve 가능 (regression 방지)

**C. Brief 정합성**
- C1. brief가 form vision에 맞는 fact_type만 표시
- C2. 기존 hallucination 잘못 분류된 row는 form 직접 검토 후 cleanup (자동 X)

### 11.4 단계 (각 commit 분리, 각 단계 후 verify, 안 되면 멈춤)

PROBLEMS.md에 단계별 결과 기록.

| 단계 | 작업 | 손대는 파일 |
|---|---|---|
| 0 | 윗 layer 호출 path 격리 (env flag) | .env, librarian.ts, transcript_processor.ts |
| 1 | transcript source 분리 (User만, system/skill/slash 텍스트 거름) | transcript_processor.ts |
| 2 | EXTRACTION_SYSTEM_PROMPT 정합성 (fact_type 정의 + system context + brief 가시성 인지) | librarian.ts |
| 3 | TRIAGE_SYSTEM_PROMPT 정합성 (third-party 텍스트 거름 기준 명시) | librarian.ts |
| 4 | Brief 필터 정합성 (form vision 기준 fact_type/태그 검토) | tools.ts |
| 5 | 기존 hallucination row cleanup (form 직접 검토 후 archive) | DB 직접, archive 쿼리 |

### 11.5 Exit 기준

- 단계 1~5 완료 → form 직접 다음 세션 사용 → 평가
- **"잘됨"** → §8 현황 갱신, MEMORY.md closure 기록, 윗 layer 재활성화는 별도 결정
- **"안 됨"** → 폐기 검토 회의 (vision 재정립 또는 fresh design). 11.4 단계 결과를 evidence로 활용.

### 11.6 결정 기준 (쿠 self-evaluation 금지)

- 쿠가 "self-test 통과" 했다고 "잘됨" 판단 X
- form이 다음 세션에서 직접 사용 후 evaluation이 결정 기준
- 단계 진행 중 form vision 위반 의심되면 즉시 멈추고 confirm
