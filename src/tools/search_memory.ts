/**
 * search_memory — 조회/검색 통합 MCP tool.
 *
 * RESPEC §시퀀스 #4 / §2.c.
 *
 * 흐름:
 *   1. p_tag string → project_tags lookup (alias_of 그룹 대표 id)
 *   2. query → embedder → halfvec
 *   3. SELECT ... WHERE filters... ORDER BY embedding <=> $vec LIMIT N
 *   4. max(similarity) < SEARCH_FALLBACK_THRESHOLD 이면 ILIKE fallback
 *
 * 응답 메타: { used: 'vector'|'ilike'|'recency', similarity?, results: [...] }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../db.js";
import { getDefaultUserId } from "../users.js";
import { embedMessage, vectorToHalfvecSql } from "../cold_path/embedder.js";

const DEFAULT_LIMIT = 10;
const DEFAULT_FALLBACK_THRESHOLD = 0.3;

function parseDateRange(s: string | undefined): Date | null {
  if (!s) return null;
  const trimmed = s.trim().toLowerCase();
  // ISO date or relative (last_week / last_month / NN_days_ago)
  const isoMatch = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (isoMatch) return new Date(isoMatch[1]);

  if (trimmed === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (trimmed === 'last_week') {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d;
  }
  if (trimmed === 'last_month') {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d;
  }
  const daysAgo = /^(\d+)_?days?_ago$/.exec(trimmed);
  if (daysAgo) {
    const d = new Date();
    d.setDate(d.getDate() - Number(daysAgo[1]));
    return d;
  }
  return null;
}

async function lookupProjectTagId(name: string): Promise<number | null> {
  const slug = name.toLowerCase().trim();
  if (!slug) return null;
  // alias_of 따라가서 대표 id 반환
  const r = await db.query(
    `WITH RECURSIVE chain AS (
       SELECT id, alias_of FROM project_tags WHERE name = $1
       UNION ALL
       SELECT pt.id, pt.alias_of FROM project_tags pt
         JOIN chain c ON pt.id = c.alias_of
     )
     SELECT id FROM chain WHERE alias_of IS NULL LIMIT 1`,
    [slug]
  );
  if (r.rows.length === 0) return null;
  return Number(r.rows[0].id);
}

interface SearchRow {
  id: number;
  role: 'user' | 'assistant';
  message: string;
  agent_platform: string;
  agent_model: string;
  p_tag_name: string | null;
  d_tag: string[];
  is_pinned: boolean;
  created_at: Date;
  similarity?: number;
}

export function registerSearchMemory(server: McpServer): void {
  server.registerTool(
    'search_memory',
    {
      description: `과거 기억 조회/검색 통합 도구 (RESPEC §시퀀스 #4).

흐름: vector 의미검색 → cosine 유사도 임계값 미만 시 ILIKE 키워드 fallback.
필터: p_tag (프로젝트 한정), date_range (기간 한정), role (user/assistant 한정).
query 없을 때: 단순 시간순 최근 N건.

date_range 인식 형식:
  - 'today', 'last_week', 'last_month'
  - '7_days_ago', '30_days_ago'
  - 'YYYY-MM-DD' (해당 일 이후)

응답에 메타 정보 (used, similarity) 포함 — 어떤 path로 결과를 얻었는지 투명.`,
      inputSchema: {
        query: z.string().optional().describe("의미 검색할 텍스트 (생략 시 시간순 최근 N건)"),
        p_tag: z.string().optional().describe("특정 프로젝트로 한정 (project_tags.name)"),
        date_range: z.string().optional().describe("기간 한정 (today / last_week / last_month / 7_days_ago / YYYY-MM-DD)"),
        role: z.enum(['user', 'assistant']).optional().describe("발화자 한정 (생략 시 둘 다)"),
        agent_platform: z.string().optional().describe(
          "agent platform 한정 (예: 'claude-code', 'gemini-cli-mcp-client'). 생략 시 cross-platform."
        ),
        limit: z.number().int().min(1).max(50).optional().describe(`최대 결과 수 (default ${DEFAULT_LIMIT})`),
        include_archived: z.boolean().optional().describe("archived 메모리도 포함 (default false)"),
      },
    },
    async (args) => {
      const userId = await getDefaultUserId();
      const limit = args.limit ?? DEFAULT_LIMIT;
      const threshold = Number(process.env.SEARCH_FALLBACK_THRESHOLD ?? DEFAULT_FALLBACK_THRESHOLD);

      // p_tag → id
      let p_tag_id: number | null = null;
      if (args.p_tag) {
        p_tag_id = await lookupProjectTagId(args.p_tag);
        if (p_tag_id === null) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                used: 'none',
                results: [],
                note: `p_tag '${args.p_tag}' not found in project_tags`,
              }, null, 2),
            }],
          };
        }
      }

      const sinceDate = parseDateRange(args.date_range);
      const includeArchived = args.include_archived === true;

      const filters: string[] = [`m.user_id = $1`];
      const params: any[] = [userId];
      let p = 2;
      if (!includeArchived) {
        filters.push(`m.is_active = TRUE`);
      }
      if (p_tag_id !== null) {
        filters.push(`m.p_tag_id = $${p++}`);
        params.push(p_tag_id);
      }
      if (sinceDate) {
        filters.push(`m.created_at >= $${p++}`);
        params.push(sinceDate);
      }
      if (args.role) {
        filters.push(`m.role = $${p++}`);
        params.push(args.role);
      }
      if (args.agent_platform) {
        filters.push(`m.agent_platform = $${p++}`);
        params.push(args.agent_platform);
      }
      const whereSql = filters.join(' AND ');

      let used: 'vector' | 'ilike' | 'recency' = 'recency';
      let topSimilarity: number | undefined = undefined;
      let rows: SearchRow[] = [];

      // ── Step 1: query 있으면 vector search 시도 ──
      if (args.query && args.query.trim().length > 0) {
        try {
          const vec = await embedMessage(args.query);
          const vecSql = vectorToHalfvecSql(vec);
          const vecParam = p++;
          params.push(vecSql);
          const limitParam = p++;
          params.push(limit);

          const r = await db.query(
            `SELECT m.id, m.role, m.message, m.agent_platform, m.agent_model,
                    pt.name AS p_tag_name, m.d_tag, m.is_pinned, m.created_at,
                    1 - (m.embedding <=> $${vecParam}::halfvec) AS similarity
               FROM memory m
               LEFT JOIN project_tags pt ON pt.id = m.p_tag_id
              WHERE ${whereSql}
                AND m.embedding IS NOT NULL
              ORDER BY m.embedding <=> $${vecParam}::halfvec
              LIMIT $${limitParam}`,
            params
          );
          rows = r.rows.map((row: any) => ({
            id: Number(row.id),
            role: row.role,
            message: row.message,
            agent_platform: row.agent_platform,
            agent_model: row.agent_model,
            p_tag_name: row.p_tag_name,
            d_tag: row.d_tag ?? [],
            is_pinned: row.is_pinned,
            created_at: row.created_at,
            similarity: Number(row.similarity),
          }));
          if (rows.length > 0) {
            topSimilarity = rows[0].similarity;
            used = 'vector';
          }
        } catch (err) {
          console.error("⚠️ [search_memory] vector path failed, falling through:", err);
        }

        // Step 2: top similarity < threshold면 ILIKE fallback
        if (used !== 'vector' || (topSimilarity !== undefined && topSimilarity < threshold)) {
          // params 리셋
          const ilikeParams: any[] = [userId];
          let q = 2;
          const ilikeFilters: string[] = [`m.user_id = $1`];
          if (!includeArchived) ilikeFilters.push(`m.is_active = TRUE`);
          if (p_tag_id !== null) {
            ilikeFilters.push(`m.p_tag_id = $${q++}`);
            ilikeParams.push(p_tag_id);
          }
          if (sinceDate) {
            ilikeFilters.push(`m.created_at >= $${q++}`);
            ilikeParams.push(sinceDate);
          }
          if (args.role) {
            ilikeFilters.push(`m.role = $${q++}`);
            ilikeParams.push(args.role);
          }
          if (args.agent_platform) {
            ilikeFilters.push(`m.agent_platform = $${q++}`);
            ilikeParams.push(args.agent_platform);
          }
          ilikeFilters.push(`m.message ILIKE $${q++}`);
          ilikeParams.push(`%${args.query}%`);
          ilikeParams.push(limit);

          const r = await db.query(
            `SELECT m.id, m.role, m.message, m.agent_platform, m.agent_model,
                    pt.name AS p_tag_name, m.d_tag, m.is_pinned, m.created_at
               FROM memory m
               LEFT JOIN project_tags pt ON pt.id = m.p_tag_id
              WHERE ${ilikeFilters.join(' AND ')}
              ORDER BY m.created_at DESC
              LIMIT $${q}`,
            ilikeParams
          );
          if (r.rows.length > 0) {
            rows = r.rows.map((row: any) => ({
              id: Number(row.id),
              role: row.role,
              message: row.message,
              agent_platform: row.agent_platform,
              agent_model: row.agent_model,
              p_tag_name: row.p_tag_name,
              d_tag: row.d_tag ?? [],
              is_pinned: row.is_pinned,
              created_at: row.created_at,
            }));
            used = 'ilike';
            topSimilarity = undefined;
          }
        }
      } else {
        // ── query 없음: 시간순 최근 N건 ──
        params.push(limit);
        const r = await db.query(
          `SELECT m.id, m.role, m.message, m.agent_platform, m.agent_model,
                  pt.name AS p_tag_name, m.d_tag, m.is_pinned, m.created_at
             FROM memory m
             LEFT JOIN project_tags pt ON pt.id = m.p_tag_id
            WHERE ${whereSql}
            ORDER BY m.created_at DESC
            LIMIT $${p}`,
          params
        );
        rows = r.rows.map((row: any) => ({
          id: Number(row.id),
          role: row.role,
          message: row.message,
          agent_platform: row.agent_platform,
          agent_model: row.agent_model,
          p_tag_name: row.p_tag_name,
          d_tag: row.d_tag ?? [],
          is_pinned: row.is_pinned,
          created_at: row.created_at,
        }));
        used = 'recency';
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            used,
            threshold: used === 'ilike' ? threshold : undefined,
            top_similarity: topSimilarity,
            count: rows.length,
            results: rows,
          }, null, 2),
        }],
      };
    }
  );
}
