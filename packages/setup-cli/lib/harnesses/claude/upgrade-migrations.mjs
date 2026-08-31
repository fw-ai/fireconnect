import { isEnabledFireworksHarness, readGlobalConfig } from "../../config/global-config.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import { CLAUDE_CODE_BEHAVIOR_ENV, providerStatusFromEnv, userSettingsPath } from "./core.mjs";

/**
 * Add `ENABLE_TOOL_SEARCH` to an already-connected Claude Code install.
 * Installs connected before this key existed route to the Fireworks gateway
 * without it, and Claude Code turns MCP tool search off for a non-first-party
 * `ANTHROPIC_BASE_URL` unless it is set.
 *
 * Owns every gate: the harness must be enabled and Fireworks-routed, settings
 * must already point at Fireworks, and an existing value (including a user's
 * `false` / `auto:N`) is left alone.
 * @param {string} home
 * @returns {Promise<boolean>} true when the file was updated
 */
export async function migrateClaudeToolSearchOnUpgrade(home) {
  if (!home) {
    return false;
  }
  const { harnesses } = await readGlobalConfig(home);
  if (!isEnabledFireworksHarness(harnesses, HARNESS.CLAUDE)) {
    return false;
  }
  const settingsPath = userSettingsPath(home);
  const settings = await readJsonIfExists(settingsPath);
  const env = settings.env ?? {};
  if (providerStatusFromEnv(env) !== "fireworks" || Object.hasOwn(env, "ENABLE_TOOL_SEARCH")) {
    return false;
  }
  await writeJson(
    settingsPath,
    {
      ...settings,
      env: { ...env, ENABLE_TOOL_SEARCH: CLAUDE_CODE_BEHAVIOR_ENV.ENABLE_TOOL_SEARCH },
    },
    // Managed settings hold the baked Fireworks key.
    { mode: 0o600 },
  );
  return true;
}
