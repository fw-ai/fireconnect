import { unlink } from "node:fs/promises";
import {
  backupFromSettings,
  backupTopLevelFromSettings,
  applyTopLevelBackup,
  clearFireworksTopLevelWithoutBackup,
  CLAUDE_CODE_BEHAVIOR_ENV,
  FIREWORKS_ENV_KEYS,
  isFireworksModelId,
  providerBackupPath,
  providerStatePath,
  readJsonIfExists,
  stripFireworksOwnedEnv,
  stripManagedApiKeyHelper,
  stripModelMappingEnv,
  writeJson,
} from "./fireconnect-core.mjs";
import { fireconnectKeyExportCommand } from "./cli-path.mjs";
import {
  persistGlobalRouterBaseUrl,
  readGlobalConfig,
} from "./global-config.mjs";
import {
  buildClaudeCustomHeaders,
  CLAUDE_FIREROUTER_ENV_KEYS,
  firerouterStatusFromEnv,
  resolveFirerouterBaseUrl,
  stripFirerouterOwnedEnv,
} from "./firerouter-core.mjs";

export { CLAUDE_FIREROUTER_ENV_KEYS, firerouterStatusFromEnv } from "./firerouter-core.mjs";

function supplementFirerouterBackup(backup, settings) {
  const env = settings.env ?? {};
  const supplementalKeys = CLAUDE_FIREROUTER_ENV_KEYS.filter(
    (key) => !FIREWORKS_ENV_KEYS.includes(key),
  );
  const values = { ...backup.values };
  const missing = [...(backup.missing ?? [])];
  for (const key of supplementalKeys) {
    if (Object.hasOwn(env, key)) {
      values[key] = env[key];
      const idx = missing.indexOf(key);
      if (idx !== -1) {
        missing.splice(idx, 1);
      }
    } else if (!missing.includes(key) && !Object.hasOwn(values, key)) {
      missing.push(key);
    }
  }
  return { ...backup, values, missing };
}

function backupForFirerouterEnable(settings) {
  return supplementFirerouterBackup(backupFromSettings(settings), settings);
}

/**
 * Strip a FireConnect-managed apiKeyHelper for the firerouter path. Prefers
 * the exact `managedApiKeyHelper` recorded in provider-state.json (which
 * always matches what direct mode wrote to settings) over recomputing from
 * `home` — that way a CLI path change between direct-on and router-on/off
 * (Node upgrade, launcher appearing/disappearing, flag format change) can't
 * make the strip silently no-op. Falls back to `fireconnectKeyExportCommand`
 * only when state lacks `managedApiKeyHelper`, so a lingering managed helper
 * is still caught when state was cleared but settings weren't. Preserves
 * `state.authMode === "apiKeyHelper"` so the authMode strip path still works.
 * Returns { settings, changed } like the sibling strip helpers.
 */
function stripManagedHelper(settings, { state = {}, home = "" } = {}) {
  const stored = state.managedApiKeyHelper;
  const recompute = home ? fireconnectKeyExportCommand(home) : "";
  return stripManagedApiKeyHelper(settings, {
    authMode: state.authMode,
    managedApiKeyHelper: stored || recompute || undefined,
  });
}

/**
 * @param {{
 *   settingsPath: string,
 *   dataDir: string,
 *   baseUrl?: string,
 *   fireworksKey: string,
 *   anthropicKey?: string,
 *   home?: string,
 * }} opts
 */
export async function enableFirerouterClaude({
  settingsPath,
  dataDir,
  baseUrl = "",
  fireworksKey,
  anthropicKey = "",
  home = "",
}) {
  if (!fireworksKey?.trim()) {
    throw new Error("No Fireworks API key found. Pass --api-key or set FIREWORKS_API_KEY.");
  }

  const globalConfig = home ? await readGlobalConfig(home) : { routerBaseUrl: "" };
  const routerOptions = { routerBaseUrl: globalConfig.routerBaseUrl };
  const settings = await readJsonIfExists(settingsPath);
  const env = settings.env ?? {};
  const backupPath = providerBackupPath(dataDir);
  const state = await readJsonIfExists(providerStatePath(dataDir));

  if (firerouterStatusFromEnv(env, routerOptions) !== "firerouter") {
    const existingBackup = await readJsonIfExists(backupPath);
    if (!existingBackup.values) {
      await writeJson(backupPath, backupForFirerouterEnable(settings));
    } else if (!existingBackup.topLevel) {
      await writeJson(backupPath, {
        ...supplementFirerouterBackup(existingBackup, settings),
        topLevel: backupTopLevelFromSettings(settings),
      });
    }
  }

  const resolvedBaseUrl = resolveFirerouterBaseUrl(baseUrl, globalConfig.routerBaseUrl);
  const stripped = stripFireworksOwnedEnv(env);
  const strippedRouter = stripFirerouterOwnedEnv(stripped.env, routerOptions);
  const strippedModels = stripModelMappingEnv(strippedRouter.env);
  const nextEnv = {
    ...strippedModels.env,
    ...CLAUDE_CODE_BEHAVIOR_ENV,
    ANTHROPIC_BASE_URL: resolvedBaseUrl,
    ANTHROPIC_CUSTOM_HEADERS: buildClaudeCustomHeaders({
      fireworksKey: fireworksKey.trim(),
    }),
  };
  if (anthropicKey?.trim()) {
    nextEnv.ANTHROPIC_AUTH_TOKEN = anthropicKey.trim();
  } else {
    delete nextEnv.ANTHROPIC_AUTH_TOKEN;
  }
  delete nextEnv.ANTHROPIC_API_KEY;

  let nextSettings = { ...settings, env: nextEnv };
  if (isFireworksModelId(nextSettings.model)) {
    nextSettings = clearFireworksTopLevelWithoutBackup(nextSettings);
  }
  // Router mode authenticates via ANTHROPIC_CUSTOM_HEADERS (+ optional
  // ANTHROPIC_AUTH_TOKEN). Strip only a FireConnect-managed apiKeyHelper
  // (left over from direct mode) — it would re-inject the Fireworks key as
  // ANTHROPIC_API_KEY and conflict with header auth. A user's OWN helper is
  // kept: router mode "picks up" whatever helper existed in the off/native
  // state (the pre-off in `claude on --router` restored it first) and lets it
  // run. `claude off` leaves the user's helper in place.
  nextSettings = stripManagedHelper(nextSettings, { state, home }).settings;

  await writeJson(settingsPath, nextSettings);
  if (home) {
    await persistGlobalRouterBaseUrl(home, resolvedBaseUrl);
  }

  return {
    baseUrl: resolvedBaseUrl,
    anthropicKey: anthropicKey?.trim() ?? "",
    fireworksKey: fireworksKey.trim(),
  };
}

/**
 * @param {{
 *   settingsPath: string,
 *   dataDir: string,
 *   wasEnabled?: boolean,
 *   routerBaseUrl?: string,
 *   home?: string,
 * }} opts
 */
export async function disableFirerouterClaude({
  settingsPath,
  dataDir,
  wasEnabled = false,
  routerBaseUrl = "",
  home = "",
}) {
  const backupPath = providerBackupPath(dataDir);
  const settings = await readJsonIfExists(settingsPath);
  const backup = await readJsonIfExists(backupPath);
  const state = await readJsonIfExists(providerStatePath(dataDir));
  const env = settings.env ?? {};
  const routerOptions = { routerBaseUrl };
  const hasBackup = Boolean(backup.values);

  if (!wasEnabled && !hasBackup) {
    return;
  }

  if (hasBackup) {
    const nextEnv = { ...env };
    for (const key of CLAUDE_FIREROUTER_ENV_KEYS) {
      delete nextEnv[key];
    }
    for (const [key, value] of Object.entries(backup.values)) {
      nextEnv[key] = value;
    }
    for (const key of backup.missing ?? []) {
      delete nextEnv[key];
    }

    let nextSettings = { ...settings, env: nextEnv };
    if (backup.topLevel?.values || backup.topLevel?.missing) {
      nextSettings = applyTopLevelBackup(nextSettings, backup.topLevel);
    } else if (isFireworksModelId(nextSettings.model)) {
      nextSettings = clearFireworksTopLevelWithoutBackup(nextSettings);
    }
    // Strip a lingering managed helper AFTER the restore, independent of
    // whether the backup had a topLevel entry — a pre-fix backup may lack
    // topLevel, and the strip is a safe no-op when nothing matches.
    nextSettings = stripManagedHelper(nextSettings, { state, home }).settings;

    await writeJson(settingsPath, nextSettings);
    await unlink(backupPath).catch(() => {});
    return;
  }

  const { env: nextEnv, changed: envChanged } = stripFirerouterOwnedEnv(env, routerOptions);
  let nextSettings = { ...settings, env: nextEnv };
  const hadFireworksModel = isFireworksModelId(settings.model);
  if (hadFireworksModel) {
    nextSettings = clearFireworksTopLevelWithoutBackup(nextSettings);
  }
  const { settings: strippedSettings, changed: helperChanged } = stripManagedHelper(nextSettings, { state, home });
  nextSettings = strippedSettings;

  if (envChanged || hadFireworksModel || helperChanged) {
    await writeJson(settingsPath, nextSettings);
  }
}
