/**
 * save_message — 매 대화 자동 저장 MCP tool (cross-platform).
 *
 * RESPEC PROBLEMS.md §4 fix. Caller agent가 매 turn 끝나고 호출.
 *
 * Hot Path 핵심: tag/embed는 NULL로 INSERT만 (Cold Path가 background 처리).
 * Latency 목표 <50ms.
 *
 * caller convention (instructions에 명시):
 *   - 매 user turn 끝나면 → save_message({ role: 'user', message, agent_model })
 *   - 매 assistant turn 끝나면 → save_message({ role: 'assistant', message, agent_model })
 *   - subagent context면 subagent: true + subagent_model + subagent_role 동봉
 *
 * Claude Code 같은 JSONL writes-itself platform은 background JSONL capture가
 * 보조 (jsonl_capture.ts). 따라서 본 tool 안 호출돼도 SessionEnd 시 캡처됨.
 * 그 외 (Gemini CLI, Codex 등)는 본 tool 호출이 유일한 자동 저장 path.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { insertRawMemory } from "../hot_path.js";
import { getDefaultUserId } from "../users.js";
import { resolveAgentIdentity } from "../agent_identity.js";

export function registerSaveMessage(server: McpServer): void {
  server.registerTool(
    'save_message',
    {
      description: `매 대화 turn 자동 저장 (Hot Path).

caller convention: 매 user/assistant turn 끝나면 호출. 메시지 raw 그대로 저장하고,
태깅 + 임베딩은 백그라운드 (Cold Path) 처리. Latency <50ms.

호출 시점:
  - user 발화 직후 → save_message({ role: 'user', message: "...", agent_model: "..." })
  - assistant 답변 직후 → save_message({ role: 'assistant', message: "...", agent_model: "..." })

agent_platform은 MCP clientInfo로 자동 감지 (claude-code / gemini-cli / codex 등).
agent_model은 caller가 자기 model 명시. 명시 안 하면 'unknown' 저장.

subagent 컨텍스트라면 subagent=true + subagent_model + subagent_role 함께.

응답: { stored, id, role, created_at }`,
      inputSchema: {
        role: z.enum(['user', 'assistant']).describe("발화자 (user / assistant)"),
        message: z.string().describe("raw 메시지 본문 (그대로 저장)"),
        agent_model: z.string().optional().describe("호출한 agent의 model. 명시 안 하면 'unknown'."),
        agent_platform: z.string().optional().describe("agent_platform override (default: MCP clientInfo.name 자동)"),
        subagent: z.boolean().optional().describe("subagent context인 경우 true"),
        subagent_model: z.string().optional().describe("subagent=true 일 때 sub의 model"),
        subagent_role: z.string().optional().describe("subagent=true 일 때 role description (free-form)"),
      },
    },
    async (args) => {
      const userId = await getDefaultUserId();
      const id = resolveAgentIdentity(server, args);

      // user role: 사람이 친 거니 model N/A → null. assistant: id.agent_model.
      const agentModel = args.role === 'user' ? null : id.agent_model;

      const inserted = await insertRawMemory({
        user_id: userId,
        agent_platform: id.agent_platform,
        agent_model: agentModel,
        subagent: id.subagent,
        subagent_model: id.subagent_model,
        subagent_role: id.subagent_role,
        role: args.role,
        message: args.message,
        // tag/embed NULL — Cold Path가 background 처리 (Hot Path latency 보장)
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            stored: true,
            id: inserted.id,
            role: args.role,
            created_at: inserted.created_at?.toISOString(),
          }, null, 2),
        }],
      };
    }
  );
}
