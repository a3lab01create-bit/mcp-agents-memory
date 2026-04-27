# mcp-agents-memory (v0.6.0)

Multi-agent Shared Long-term Memory MCP Server.  
An MCP server that enables AI agents (Claude, Gemini, GPT, etc.) to **autonomously manage memory** and evolve knowledge into **validated operational rules (Skills)**.

## 🌟 New in v0.6: Knowledge Evolution

- **🧠 Memory Tiering**: Intelligent loading strategy mimicking human memory. Full detail for the **last 30 days** (short-term) and metadata/important summaries for older records (long-term).
- **🦾 Skill Evolution**: Repetitive patterns and project know-how automatically evolve into **Skills**. These rules are injected into the agent's system prompt to guide future actions.
- **🌐 Authority Grounding**: High-value facts are reconciled against external authority sources (**Tavily** for recency, **Exa** for authority/docs) before storage.
- **⚡ MCP Prompts (Slash Commands)**: Direct interaction via `/briefing`, `/recall <query>`, and `/save <text>` for a premium UX.
- **🔐 Cross-MCP Ready**: Standardized context hooks to share `subject_key` and `session_id` with other MCPs (Vision, Audio, etc.).

## Features

- **📚 Librarian Engine**: Multi-model pipeline (Triage → Extract → Audit) for zero-config fact extraction.
- **⚡ Contradiction Resolution**: Detects and updates conflicting information (e.g., "Lives in Seoul" → "Moved to Busan").
- **🧠 Smart Briefing**: Dynamic session startup with user profile, project context, and applicable **Skills**.
- **🔍 Semantic Search**: Vector embedding-based retrieval with automatic tier-up for matching long-term memories.
- **🔐 Unified Provenance**: Every fact is tagged with `author_model`, `platform`, and `session_id` for perfect traceability.

## 🧠 Hybrid Intelligence Tech Stack

v0.6 employs a sophisticated multi-role architecture using the best models for each specialized task.

| Role | Technology | Description |
|----------|------------|-------------|
| **Skill Auditor** | Anthropic `Sonnet` / `Gemini Pro` | **Grounding**: Reconciles facts with external docs using Tavily + Exa. |
| **Skill Curator** | Google `Gemini Flash` | **Promotion**: Monitors memory clusters to identify skill candidates. |
| **Fact Extractor** | OpenAI `gpt-4o-mini` | **Extraction**: Efficient atomic fact generation from text. |
| **Embedding** | OpenAI `text-embedding-3-small` | **Standard**: 1536-dim vector indexing for semantic search. |
| **Search (Required)** | **Tavily + Exa** | **The Two Pillars**: Tavily (Recency) + Exa (Authority/Research). |
| **Database** | PostgreSQL + pgvector | **Tiered Storage**: Tier-aware partitioning (Short/Long term). |

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌──────────────┐
│   Claude Code   │     │   Gemini     │     │     GPT      │
│ (Zero-Config)   │     │ (Autonomous) │     │ (Autonomous) │
└────────┬────────┘     └──────┬───────┘     └──────┬───────┘
         │                     │                    │
         └─────────────────────┼────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   MCP Protocol      │
                    │ (w/ instructions)   │  ← Zero-Config Entry
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐      ┌──────────────────┐
                    │  mcp-agents-memory  │      │  Skill Track     │
                    │  ┌───────────────┐  │ ───▶ │  Curator/Auditor │
                    │  │   Librarian   │  │      │  (Knowledge/Web) │
                    │  │   Engine      │  │      └────────┬─────────┘
                    │  └───────┬───────┘  │               │
                    └──────────┼──────────┘      ┌────────▼─────────┐
                               │                 │   Skills Table   │
                    ┌──────────▼──────────┐      │ (Operational)    │
                    │  PostgreSQL + pgvec │      └──────────────────┘
                    │  (Tiered Memories)  │
                    └─────────────────────┘
```

## Setup

### 1. Requirements
- PostgreSQL with `pgvector` extension.
- **Required API Keys**: OpenAI (Embeddings), Tavily, Exa.
- **Optional**: Gemini, Anthropic, xAI (for specialized roles).

### 2. Install & Build
```bash
npm install
npm run build
npm run setup  # Run Wizard for DB/API config
```

### 3. Connect
Add the server to your client (Claude Code, Antigravity, etc.).
```bash
claude mcp add mcp-agents-memory node /path/to/build/index.js
```

## Roadmap

- [x] v0.4 — Librarian Engine (Auto extraction + resolution)
- [x] v0.5 — Provenance Layer (Model/Platform tracking)
- [x] v0.6 — **Knowledge Evolution**: Tiered Memory + Skill Grounding (Current)
- [ ] v0.8 — **Memory Graph**: Advanced relationship traversal and auto-forgetting
- [ ] v1.0 — **Production Ready**: Full benchmark and stability

## License
MIT
