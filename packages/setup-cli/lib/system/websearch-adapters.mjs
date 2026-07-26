import path from "node:path";

import { HARNESS } from "../harness/id.mjs";
import {
  WEBSEARCH_MCP_SERVER_NAME,
  WEBSEARCH_MCP_URL,
} from "./websearch-state.mjs";

/**
 * @typedef {object} WebsearchMcpAdapter
 * @property {import("../harness/id.mjs").HarnessId} harnessId
 * @property {(home: string) => string} configPath
 * @property {boolean} needsShellFireworksExport
 * @property {() => object} buildEntry
 * @property {(config: unknown) => boolean} hasManaged
 * @property {(config: unknown, entry: object) => object} applyEnable
 * @property {(config: unknown) => object} applyDisable
 * @property {{ mode?: number }} jsonWriteOptions
 * @property {() => string} restartHint
 */

/** @type {Record<import("../harness/id.mjs").HarnessId, WebsearchMcpAdapter>} */
export const WEBSEARCH_MCP_ADAPTERS = {
  [HARNESS.CLAUDE]: {
    harnessId: HARNESS.CLAUDE,
    configPath: (home) => path.join(home, ".claude.json"),
    needsShellFireworksExport: true,
    jsonWriteOptions: { mode: 0o600 },
    buildEntry: () => ({
      type: "http",
      url: WEBSEARCH_MCP_URL,
      headers: {
        Authorization: "Bearer ${FIREWORKS_API_KEY}",
      },
    }),
    hasManaged: (config) => Boolean(config?.mcpServers?.[WEBSEARCH_MCP_SERVER_NAME]),
    applyEnable: (config, entry) => ({
      ...(config ?? {}),
      mcpServers: {
        ...((config ?? {}).mcpServers ?? {}),
        [WEBSEARCH_MCP_SERVER_NAME]: entry,
      },
    }),
    applyDisable: (config) => {
      const next = { ...(config ?? {}) };
      const servers = { ...((config ?? {}).mcpServers ?? {}) };
      delete servers[WEBSEARCH_MCP_SERVER_NAME];
      if (Object.keys(servers).length > 0) {
        next.mcpServers = servers;
      } else {
        delete next.mcpServers;
      }
      return next;
    },
    restartHint: () => "Restart Claude Code and run /mcp to connect.",
  },
};

/**
 * @param {import("../harness/id.mjs").HarnessId} harnessId
 */
export function websearchMcpAdapter(harnessId) {
  const adapter = WEBSEARCH_MCP_ADAPTERS[harnessId];
  if (!adapter) {
    throw new Error(`Websearch MCP is not supported for harness: ${harnessId}`);
  }
  return adapter;
}
