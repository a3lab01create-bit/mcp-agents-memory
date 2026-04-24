# mcp-agents-memory

Multi-agent Shared Long-term Memory MCP Server.  
AI 에이전트(Claude, Gemini, GPT 등)가 세션을 넘어서 **자율적으로 기억을 추출, 분류, 관리**할 수 있게 해주는 MCP 서버입니다.

## Tech Stack
- Node.js + TypeScript
- @modelcontextprotocol/sdk (MCP Protocol)
- PostgreSQL + pgvector (Semantic Vector Search)
- OpenAI `text-embedding-3-small` (Embeddings)
- OpenAI `gpt-4o-mini` (Librarian AI — Fact Extraction)
- Zod (Validation)
- ssh2 / tunnel-ssh (SSH Tunneling Support)

## Features
- **📚 Librarian AI**: 대화 원문을 자동으로 분석하여 핵심 사실(fact)을 추출, 분류, 저장
- **⚡ Contradiction Resolution**: "서울 거주" → "부산 이사" 같은 모순을 자동 감지 & 기존 기억 업데이트
- **🧠 Smart Briefing**: 세션 시작 시 유저 프로필, 프로젝트 상태, 핵심 결정사항을 한 번에 브리핑
- **🔍 Semantic Search**: 벡터 임베딩 기반 의미 검색 + 키워드 폴백
- **🔐 SSH Tunneling**: 원격 DB에 안전하게 접속
- **🤖 Multi-Agent**: 어떤 AI 모델이든 동일한 메모리 풀을 공유

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Run Setup Wizard**:
   ```bash
   npm run setup
   ```
   Follow the prompts to configure your DB connection and initialize the schema.

3. **Set OpenAI API Key** (for embeddings + librarian):
   ```bash
   # Add to your .env file
   OPENAI_API_KEY=sk-...
   ```

4. **Build and Start**:
   ```bash
   npm run build
   ```

5. **Connect to Claude Code**:
   ```bash
   claude mcp add mcp-agents-memory node /path/to/build/index.js
   ```

## Tools (v0.4)

4개의 핵심 도구로 통합되었습니다. (v0.3의 12개에서 대폭 축소)

### 🚨 Session Initialization
| Tool | Description |
|------|-------------|
| `memory_startup` | **필수 최초 호출.** 유저 프로필 + 프로젝트 상태 + 핵심 결정/학습을 구조화된 브리핑으로 반환 |

### 💾 Memory Operations
| Tool | Description |
|------|-------------|
| `memory_add` | 원문 텍스트를 Librarian AI가 자동 분석 → 사실 추출 → 분류 → 모순 해결 → 저장 |
| `memory_search` | 시맨틱 + 키워드 통합 검색. subject/type/tag 필터 지원 |

### 📊 System
| Tool | Description |
|------|-------------|
| `memory_status` | 메모리 시스템 상태: 총 fact 수, 타입별 분포, 최근 추가 목록 |

## How It Works — Librarian Engine

```
에이전트가 memory_add("훈님이 YoonTube에서 hq720 폴백을 hqdefault로 결정했다") 호출
                    │
                    ▼
        ┌───────────────────────┐
        │   📚 Librarian AI     │
        │   (gpt-4o-mini)       │
        │                       │
        │  1. 사실 추출          │  → "YoonTube 이미지 폴백: hq720→hqdefault"
        │  2. 타입 분류          │  → decision
        │  3. 태그 생성          │  → ['yoontube', 'thumbnail', 'fallback']
        │  4. 모순 확인          │  → 기존 "maxresdefault 사용" 사실 supersede
        │  5. 임베딩 생성        │  → vector(1536)
        └───────────┬───────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │   PostgreSQL + pgvec  │
        │   facts 테이블         │
        └───────────────────────┘
```

## Architecture (v0.4)

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
                    │   (stdio/http)      │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  mcp-agents-memory  │
                    │  ┌───────────────┐  │
                    │  │  tools.ts     │  │  ← 4 MCP Tools
                    │  │  librarian.ts │  │  ← Fact Extraction Engine
                    │  │  hooks.ts     │  │  ← Recall Hooks
                    │  │  embeddings.ts│  │  ← OpenAI Vectors
                    │  └───────┬───────┘  │
                    └──────────┼──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  PostgreSQL + pgvec │
                    │  subjects + facts   │
                    │  (SSH Tunnel)       │
                    └─────────────────────┘
```

## Database Schema (v0.4)

```sql
-- 주체 관리 (유저, 에이전트, 프로젝트 등)
subjects (id, subject_type, subject_key, display_name, is_active, metadata)

-- 통합 메모리 테이블 (모든 기억이 여기에)
facts (id, subject_id, project_subject_id, content, source_text,
       fact_type, confidence, importance, tags, embedding,
       source, access_count, superseded_by, is_active)
```

**fact_type 종류:**
| Type | 설명 | 예시 |
|------|------|------|
| `preference` | 선호도, 습관 | "한국어 소통 선호" |
| `profile` | 신상, 역할, 배경 | "풀스택 개발자" |
| `state` | 현재 상태 | "YoonTube 4K 최적화 중" |
| `skill` | 기술, 스킬 | "React Native 사용" |
| `decision` | 결정 사항 | "hq720→hqdefault 폴백" |
| `learning` | 학습, 인사이트 | "tunnel-ssh가 더 안정적" |
| `relationship` | 관계 | "TripleA Lab 소속" |

## Claude Code Hooks (Optional, Recommended)

```jsonc
{
  "hooks": {
    // 프롬프트 입력 시 자동으로 관련 메모리 검색
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "mcp_tool",
        "server": "mcp-agents-memory",
        "tool": "memory_search",
        "input": { "query": "${prompt}", "limit": 5 },
        "statusMessage": "관련 메모리 검색 중..."
      }]
    }],
    // 세션 종료 시 대화 내용을 Librarian에게 전달
    "Stop": [{
      "hooks": [{
        "type": "agent",
        "prompt": "이 세션에서 중요한 내용이 있다면 memory_add로 원문을 전달하세요. Librarian이 알아서 사실을 추출합니다.",
        "statusMessage": "세션 메모리 저장 중..."
      }]
    }]
  }
}
```

> ⚠️ `SessionStart` 훅에서 `mcp_tool`을 사용하면 서버 초기화 시간 때문에 타임아웃이 발생할 수 있습니다. 대신 `memory_startup` 툴의 description이 에이전트를 유도하므로 별도 설정이 필요 없습니다.

## Roadmap

- [x] v0.1 — 기본 CRUD 메모리 시스템
- [x] v0.2 — 동적 주체 생성, 유연한 subject_key, pgvector 시맨틱 검색
- [x] v0.3 — 스마트 브리핑, 원자적 저장 강제, 퀄리티 개선
- [x] v0.4 — **Librarian Engine** (자동 추출 + 모순 해결 + 스키마 단순화) ← **현재**

### 🔮 향후 방향 (Where We're Headed)

우리의 목표는 단순한 "메모리 DB"가 아니라, [supermemory](https://github.com/supermemoryai/supermemory)와 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 수준의 **자율적 기억 시스템**입니다.

#### 현재 갭 분석

| 기능 | supermemory | Hermes | 우리 (v0.4) | 목표 |
|------|:-----------:|:------:|:-----------:|:----:|
| 자동 사실 추출 | ✅ | ✅ | ✅ | ✅ |
| 모순 해결 (fact update) | ✅ | ✅ | ✅ | ✅ |
| 자동 만료 | ✅ | ❌ | ❌ | v0.8 |
| 유저 프로필 자동 빌드 | ✅ | ✅ | ✅ | ✅ |
| 스킬/규칙 자동 갱신 | ❌ | ✅ | ❌ | v0.6 |
| 멀티 에이전트 | ✅ | ✅ | ✅ | ✅ |
| 시맨틱 검색 | ✅ | ❌ | ✅ | ✅ |

#### Phase 2: v0.6 — 스킬 시스템 (Skill System)
> "기억이 행동 규칙으로 진화한다" (Hermes MEMORY.md 스타일)

- [ ] **Project Rules Engine**: 프로젝트별 운영 규칙을 DB에서 관리하고 자동 갱신
- [ ] **Learned Heuristics → Skills**: 반복된 학습 패턴이 일정 threshold 넘으면 자동으로 "스킬"로 승격
- [ ] **Skill Injection**: `memory_startup` 호출 시 관련 스킬을 시스템 프롬프트에 자동 주입

#### Phase 3: v0.8 — 자율 메모리 (Autonomous Memory)
> "사람처럼 기억하고, 잊고, 연결한다"

- [ ] **Auto Forgetting**: 시간/관련성 기반 자동 만료 정책
- [ ] **Memory Graph**: 기억 간 관계 그래프 → "A 작업에서 배운 걸 B에 적용" 추론
- [ ] **Connectors**: GitHub, Notion, Google Drive 등 외부 데이터 자동 동기화

#### 🎉 v1.0 — Production Ready
> "어떤 AI 에이전트든, 어떤 환경이든, 설치만 하면 사람처럼 기억한다"

- [ ] **MCP Prompts Endpoint**: 클라이언트가 자동으로 컨텍스트를 주입받는 표준 엔드포인트
- [ ] **Benchmark**: LongMemEval / LoCoMo 기준 평가
- [ ] **npm publish**: `npx mcp-agents-memory` 한 줄로 설치

## License
MIT
