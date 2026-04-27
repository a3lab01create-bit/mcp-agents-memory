import { tavily } from "@tavily/core";
import { Exa } from "exa-js";

export type Authority = 'high' | 'medium' | 'low';

export interface ExternalSource {
  title: string;
  url: string;
  snippet: string;
  engine: 'tavily' | 'exa';
  authority: Authority;
  weight: number;
}

/**
 * Classify URL authority based on hostname (not substring).
 * - high:   .gov, .edu TLD; docs.* subdomain
 * - medium: .org TLD; well-known reference subdomains (wikipedia, mdn, etc.)
 * - low:    everything else
 */
export function getAuthority(url: string): Authority {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.endsWith('.gov') || hostname.endsWith('.edu')) return 'high';
    if (hostname.startsWith('docs.') || hostname.includes('.docs.')) return 'high';
    if (hostname.endsWith('.org')) return 'medium';
    if (/^(en|ko|ja|de|fr)\.wikipedia\.org$/.test(hostname)) return 'medium';
    if (hostname === 'developer.mozilla.org' || hostname.endsWith('.mozilla.org')) return 'medium';
    return 'low';
  } catch {
    return 'low';
  }
}

export function authorityToWeight(authority: Authority): number {
  return authority === 'high' ? 1.0 : authority === 'medium' ? 0.85 : 0.7;
}

export function getTavilyClient() {
  if (!process.env.TAVILY_API_KEY) return null;
  return tavily({ apiKey: process.env.TAVILY_API_KEY });
}

export function getExaClient() {
  if (!process.env.EXA_API_KEY) return null;
  return new Exa(process.env.EXA_API_KEY);
}

function dedupeSources(sources: ExternalSource[]): ExternalSource[] {
  const byUrl = new Map<string, ExternalSource>();

  for (const source of sources) {
    const existing = byUrl.get(source.url);
    if (!existing) {
      byUrl.set(source.url, source);
      continue;
    }

    if (
      source.weight > existing.weight ||
      (source.weight === existing.weight && source.snippet.length > existing.snippet.length)
    ) {
      byUrl.set(source.url, source);
    }
  }

  return Array.from(byUrl.values()).sort((a, b) => b.weight - a.weight);
}

async function searchTavily(query: string, maxResults: number): Promise<ExternalSource[]> {
  const client = getTavilyClient();
  if (!client) return [];

  try {
    const response = await client.search(query, {
      searchDepth: "advanced",
      maxResults,
    });

    return response.results.map((result: any) => {
      const authority = getAuthority(result.url);
      return {
        title: result.title,
        url: result.url,
        snippet: result.content,
        engine: 'tavily',
        authority,
        weight: authorityToWeight(authority),
      };
    });
  } catch (err) {
    console.warn("⚠️ [ExternalSearch] Tavily search failed:", err);
    return [];
  }
}

async function searchExa(query: string, maxResults: number): Promise<ExternalSource[]> {
  const client = getExaClient();
  if (!client) return [];

  try {
    const response = await client.searchAndContents(query, {
      type: "neural",
      numResults: maxResults,
      highlights: true,
      text: { maxCharacters: 1000 },
    });

    return response.results.map((result: any) => {
      const authority = getAuthority(result.url);
      return {
        title: result.title || "Untitled",
        url: result.url,
        snippet: result.text || "",
        engine: 'exa',
        authority,
        weight: authorityToWeight(authority),
      };
    });
  } catch (err) {
    console.warn("⚠️ [ExternalSearch] Exa search failed:", err);
    return [];
  }
}

export async function searchExternal(
  query: string,
  opts?: { tavilyMax?: number; exaMax?: number }
): Promise<ExternalSource[]> {
  const tavilyMax = opts?.tavilyMax ?? 3;
  const exaMax = opts?.exaMax ?? 2;

  const [tavilyResults, exaResults] = await Promise.all([
    searchTavily(query, tavilyMax),
    searchExa(query, exaMax),
  ]);

  return dedupeSources([...tavilyResults, ...exaResults]);
}
