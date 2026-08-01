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
 * @property {(apiKey?: string) => object} buildEntry
 * @property {(config: unknown) => boolean} hasManaged
 * @property {(config: unknown, entry: object) => object} applyEnable
 * @property {(config: unknown) => object} applyDisable
 * @property {{ mode?: number }} jsonWriteOptions
 * @property {() => string} restartHint
 */

/**
 * @param {string} [apiKey]
 */
export function buildWebsearchMcpEntry(apiKey = "") {
  const token = apiKey.trim();
  return {
    type: "http",
    url: WEBSEARCH_MCP_URL,
    headers: {
      // Bake the key (same shape as `claude mcp add --header`). Claude expands
      // `${FIREWORKS_API_KEY}` from the process env; a literal avoids the shell
      // hook and auth-miss retries when the env var is unset.
      Authorization: token
        ? `Bearer ${token}`
        : "Bearer ${FIREWORKS_API_KEY}",
    },
  };
}

/** @type {Record<import("../harness/id.mjs").HarnessId, WebsearchMcpAdapter>} */
export const WEBSEARCH_MCP_ADAPTERS = {
  [HARNESS.CLAUDE]: {
    harnessId: HARNESS.CLAUDE,
    configPath: (home) => path.join(home, ".claude.json"),
    // Auth is a baked Bearer token; no FIREWORKS_API_KEY shell export needed.
    needsShellFireworksExport: false,
    jsonWriteOptions: { mode: 0o600 },
    buildEntry: (apiKey = "") => buildWebsearchMcpEntry(apiKey),
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
