# mcp-agents-memory (v0.5.3)

Multi-agent Shared Long-term Memory MCP Server.  
An MCP server that enables AI agents (Claude, Gemini, GPT, etc.) to **autonomously extract, classify, and manage memories** across sessions.

## 🚀 Key Improvements in v0.5 (Provenance Layer)

- **🔐 Provenance Layer**: Every memory is now tracked with its origin—which AI model (e.g., Sonnet 3.5, GPT-4o) and which platform (e.g., Claude Code, Terminal) created it.
- **🤖 Auto-Registration**: Unknown models and platforms are automatically registered upon first use with default trust weights.
- **⚖️ Trust-Based Confidence**: Memory reliability is now calculated as `Effective Confidence` (Model Trust × Platform Trust × Fact Confidence).
- **🛡️ Transaction Safety**: Implementation of `PoolClient` transactions ensuring data integrity during complex batch operations.
- **🔄 Contradiction Safety Net**: Enhanced detection using a hybrid approach (Vector Similarity + Recent Fact Fallback).

## Features

- **📚 Librarian AI**: Automatically analyzes conversation history → extracts, classifies, and stores core facts.
- **⚡ Contradiction Resolution**: Automatically detects and updates conflicting information (e.g., "Lives in Seoul" → "Moved to Busan").
- **🧠 Smart Briefing**: Provides a structured briefing of user profile, project status, and key decisions at the start of a session.
- **🔍 Semantic Search**: Vector embedding-based search with automatic user profile attachment.
- **🔐 SSH Tunneling**: Secure access to remote databases with robust connection management.
- **🤖 Multi-Agent**: Share the same memory pool across any AI model or platform.

## Tech Stack

| Category | Technology |
|----------|------------|
| Runtime | Node.js + TypeScript |
| Protocol | @modelcontextprotocol/sdk (MCP) |
| Database | PostgreSQL + pgvector |
| Embedding | OpenAI `text-embedding-3-small` |
| Librarian | OpenAI `gpt-4o-mini` (configurable) |
| Validation | Zod |
| SSH | ssh2 / tunnel-ssh |

## Setup

### 1. Install & Build

```bash
npm install
npm run build
```

### 2. Run Setup Wizard

```bash
npm run setup
```

Configures DB connection, SSH tunnel, OpenAI API keys, and automatically creates the schema.

### 3. OpenAI API Permissions

> ⚠️ **Ensure your API key has these two permissions:**

| Permission | Usage |
|------------|-------|
| **Embeddings** (`/v1/embeddings`) | Generating vectors for semantic search |
| **Chat completions** (`/v1/chat/completions`) | Fact extraction by Librarian AI |

### 4. Connect to Claude Code

```bash
claude mcp add mcp-agents-memory node /path/to/build/index.js
```

## Tools (v0.5)

### 🚨 Session Initialization
| Tool | Description |
|------|-------------|
| `memory_startup` | **MANDATORY FIRST CALL.** Returns user profile + project state + key decisions/learnings. |

### 💾 Memory Operations
| Tool | Description |
|------|-------------|
| `memory_add` | Raw text → Librarian AI analysis → Fact extraction → Classification → Contradiction resolution → Saved with Provenance. |
| `memory_search` | Integrated semantic + keyword search. Supports subject/type/tag filters. |

### 📊 System
| Tool | Description |
|------|-------------|
| `memory_status` | System health: Fact counts, type distribution, recent activity, and model trust statistics. |

## How It Works — Provenance Layer

```
Agent calls memory_add("Decided to use hqdefault as fallback for YoonTube")
                    │
                    ▼
        ┌───────────────────────┐
        │   📚 Librarian AI     │
        │   (gpt-4o-mini)       │
        └───────────┬───────────┘
                    │
                    ▼ [v0.5 Provenance Enrichment]
        ┌─────────────────────────────────────────┐
        │ 1. Identify Model (e.g. Sonnet 3.5)     │
        │ 2. Identify Platform (e.g. Claude Code) │
        │ 3. Calculate Effective Confidence       │
        └───────────┬─────────────────────────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │   PostgreSQL + pgvec  │
        │   facts + provenance  │
        └───────────────────────┘
```

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
                    └──────────┬──────────┘
                                │
                    ┌──────────▼──────────┐
                    │  mcp-agents-memory  │
                    │  ┌───────────────┐  │
                    │  │  tools.ts     │  │  ← 4 MCP Tools
                    │  │  librarian.ts │  │  ← Fact Extraction + Provenance
                    │  │  db.ts        │  │  ← Transaction Manager
                    │  └───────┬───────┘  │
                    └──────────┼──────────┘
                                │
                    ┌──────────▼──────────┐
                    │  PostgreSQL + pgvec │
                    │  models + platforms │  ← New in v0.5
                    │  subjects + facts   │
                    └─────────────────────┘
```

## Database Schema (v0.5)

### Core Tables
- **models**: Trust weights and metadata for AI models.
- **platforms**: Trust weights for platforms/interfaces.
- **provenance**: Links facts to specific models, platforms, and sessions.
- **subjects**: Entities like users, agents, and projects.
- **facts**: The actual memories with embeddings and metadata.

### fact_type categories
`preference`, `profile`, `state`, `skill`, `decision`, `learning`, `relationship`.

## Environment Variables

| Variable | Required | Default | Description |
|----------|:--------:|---------|-------------|
| `DB_HOST` | ✅ | `localhost` | PostgreSQL host |
| `DB_PASS` | ✅ | — | DB password |
| `OPENAI_API_KEY` | ✅ | — | OpenAI API Key |
| `LIBRARIAN_MODEL` | — | `gpt-4o-mini` | Fact extraction model |
| `SSH_ENABLED` | — | `false` | Enable SSH Tunneling |

## Roadmap

- [x] v0.1 — Basic CRUD memory system
- [x] v0.2 — Dynamic subjects, pgvector semantic search
- [x] v0.3 — Smart briefing, atomic saves
- [x] v0.4 — Librarian Engine (Auto extraction + resolution)
- [x] v0.5 — **Provenance Layer** (Model/Platform trust + Hardening) ← **Current**
- [ ] v0.6 — **Skill System**: Project rules and learned heuristics
- [ ] v0.8 — **Autonomous Memory**: Auto-forgetting and memory graphs
- [ ] v1.0 — **Production Ready**: npm publish and benchmarks

## License
MIT
