/**
 * memory_startup — 시작 brief refresh tool (RESPEC PROBLEMS.md §1).
 *
 * Connect 시 instructions에 brief 자동 주입되는 게 primary path.
 * 본 tool은 mid-session refresh / 명시적 새 brief 호출용 fallback.
 *
 * 응답: brief 텍스트 (markdown).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { collectBrief, formatBriefMarkdown } from "../briefing.js";

export function registerMemoryStartup(server: McpServer): void {
  server.registerTool(
    'memory_startup',
    {
      description: `시작 brief refresh — 첫 connect 시 server instructions로 자동 주입됨.
세션 중간에 user profile / 최근 활성 p_tag / 최근 메모리를 다시 보고 싶을 때
명시 호출. 응답은 markdown text.

primary path: server connect 시 instructions에 자동 주입.
fallback path: 본 tool로 mid-session에 갱신된 brief 받기.

platform priority: 호출하는 platform (Claude / Gemini / Codex)이 자동 감지되어
그 platform 메시지를 brief 우선순위로 보여주고, 다른 platform은 별도 섹션
("Cross-platform Whispers")으로 짧게. 모든 platform 통합 brief 원하면
agent_platform_filter=false.`,
      inputSchema: {
        short_term_days: z.number().int().min(1).max(30).optional().describe(
          `단기 메모리 윈도우 (default: env SHORT_TERM_DAYS, 기본 3일)`
        ),
        agent_platform_filter: z.boolean().optional().describe(
          `current platform 우선 brief 사용 (default: true). false면 모든 platform 통합.`
        ),
      },
    },
    async (args) => {
      // clientInfo로 current platform 감지 (handshake 후 안정적)
      let currentPlatform: string | null = null;
      const useFilter = args.agent_platform_filter ?? true;
      if (useFilter) {
        try {
          const cv = server.server.getClientVersion();
          currentPlatform = cv?.name ?? null;
        } catch {
          currentPlatform = null;
        }
      }
      const brief = await collectBrief({
        shortTermDays: args.short_term_days,
        currentPlatform,
      });
      const md = formatBriefMarkdown(brief);
      return {
        content: [{ type: 'text' as const, text: md }],
      };
    }
  );
}
