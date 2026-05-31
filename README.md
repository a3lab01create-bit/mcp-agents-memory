# mcp-agents-memory

> Long-term, time-ordered memory for AI agents — a shared memory pool that persists across sessions and machines, modeled on human memory.

Multiple agents (Claude Code, Codex, Gemini CLI, Grok, Antigravity, …) share **one** memory pool, accumulating and recalling memories in chronological order. Each platform/model gets its own view automatically, while project tags let collaborators see each other's relevant context.

[![npm](https://img.shields.io/npm/v/mcp-agents-memory.svg)](https://www.npmjs.com/package/mcp-agents-memory)

> 🇰🇷 한국어 README → [`README.ko.md`](./README.ko.md)
> Design rationale and decisions → [`RESPEC.md`](./RESPEC.md)

---

## Motivation

- [**supermemory**](https://supermemory.io) — a universal, semantic-graph memory layer
- [**Hermes Agent**](https://github.com/NousResearch/hermes-agent) — `MEMORY.md`-style self-updating memory, skills & rules

This project aims to combine the strengths of both: supermemory's recall and Hermes' self-curation, without their weaknesses (machine-locked storage, opaque mutation).

---

## Core design

1. **Time-ordered, like human memory** — every turn is stored raw in chronological order. No `fact_type` taxonomy. Older memories are summarized by tag and archived (soft-delete, never destroyed).
2. **Automatic per-model separation** — the `agent_platform` / `agent_model` columns alone separate memories per model. No manual categories.
3. **Two asynchronous tracks** — a **Hot Path** (instant raw INSERT, fast response) and a **Cold Path** (a background "librarian" that tags, embeds, clusters, and curates on a 1-minute / 5-message cadence).
4. **Tag-centric recall** — recent days as raw text, older history as tag-centric summaries. Anything older is retrievable from the archive by date / tag / keyword.

---

## Architecture

### Two asynchronous tracks

```
┌─────────────────┐      ┌──────────────────────────┐
│  Agent          │      │ MCP Server               │
│  (Claude Code,  │ ───▶ │ ▶ Hot Path (instant save)│ ──▶ memory table
│   Codex, ...)   │      └──────────────────────────┘     (raw + role + platform/model)
└─────────────────┘                  │
                                     │  rows with NULL p_tag/d_tag/embedding accumulate
                                     ▼
                        ┌──────────────────────────────┐
                        │ Cold Path  (1 min / 5 msgs)   │
                        │  ├─ Tagger    → p_tag, d_tag   │
                        │  ├─ Embedder  → embedding      │
                        │  ├─ Librarian → user profile   │
                        │  ├─ Clusterer → tag summaries  │
                        │  └─ AliasPromoter → tag merges │
                        └──────────────────────────────┘
```

The Cold Path's LLM roles (tagger / librarian / clusterer / project-alias judge) all run on a **single shared backend** — local `Qwen3-14B` via llama.cpp, or a cloud fallback (see [Cold Path LLM backend](#cold-path-llm-backend)).

### Data model

**`memory`** — raw, time-ordered conversation log (single table, soft-delete archive)

| Column | Notes |
|---|---|
| `user_id` | user identity |
| `agent_platform` | claude-code / codex / gemini-cli / grok / antigravity … |
| `agent_model` | e.g. opus-4-8 / gemini-3-pro / gpt-5.5 |
| `subagent` | yes / no (1 level tracked) |
| `subagent_model` / `subagent_role` | filled for subagents; role is free-form (lowercase-normalized) |
| `role` | `user` / `assistant` |
| `message` | raw body |
| `p_tag` | predefined project tag (→ `project_tags`) |
| `d_tag` | dynamic context tags |
| `embedding` | `vector(3072)` — text-embedding-3-large |
| `is_active` / `archived_at` | soft delete (lossless) |
| `is_pinned` | force-remembered via `manage_knowledge`; exempt from archival |
| `created_at` / `updated_at` | |

**`users`** — core facts the Librarian promotes out of `memory`

| Column | Notes |
|---|---|
| `user_id` / `user_name` | |
| `core_profile` | the most important, durable facts about the user |
| `sub_profile` | other facts worth remembering |

**`project_tags`** — project tags, grown dynamically by the Cold Path

| Column | Notes |
|---|---|
| `id` / `name` / `description` | |
| `alias_of` | post-hoc merge of synonyms (e.g. "centragens" ↔ "Centrazen project") |

---

## Multi-machine — server / client

When several machines share **one** database, the Cold Path (tagging / profiling / clustering / alias judging) must run on **exactly one** of them — otherwise machines double-process the same rows and double the cloud cost. The same package splits roles purely by **config**:

| | Client | Server (processing) |
|---|---|---|
| **DB** | remote (e.g. SSH tunnel) | DB host / direct |
| **Cold Path** | `COLD_PATH_ENABLED=false` | standalone daemon, always on |
| **Does** | `search` / `manage_knowledge` only | tagging · profiling · clustering · alias judging |
| **Setup** | a few `.env` lines | config + local LLM infra |

- **Client**: the MCP server your editor spawns is the terminal. Just add `COLD_PATH_ENABLED=false`.
- **Server**: run the Cold Path decoupled from the editor's lifetime, as a standalone daemon (processes even when no editor is open):
  ```bash
  mcp-agents-memory coldpath    # Cold Path worker only, no MCP server (systemd recommended)
  ```
  The daemon is a **singleton** via a PostgreSQL advisory lock — no matter how many instances exist, only the one holding the lock processes (dedup + automatic failover).

### Cold Path LLM backend

Point `LOCAL_LLM_BASE_URL` at any OpenAI-compatible endpoint to use local / self-hosted inference (llama.cpp, ollama, …). If unset, a cloud model is used; `LOCAL_GROK_FALLBACK=true` falls back to Grok when local inference fails.

> e.g. serve `Qwen3-14B` with llama.cpp `llama-server` on an AMD/NVIDIA GPU and set `LOCAL_LLM_BASE_URL=http://localhost:8080/v1` → Cold Path cloud cost ≈ $0. (A `json_schema` grammar with thinking disabled guarantees valid JSON.)

---

## Memory load rules

- **Short-term**: recent 2–3 days raw, or ~8000 tokens (whichever comes first). Token count is char-approximate (`chars / 1.7`) to protect Hot Path latency. Window is env-tunable.
- **Model separation**: by default, only memories with the same `agent_platform` / `agent_model`. A `p_tag` match (same project) pulls in collaborating agents' memories too.
- **Archive search**: on a user cue ("a few days ago…") or when older context is needed, retrieve from the archive by date / tag / keyword.
- **Search fallback**: when semantic (cosine) results fall below threshold, fall back to `ILIKE` (env-tunable, starts at 0.3).

---

## Tools

The server exposes **4 tools**. Most clients only ever need the first three; `save_message` is a fallback.

### `memory_startup` — session boot brief
Returns a markdown brief (recent conversations, active projects, user profile) so a new session picks up where the last left off. On supported clients it is injected automatically at connect; call it explicitly to refresh mid-session.

### `search_memory` — unified read / search
```ts
search_memory({
  query?: string,        // semantic search (vector + ILIKE fallback)
  p_tag?: string,        // restrict to a project
  date_range?: string,   // e.g. "2026-04-29..", "last_week"
  role?: 'user' | 'assistant',
  agent_platform?: string,      // restrict to a platform; omit or '*' = all
  device_scope?: 'local' | 'global',  // 'global' (default) = all machines; 'local' = this one
  limit?: number,        // default 10, max 50
  include_archived?: boolean,
})
```
> "When you don't remember, reach for this one." Agents just vary the parameters.

### `manage_knowledge` — unified write / edit
```ts
manage_knowledge({
  action: 'add' | 'update' | 'remove',
  target: 'sub_profile' | 'memory',
  content: string,
})
```
> Use when the user explicitly says "remember this" / "forget that".
> `target='memory'` = force-remember (`is_pinned=true`, importance bump, archive-exempt).
> `manage_knowledge` skips the Cold Path and **syncs tag + embedding immediately**, so the memory is searchable the instant you say "got it".

### `save_message` — transcript fallback
For platforms that **don't** auto-capture transcripts, the agent calls this each turn to persist the message. On auto-capturing clients (see below) it must **not** be called — that would duplicate rows.

### Automatic capture

| Platform | Auto-capture |
|---|---|
| Claude Code · Codex CLI · Gemini CLI · Grok Build · Antigravity CLI | ✅ transcript captured automatically — do **not** call `save_message` |
| Everything else | call `save_message(role=…)` each turn |

> Auto-injection of the startup brief / auto-capture depends on the **client**, not the transport — some clients (e.g. desktop/web) don't expose those hooks, so they fall back to explicit tool calls.

---

## Tech stack

| Role | Tech |
|---|---|
| **Embedding** | OpenAI `text-embedding-3-large` (3072-dim) |
| **Cold Path LLM** (tagger / librarian / clusterer / project-alias judge) | local `Qwen3-14B` (llama.cpp; `json_schema` grammar + thinking off → valid JSON), **or** cloud `grok-4-1-fast-non-reasoning` fallback — selected via `LOCAL_LLM_BASE_URL` |
| **Search fallback** | PostgreSQL `ILIKE` (below cosine threshold) |
| **DB** | PostgreSQL + pgvector |
| **Librarian** (memory → users) | shares the Cold Path backend — recency-bias-resistant curation (core identity ↔ sub work split, null-preserve), gated by env-tunable thresholds |

---

## Environment variables

See [`.env.example`](./.env.example) for the full, annotated list. The essentials:

```bash
# DB
DB_HOST=...      DB_PORT=5432   DB_USER=...   DB_PASS=...   DB_NAME=...

# Keys
OPENAI_API_KEY=...                 # embedding (required)
XAI_API_KEY=...                    # Grok (Cold Path cloud + local fallback)

# Cold Path LLM backend — OpenAI-compatible endpoint for local inference (omit → cloud)
LOCAL_LLM_BASE_URL=http://localhost:8080/v1
LOCAL_GROK_FALLBACK=true
TAGGER_PROVIDER=local              TAGGER_MODEL=qwen3-14b
LIBRARIAN_PROVIDER=local           LIBRARIAN_MODEL=qwen3-14b
LIBRARIAN_ENABLED=true

# Hot/Cold path control
COLD_PATH_ENABLED=true             # false = client terminal (no Cold Path); only the server is true
COLD_PATH_INTERVAL_SEC=60
COLD_PATH_BATCH_SIZE=5

# Memory load tunables
SHORT_TERM_DAYS=3
SHORT_TERM_TOKEN_LIMIT=8000
SEARCH_FALLBACK_THRESHOLD=0.3

# Agent identity (caller self-reports)
AGENT_PLATFORM=claude-code
AGENT_MODEL=opus-4-8
```

---

## Client setup

### Claude Code / Codex
```toml
# ~/.codex/config.toml
[mcp_servers.mcp-agents-memory]
command = "mcp-agents-memory"
args = []
```

### Gemini CLI
```json
// ~/.gemini/settings.json
{
  "mcpServers": {
    "mcp-agents-memory": {
      "type": "stdio",
      "command": "mcp-agents-memory",
      "args": [],
      "env": {},
      "trust": true
    }
  }
}
```

> Install globally with `npm i -g mcp-agents-memory`, or point `command` at a local `build/index.js`.

---

## Guiding principle

> Solving the problem in front of you must not break the whole structure.

Every change is checked against the `RESPEC.md` vision — "does this fix fit the big picture?" — before proceeding. "Just make it run" is a stop signal.

---

## Reference docs

- [`RESPEC.md`](./RESPEC.md) — current vision, decisions, implementation detail (single source of truth)
- [`DEVLOG.md`](./DEVLOG.md) — operational issues, observations, ideas
- [`README.ko.md`](./README.ko.md) — Korean README
