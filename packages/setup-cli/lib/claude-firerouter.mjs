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
  readJsonIfExists,
  stripFireworksOwnedEnv,
  stripModelMappingEnv,
  writeJson,
} from "./fireconnect-core.mjs";
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
 * }} opts
 */
export async function disableFirerouterClaude({
  settingsPath,
  dataDir,
  wasEnabled = false,
  routerBaseUrl = "",
}) {
  const backupPath = providerBackupPath(dataDir);
  const settings = await readJsonIfExists(settingsPath);
  const backup = await readJsonIfExists(backupPath);
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

  if (envChanged || hadFireworksModel) {
    await writeJson(settingsPath, nextSettings);
  }
}
