/**
 * MCP tool registration — RESPEC v1 fresh impl skeleton.
 *
 * Phase A2: Skeleton 상태. 실제 tool은 Phase C/E에서 등록:
 *   - Phase C: manage_knowledge (저장/수정 통합)
 *   - Phase E: search_memory (조회/검색 통합)
 *
 * 옛 12개 tool (memory_startup, memory_add, memory_save_skill,
 * memory_curator_run, memory_search 구버전, memory_status, memory_restore,
 * connector_sync 등) 전부 폐기. RESPEC §1 Tool Consolidation 결정 정합.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerTools(_server: McpServer): void {
  // 비어있음 — Phase C / Phase E에서 채움.
}
