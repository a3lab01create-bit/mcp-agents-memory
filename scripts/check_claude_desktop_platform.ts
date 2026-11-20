/** Claude Desktop clientInfo 정규화와 memory_startup 경고 연결 경로. DB 연결 없이 검사한다. */
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectClientPlatform, resolveAgentIdentity } from "../src/agent_identity.js";
import { formatCaptureWarning, type CaptureStatus } from "../src/auto_save/jsonl_capture.js";

function serverFor(name?: string): McpServer {
  return { server: { getClientVersion: () => name === undefined ? undefined : { name, version: "check" } } } as McpServer;
}

const pending: CaptureStatus = {
  mode: "pending", cwd: "/project", projectDir: null, files: 0, reason: "waiting",
};

for (const name of ["local-agent-mode-mcp-agents-memory", "local-agent-mode-other-server", "local-agent-mode"]) {
  const server = serverFor(name);
  const platform = detectClientPlatform(server);
  assert.equal(platform, "claude-desktop", `${name} → stable desktop platform`);
  assert.equal(resolveAgentIdentity(server, {}).agent_platform, "claude-desktop");
  assert.equal(resolveAgentIdentity(server, { agent_platform: "explicit-platform" }).agent_platform, "explicit-platform",
    "caller override still takes priority");
  assert.match(formatCaptureWarning(platform, pending) ?? "", /자동 수집되지 않고/,
    "normalized name must retain the missing-capture warning");
  assert.match(formatCaptureWarning(name, pending) ?? "", /자동 수집되지 않고/,
    "raw clientInfo names remain compatible");
}

for (const name of ["claude-code", "claude-desktop"]) {
  assert.equal(detectClientPlatform(serverFor(name)), name);
  assert.match(formatCaptureWarning(name, pending) ?? "", /자동 수집되지 않고/);
  assert.equal(formatCaptureWarning(name, { ...pending, mode: "dir", files: 1 }), null,
    "armed capture is quiet");
  assert.equal(formatCaptureWarning(name, { ...pending, cwd: "/" }), null,
    "app-wide root connection is quiet");
  assert.match(formatCaptureWarning(name, { ...pending, mode: "off", cwd: null }) ?? "", /자동 수집되지 않고/);
}

for (const name of ["codex-mcp-client", "gemini-cli-mcp-client", "mcp", "opencode", "cli", "acp",
  "grok-shell-mcp-agents-memory", "antigravity-client", "other-client", "other-local-agent-mode"]) {
  assert.equal(detectClientPlatform(serverFor(name)), name, "other clients keep their identity");
  assert.equal(formatCaptureWarning(detectClientPlatform(serverFor(name)), pending), null,
    "other clients do not receive Claude capture warnings");
}

for (const name of [undefined, ""]) {
  const server = serverFor(name);
  assert.equal(detectClientPlatform(server), null);
  assert.equal(resolveAgentIdentity(server, {}).agent_platform, "unknown");
  assert.equal(formatCaptureWarning(detectClientPlatform(server), pending), null);
}
const beforeHandshake = { server: { getClientVersion() { throw new Error("not initialized"); } } } as unknown as McpServer;
assert.equal(detectClientPlatform(beforeHandshake), null);
assert.equal(resolveAgentIdentity(beforeHandshake, {}).agent_platform, "unknown");

console.log("Claude Desktop platform and capture warning checks passed");
