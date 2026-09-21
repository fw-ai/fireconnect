import path from "node:path";

export const WEBSEARCH_MCP_SERVER_NAME = "fireworks-websearch";
export const WEBSEARCH_MCP_URL = "https://mcp.fireworks.ai/work/mcp";

export function claudeJsonPath(home) {
  return path.join(home, ".claude.json");
}

/**
 * @param {unknown} config
 */
export function hasManagedWebsearchMcp(config) {
  const servers = config?.mcpServers;
  return Boolean(
    servers
    && typeof servers === "object"
    && Object.hasOwn(servers, WEBSEARCH_MCP_SERVER_NAME),
  );
}
