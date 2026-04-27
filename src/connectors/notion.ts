/**
 * Notion API wrapper for the Connector pipeline.
 *
 * Thin wrapper — no fact extraction here, no DB writes. Just fetches the page
 * (or database) content and returns plaintext + minimal metadata. The sync
 * orchestrator (`./sync.ts`) handles dedup + handoff to Librarian.
 *
 * v1 scope: top-level blocks of a single page only. Child blocks (toggle
 * children, sub-pages) are NOT recursively traversed — sub-pages are treated
 * as separate sync targets the user opts into. See spec for rationale.
 */

import { Client, isFullPage, isFullBlock } from "@notionhq/client";

let cached: Client | null = null;

function getClient(): Client {
  if (cached) return cached;
  const auth = process.env.NOTION_API_KEY;
  if (!auth) {
    throw new Error(
      "NOTION_API_KEY missing. Add it to your config (~/.config/mcp-agents-memory/.env) " +
        "or set it in the shell before invoking the connector."
    );
  }
  cached = new Client({ auth });
  return cached;
}

export interface NotionResource {
  external_id: string;
  resource_type: "page" | "database";
  title: string | null;
  plaintext: string;
  last_edited_time: string;
}

function richTextToPlaintext(rt: any[] | undefined): string {
  if (!rt) return "";
  return rt.map((r) => r.plain_text ?? "").join("");
}

function extractTitleFromPage(page: any): string | null {
  if (!isFullPage(page)) return null;
  for (const prop of Object.values(page.properties ?? {}) as any[]) {
    if (prop.type === "title") return richTextToPlaintext(prop.title) || null;
  }
  return null;
}

/**
 * Convert a Notion block (top-level only) to a plaintext line.
 * Block types we don't render produce an empty string and get filtered out.
 */
function blockToLine(block: any): string {
  if (!isFullBlock(block)) return "";
  const t = block.type;
  const node = (block as any)[t];

  switch (t) {
    case "paragraph":
    case "heading_1":
    case "heading_2":
    case "heading_3":
    case "bulleted_list_item":
    case "numbered_list_item":
    case "quote":
    case "callout":
    case "toggle":
    case "to_do":
      return richTextToPlaintext(node?.rich_text);
    case "code":
      return richTextToPlaintext(node?.rich_text);
    case "divider":
      return "---";
    default:
      return "";
  }
}

/**
 * Block types whose children are inline content the user wrote ON THIS PAGE
 * (vs structural sub-resources). We recurse into these so toggles, callouts,
 * and column layouts don't silently swallow text. We deliberately do NOT
 * recurse into `child_page` / `child_database` — those are separate sync
 * targets the user opts into.
 */
const RECURSE_INTO = new Set([
  "toggle",
  "callout",
  "quote",
  "column_list",
  "column",
  "synced_block",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
]);

async function listAllBlocks(client: Client, blockId: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 });
    out.push(...res.results);
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return out;
}

/**
 * Walk blocks recursively, but only descend into structurally-inline
 * containers (toggle/callout/column layouts). Sub-pages and child databases
 * are skipped on purpose — they're separate sync targets.
 */
async function collectLines(client: Client, blockId: string, depth: number, lines: string[]): Promise<void> {
  if (depth > 5) return; // safety cap on deeply nested toggles
  const blocks = await listAllBlocks(client, blockId);
  for (const b of blocks) {
    if (!isFullBlock(b)) continue;
    const line = blockToLine(b).trim();
    if (line) lines.push(line);
    if ((b as any).has_children && RECURSE_INTO.has((b as any).type)) {
      await collectLines(client, (b as any).id, depth + 1, lines);
    }
  }
}

export async function fetchPage(pageId: string): Promise<NotionResource> {
  const client = getClient();
  const page = await client.pages.retrieve({ page_id: pageId });
  const title = extractTitleFromPage(page);
  const lastEdited = (page as any).last_edited_time as string;

  const lines: string[] = [];
  await collectLines(client, pageId, 0, lines);

  return {
    external_id: pageId,
    resource_type: "page",
    title,
    plaintext: lines.join("\n"),
    last_edited_time: lastEdited,
  };
}

// NOTE: database iteration deferred to v2.
// @notionhq/client v5 split databases into Database + DataSource (Aug 2025
// API change). Database row queries now require resolving the database's
// data_source_id first and calling `dataSources.query`. Page-only sync covers
// the common use case for v1; database support arrives with the GitHub/Drive
// connectors when this layer gets a proper rework.
