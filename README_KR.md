# mcp-agents-memory (v0.5.3)

멀티 에이전트 공유 장기 기억 MCP 서버.  
AI 에이전트(Claude, Gemini, GPT 등)가 세션을 넘어서 **자율적으로 기억을 추출, 분류, 관리**할 수 있게 해주는 MCP 서버입니다.

## 🚀 v0.5 주요 개선 사항 (Provenance Layer)

- **🔐 출처 관리(Provenance Layer)**: 모든 기억에 대해 어떤 AI 모델(Sonnet 3.5, GPT-4o 등)과 어떤 플랫폼(Claude Code, 터미널 등)이 생성했는지 추적합니다.
- **🤖 자동 등록**: 처음 사용되는 모델이나 플랫폼은 기본 신뢰도와 함께 자동으로 시스템에 등록됩니다.
- **⚖️ 신뢰도 기반 확신도**: 기억의 신뢰성을 `실질 확신도(Effective Confidence)` (모델 신뢰도 × 플랫폼 신뢰도 × 사실 확신도)로 계산합니다.
- **🛡️ 트랜잭션 안정성**: `PoolClient` 트랜잭션을 도입하여 복잡한 배치 작업 중 데이터 무결성을 보장합니다.
- **🔄 모순 감지 세이프티 넷**: 벡터 유사도와 최신 사실 기반 Fallback을 결합하여 모순 감지 정확도를 높였습니다.

## 주요 기능

- **📚 Librarian AI**: 대화 원문을 자동으로 분석 → 핵심 사실(fact) 추출, 분류, 저장
- **⚡ 모순 해결(Contradiction Resolution)**: "서울 거주" → "부산 이사" 같은 모순을 자동 감지하고 기존 기억을 업데이트(Supersede)합니다.
- **🧠 스마트 브리핑**: 세션 시작 시 유저 프로필, 프로젝트 상태, 핵심 결정사항을 한 번에 브리핑합니다.
- **🔍 시맨틱 검색**: 벡터 임베딩 기반 검색 + 유저 프로필 자동 첨부 기능을 지원합니다.
- **🔐 SSH 터널링**: 원격 DB에 안전하게 접속하며, 안정적인 연결 관리 기능을 제공합니다.
- **🤖 멀티 에이전트**: 어떤 AI 모델이나 플랫폼을 사용하더라도 동일한 메모리 풀을 공유합니다.

## 기술 스택

| 분류 | 기술 |
|------|------|
| Runtime | Node.js + TypeScript |
| Protocol | @modelcontextprotocol/sdk (MCP) |
| Database | PostgreSQL + pgvector |
| Embedding | OpenAI `text-embedding-3-small` |
| Librarian | OpenAI `gpt-4o-mini` (설정 가능) |
| Validation | Zod |
| SSH | ssh2 / tunnel-ssh |

## 설치 및 설정

### 1. 설치 및 빌드

```bash
npm install
npm run build
```

### 2. 설정 위저드 실행

```bash
npm run setup
```

DB 연결, SSH 터널, OpenAI API 키를 설정하고 스키마를 자동 생성합니다.

### 3. OpenAI API 권한 확인

> ⚠️ **API 키에 다음 두 권한이 모두 필요합니다:**

| 권한 | 용도 |
|------------|------|
| **Embeddings** (`/v1/embeddings`) | 시맨틱 검색용 벡터 생성 |
| **Chat completions** (`/v1/chat/completions`) | Librarian AI 사실 추출 |

### 4. Claude Code에 연결

```bash
claude mcp add mcp-agents-memory node /path/to/build/index.js
```

## 도구(Tools) (v0.5)

### 🚨 세션 초기화
| 도구 | 설명 |
|------|-------------|
| `memory_startup` | **필수 최초 호출.** 유저 프로필 + 프로젝트 상태 + 핵심 결정/학습을 구조화된 브리핑으로 반환합니다. |

### 💾 메모리 조작
| 도구 | 설명 |
|------|-------------|
| `memory_add` | 원문 텍스트 → Librarian AI 분석 → 사실 추출 → 분류 → 모순 해결 → 출처 정보와 함께 저장합니다. |
| `memory_search` | 시맨틱 + 키워드 통합 검색. 유저 프로필 자동 첨부 및 필터 기능을 지원합니다. |

### 📊 시스템
| 도구 | 설명 |
|------|-------------|
| `memory_status` | 시스템 상태: 총 사실 수, 타입별 분포, 최근 활동 및 모델 신뢰도 통계를 보여줍니다. |

## 작동 원리 — 출처 관리 레이어 (Provenance Layer)

```
에이전트가 memory_add("YoonTube 이미지 폴백을 hqdefault로 결정") 호출
                    │
                    ▼
        ┌───────────────────────┐
        │   📚 Librarian AI     │
        │   (gpt-4o-mini)       │
        └───────────┬───────────┘
                    │
                    ▼ [v0.5 출처 정보 보강]
        ┌─────────────────────────────────────────┐
        │ 1. 모델 식별 (예: Sonnet 3.5)            │
        │ 2. 플랫폼 식별 (예: Claude Code)         │
        │ 3. 실질 확신도(Effective Confidence) 계산 │
        └───────────┬─────────────────────────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │   PostgreSQL + pgvec  │
        │   facts + provenance  │
        └───────────────────────┘
```

## 아키텍처

```
┌─────────────────┐     ┌──────────────┐     ┌──────────────┐
│   Claude Code   │     │   Gemini     │     │     GPT      │
│  (Hook System)  │     │              │     │              │
└────────┬────────┘     └──────┬───────┘     └──────┬───────┘
         │                     │                     │
         └─────────────────────┼─────────────────────┘
                                │
                    ┌──────────▼──────────┐
                    │   MCP Protocol      │
                    └──────────┬──────────┘
                                │
                    ┌──────────▼──────────┐
                    │  mcp-agents-memory  │
                    │  ┌───────────────┐  │
                    │  │  tools.ts     │  │  ← 4 MCP 도구
                    │  │  librarian.ts │  │  ← 사실 추출 + 출처 관리
                    │  │  db.ts        │  │  ← 트랜잭션 관리자
                    │  └───────┬───────┘  │
                    └──────────┼──────────┘
                                │
                    ┌──────────▼──────────┐
                    │  PostgreSQL + pgvec │
                    │  models + platforms │  ← v0.5 신규 추가
                    │  subjects + facts   │
                    └─────────────────────┘
```

## 데이터베이스 스키마 (v0.5)

### 핵심 테이블
- **models**: AI 모델별 신뢰도 및 메타데이터 관리
- **platforms**: 인터페이스(터미널, VSCode 등)별 신뢰도 관리
- **provenance**: 기억과 모델, 플랫폼, 세션 정보를 연결
- **subjects**: 유저, 에이전트, 프로젝트 등 주체 관리
- **facts**: 실제 기억 데이터 및 임베딩 저장

### 사실 타입(fact_type) 종류
`preference`, `profile`, `state`, `skill`, `decision`, `learning`, `relationship`.

## 환경 변수

| 변수명 | 필수 | 기본값 | 설명 |
|----------|:--------:|---------|-------------|
| `DB_HOST` | ✅ | `localhost` | PostgreSQL 호스트 |
| `DB_PASS` | ✅ | — | DB 비밀번호 |
| `OPENAI_API_KEY` | ✅ | — | OpenAI API 키 |
| `LIBRARIAN_MODEL` | — | `gpt-4o-mini` | 사실 추출 모델 |
| `SSH_ENABLED` | — | `false` | SSH 터널링 활성화 여부 |

## 로드맵

- [x] v0.1 — 기본 CRUD 메모리 시스템
- [x] v0.2 — 동적 주체 생성, pgvector 시맨틱 검색
- [x] v0.3 — 스마트 브리핑, 원자적 저장 강제
- [x] v0.4 — Librarian 엔진 (자동 추출 및 해결)
- [x] v0.5 — **출처 관리 레이어** (모델/플랫폼 신뢰도 + 안정화) ← **현재**
- [ ] v0.6 — **스킬 시스템**: 프로젝트 규칙 및 학습된 휴리스틱 관리
- [ ] v0.8 — **자율 메모리**: 자동 만료 및 기억 그래프 연관 추론
- [ ] v1.0 — **프로덕션 준비**: npm 배포 및 벤치마킹

## 라이선스
MIT
