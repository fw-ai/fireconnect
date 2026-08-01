import { readJsonIfExists, writeJson } from "../io/json.mjs";
import { HARNESS } from "../harness/id.mjs";
import {
  WEBSEARCH_MCP_HARNESS_IDS,
  WEBSEARCH_MCP_SERVER_NAME,
} from "./websearch-state.mjs";
import { websearchMcpAdapter } from "./websearch-adapters.mjs";

export { WEBSEARCH_MCP_HARNESS_IDS } from "./websearch-state.mjs";

/**
 * @param {string} home
 * @param {import("../harness/id.mjs").HarnessId} harnessId
 */
export function websearchMcpConfigPath(home, harnessId) {
  return websearchMcpAdapter(harnessId).configPath(home);
}

/**
 * @param {unknown} config
 * @param {import("../harness/id.mjs").HarnessId} harnessId
 */
export function hasManagedWebsearchMcpForHarness(config, harnessId) {
  if (!config || typeof config !== "object") {
    return false;
  }
  return websearchMcpAdapter(harnessId).hasManaged(config);
}

/**
 * @param {import("../harness/id.mjs").HarnessId} harnessId
 * @param {string} [apiKey]
 */
export function websearchMcpEntryForHarness(harnessId, apiKey = "") {
  return websearchMcpAdapter(harnessId).buildEntry(apiKey);
}

/**
 * @param {string} home
 * @param {import("../harness/id.mjs").HarnessId} harnessId
 */
export async function readWebsearchMcpConfig(home, harnessId) {
  const adapter = websearchMcpAdapter(harnessId);
  const filePath = adapter.configPath(home);
  return { filePath, config: await readJsonIfExists(filePath) };
}

/**
 * @param {string} home
 * @param {import("../harness/id.mjs").HarnessId} harnessId
 * @param {{ apiKey?: string }} [options]
 */
export async function enableWebsearchMcpForHarness(home, harnessId, { apiKey = "" } = {}) {
  const adapter = websearchMcpAdapter(harnessId);
  const { filePath, config } = await readWebsearchMcpConfig(home, harnessId);
  const current = config ?? {};
  const alreadyPresent = adapter.hasManaged(current);
  const entry = adapter.buildEntry(apiKey);
  const next = adapter.applyEnable(current, entry);
  if (!alreadyPresent || JSON.stringify(current) !== JSON.stringify(next)) {
    await writeJson(filePath, next, adapter.jsonWriteOptions);
    return { changed: true, filePath };
  }
  return { changed: false, filePath };
}

/**
 * @param {string} home
 * @param {import("../harness/id.mjs").HarnessId} harnessId
 */
export async function disableWebsearchMcpForHarness(home, harnessId) {
  const adapter = websearchMcpAdapter(harnessId);
  const { filePath, config } = await readWebsearchMcpConfig(home, harnessId);
  const current = config ?? {};
  if (!adapter.hasManaged(current)) {
    return { changed: false, filePath };
  }
  const next = adapter.applyDisable(current);
  await writeJson(filePath, next);
  return { changed: true, filePath };
}

/**
 * @param {import("../harness/id.mjs").HarnessId} harnessId
 */
export function websearchMcpRestartHint(harnessId) {
  return websearchMcpAdapter(harnessId).restartHint();
}

/**
 * @param {string} home
 * @param {import("../harness/id.mjs").HarnessId} harnessId
 */
export async function harnessWebsearchMcpEnabled(home, harnessId) {
  const { config } = await readWebsearchMcpConfig(home, harnessId);
  return websearchMcpAdapter(harnessId).hasManaged(config);
}

/**
 * @param {string} home
 */
export async function managedWebsearchMcpEnabled(home) {
  for (const harnessId of WEBSEARCH_MCP_HARNESS_IDS) {
    if (await harnessWebsearchMcpEnabled(home, harnessId)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether Claude has the managed websearch MCP entry (for status / diagnostics).
 * Auth is a baked Bearer token; the shell hook is no longer required.
 * @param {string} home
 */
export async function claudeWebsearchMcpEnabled(home) {
  return harnessWebsearchMcpEnabled(home, HARNESS.CLAUDE);
}

export { WEBSEARCH_MCP_SERVER_NAME };
