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
import * as os from "node:os";
import { insertRawMemory } from "../hot_path.js";
import { getDefaultUserId } from "../users.js";
import { resolveAgentIdentity } from "../agent_identity.js";
import { isCaptureArmed as isGeminiArmed } from "./gemini_capture.js";
import { isCaptureArmed as isGrokArmed } from "./grok_capture.js";
import { isCaptureArmed as isAntigravityArmed } from "./antigravity_capture.js";
import { isCaptureArmed as isHermesArmed } from "./hermes_capture.js";

const DEVICE_NAME = os.hostname();

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

      // passive capture가 활성화된 platform은 save_message 수동 호출 불필요 — 중복 방지
      if (id.agent_platform === "gemini-cli-mcp-client" && isGeminiArmed()) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ stored: false, skipped: "passive capture active" }, null, 2),
          }],
        };
      }
      // Grok: clientInfo.name이 'grok-shell-...' 등 변형이라 prefix로 매칭 (grok* = grok뿐)
      if (id.agent_platform?.startsWith("grok") && isGrokArmed()) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ stored: false, skipped: "passive capture active" }, null, 2),
          }],
        };
      }
      // Antigravity CLI: 과거 DB platform이 antigravity-client / antigravity 일 수 있으므로 startsWith
      if (id.agent_platform?.startsWith("antigravity") && isAntigravityArmed()) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ stored: false, skipped: "passive capture active" }, null, 2),
          }],
        };
      }
      // Hermes: MCP clientInfo.name을 "mcp"로 보고함 (live DB 실측). state.db passive
      // capture가 armed면 (= ~/.hermes/state.db 있는 기기) save_message 수동 호출 불필요 → 중복 방지.
      //
      // ⚠️ 주의: 다른 sibling gate(gemini-cli-mcp-client / grok* / antigravity*)는 *고유* platform
      //   문자열로 매칭하지만, Hermes는 generic catch-all인 bare "mcp"로 매칭한다.
      //   isHermesArmed()는 "이 *기기*에 Hermes가 있다"는 뜻이지 "이 *요청*이 Hermes다"가 아니다.
      //   → Hermes 호스트에서 다른 MCP 클라이언트가 똑같이 bare "mcp"로 붙고 save_message에
      //     의존하면, 그 write가 조용히 드롭된다(Hermes 폴링은 ~/.hermes/state.db만 읽으므로 미포착).
      //   현재 fleet(claude-code/codex-cli/gemini-cli-mcp-client/grok*/antigravity*)에선 bare "mcp"가
      //   Hermes 고유로 보이나, 확정은 아님. gate 제거는 불가(save_message는 external_uuid=null이라
      //   hermes:<id> capture와 dedup 안 됨 → 이중 저장). E2E에서 Hermes clientInfo.version/title 등
      //   고유 시그널 확인되면 그걸로 좁힐 것.
      if (id.agent_platform === "mcp" && isHermesArmed()) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ stored: false, skipped: "passive capture active" }, null, 2),
          }],
        };
      }

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
        device_name: DEVICE_NAME,
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
