# mcp-agents-memory

Multi-agent Shared Long-term Memory MCP Server.  
AI 에이전트(Claude, Gemini, GPT 등)가 세션을 넘어서 **지속적으로 기억을 쌓고, 회상하고, 학습**할 수 있게 해주는 MCP 서버입니다.

## Tech Stack
- Node.js + TypeScript
- @modelcontextprotocol/sdk (MCP Protocol)
- PostgreSQL + pgvector (Semantic Vector Search)
- OpenAI `text-embedding-3-small` (Embeddings)
- Zod (Validation)
- ssh2 / tunnel-ssh (SSH Tunneling Support)

## Features
- **🧠 Smart Briefing**: 세션 시작 시 유저 프로필, 최근 세션, 활성 프로젝트, 학습 패턴을 한 번에 브리핑
- **🔍 Semantic Recall**: 벡터 임베딩 기반 의미 검색 + 키워드 폴백으로 정확한 기억 회상
- **💾 Atomic Memory Saving**: 사실(fact) 단위로 개별 저장하여 검색 퀄리티 극대화
- **📚 Learning System**: 작업 완료 후 성공/실패 패턴을 학습하여 미래 성능 향상
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

3. **Set OpenAI API Key** (for embeddings):
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

## Tools (v3.1)

All tools are prefixed with `memory_` for clear intent in multi-agent environments.

### 🚨 Session Initialization
| Tool | Description |
|------|-------------|
| `memory_startup` | **필수 최초 호출.** 유저 프로필 + 최근 세션 + 활성 프로젝트 + 학습 패턴을 구조화된 브리핑으로 반환 |

### 💾 Core Memory Operations
| Tool | Description |
|------|-------------|
| `memory_remember` | 장기 기억 저장. **사실(fact) 1개당 1번 호출** 원칙 |
| `memory_recall` | 시맨틱 검색으로 관련 기억 회상. subject_key 생략 시 전체 검색 |

### 📋 Task & Session Tracking
| Tool | Description |
|------|-------------|
| `memory_log_task` | 태스크 생성 |
| `memory_complete_task` | 태스크 완료 및 결과 기록 |
| `memory_log_session` | AI 세션 시작 로깅 |
| `memory_complete_session` | AI 세션 완료 로깅 |

### 📚 Learning System
| Tool | Description |
|------|-------------|
| `memory_learn` | 성공/실패 패턴, 휴리스틱 저장 |
| `memory_get_learnings` | 과거 학습 패턴 조회 (시맨틱 검색 지원) |

### 🗂️ Subject Management
| Tool | Description |
|------|-------------|
| `memory_get_subject` | 주체 상세 정보 조회 |
| `memory_register_subject` | 새 주체(프로젝트, 유저 등) 등록 |
| `memory_log_raw` | 비구조화 원시 데이터 기록 |

## Memory Saving Best Practices

에이전트가 기억을 저장할 때 지켜야 할 원칙:

```
❌ BAD: "오늘 YoonTube 작업하면서 이것저것 고쳤다"
✅ GOOD: 
   1. memory_remember("YoonTube Android TV는 React Native 기반")
   2. memory_remember("hq720.jpg 폴백은 hqdefault.jpg로")
   3. memory_remember("webapis.js 에러는 무시 처리 완료")
```

- **원자적 저장**: 하나의 명확한 사실(fact)만 담을 것
- **서술 금지**: "이것저것 했다" 같은 모호한 요약 금지
- **중복 방지**: 이미 저장된 사실은 다시 저장하지 않기
- **태그 필수**: 2~4개 관련 키워드 태그 부여

## Architecture

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
                    │  │  tools.ts     │  │  ← 12 MCP Tools
                    │  │  hooks.ts     │  │  ← Recall Hooks
                    │  │  embeddings.ts│  │  ← OpenAI Vectors
                    │  └───────┬───────┘  │
                    └──────────┼──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  PostgreSQL + pgvec │
                    │  (SSH Tunnel)       │
                    └─────────────────────┘
```

## Claude Code Hooks (Optional, Recommended)

MCP 서버 자체는 어떤 AI 클라이언트에서든 작동하지만, Claude Code를 사용한다면 아래 훅 설정을 `~/.claude/settings.json`에 추가하면 자동화 수준이 올라갑니다.

```jsonc
{
  "hooks": {
    // 프롬프트 입력 시 자동으로 관련 메모리 검색
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "mcp_tool",
        "server": "mcp-agents-memory",
        "tool": "memory_recall",
        "input": { "query": "${prompt}", "limit": 5 },
        "statusMessage": "관련 메모리 검색 중..."
      }]
    }],
    // 세션 종료 시 핵심 사실을 개별 저장
    "Stop": [{
      "hooks": [{
        "type": "agent",
        "prompt": "핵심 사실(fact)을 개별 memory_remember 호출로 분리 저장할 것. 서술적 요약 금지. 구체적 사실만 저장.",
        "statusMessage": "세션 메모리 저장 중..."
      }]
    }]
  }
}
```

> ⚠️ `SessionStart` 훅에서 `mcp_tool`을 사용하면 서버 초기화 시간 때문에 타임아웃이 발생할 수 있습니다. 대신 `memory_startup` 툴의 description이 에이전트를 유도하므로 별도 설정이 필요 없습니다.

## Roadmap

- [x] v1.0 — 기본 CRUD 메모리 시스템
- [x] v2.0 — 동적 주체 생성, 유연한 subject_key
- [x] v3.0 — pgvector 시맨틱 검색, 하이브리드 정렬
- [x] v3.1 — 스마트 브리핑, 원자적 저장 강제, 퀄리티 개선
- [ ] v4.0 — 툴 통합 (12개 → 3~4개: `memory_save`, `memory_search`, `memory_status`)
- [ ] v5.0 — MCP Prompts 엔드포인트, 자동 요약/압축, 메모리 만료 정책

## License
MIT
