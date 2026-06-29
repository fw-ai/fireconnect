import { createHash } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_FIREPASS_MAIN_MODEL,
  DEFAULT_MAIN_MODEL,
  detectApiKeyType,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
  normalizeModelId,
  readJsonIfExists,
  writeJson,
} from "./fireconnect-core.mjs";
import { readRawIfExists } from "./opencode-core.mjs";
import {
  AZURE_API_KEY_ENV,
  AZURE_PROVIDER_LABEL,
  DEFAULT_AZURE_MODEL,
  MISSING_AZURE_API_KEY_MESSAGE,
  MISSING_AZURE_BASE_URL_MESSAGE,
  normalizeAzureBaseUrl,
} from "./azure-core.mjs";

export const PI_SETTINGS_RELATIVE_PATH = ".pi/agent/settings.json";
export const PI_MODELS_RELATIVE_PATH = ".pi/agent/models.json";
export const PI_DATA_RELATIVE_DIR = ".fireconnect/pi";
export const PI_API_KEY_ENV_REF = "$FIREWORKS_API_KEY";
const PI_PROVIDER = "fireworks";
const PI_MANAGED_BY = "fireconnect";
// Pi routes Foundry through a distinct custom provider (openai-completions) so
// it never collides with the built-in Fireworks provider.
export const PI_AZURE_PROVIDER = "fireworks-azure";
export const PI_AZURE_API_KEY_ENV_REF = `$${AZURE_API_KEY_ENV}`;

/** Fireworks routers FireConnect uses that Pi does not ship in its models.dev snapshot. */
const PI_FIREWORKS_ROUTER_ENTRIES = [
  { id: "accounts/fireworks/routers/glm-latest", name: "GLM Latest via Fireworks" },
  { id: "accounts/fireworks/routers/glm-fast-latest", name: "GLM Fast Latest via Fireworks" },
  { id: "accounts/fireworks/routers/glm-5p2-fast", name: "GLM 5.2 Fast via Fireworks" },
  { id: "accounts/fireworks/routers/kimi-fast-latest", name: "Kimi Fast Latest via Fireworks" },
  { id: "accounts/fireworks/routers/kimi-k2p6-turbo", name: "Kimi K2.6 Turbo via Fireworks" },
  { id: "accounts/fireworks/routers/kimi-k2p7-code-fast", name: "Kimi K2.7 Code Fast via Fireworks" },
  { id: "accounts/fireworks/routers/kimi-latest", name: "Kimi Latest via Fireworks" },
];

function isFireconnectActive(settings) {
  if (settings.defaultProvider === PI_AZURE_PROVIDER
    && typeof settings.defaultModel === "string"
    && settings.defaultModel.length > 0) {
    return true;
  }
  return settings.defaultProvider === PI_PROVIDER
    && typeof settings.defaultModel === "string"
    && settings.defaultModel.startsWith("accounts/fireworks/");
}

function isFireconnectManagedAuth(auth) {
  return auth[PI_PROVIDER]?.managedBy === PI_MANAGED_BY;
}

export function piSettingsPath(home, settingsPath = "") {
  return settingsPath || path.join(home, PI_SETTINGS_RELATIVE_PATH);
}

export function piAuthPath(home, authPath = "", settingsPath = "") {
  if (authPath) {
    return authPath;
  }
  if (settingsPath) {
    return path.join(path.dirname(settingsPath), "auth.json");
  }
  return path.join(home, ".pi/agent/auth.json");
}

export function piModelsPath(home, settingsPath = "") {
  if (settingsPath) {
    return path.join(path.dirname(settingsPath), "models.json");
  }
  return path.join(home, PI_MODELS_RELATIVE_PATH);
}

function fireworksModelEntry(modelId) {
  const shortId = modelId.split("/").pop() ?? modelId;
  return {
    id: modelId,
    name: `${shortId} via Fireworks`,
    reasoning: true,
  };
}

function piModelsToRegister(resolvedModel) {
  const entries = [...PI_FIREWORKS_ROUTER_ENTRIES.map((entry) => ({
    ...entry,
    reasoning: true,
  }))];
  if (resolvedModel.startsWith("accounts/fireworks/")
    && !entries.some((entry) => entry.id === resolvedModel)) {
    entries.push(fireworksModelEntry(resolvedModel));
  }
  return entries;
}

export function mergePiFireworksRouterModels(config, resolvedModel) {
  const next = config && typeof config === "object"
    ? structuredClone(config)
    : { providers: {} };
  next.providers ??= {};
  const fireworks = { ...(next.providers[PI_PROVIDER] ?? {}) };
  const models = [...(fireworks.models ?? [])];
  for (const entry of piModelsToRegister(resolvedModel)) {
    const index = models.findIndex((model) => model.id === entry.id);
    if (index >= 0) {
      models[index] = { ...models[index], ...entry };
    } else {
      models.push(entry);
    }
  }
  fireworks.models = models;
  next.providers[PI_PROVIDER] = fireworks;
  return next;
}

export function piDataDir(home, dataDir = "") {
  return dataDir || path.join(home, PI_DATA_RELATIVE_DIR);
}

function backupPath(dataDir, filePath, label) {
  const key = createHash("sha256").update(path.resolve(filePath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `${label}-backup.${key}.json`);
}

function statePath(dataDir) {
  return path.join(dataDir, "state.json");
}

async function writeState(dataDir, enabled, managedModelIds = []) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeJson(statePath(dataDir), { enabled, managedModelIds });
  await chmod(statePath(dataDir), 0o600);
}

export function resolvePiApiKeyValue(key) {
  return key === PI_API_KEY_ENV_REF || key === "${FIREWORKS_API_KEY}"
    ? (process.env.FIREWORKS_API_KEY ?? "")
    : key;
}

/**
 * Resolve Pi's Azure key reference ($AZURE_API_KEY / ${AZURE_API_KEY}) to the
 * real environment value. Pi uses the shell `$VAR` interpolation syntax, not the
 * `{env:VAR}` form that azure-core's `effectiveAzureApiKey` understands.
 * @param {string} key
 */
export function resolvePiAzureApiKeyValue(key) {
  if (!key) {
    return "";
  }
  if (key === PI_AZURE_API_KEY_ENV_REF || key === `\${${AZURE_API_KEY_ENV}}`) {
    return process.env[AZURE_API_KEY_ENV]?.trim() ?? "";
  }
  return key;
}

export function piAuthKeyMode(key) {
  if (!key) {
    return "missing";
  }
  return key === PI_API_KEY_ENV_REF || key === "${FIREWORKS_API_KEY}" ? "env-reference" : "literal";
}

export function piProviderStatus(settings) {
  const model = typeof settings.defaultModel === "string" ? settings.defaultModel : "";
  const fireworksModel = model.startsWith("accounts/fireworks/");
  if (settings.defaultProvider === PI_AZURE_PROVIDER && model) {
    return "azure";
  }
  if (settings.defaultProvider === PI_PROVIDER && fireworksModel) {
    return "fireworks";
  }
  if (settings.defaultProvider === PI_PROVIDER
    || settings.defaultProvider === PI_AZURE_PROVIDER
    || fireworksModel) {
    return "custom";
  }
  return "default";
}

export function piAzureCurrentModelId(settings) {
  if (settings.defaultProvider === PI_AZURE_PROVIDER
    && typeof settings.defaultModel === "string"
    && settings.defaultModel) {
    return settings.defaultModel;
  }
  return null;
}

function mergePiAzureProvider(config, { baseUrl, apiKey, modelId }) {
  const next = config && typeof config === "object"
    ? structuredClone(config)
    : { providers: {} };
  next.providers ??= {};
  next.providers[PI_AZURE_PROVIDER] = {
    name: AZURE_PROVIDER_LABEL,
    baseUrl,
    api: "openai-completions",
    authHeader: true,
    apiKey,
    models: [{ id: modelId }],
  };
  return next;
}

/**
 * Remove the FireConnect-managed Fireworks gateway router models from a models
 * config, dropping the `fireworks` provider entirely if nothing else remains.
 * User-added models on that provider are preserved.
 * @param {{ providers?: Record<string, any> }} config
 */
function stripManagedFireworksModels(config) {
  const fireworks = config.providers?.[PI_PROVIDER];
  if (!fireworks || !Array.isArray(fireworks.models)) {
    return config;
  }
  const managedIds = new Set(PI_FIREWORKS_ROUTER_ENTRIES.map((entry) => entry.id));
  const remaining = fireworks.models.filter((model) => !managedIds.has(model.id));
  if (remaining.length === fireworks.models.length) {
    return config;
  }
  const next = { ...config, providers: { ...config.providers } };
  if (remaining.length === 0) {
    delete next.providers[PI_PROVIDER];
  } else {
    next.providers[PI_PROVIDER] = { ...fireworks, models: remaining };
  }
  return next;
}

async function writePrivateBackup(dataDir, dest, filePath, snapshot) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeJson(dest, { filePath: path.resolve(filePath), snapshot });
  await chmod(dest, 0o600);
}

async function writeAuthFile(authPath, auth) {
  await mkdir(path.dirname(authPath), { recursive: true });
  await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
  await chmod(authPath, 0o600);
}

async function restoreSnapshot(filePath, snapshot) {
  if (snapshot.existed) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, snapshot.raw, "utf8");
    if (filePath.endsWith("auth.json")) {
      await chmod(filePath, 0o600);
    }
    return;
  }
  await unlink(filePath).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

async function parseJsonFile(filePath, snapshot) {
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(snapshot.raw);
  } catch {
    throw new Error(`${filePath} is not valid JSON`);
  }
}

export async function enablePiFireworks({
  settingsPath,
  authPath,
  modelsPath,
  dataDir,
  apiKey,
  apiKeyFromFlag = false,
  modelId,
  keyType = "fireworks",
}) {
  if (!apiKey) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }

  const settingsSnapshot = await readRawIfExists(settingsPath);
  const authSnapshot = await readRawIfExists(authPath);
  const modelsSnapshot = await readRawIfExists(modelsPath);
  const settings = await parseJsonFile(settingsPath, settingsSnapshot);
  const auth = await parseJsonFile(authPath, authSnapshot);
  const modelsConfig = await parseJsonFile(modelsPath, modelsSnapshot);

  const resolvedKeyType = keyType === "fireworks"
    ? detectApiKeyType(resolvePiApiKeyValue(apiKey))
    : keyType;
  let effectiveModelId = modelId;
  if (resolvedKeyType === "firepass" && !modelId) {
    effectiveModelId = DEFAULT_FIREPASS_MAIN_MODEL;
  }
  const resolvedModel = normalizeModelId(
    effectiveModelId || DEFAULT_MAIN_MODEL,
  );

  const settingsBackup = backupPath(dataDir, settingsPath, "settings");
  const hasActiveBackup = (await readJsonIfExists(settingsBackup)).snapshot !== undefined;

  // Snapshot only a genuinely pre-FireConnect config. `isFireconnectActive`
  // covers BOTH Fireworks and Azure routing, so switching from Azure back to the
  // gateway must not re-snapshot the Azure-managed state over the real backup.
  if (!hasActiveBackup || !isFireconnectActive(settings)) {
    await writePrivateBackup(dataDir, settingsBackup, settingsPath, settingsSnapshot);
    if (authSnapshot.existed) {
      await writePrivateBackup(dataDir, backupPath(dataDir, authPath, "auth"), authPath, authSnapshot);
    }
    await writePrivateBackup(dataDir, backupPath(dataDir, modelsPath, "models"), modelsPath, modelsSnapshot);
  }

  const apiKeyValue = apiKeyFromFlag ? apiKey : PI_API_KEY_ENV_REF;
  await writeJson(settingsPath, {
    ...settings,
    defaultProvider: PI_PROVIDER,
    defaultModel: resolvedModel,
  });
  await writeAuthFile(authPath, {
    ...auth,
    [PI_PROVIDER]: { type: "api_key", key: apiKeyValue, managedBy: PI_MANAGED_BY },
  });
  // Drop a leftover Azure provider when switching from Foundry to the gateway,
  // so only one FireConnect-managed provider remains (matches OpenCode/Codex).
  const fireworksModels = mergePiFireworksRouterModels(modelsConfig, resolvedModel);
  if (fireworksModels.providers?.[PI_AZURE_PROVIDER]) {
    delete fireworksModels.providers[PI_AZURE_PROVIDER];
  }
  await writeJson(modelsPath, fireworksModels);
  const managedModelIds = piModelsToRegister(resolvedModel).map((entry) => entry.id);
  await writeState(dataDir, true, managedModelIds);

  return {
    model: resolvedModel,
    apiKeyMode: piAuthKeyMode(apiKeyValue),
    keyType: resolvedKeyType,
  };
}

/**
 * Route Pi through Fireworks models served on Microsoft Foundry (Azure).
 * Registers a custom `openai-completions` provider in models.json pointed at
 * the Foundry resource's OpenAI-compatible base, with the Azure key (literal
 * via --api-key, or the `$AZURE_API_KEY` interpolation) and `authHeader: true`.
 * The key lives in models.json (not auth.json), so auth.json is never touched.
 *
 * @param {{
 *   settingsPath: string,
 *   modelsPath: string,
 *   dataDir: string,
 *   apiKey: string,
 *   apiKeyFromFlag?: boolean,
 *   baseUrl: string,
 *   modelId?: string,
 * }} args
 */
export async function enablePiAzure({
  settingsPath,
  modelsPath,
  dataDir,
  apiKey,
  apiKeyFromFlag = false,
  baseUrl,
  modelId = "",
}) {
  const normalizedBaseUrl = normalizeAzureBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    throw new Error(MISSING_AZURE_BASE_URL_MESSAGE);
  }
  const effectiveApiKey = apiKey === PI_AZURE_API_KEY_ENV_REF
    ? (process.env[AZURE_API_KEY_ENV] ?? "")
    : apiKey;
  if (!effectiveApiKey) {
    throw new Error(MISSING_AZURE_API_KEY_MESSAGE);
  }

  const settingsSnapshot = await readRawIfExists(settingsPath);
  const modelsSnapshot = await readRawIfExists(modelsPath);
  const settings = await parseJsonFile(settingsPath, settingsSnapshot);
  const modelsConfig = await parseJsonFile(modelsPath, modelsSnapshot);

  const resolvedModel = modelId || piAzureCurrentModelId(settings) || DEFAULT_AZURE_MODEL;

  const settingsBackup = backupPath(dataDir, settingsPath, "settings");
  const hasActiveBackup = (await readJsonIfExists(settingsBackup)).snapshot !== undefined;
  // Snapshot only a genuinely pre-FireConnect config — a re-`on` or a switch
  // from the Fireworks gateway must not capture a managed config as the backup.
  if (!hasActiveBackup || !isFireconnectActive(settings)) {
    await writePrivateBackup(dataDir, settingsBackup, settingsPath, settingsSnapshot);
    await writePrivateBackup(dataDir, backupPath(dataDir, modelsPath, "models"), modelsPath, modelsSnapshot);
  }

  const apiKeyValue = apiKeyFromFlag ? apiKey : PI_AZURE_API_KEY_ENV_REF;
  await writeJson(settingsPath, {
    ...settings,
    defaultProvider: PI_AZURE_PROVIDER,
    defaultModel: resolvedModel,
  });
  // Drop FireConnect-managed Fireworks gateway router models when switching to
  // Foundry, so only one managed provider remains (matches OpenCode/Codex).
  const azureModels = stripManagedFireworksModels(
    mergePiAzureProvider(modelsConfig, {
      baseUrl: normalizedBaseUrl,
      apiKey: apiKeyValue,
      modelId: resolvedModel,
    }),
  );
  await writeJson(modelsPath, azureModels);
  await writeState(dataDir, true, []);

  return {
    model: resolvedModel,
    baseUrl: normalizedBaseUrl,
    apiKeyMode: apiKeyFromFlag ? "literal" : "env-reference",
  };
}

async function restoreBackedUpFile(filePath, backupPath, label) {
  const backup = await readJsonIfExists(backupPath);
  if (backup.snapshot !== undefined
    && backup.filePath !== undefined
    && backup.filePath !== path.resolve(filePath)) {
    throw new Error(`Backup was taken for ${backup.filePath}, not ${filePath}; refusing to restore ${label}.`);
  }
  if (backup.snapshot !== undefined) {
    if (label === "auth" && !backup.snapshot.existed) {
      await unlink(backupPath).catch(() => {});
      return false;
    }
    await restoreSnapshot(filePath, backup.snapshot);
    await unlink(backupPath).catch(() => {});
    return true;
  }
  return false;
}

async function stripManagedSettings(settingsPath) {
  if (!(await readRawIfExists(settingsPath)).existed) {
    return false;
  }
  const settings = await readJsonIfExists(settingsPath);
  const next = { ...settings };
  let changed = false;
  const wasAzure = next.defaultProvider === PI_AZURE_PROVIDER;
  if (next.defaultProvider === PI_PROVIDER || wasAzure) {
    delete next.defaultProvider;
    changed = true;
  }
  // Azure deployment names are opaque, so clear defaultModel whenever we owned
  // the provider; the Fireworks gateway model is recognized by its prefix.
  if (typeof next.defaultModel === "string"
    && (wasAzure || next.defaultModel.startsWith("accounts/fireworks/"))) {
    delete next.defaultModel;
    changed = true;
  }
  if (changed) {
    await writeJson(settingsPath, next);
  }
  return changed;
}

async function stripManagedAzureModels(modelsPath) {
  if (!(await readRawIfExists(modelsPath)).existed) {
    return false;
  }
  const config = await readJsonIfExists(modelsPath);
  if (!config.providers?.[PI_AZURE_PROVIDER]) {
    return false;
  }
  const next = { ...config, providers: { ...config.providers } };
  delete next.providers[PI_AZURE_PROVIDER];
  if (Object.keys(next.providers).length === 0) {
    await unlink(modelsPath).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    return true;
  }
  await writeJson(modelsPath, next);
  return true;
}

function managedModelIdsFromState(state) {
  if (Array.isArray(state.managedModelIds) && state.managedModelIds.length > 0) {
    return state.managedModelIds;
  }
  return PI_FIREWORKS_ROUTER_ENTRIES.map((entry) => entry.id);
}

async function stripManagedModels(modelsPath, managedModelIds) {
  if (!(await readRawIfExists(modelsPath)).existed) {
    return false;
  }
  const config = await readJsonIfExists(modelsPath);
  const fireworks = config.providers?.[PI_PROVIDER];
  if (!fireworks || !Array.isArray(fireworks.models)) {
    return false;
  }

  const managedIds = new Set(managedModelIds);
  const remaining = fireworks.models.filter((model) => !managedIds.has(model.id));
  if (remaining.length === fireworks.models.length) {
    return false;
  }

  const next = { ...config, providers: { ...config.providers } };
  if (remaining.length === 0) {
    delete next.providers[PI_PROVIDER];
    if (Object.keys(next.providers).length === 0) {
      await unlink(modelsPath).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
      return true;
    }
  } else {
    next.providers[PI_PROVIDER] = { ...fireworks, models: remaining };
  }
  await writeJson(modelsPath, next);
  return true;
}

async function stripManagedAuth(authPath) {
  if (!(await readRawIfExists(authPath)).existed) {
    return false;
  }
  const auth = await readJsonIfExists(authPath);
  if (!isFireconnectManagedAuth(auth)) {
    return false;
  }
  const next = { ...auth };
  delete next[PI_PROVIDER];
  if (Object.keys(next).length === 0) {
    await unlink(authPath).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  } else {
    await writeAuthFile(authPath, next);
  }
  return true;
}

export async function disablePiFireworks({ settingsPath, authPath, modelsPath, dataDir }) {
  const state = await readJsonIfExists(statePath(dataDir));
  const wasEnabled = state.enabled === true;
  const managedModelIds = managedModelIdsFromState(state);
  const settingsBackup = backupPath(dataDir, settingsPath, "settings");
  const hasBackup = (await readJsonIfExists(settingsBackup)).snapshot !== undefined;

  if (!wasEnabled && !hasBackup) {
    const auth = await readJsonIfExists(authPath);
    const settings = await readJsonIfExists(settingsPath);
    const hasFireconnectState = (await readRawIfExists(statePath(dataDir))).existed;
    if (!isFireconnectManagedAuth(auth)) {
      if (!hasFireconnectState || !isFireconnectActive(settings)) {
        return { changed: false };
      }
    }
    let changed = false;
    changed = (await stripManagedSettings(settingsPath)) || changed;
    if (isFireconnectManagedAuth(auth)) {
      changed = (await stripManagedAuth(authPath)) || changed;
    }
    changed = (await stripManagedModels(modelsPath, managedModelIds)) || changed;
    changed = (await stripManagedAzureModels(modelsPath)) || changed;
    if (!changed) {
      return { changed: false };
    }
    await writeState(dataDir, false, []);
    return { changed: true };
  }

  const restoredSettings = await restoreBackedUpFile(settingsPath, settingsBackup, "settings");
  let changed = restoredSettings;
  if (!restoredSettings && wasEnabled) {
    changed = (await stripManagedSettings(settingsPath)) || changed;
  }

  const restoredAuth = await restoreBackedUpFile(
    authPath,
    backupPath(dataDir, authPath, "auth"),
    "auth",
  );
  if (restoredAuth) {
    changed = true;
  } else {
    changed = (await stripManagedAuth(authPath)) || changed;
  }

  const restoredModels = await restoreBackedUpFile(
    modelsPath,
    backupPath(dataDir, modelsPath, "models"),
    "models",
  );
  if (restoredModels) {
    changed = true;
  } else {
    changed = (await stripManagedModels(modelsPath, managedModelIds)) || changed;
    changed = (await stripManagedAzureModels(modelsPath)) || changed;
  }

  await writeState(dataDir, false, []);
  return { changed };
}
