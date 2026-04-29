# mcp-agents-memory

> 사람의 기억을 모티브로 한, AI 에이전트들이 공유하는 장기 기억 MCP 서버.

여러 에이전트(Claude, Codex, ChatGPT, Hermes-Agent, OpenClaw 등)가 세션을 넘어 동일한 메모리 풀을 공유하며, 시간 순서대로 기억을 축적·회상하도록 설계.

> **현재 fresh implementation 진행 중**. 이전 v0.x 시리즈는 `fact_type` 분류 axis로 짜여있어 form vision (시간 + 태그 + 임베딩)과 wrong axis. 상세 → [`RESPEC.md`](./RESPEC.md)

---

## 모티브

- [**supermemory**](https://supermemory.io) — 시맨틱 그래프 기반 보편적 메모리 레이어
- [**Hermes Agent**](https://github.com/NousResearch/hermes-agent) — MEMORY.md 스타일 자동 갱신, 스킬·규칙 시스템

이 두 프로젝트의 핵심을 합친 형태가 본 프로젝트의 목표.

---

## 핵심 설계

1. **사람 기억처럼 시간 순서**: 모든 대화가 시간 순서로 raw 저장. 별도 분류(fact_type) X. 시간이 지나면 태그 기반 요약 + 오래된 건 archive.
2. **자동 모델별 분리**: `agent_platform` / `agent_model` 컬럼만으로 모델별 기억 자동 분리. 별도 카테고리 만들 필요 없음.
3. **두 트랙 비동기**: Hot Path (raw 즉시 저장, 응답 빠름) ↔ Cold Path (백그라운드 사서가 1분 / 5메시지 단위로 태깅 + 임베딩).
4. **태그 중심 회상**: 단기는 최근 2-3일 raw, 장기는 태그 중심 요약. 과거 기록 필요 시 날짜 / 태그 / 키워드로 archive에서 retrieval.

---

## 아키텍처

### 두 트랙 비동기

```
┌─────────────────┐      ┌─────────────────────────┐
│  Agent          │      │ MCP Server              │
│  (Claude Code,  │ ───▶ │ ▶ Hot Path (즉시 저장)  │ ──▶ memory 테이블
│   Codex, ...)   │      └─────────────────────────┘     (raw + role + platform/model)
└─────────────────┘                  │
                                     │  p_tag/d_tag/embedding NULL인 row 누적
                                     ▼
                        ┌─────────────────────────────┐
                        │ Cold Path (1분 / 5메시지)   │
                        │  ├─ Tagger (gemini-2.5-flash)│ ──▶ p_tag, d_tag
                        │  └─ Embedder (3-large)      │ ──▶ embedding
                        └─────────────────────────────┘
                                     │  빈칸 UPDATE
                                     ▼
                        ┌─────────────────────────────┐
                        │ Librarian (memory → user)   │ ──▶ user 테이블
                        │  핵심 사용자 정보 promote   │     (core_profile / sub_profile)
                        └─────────────────────────────┘
```

### 데이터 모델

**`memory` 테이블** — 시간 순서 raw 대화 저장 (단일 테이블, soft delete 아카이브)

| 컬럼 | 설명 |
|---|---|
| `user_id` | 사용자 식별 |
| `agent_platform` | claude-code / codex / chatgpt / hermes-agent / openclaw 등 |
| `agent_model` | opus-4-7 / gemini-3-pro / gpt-5.5 등 |
| `subagent` | yes / no (1-level만 추적) |
| `subagent_model` / `subagent_role` | sub일 때 채움. role은 free-form (lowercase normalize) |
| `role` | `user` / `assistant` |
| `message` | raw 본문 |
| `p_tag` | predefined (프로젝트 태그, `project_tags` 참조) |
| `d_tag` | dynamic (문맥 태그) |
| `embedding` | `vector(3072)` — text-embedding-3-large |
| `is_active` / `archived_at` | soft delete (무손실 보존) |
| `is_pinned` | `manage_knowledge`로 강제 기억된 row, archive 면제 |
| `created_at` / `updated_at` | |

**`user` 테이블** — Librarian이 memory에서 핵심 정보 promote

| 컬럼 | 설명 |
|---|---|
| `user_id` / `user_name` | |
| `core_profile` | 아주 중요한 핵심 사용자 정보 |
| `sub_profile` | 그 외 기억해야 할 사용자 정보 |
| `created_at` / `updated_at` | |

**`project_tags` 테이블** — 프로젝트 태그 누적 (Cold Path가 동적 추가)

| 컬럼 | 설명 |
|---|---|
| `id` / `name` / `description` | |
| `alias_of` | 동의어 사후 병합용 (예: "centragens" ↔ "Centrazen 프로젝트") |

---

## 메모리 로드 룰

- **단기 메모리**: 최근 2-3일 raw 그대로, 또는 8000 토큰(약 12000-16000자) 중 먼저 도달하는 것
  - 토큰 측정은 char-approximate (`char_count / 1.7`) — Hot Path latency 보호
  - 단기/장기 전환 기간은 env로 tunable (form이 직접 조정 가능)
- **모델 분리**: 기본 = 같은 `agent_platform` / `agent_model` 기억만. `p_tag` 매칭 시 (= 같은 프로젝트) 협업 agent 기억까지 포함
- **archive 검색**: 사용자 발화 컨텍스트 ("며칠 전에...") 또는 과거 기록 필요 판단 시 → 날짜 / 태그 / 키워드로 archive에서 retrieval
- **검색 fallback**: 의미 검색 (cosine) 결과 임계값 미만 시 ILIKE로 fallback (env tunable, 시작 0.3)

---

## API (Tool 2개)

### `search_memory` — 조회/검색 통합

```ts
search_memory({
  query?: string,        // 의미 검색 (vector + ILIKE fallback)
  p_tag?: string,        // 특정 프로젝트로 한정
  date_range?: string,   // 기간 한정 (예: "2026-04-29..", "last_week")
  role?: 'user' | 'assistant',  // form 발화만 / assistant 발화만 (기본 둘 다)
})
```

> "기억 안 나면 무조건 이거 하나만 써" — 에이전트가 파라미터 조합만 바꿔서 검색.

### `manage_knowledge` — 저장/수정 통합

```ts
manage_knowledge({
  action: 'add' | 'update' | 'remove',
  target: 'sub_profile' | 'memory',
  content: string,
})
```

> 사용자가 명시적으로 "이건 기억해" / "이건 지워" 할 때 사용.
> `target='memory'` 호출 = 강제 기억 (`is_pinned=true`, importance bump, archive 면제).
> `manage_knowledge`만큼은 Cold Path 거치지 않고 **즉시 sync tag + embed**. ("기억했어요" 답한 직후 바로 검색 가능 보장)

---

## 기술 스택

| 역할 | 사용 기술 |
|---|---|
| **Embedding** | OpenAI `text-embedding-3-large` (3072 dim) |
| **Tagger (Cold Path)** | Google `gemini-2.5-flash` (predefined + dynamic) |
| **검색 fallback** | PostgreSQL `ILIKE` (cosine 임계값 미만 시) |
| **DB** | PostgreSQL + pgvector |
| **Librarian (memory → user)** | TBD (form vision 결정 후) |
| **Skill 시스템** | TBD (다음 라운드) |

---

## 환경변수 (계획)

```bash
# DB
DB_HOST=...
DB_PORT=5432
DB_USER=...
DB_PASS=...
DB_NAME=...

# SSH tunnel (옵션)
SSH_ENABLED=true
SSH_HOST=...

# 모델
EMBEDDING_MODEL=text-embedding-3-large
TAGGER_MODEL=gemini-2.5-flash
OPENAI_API_KEY=...
GEMINI_API_KEY=...

# Hot/Cold path 제어
COLD_PATH_INTERVAL_SEC=60          # 1분 단위 스케줄
COLD_PATH_BATCH_SIZE=5             # 또는 5메시지 단위

# 메모리 로드 tunable
SHORT_TERM_DAYS=3                  # 단기 메모리 윈도우
SHORT_TERM_TOKEN_LIMIT=8000        # 토큰 리밋 (char-approx)
SEARCH_FALLBACK_THRESHOLD=0.3      # cosine 미만 시 ILIKE fallback

# Agent 식별 (caller가 self-report)
AGENT_PLATFORM=claude-code
AGENT_MODEL=opus-4-7
AGENT_KEY=...                      # 옵션, multi-persona 구분용
```

---

## 상태

| 항목 | 상태 |
|---|---|
| `RESPEC.md` 작성 (vision + 결정사항 + nuance + 살릴 자산 / 폐기 코드) | ✅ Done |
| 새 schema SQL (migration 019) | ✅ Done — `users` + `memory` + `project_tags` 3테이블 |
| Hot Path 구현 (즉시 raw INSERT) | ✅ Done |
| Cold Path 구현 (tagger gemini-2.5-flash + embedder 3-large + worker SKIP LOCKED) | ✅ Done |
| Librarian 구현 (memory → user.core/sub_profile promote) | ✅ Done |
| MCP Tools (`search_memory` + `manage_knowledge`) | ✅ Done |
| Migration (legacy ~3582 row → archive 보존 + 재임베딩) | ✅ Done |
| 핵심 정체성 promote (user.core_profile / sub_profile) | ✅ Done — Librarian draft + form review |
| Skill 트랙 정리 | ⏳ form 결정 보류, 차후 |

---

## 참조 문서

- [`RESPEC.md`](./RESPEC.md) — 현재 vision + 회의 결정사항 + 구현 detail (단일 진실 원천)
- [`SPEC.md`](./SPEC.md) — 구 SPEC (v0.x 역사 보존, 일부 §3.4 Memory Tier가 본 vision의 원형)
- [`PROBLEMS.md`](./PROBLEMS.md) — 현재 진행 중 cleanup 단계 / 진단 결과

---

## 가이드 원칙

> 눈앞 문제 해결한다고 전체 구조가 망가지면 안 됨.

매 작업/제안 시 RESPEC.md vision 정합 검증 → "이 fix가 큰 틀과 맞나?" 확인 후 진행.
"일단 돌게만 만들자"는 멈춤 신호.

---

*Status: fresh implementation 준비 단계. 실제 구현은 form 결정 후 진행.*
