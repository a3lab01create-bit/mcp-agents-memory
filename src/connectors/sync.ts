/**
 * Connector sync orchestrator.
 *
 * Generic over provider via `memory_sources(provider, external_id)`. v1
 * dispatches `provider='notion'` to ./notion.ts; future GitHub/Drive
 * connectors slot in alongside.
 *
 * Flow per resource:
 *   1. Fetch via provider client → plaintext + title + last_edited_time
 *   2. Compute SHA-256 of normalized plaintext
 *   3. Look up memory_sources(provider, external_id):
 *        - same hash  → skip, no work
 *        - new hash   → run Librarian extraction, INSERT memories with
 *                       source='connector', upsert memory_sources row
 *   4. Return per-resource counts so callers can report.
 */

import crypto from "crypto";
import { db } from "../db.js";
import { processBatch } from "../librarian.js";
import { getOrCreateSubject } from "../subjects.js";
import { fetchPage, type NotionResource } from "./notion.js";

export type ConnectorProvider = "notion" | "github" | "drive";
export type ResourceType = "page" | "database" | "file" | "commit" | "pr";

export interface SyncRequest {
  provider: ConnectorProvider;
  external_id: string;
  resource_type: ResourceType;
}

export interface SyncResult {
  pages_seen: number;
  pages_synced: number;
  pages_skipped_unchanged: number;
  facts_added: number;
  errors: string[];
}

const PROVIDER_SUBJECT_KEY: Record<ConnectorProvider, string> = {
  notion: "system_connector_notion",
  github: "system_connector_github",
  drive: "system_connector_drive",
};

function normalizeForHash(plaintext: string): string {
  // Visible plaintext only (no formatting). NFC + collapse runs of whitespace.
  return plaintext.normalize("NFC").replace(/\s+/g, " ").trim();
}

function hash(plaintext: string): string {
  return crypto.createHash("sha256").update(normalizeForHash(plaintext)).digest("hex");
}

async function syncOnePage(
  provider: ConnectorProvider,
  resource: NotionResource,
  result: SyncResult
): Promise<void> {
  result.pages_seen++;
  const newHash = hash(resource.plaintext);

  const existing = await db.query(
    `SELECT id, content_hash FROM memory_sources WHERE provider = $1 AND external_id = $2`,
    [provider, resource.external_id]
  );

  if (existing.rows.length > 0 && existing.rows[0].content_hash === newHash) {
    result.pages_skipped_unchanged++;
    return;
  }

  // Hand text to Librarian. Tag source='connector' so memory_status / forgetting
  // can distinguish connector-derived memories from user/agent input.
  const subjectId = await getOrCreateSubject(PROVIDER_SUBJECT_KEY[provider], "system");
  const text = resource.title
    ? `[${resource.title}]\n${resource.plaintext}`
    : resource.plaintext;

  if (!text.trim()) {
    // Empty page — record the source row so we don't re-fetch each time, but extract nothing.
    await upsertSource(provider, resource, newHash, 0);
    return;
  }

  const proc = await processBatch(text, subjectId, null, text, {
    source: "connector",
    platform: `connector-${provider}`,
  });
  result.facts_added += proc.saved;
  result.errors.push(...proc.errors.map((e) => `[${resource.external_id}] ${e}`));

  await upsertSource(provider, resource, newHash, proc.saved);
  result.pages_synced++;
}

async function upsertSource(
  provider: ConnectorProvider,
  resource: NotionResource,
  contentHash: string,
  factsAdded: number
): Promise<void> {
  await db.query(
    `INSERT INTO memory_sources
       (provider, external_id, resource_type, title, content_hash, facts_added, metadata, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (provider, external_id) DO UPDATE SET
       resource_type = EXCLUDED.resource_type,
       title         = EXCLUDED.title,
       content_hash  = EXCLUDED.content_hash,
       facts_added   = EXCLUDED.facts_added,
       metadata      = EXCLUDED.metadata,
       last_synced_at = NOW()`,
    [
      provider,
      resource.external_id,
      resource.resource_type,
      resource.title,
      contentHash,
      factsAdded,
      JSON.stringify({ last_edited_time: resource.last_edited_time }),
    ]
  );
}

export async function runConnectorSync(req: SyncRequest): Promise<SyncResult> {
  const result: SyncResult = {
    pages_seen: 0,
    pages_synced: 0,
    pages_skipped_unchanged: 0,
    facts_added: 0,
    errors: [],
  };

  if (req.provider !== "notion") {
    throw new Error(`Connector for provider '${req.provider}' is not implemented yet (v1 ships Notion only).`);
  }

  if (req.resource_type === "page") {
    try {
      const page = await fetchPage(req.external_id);
      await syncOnePage(req.provider, page, result);
    } catch (err: any) {
      // Single-page errors get surfaced via result.errors so the MCP tool
      // wrapper has a uniform shape (matches future multi-page iteration).
      result.errors.push(`[page=${req.external_id}] ${err?.message ?? err}`);
    }
    return result;
  }

  // database iteration deferred — see ./notion.ts for the SDK-version note.
  throw new Error(
    `Unsupported resource_type '${req.resource_type}' for Notion in v1 — only 'page' is implemented.`
  );
}
