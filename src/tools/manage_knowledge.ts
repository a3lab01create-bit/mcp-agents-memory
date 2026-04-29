/**
 * manage_knowledge — 명시 저장/수정/삭제 통합 MCP tool.
 *
 * RESPEC §1.4 / §시퀀스 #5:
 *   - target='memory' action='add'    → sync tag+embed, is_pinned=TRUE INSERT
 *   - target='memory' action='update' → message 갱신, p_tag/embedding NULL → Cold Path 재처리
 *   - target='memory' action='remove' → soft delete (is_active=FALSE), pinned는 거부
 *   - target='sub_profile' action='add'/'update'/'remove' → users.sub_profile UPDATE
 *
 * sync tag+embed 핵심 (RESPEC §2.b): 사용자가 "꼭 기억해" 한 직후 바로 검색
 * 가능해야 함. 실패 fallback: raw 저장은 무조건 성공, tag/embed는 'pending'으로
 * 응답해서 Cold Path가 다음 사이클에 자동 처리.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../db.js";
import { insertRawMemory } from "../hot_path.js";
import { getDefaultUserId, updateUserProfile, getUserProfile } from "../users.js";
import { generateEmbedding } from "../embeddings.js";

function ok(payload: any) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function err(message: string, extra?: any) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, ...extra }, null, 2) }],
  };
}

/**
 * Phase D에서 cold_path/tagger.ts로 추출 예정. 현 단계는 stub —
 * sync 처리 시 NULL 반환 (Cold Path가 다음 사이클에 처리).
 *
 * @returns null이면 tagger 미준비, Cold Path가 채울 거라는 의미.
 */
async function syncTagger(_message: string): Promise<{
  p_tag_id: number | null;
  d_tag: string[];
} | null> {
  // Phase D에서 gemini-2.5-flash 호출 + project_tags lookup으로 채움.
  return null;
}

export function registerManageKnowledge(server: McpServer): void {
  server.registerTool(
    'manage_knowledge',
    {
      description: `명시적 메모리 저장/수정/삭제 통합 도구 (RESPEC §1.4).

target='memory' 사용 시:
  - action='add': 사용자가 "이건 꼭 기억해" 같은 명시 저장. 자동저장과
    달리 is_pinned=TRUE (archive 면제) + 즉시 sync tag+embed 시도. 실패
    시 raw 저장만 성공 + tag/embed pending — Cold Path가 다음 사이클에 처리.
  - action='update': 기존 row의 message 갱신. embedding/p_tag NULL로 set →
    Cold Path 재처리.
  - action='remove': soft delete (is_active=FALSE). is_pinned=TRUE row는 거부.

target='sub_profile' 사용 시:
  - action='add': 기존 sub_profile 끝에 한 줄 append.
  - action='update': sub_profile 통째 교체.
  - action='remove': sub_profile = NULL.`,
      inputSchema: {
        action: z.enum(['add', 'update', 'remove']).describe('동작 종류'),
        target: z.enum(['memory', 'sub_profile']).describe("'memory': 메모리 row | 'sub_profile': 사용자 프로필 부가 정보"),
        content: z.string().optional().describe("add/update 시 저장할 텍스트 (remove 시 무시)"),
        memory_id: z.number().int().optional().describe("update/remove(target='memory') 시 대상 row id"),
        agent_platform: z.string().optional().describe("agent 식별 (default: env AGENT_PLATFORM)"),
        agent_model: z.string().optional().describe("agent model (default: env AGENT_MODEL)"),
      },
    },
    async (args) => {
      const userId = await getDefaultUserId();

      // ── target='sub_profile' ──
      if (args.target === 'sub_profile') {
        if (args.action === 'remove') {
          await updateUserProfile(userId, 'sub_profile', null);
          return ok({ stored: true, target: 'sub_profile', action: 'remove' });
        }
        if (!args.content) {
          return err("content is required for sub_profile add/update");
        }
        if (args.action === 'update') {
          await updateUserProfile(userId, 'sub_profile', args.content);
          return ok({ stored: true, target: 'sub_profile', action: 'update' });
        }
        // add: append a line
        const cur = await getUserProfile(userId);
        const next = cur.sub_profile ? `${cur.sub_profile}\n${args.content}` : args.content;
        await updateUserProfile(userId, 'sub_profile', next);
        return ok({ stored: true, target: 'sub_profile', action: 'add' });
      }

      // ── target='memory' ──
      if (args.action === 'remove') {
        if (args.memory_id == null) {
          return err("memory_id required for memory remove");
        }
        const result = await db.query(
          `UPDATE memory
              SET is_active = FALSE, archived_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND user_id = $2 AND is_pinned = FALSE
            RETURNING id`,
          [args.memory_id, userId]
        );
        if (result.rowCount === 0) {
          // Either not found, not user's row, or pinned — surface specific reason.
          const r2 = await db.query(
            `SELECT is_pinned, user_id FROM memory WHERE id = $1`,
            [args.memory_id]
          );
          if (r2.rows.length === 0) return err("memory row not found", { id: args.memory_id });
          const row = r2.rows[0];
          if (Number(row.user_id) !== userId) return err("memory row belongs to another user", { id: args.memory_id });
          if (row.is_pinned) return err("cannot remove a pinned memory; pinned=TRUE rows are archive-exempt by design", { id: args.memory_id });
          return err("remove failed for unknown reason", { id: args.memory_id });
        }
        return ok({ stored: true, target: 'memory', action: 'remove', id: args.memory_id });
      }

      if (args.action === 'update') {
        if (args.memory_id == null) {
          return err("memory_id required for memory update");
        }
        if (!args.content) {
          return err("content is required for memory update");
        }
        // message 변경 → Cold Path가 재태깅+재임베딩
        const result = await db.query(
          `UPDATE memory
              SET message = $1,
                  embedding = NULL,
                  p_tag_id = NULL,
                  d_tag = '{}',
                  cold_error = NULL,
                  updated_at = NOW()
            WHERE id = $2 AND user_id = $3
            RETURNING id`,
          [args.content, args.memory_id, userId]
        );
        if (result.rowCount === 0) {
          return err("memory row not found or belongs to another user", { id: args.memory_id });
        }
        return ok({
          stored: true,
          target: 'memory',
          action: 'update',
          id: args.memory_id,
          tagged: 'pending',
          embedded: 'pending',
        });
      }

      // action='add' — sync tag+embed 시도, 실패 fallback raw
      if (!args.content) {
        return err("content is required for memory add");
      }
      const platform = args.agent_platform ?? process.env.AGENT_PLATFORM ?? 'unknown';
      const model = args.agent_model ?? process.env.AGENT_MODEL ?? 'unknown';

      // sync tagger
      let p_tag_id: number | null = null;
      let d_tag: string[] = [];
      let tagged: 'ok' | 'pending' = 'pending';
      try {
        const tagResult = await syncTagger(args.content);
        if (tagResult) {
          p_tag_id = tagResult.p_tag_id;
          d_tag = tagResult.d_tag;
          tagged = 'ok';
        }
      } catch (e) {
        // tagger 실패 — pending으로 두고 Cold Path가 처리
        tagged = 'pending';
      }

      // sync embedder
      let embedding: number[] | null = null;
      let embedded: 'ok' | 'pending' = 'pending';
      try {
        const emb = await generateEmbedding(args.content);
        if (emb) {
          embedding = emb;
          embedded = 'ok';
        }
      } catch (e) {
        embedded = 'pending';
      }

      const inserted = await insertRawMemory({
        user_id: userId,
        agent_platform: platform,
        agent_model: model,
        role: 'user', // manage_knowledge는 사용자 명시이므로 user
        message: args.content,
        is_pinned: true, // 강제 기억은 archive 면제
        p_tag_id,
        d_tag,
        embedding,
      });

      return ok({
        stored: true,
        target: 'memory',
        action: 'add',
        id: inserted.id,
        is_pinned: true,
        tagged,
        embedded,
      });
    }
  );
}
