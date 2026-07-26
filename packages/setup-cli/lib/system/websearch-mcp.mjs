import { isAccountFeatureFlagEnabled } from "../config/feature-flags.mjs";
import { exportFireworksApiKey } from "../keys/api-key.mjs";
import { verifyFireworksApiKey } from "../keys/verify-api-key.mjs";
import { reconcileShellEnvHook } from "../io/shell-env-hook.mjs";
import { HARNESS } from "../harness/id.mjs";
import {
  WEBSEARCH_MCP_SERVER_NAME,
  WEBSEARCH_MCP_URL,
  claudeJsonPath,
  hasManagedWebsearchMcp,
} from "./websearch-state.mjs";
import { printWebsearchOnStep } from "./websearch-install-guide.mjs";
import {
  disableWebsearchMcpForHarness,
  enableWebsearchMcpForHarness,
  websearchMcpEntryForHarness,
} from "./websearch-harness.mjs";

export {
  WEBSEARCH_MCP_SERVER_NAME,
  WEBSEARCH_MCP_URL,
  claudeJsonPath,
  hasManagedWebsearchMcp,
} from "./websearch-state.mjs";
export {
  WEBSEARCH_MCP_HARNESS_IDS,
  managedWebsearchMcpEnabled,
  claudeWebsearchMcpEnabled,
} from "./websearch-harness.mjs";

/** Feature flag that gates FireSearch / websearch MCP (control plane). */
export const WEBSEARCH_FEATURE_FLAG_ID = "allow-search-gateway";

/**
 * FireConnect-managed MCP entry for Claude (~/.claude.json).
 * @returns {{ type: string, url: string, headers: Record<string, string> }}
 */
export function websearchMcpServerEntry() {
  return websearchMcpEntryForHarness(HARNESS.CLAUDE);
}

/**
 * @param {string} home
 * @param {import("../harness/id.mjs").HarnessId} [harnessId]
 * @param {{ apiKey?: string }} [options]
 */
export async function enableWebsearchMcp(home, harnessId = HARNESS.CLAUDE) {
  const result = await enableWebsearchMcpForHarness(home, harnessId);
  await reconcileShellEnvHook(home);
  return result;
}

/**
 * @param {string} home
 * @param {import("../harness/id.mjs").HarnessId} [harnessId]
 */
export async function disableWebsearchMcp(home, harnessId = HARNESS.CLAUDE) {
  const result = await disableWebsearchMcpForHarness(home, harnessId);
  await reconcileShellEnvHook(home);
  return result;
}

/**
 * @param {string} home
 * @param {import("../harness/id.mjs").HarnessId} harnessId
 * @param {{ installed: boolean, reason: string }} result
 */
async function leaveWebsearchMcp(home, harnessId, result) {
  if (!result.installed) {
    await disableWebsearchMcp(home, harnessId);
  }
  return result;
}

/**
 * Install or remove the managed websearch MCP server based on the account flag.
 * @param {string} home
 * @param {{ harnessId?: import("../harness/id.mjs").HarnessId, apiKey?: string, accountId?: string, quiet?: boolean }} [options]
 */
export async function syncWebsearchMcp(home, {
  harnessId = HARNESS.CLAUDE,
  apiKey = "",
  accountId = "",
  quiet = false,
} = {}) {
  let resolvedKey = apiKey.trim();
  let resolvedAccountId = accountId.trim();
  if (!resolvedKey) {
    try {
      resolvedKey = await exportFireworksApiKey(home, { storedOnly: false });
    } catch {
      return leaveWebsearchMcp(home, harnessId, { installed: false, reason: "missing-api-key" });
    }
  }
  if (!resolvedAccountId) {
    const verified = await verifyFireworksApiKey(resolvedKey);
    if (!verified.ok) {
      return leaveWebsearchMcp(home, harnessId, {
        installed: false,
        reason: verified.reason || "invalid-api-key",
      });
    }
    resolvedAccountId = verified.accountId.trim();
    if (!resolvedAccountId) {
      return leaveWebsearchMcp(home, harnessId, { installed: false, reason: "missing-account-id" });
    }
  }

  const flag = await isAccountFeatureFlagEnabled(resolvedAccountId, resolvedKey, WEBSEARCH_FEATURE_FLAG_ID);
  if (flag.unavailable) {
    if (!quiet) {
      console.log(
        `Websearch MCP was not configured (${flag.reason}). `
          + "Could not verify web search access for this account.",
      );
    }
    return leaveWebsearchMcp(home, harnessId, { installed: false, reason: flag.reason || "flag-unavailable" });
  }
  if (!flag.enabled) {
    return leaveWebsearchMcp(home, harnessId, { installed: false, reason: "flag-disabled" });
  }

  const result = await enableWebsearchMcp(home, harnessId);
  const syncResult = { installed: true, reason: "", filePath: result.filePath, changed: result.changed };
  if (!quiet) {
    await printWebsearchOnStep(syncResult, home);
  }
  return syncResult;
}
