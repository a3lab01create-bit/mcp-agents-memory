/**
 * MCP tool registration — RESPEC v1 fresh impl.
 *
 * Registered tools:
 *   - manage_knowledge (Phase C) : 명시 저장/수정/삭제 통합
 *   - search_memory    (Phase E) : 조회/검색 통합
 *
 * Hot Path 자동 저장 (raw INSERT)은 별도 함수 (`insertRawMemory` from
 * src/hot_path.ts) — caller가 직접 호출. MCP tool 아님.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerManageKnowledge } from "./tools/manage_knowledge.js";
import { registerSearchMemory } from "./tools/search_memory.js";
import { registerMemoryStartup } from "./tools/memory_startup.js";

export function registerTools(server: McpServer): void {
  registerManageKnowledge(server);
  registerSearchMemory(server);
  registerMemoryStartup(server);
}
