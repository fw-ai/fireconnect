import { isEnabledFireworksHarness, readGlobalConfig } from "../../config/global-config.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import { loadRegisterableModels } from "../../fireworks/models.mjs";
import { shortFireworksModelRef } from "../../fireworks/model-id.mjs";
import { detectApiKeyType } from "../../keys/key-type.mjs";
import { resolveFireworksApiKeyValue } from "../../keys/api-key.mjs";
import { disableWebsearchMcp } from "../../system/websearch-mcp.mjs";
import {
  CLAUDE_CODE_BEHAVIOR_ENV,
  providerBackupPath,
  providerStatusFromEnv,
  resolveDataDir,
  userSettingsPath,
} from "./core.mjs";
import {
  originalSettingsDeniedServerTools,
  reconcileGatewayServerToolDenials,
} from "./server-tools-deny.mjs";
import {
  buildFireconnectModelPickerOptions,
  isFireconnectModelPicker,
} from "./settings-model-picker.mjs";
import { resolveClaudeAuthState } from "./index.mjs";

/**
 * Backfill one behavior key into an already-connected Claude Code install.
 * Owns every gate: the harness must be enabled and Fireworks-routed, and an
 * existing value (including a user's) is left alone.
 * @param {string} home
 * @param {keyof typeof CLAUDE_CODE_BEHAVIOR_ENV} key
 * @returns {Promise<boolean>} true when the file was updated
 */
async function backfillClaudeBehaviorKey(home, key) {
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
  if (providerStatusFromEnv(env) !== "fireworks" || Object.hasOwn(env, key)) {
    return false;
  }
  await writeJson(
    settingsPath,
    { ...settings, env: { ...env, [key]: CLAUDE_CODE_BEHAVIOR_ENV[key] } },
    // Managed settings hold the baked Fireworks key.
    { mode: 0o600 },
  );
  return true;
}

/**
 * Add `ENABLE_TOOL_SEARCH` to an already-connected Claude Code install.
 * Installs connected before this key existed route to the Fireworks gateway
 * without it, and Claude Code turns MCP tool search off for a non-first-party
 * `ANTHROPIC_BASE_URL` unless it is set.
 * @param {string} home
 * @returns {Promise<boolean>} true when the file was updated
 */
export async function migrateClaudeToolSearchOnUpgrade(home) {
  return backfillClaudeBehaviorKey(home, "ENABLE_TOOL_SEARCH");
}

/**
 * Pin `CLAUDE_CODE_AUTO_MODE_SERVER` to local-only classifier requests on an
 * already-connected Claude Code install. Installs connected before this key
 * existed ask the server by default (Claude Code >= 2.1.278) and earn the
 * ineligibility notice on every session, because the Fireworks gateway does
 * not implement the server-side classifier yet.
 *
 * Temporary: remove this migration (and the preset entry) once the gateway
 * implements safeguard passthrough.
 * @param {string} home
 * @returns {Promise<boolean>} true when the file was updated
 */
export async function migrateClaudeAutoModeServerOnUpgrade(home) {
  return backfillClaudeBehaviorKey(home, "CLAUDE_CODE_AUTO_MODE_SERVER");
}

/**
 * Let the built-in Explore agent inherit the session model on an
 * already-connected Claude Code install. Installs connected before this key
 * existed run every exploration call on Opus: Explore inherits the main model
 * capped at Opus, and a Fireworks parent model fails that mapping.
 * @param {string} home
 * @returns {Promise<boolean>} true when the file was updated
 */
export async function migrateClaudeExploreInheritCapOnUpgrade(home) {
  return backfillClaudeBehaviorKey(home, "CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP");
}

/**
 * Retire the FireConnect-managed WebSearch MCP now that the Messages endpoint
 * supports Claude's native WebSearch and WebFetch tools. Existing user MCPs
 * and explicit user deny rules are preserved.
 * @param {string} home
 * @returns {Promise<boolean>} true when any config was updated
 */
export async function migrateClaudeNativeWebSearchOnUpgrade(home) {
  if (!home) {
    return false;
  }
  const mcpResult = await disableWebsearchMcp(home);
  const { harnesses } = await readGlobalConfig(home);
  if (!isEnabledFireworksHarness(harnesses, HARNESS.CLAUDE)) {
    return mcpResult.changed;
  }

  const settingsPath = userSettingsPath(home);
  const settings = await readJsonIfExists(settingsPath);
  if (providerStatusFromEnv(settings.env ?? {}) !== "fireworks") {
    return mcpResult.changed;
  }
  const backup = await readJsonIfExists(providerBackupPath(resolveDataDir({ home })));
  const next = reconcileGatewayServerToolDenials(settings, {
    preserveDeniedTools: originalSettingsDeniedServerTools(settings, backup),
  });
  if (next === settings) {
    return mcpResult.changed;
  }
  await writeJson(settingsPath, next, { mode: 0o600 });
  return true;
}

/**
 * Re-render the managed `/model` picker rows from the live serverless catalog
 * on upgrade. `claude on` rebuilds the picker wholesale, but an already-on
 * install that only upgrades would otherwise keep last version's descriptions,
 * pricing, and catalog rows forever — this is the upgrade half of the refresh.
 *
 * Only FireConnect-managed pickers are touched; a user-authored `modelPicker`
 * block is left exactly as-is (the whole point of the marker). Rows the live
 * catalog doesn't serve are preserved rather than pruned — a `--model`-added
 * extra is indistinguishable from a delisted catalog row here, and `claude on`
 * remains the authoritative prune path. Best-effort: no key or unreachable
 * catalog leaves the file untouched.
 *
 * @param {string} home
 * @returns {Promise<boolean>} true when the file was updated
 */
export async function migrateClaudeModelPickerOnUpgrade(home) {
  if (!home) {
    return false;
  }
  const { harnesses } = await readGlobalConfig(home);
  if (!isEnabledFireworksHarness(harnesses, HARNESS.CLAUDE)) {
    return false;
  }
  const settingsPath = userSettingsPath(home);
  const settings = await readJsonIfExists(settingsPath);
  if (providerStatusFromEnv(settings.env ?? {}) !== "fireworks") {
    return false;
  }
  const modelPicker = settings.modelPicker;
  if (!isFireconnectModelPicker(modelPicker)) {
    return false;
  }
  const token = resolveClaudeAuthState(settings).token
    || await resolveFireworksApiKeyValue({ home }).catch(() => "");
  if (!token) {
    return false;
  }
  // Fire Pass serves no picker catalog — `claude on` strips the picker for it,
  // so an upgrade must not rebuild one. Leave it for the next `on` instead.
  const keyType = detectApiKeyType(token);
  if (keyType === "firepass") {
    return false;
  }
  const { ids } = await loadRegisterableModels({
    apiKey: token,
    includeFirerouter: true,
  });
  const rebuilt = buildFireconnectModelPickerOptions(
    ids.map((id) => shortFireworksModelRef(id)).filter(Boolean),
  );
  if (!rebuilt.length) {
    return false;
  }
  // Preserve extras (custom --model rows, firerouter paths) the rebuild drops.
  const seen = new Set(rebuilt.map((option) => option.model));
  const options = [...rebuilt];
  for (const row of modelPicker.options ?? []) {
    if (typeof row?.model === "string" && !seen.has(row.model)) {
      options.push(row);
      seen.add(row.model);
    }
  }
  if (JSON.stringify(options) === JSON.stringify(modelPicker.options ?? [])) {
    return false;
  }
  await writeJson(
    settingsPath,
    { ...settings, modelPicker: { ...modelPicker, options } },
    { mode: 0o600 },
  );
  return true;
}
