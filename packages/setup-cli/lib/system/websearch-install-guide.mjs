import { printDetail, printNote, printSuccess } from "../cli/messages.mjs";
import { WEBSEARCH_MCP_SERVER_NAME } from "./websearch-state.mjs";

/**
 * @param {string} filePath
 * @param {string} home
 */
function displayConfigPath(filePath, home) {
  if (home && filePath.startsWith(home)) {
    return `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

/**
 * Explicit on-command step for Claude Code websearch MCP.
 * @param {{ installed?: boolean, changed?: boolean, filePath?: string, reason?: string }} syncResult
 * @param {string} home
 */
export async function printWebsearchOnStep(syncResult, home) {
  if (!syncResult?.installed) {
    if (syncResult?.reason === "flag-unavailable") {
      printNote("Web search MCP was not configured (could not verify account access).");
    }
    return;
  }

  const status = syncResult.changed ? "installed" : "configured";
  printSuccess(`Web search → ${WEBSEARCH_MCP_SERVER_NAME} (${status})`);
  if (syncResult.filePath) {
    printDetail("Config", displayConfigPath(syncResult.filePath, home));
  }
}
