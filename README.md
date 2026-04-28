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

### Install

```bash
npm i -g mcp-agents-memory
```

### Configure

```bash
mcp-agents-memory setup
```

The interactive wizard:
- Prompts for your Postgres connection (cloud provider with `pgvector` recommended — [Neon](https://neon.tech) and [Supabase](https://supabase.com) both have free tiers; URL must end with `?sslmode=require`).
- Asks for the required OpenAI key (embeddings).
- Lets you pick a Librarian model preset (see below).
- Writes config to `~/.config/mcp-agents-memory/.env`.
- Applies the base schema and runs all migrations idempotently.

### Add to your MCP client

Claude Desktop / Claude Code / any MCP-aware client:

```json
{
  "mcpServers": {
    "memory": {
      "command": "mcp-agents-memory",
      "env": {
        "AGENT_KEY": "agent_claude",
        "AGENT_PLATFORM": "claude-code"
      }
    }
  }
}
```

`AGENT_PLATFORM` is recorded as the Curator's harness identity on every memory_add call. The Curator's model is captured per-call (defaulting to the Producer's author_model) — set explicitly via the curator_model argument when an orchestrator saves memories on behalf of a different model (e.g. delegating to a subagent). This avoids the staleness that env-static model values would introduce when /model swaps mid-session.

### Cross-machine memory

On a second computer, run `npm i -g mcp-agents-memory` and `mcp-agents-memory setup` pointing to the **same** `DATABASE_URL`. Memory shares automatically — the database is the source of truth and the MCP server is stateless.

### CLI

- `mcp-agents-memory` — run the MCP server (stdio).
- `mcp-agents-memory setup` — interactive wizard (writes XDG config, applies schema + migrations).
- `mcp-agents-memory migrate` — apply pending migrations against an already-configured database.
- `mcp-agents-memory help` — show help.

### Local development

For self-hosted Postgres or working on the codebase directly:

```bash
git clone https://github.com/a3lab01create-bit/mcp-agents-memory.git
cd mcp-agents-memory
npm install
npm run build
npm run setup
```

Config search order: `$MEMORY_CONFIG_PATH` → `./.env` → `~/.config/mcp-agents-memory/.env` → `<package>/.env`. Project-root `.env` wins for dev workflows.

### Requirements
- PostgreSQL ≥ 14 with the `pgvector` extension.
- **Required API key**: OpenAI (embeddings).
- **Optional API keys**: depends on the wizard preset you pick (see below).

### Model presets

The wizard offers four presets for the always-on Librarian roles. Every role still accepts `<ROLE>_PROVIDER` and `<ROLE>_MODEL` env overrides if you want to mix and match.

| Preset | Triage | Extract | Audit | Contradiction | Required keys |
|---|---|---|---|---|---|
| **Recommended** | gemini-2.5-flash-lite | gpt-4o-mini | gpt-4o-mini | gpt-4o-mini | OpenAI + Google |
| OpenAI only | gpt-4o-mini | gpt-4o-mini | gpt-4o-mini | gpt-4o-mini | OpenAI |
| Anthropic only | claude-haiku-4-5 | claude-haiku-4-5 | claude-haiku-4-5 | claude-haiku-4-5 | Anthropic |
| Premium | gemini-2.5-flash | gpt-4o-mini | grok-4.20-0309-reasoning | grok-4.20-0309-reasoning | OpenAI + Google + xAI |

Grounding roles (`skill_auditor` + `memory_auditor`) default to `claude-sonnet-4-6` and only fire when `PROMOTION_ENABLED` / `MEMORY_AUDIT_ENABLED` are on. Sonnet calls use prompt caching automatically — repeat audits within 5 minutes hit at ~10× cheaper rate.

## Roadmap

- [x] v0.4 — Librarian Engine (Auto extraction + resolution)
- [x] v0.5 — Provenance Layer (Model/Platform tracking)
- [x] v0.6 — **Knowledge Evolution**: Tiered Memory + Skill Grounding
- [x] v4.5 — Skill System closure (Curator + Auditor + Promotion + Injector filtering)
- [x] v5.0 — Memory Graph + External Knowledge Grounding + Auto Forgetting + memory_restore
- [x] **Connectors v1**: Notion page ingestion (`connector_sync` MCP tool)
- [ ] **Connectors v2**: Notion database iteration, GitHub, Drive
- [ ] v1.0 — **Production Ready**: Full benchmark and stability

## Credits

Built by **Hoon** ([triplealab](https://github.com/a3lab01create-bit)) in collaboration with **Claude** (Anthropic) and **Codex** (OpenAI). Most of v0.5 / v0.6 / v4.5 / v5.0 was designed and implemented through iterative human-AI pair programming — eating our own dog food on the same memory and skill systems this server provides.

## License
MIT
