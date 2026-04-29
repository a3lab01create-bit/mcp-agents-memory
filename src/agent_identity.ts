/**
 * Agent identity 캡처 — RESPEC PROBLEMS.md §2 fix.
 *
 * 전략:
 *   - agent_platform: MCP clientInfo 자동 (claude-code / gemini-cli / codex).
 *     args로 override 가능. 못 잡히면 'unknown'.
 *   - agent_model: caller args 필수. 명시 안 하면 'unknown' (env 폴백 폐기).
 *   - subagent / subagent_model / subagent_role: caller 책임 convention.
 *
 * .env의 AGENT_PLATFORM / AGENT_MODEL 폐기 (이전 cleanup 모드의 잔재).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface AgentIdentity {
  agent_platform: string;
  agent_model: string;
  subagent: boolean;
  subagent_model: string | null;
  subagent_role: string | null;
}

export interface AgentIdentityArgs {
  agent_platform?: string;
  agent_model?: string;
  subagent?: boolean;
  subagent_model?: string;
  subagent_role?: string;
}

/**
 * MCP server의 clientInfo로부터 platform 자동 감지 + caller args 우선 적용.
 *
 * MCP 프로토콜 한계:
 *   - clientInfo: { name, version } 자동 교환 (initialize handshake) → name으로 platform 자동 캡처
 *   - model 정보는 clientInfo에 없음 → caller args 필수
 *   - subagent context는 MCP가 모름 → caller 책임
 */
export function resolveAgentIdentity(
  server: McpServer,
  args: AgentIdentityArgs
): AgentIdentity {
  // clientInfo로 platform 자동 감지 (caller args 있으면 그게 우선)
  let detectedPlatform = 'unknown';
  try {
    const clientVersion = server.server.getClientVersion();
    if (clientVersion?.name) {
      detectedPlatform = clientVersion.name;
    }
  } catch {
    // 초기화 전 또는 SDK 버전 차이 — 폴백
  }

  const agent_platform = args.agent_platform ?? detectedPlatform;
  const agent_model = args.agent_model ?? 'unknown';

  const subagent = args.subagent === true;
  const subagent_model = subagent ? (args.subagent_model ?? null) : null;
  const subagent_role = subagent ? (args.subagent_role ?? null) : null;

  return {
    agent_platform,
    agent_model,
    subagent,
    subagent_model,
    subagent_role,
  };
}
