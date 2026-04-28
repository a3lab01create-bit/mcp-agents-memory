# Notion Connector — Spec (v1, minimal)

Last v5.0 roadmap leftover. Closes the "외부 컨텐츠가 알아서 memory로 흡수된다" half of v5.0's vision (the other halves — graph, forgetting, restore — already shipped).

## Why this slice now

- It's the only Phase 3 item still unshipped from `project_original_roadmap.md`.
- The packaging milestone (982f979) makes the "share memory across computers" goal real, but right now memory only enters via direct `memory_add` calls. Connectors are how memory grows passively from the work the user already does in other apps.
- Of the three providers (GitHub, Notion, Drive) the user named, Notion has the cleanest API for v1: integration tokens are simple, search + page retrieval are one-call each, no webhook subscription dance, content model maps directly to plaintext.

## Scope (one session, ~2h)

A user-triggered sync — NOT a background poller. v1 is "fetch this Notion page (or database) → extract facts → store with provenance." Auto-polling, webhooks, workspace-wide discovery all deferred. Get the path working end-to-end first; automation is the *next* slice.

### What ships

1. **`memory_sources` schema** (migration 012) — generic `(provider, external_id, last_synced_at, content_hash, metadata)`. Per-row dedup signal. Designed for GitHub/Drive too even though only Notion uses it in v1.
2. **`src/connectors/notion.ts`** — wraps `@notionhq/client`. `fetchPage(pageId)` returns `{ title, plaintext, last_edited_time }`. `fetchDatabase(databaseId)` lists child pages and yields the same shape per page. Thin wrapper, no transformation logic.
3. **`src/connectors/sync.ts`** — orchestration: takes a (provider, external_id) pair, fetches content via the connector, computes content_hash, looks up `memory_sources` row. If unchanged → skip. If new/changed → hand text to `processBatch()` (Librarian) with a tagged `source='connector_notion'` and a synthetic `subject_id` that scopes Notion-derived memories. Update `memory_sources` row.
4. **MCP tool: `connector_sync`** — `{ provider: "notion", external_id: string, type: "page" | "database" }`. Manual trigger for now. Returns counts: `{ pages_seen, pages_synced, facts_added }`.
5. **Setup wizard prompt** — adds optional `NOTION_API_KEY` to the API-keys phase. Skipping it is fine; the connector tool just errors with a clear message until the key arrives.
6. **E2E test** — `scratch/test_notion_connector.js`. Requires user-supplied `NOTION_API_KEY` + a test page id; if either missing, test self-skips with a clear message.

### What's deferred (write down so it doesn't sneak in)

- Background polling / cron-style sync. v1 is manual-trigger only.
- Notion webhooks. Notion's webhook story is integration-app territory and adds a lot of surface for v1.
- Workspace-wide discovery (search the user's whole Notion). Per-resource (page or database) only.
- GitHub and Drive connectors — separate sessions. The `memory_sources` schema is built generic so they slot in without migration.
- Reverse-sync (Memory → Notion). Read-only for v1.
- Permission-aware filtering (don't sync private pages from a shared workspace). Notion's API only returns what the integration token has access to, so this is implicit, but worth a real review when shared workspaces enter the picture.
- Updating an already-synced memory in place when its Notion source changes. v1 just logs a new memory; the Librarian's contradiction resolver should handle most "fact replaced" cases. True update-vs-insert plumbing is its own slice.
- LLM transformation of Notion content. Pass plaintext directly to Librarian; the existing pipeline already extracts atomic facts.

## Concrete file changes

### New
- `src/migrations/012_memory_sources.ts` — table + indexes.
- `src/connectors/notion.ts` — Notion API wrapper.
- `src/connectors/sync.ts` — `runConnectorSync({ provider, external_id, type })` orchestration.
- `scratch/test_notion_connector.js` — e2e harness.

### Modified
- `src/setup.ts` — add `NOTION_API_KEY` to the optional-keys prompt + emit it to the .env block.
- `src/tools.ts` — register `connector_sync` MCP tool. Thin wrapper; format result for chat output.
- `package.json` — add `@notionhq/client` dependency.
- `.env.example` — document `NOTION_API_KEY` near the other optional keys.

### NOT modified
- `librarian.ts` — write path doesn't change. Connector calls existing `processBatch()`.
- `tools.ts` other handlers — connector output flows into memories like any other Librarian output, search and forgetting handle them automatically.

## Schema (migration 012)

```sql
CREATE TABLE IF NOT EXISTS memory_sources (
    id SERIAL PRIMARY KEY,
    provider VARCHAR(20) NOT NULL
        CHECK (provider IN ('notion', 'github', 'drive')),
    external_id VARCHAR(200) NOT NULL,         -- Notion page/database id, GH repo+sha, Drive file id
    resource_type VARCHAR(20) NOT NULL         -- 'page' / 'database' / 'file' / 'commit' (provider-specific)
        CHECK (resource_type IN ('page', 'database', 'file', 'commit', 'pr')),
    title VARCHAR(500),
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    content_hash CHAR(64) NOT NULL,            -- SHA-256 of normalized plaintext
    facts_added INTEGER NOT NULL DEFAULT 0,    -- count from the most recent successful sync
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_provider_external UNIQUE (provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_sources_provider ON memory_sources(provider);
CREATE INDEX IF NOT EXISTS idx_memory_sources_last_synced ON memory_sources(last_synced_at DESC);
```

## Connector subject scoping

Each provider gets its own `system`-type subject so Notion-sourced memories cluster cleanly:

- `system_connector_notion`  (created by 012 seed at end of migration)
- (Future) `system_connector_github`, `system_connector_drive`

`runConnectorSync()` calls `processBatch()` with this subject as `subject_id`. Existing `subject_relationships` graph + `memory_search` filtering work unchanged.

## Dedup logic

```
hash = sha256(normalize(plaintext))   // collapse whitespace, NFC normalize

SELECT content_hash FROM memory_sources WHERE provider=$1 AND external_id=$2
  → row exists with same hash?  skip, log "unchanged"
  → row exists with different hash?  re-extract facts, INSERT new memories,
     UPDATE memory_sources.content_hash + last_synced_at
  → no row?  extract, INSERT memories, INSERT memory_sources row
```

Note: this generates duplicate memories on hash change (Librarian's contradiction resolver handles "Alice owns Acme" → "Alice owns Acme Corp" cases, but won't deduplicate verbatim text. That's acceptable for v1; explicit memory replacement is its own slice).

## Open questions for advisor

1. **Where do connector-derived memories go in `subject_id`?** Single `system_connector_notion` system subject for everything from Notion, or per-page/per-database synthetic subject? Single is simpler; per-page gives finer-grained cleanup later. Lean single for v1.
2. **Plaintext normalization for hashing** — collapse whitespace + NFC, or also strip Notion-specific noise (block IDs in the API response that aren't visible content)? The hash is internal-only; I'd keep it minimal (visible plaintext only) so legitimate edits flip the hash.
3. **Sync subcommand vs MCP tool only** — should `connector_sync` ALSO be a CLI subcommand (`mcp-agents-memory sync notion <id>`)? Convenient for cron-style use later, but adds surface. Recommend MCP-tool-only for v1; CLI surface follows when there's a concrete need.
4. **Notion content traversal depth** — when fetching a page, follow child blocks (toggle children, sub-pages)? Notion's "blocks.children.list" is paginated and deep. v1 should probably grab top-level blocks only and treat sub-pages as separate sync targets the user opts into.
5. **API key location** — wizard already writes XDG `.env`. Confirm `@notionhq/client` constructor reads `NOTION_API_KEY` directly from `process.env` (most clients require explicit `auth: process.env.NOTION_API_KEY` in the constructor). Plan: explicit pass to keep it discoverable.

## Verification plan

1. Build clean.
2. Migration 012 runs cleanly on fresh Neon DB (re-use `scratch/test_neon_fresh_install.js` to reconfirm).
3. e2e — `scratch/test_notion_connector.js`:
   - If `NOTION_API_KEY` or `NOTION_TEST_PAGE_ID` env missing → log "skipped" and exit 0.
   - Else: fetch the page, run sync once → assert memory_sources row + ≥1 memory inserted with `source='connector_notion'`. Run sync again with no changes → assert facts_added=0, memory count unchanged.
4. Idempotence: a third run after editing the page (user-driven step) → assert hash flipped, new memories appended.
