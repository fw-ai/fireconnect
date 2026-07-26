import { tryReadKeychainSecret } from "../keys/api-key.mjs";
import { claudeWebsearchMcpEnabled } from "../system/websearch-harness.mjs";

/**
 * Whether the shell hook should export FIREWORKS_API_KEY for Claude websearch
 * MCP (${FIREWORKS_API_KEY} in ~/.claude.json). Harness configs use baked
 * literals; upgrade rebakes any legacy env-reference files on disk.
 * @param {string} home
 * @param {import("../config/global-config.mjs").HarnessConfigMap} _harnesses
 * @param {boolean} installShellHook
 */
export async function needsFireworksShellExport(home, _harnesses, installShellHook) {
  if (!await claudeWebsearchMcpEnabled(home)) {
    return false;
  }
  if (installShellHook) {
    return true;
  }
  // Legacy global `{env:FIREWORKS_API_KEY}` — export when keychain holds the secret.
  return Boolean(await tryReadKeychainSecret(home));
}
