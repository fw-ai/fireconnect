import { writeFileAtomic } from "../../io/atomic-write.mjs";
import { createHash } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_FIREPASS_MAIN_MODEL,
  defaultMainModel,
  fullFireworksResourceId,
  normalizeModelId,
} from "../../fireworks/model-id.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import {
  detectApiKeyType,
  isFireworksShapedKey,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "../../keys/key-type.mjs";
import { readRawIfExists } from "../opencode/core.mjs";
import {
  AZURE_API_KEY_ENV,
  AZURE_PROVIDER_LABEL,
  DEFAULT_AZURE_MODEL,
  lookupAzureFoundryModelLimits,
  MISSING_AZURE_API_KEY_MESSAGE,
  MISSING_AZURE_BASE_URL_MESSAGE,
  normalizeAzureBaseUrl,
} from "../../fireworks/azure-core.mjs";
import { fireworksInputModalities } from "../../fireworks/model-specs.mjs";
import { warmServerlessPricingCache } from "../../fireworks/models.mjs";
import {
  readGlobalConfig,
  setHarnessState,
} from "../../config/global-config.mjs";
import { HARNESS } from "../../harness/id.mjs";
import {
  cachedFireworksModelIds,
  managedPiFireworksModelIds,
  mergePiFireworksRouterModels,
  PI_ENABLED_MODELS,
} from "./fireworks-models.mjs";
import { stripFireconnectTelemetryHeaders } from "../../telemetry/request-headers.mjs";

export {
  mergePiFireworksRouterModels,
  resolvePiEffectiveFireworksModel,
} from "./fireworks-models.mjs";

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

function isFireconnectActive(settings) {
  if (settings.defaultProvider === PI_AZURE_PROVIDER
    && typeof settings.defaultModel === "string"
    && settings.defaultModel.length > 0) {
    return true;
  }
  return settings.defaultProvider === PI_PROVIDER
    && typeof settings.defaultModel === "string"
    && settings.defaultModel.length > 0;
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

/** FireConnect-owned session-affinity compat on a Pi provider entry in models.json. */
function stripManagedSessionAffinityCompat(provider) {
  if (provider.compat?.sendSessionAffinityHeaders !== true) {
    return provider;
  }
  const next = { ...provider };
  const compat = { ...next.compat };
  delete compat.sendSessionAffinityHeaders;
  if (Object.keys(compat).length) next.compat = compat;
  else delete next.compat;
  return next;
}

/**
 * Remove FireConnect-managed router models and session-affinity compat from a
 * fireworks provider config. Returns whether anything changed.
 * @param {object | undefined} fireworks
 * @param {Iterable<string>} managedModelIds
 */
function stripManagedFireworksProviderConfig(fireworks, managedModelIds) {
  if (!fireworks) {
    return { provider: fireworks, changed: false, dropProvider: false };
  }
  const managed = new Set(
    [...managedModelIds].map(fullFireworksResourceId),
  );
  let changed = false;
  let next = { ...fireworks };

  if (Array.isArray(next.models)) {
    const remaining = next.models.filter(
      (model) => !managed.has(fullFireworksResourceId(model.id)),
    );
    if (remaining.length !== next.models.length) {
      changed = true;
      if (remaining.length) {
        next.models = remaining;
      } else {
        delete next.models;
      }
    }
  }

  if (next.modelOverrides && typeof next.modelOverrides === "object") {
    const overrides = { ...next.modelOverrides };
    for (const id of Object.keys(overrides)) {
      if (managed.has(fullFireworksResourceId(id))) {
        delete overrides[id];
        changed = true;
      }
    }
    if (Object.keys(overrides).length) {
      next.modelOverrides = overrides;
    } else {
      delete next.modelOverrides;
    }
  }

  const stripped = stripManagedSessionAffinityCompat(next);
  if (stripped !== next) {
    changed = true;
    next = stripped;
  }

  if (next.headers && typeof next.headers === "object") {
    const managedRoutingHeaders = new Set([
      "x-anthropic-api-key",
      "x-openai-api-key",
      "x-routing-preference",
    ]);
    const withoutTelemetry = stripFireconnectTelemetryHeaders(next.headers);
    const headers = Object.fromEntries(
      Object.entries(withoutTelemetry).filter(
        ([name]) => !managedRoutingHeaders.has(name.toLowerCase()),
      ),
    );
    if (JSON.stringify(headers) !== JSON.stringify(next.headers)) {
      changed = true;
      if (Object.keys(headers).length) next.headers = headers;
      else delete next.headers;
    }
  }

  return {
    provider: next,
    changed,
    dropProvider: Object.keys(next).length === 0,
  };
}

export function piDataDir(home, dataDir = "") {
  return dataDir || path.join(home, PI_DATA_RELATIVE_DIR);
}

function backupPath(dataDir, filePath, label) {
  const key = createHash("sha256").update(path.resolve(filePath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `${label}-backup.${key}.json`);
}

// Pre-consolidation state file. Managed model ids now live in the global
// config (harnesses.pi.profiles.managedModelIds); the enabled flag is the
// engine's wasEnabled (global flag cross-checked against providerStatus).
function legacyStatePath(dataDir) {
  return path.join(dataDir, "state.json");
}

/**
 * Model ids FireConnect registered in models.json on the last `on` — the only
 * record of which entries are ours (model rows carry no per-entry marker).
 * Primary source is the global config; falls back to the legacy state.json
 * (pre-consolidation installs) and then to the cached serverless catalog.
 */
async function readManagedModelIds(home, dataDir) {
  if (home) {
    const config = await readGlobalConfig(home);
    const ids = config.harnesses[HARNESS.PI]?.profiles?.managedModelIds;
    if (Array.isArray(ids) && ids.length > 0) {
      return ids;
    }
  }
  const legacy = await readJsonIfExists(legacyStatePath(dataDir));
  if (Array.isArray(legacy.managedModelIds) && legacy.managedModelIds.length > 0) {
    return legacy.managedModelIds;
  }
  return cachedFireworksModelIds().map(fullFireworksResourceId);
}

/**
 * Record the registered ids in the global config (empty clears the key) and
 * remove any legacy state.json so old installs migrate on their next on/off.
 */
async function persistManagedModelIds(home, dataDir, ids) {
  if (home) {
    const config = await readGlobalConfig(home);
    const profiles = { ...(config.harnesses[HARNESS.PI]?.profiles ?? {}) };
    if (ids.length > 0) {
      profiles.managedModelIds = ids;
    } else {
      delete profiles.managedModelIds;
    }
    await setHarnessState(home, HARNESS.PI, { profiles });
  }
  await unlink(legacyStatePath(dataDir)).catch(() => {});
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

/**
 * @param {string} key
 * @returns {"literal" | "env-reference" | "missing"}
 */
export function piAzureAuthKeyMode(key) {
  if (!key) {
    return "missing";
  }
  return key === PI_AZURE_API_KEY_ENV_REF || key === `\${${AZURE_API_KEY_ENV}}`
    ? "env-reference"
    : "literal";
}

export function piProviderStatus(settings) {
  const model = typeof settings.defaultModel === "string" ? settings.defaultModel : "";
  if (settings.defaultProvider === PI_AZURE_PROVIDER && model) {
    return "azure";
  }
  if (settings.defaultProvider === PI_PROVIDER && model) {
    return "fireworks";
  }
  if (settings.defaultProvider === PI_PROVIDER
    || settings.defaultProvider === PI_AZURE_PROVIDER) {
    return "custom";
  }
  return "default";
}

/**
 * BYOK header stored on the FireConnect-managed fireworks provider (where the
 * firerouter-as-model config keeps x-anthropic-api-key).
 * @param {{ providers?: Record<string, { headers?: Record<string,string> }> }} modelsConfig
 * @returns {Record<string, string>}
 */
export function piStoredByokHeaders(modelsConfig) {
  return modelsConfig?.providers?.[PI_PROVIDER]?.headers ?? {};
}

/**
 * Re-bake the Fireworks key literal in Pi's `auth.json` after a `login`/
 * rotation. Converts legacy env-reference auth to a literal.
 * @param {{ authPath: string, fireworksKey: string }} opts
 * @returns {Promise<boolean>}
 */
export async function refreshPiGatewayKey({ authPath, fireworksKey }) {
  const key = fireworksKey?.trim();
  if (!key) return false;
  const auth = await readJsonIfExists(authPath);
  const entry = auth?.[PI_PROVIDER];
  if (entry?.managedBy !== PI_MANAGED_BY) {
    return false;
  }
  const mode = piAuthKeyMode(typeof entry.key === "string" ? entry.key : "");
  if (mode === "env-reference") {
    const next = { ...auth, [PI_PROVIDER]: { ...entry, key } };
    await writeJson(authPath, next, { mode: 0o600 });
    return true;
  }
  if (typeof entry.key !== "string"
    || !isFireworksShapedKey(entry.key)
    || entry.key === key) {
    return false;
  }
  const next = { ...auth, [PI_PROVIDER]: { ...entry, key } };
  await writeJson(authPath, next, { mode: 0o600 });
  return true;
}

export function piAzureCurrentModelId(settings) {
  if (settings.defaultProvider === PI_AZURE_PROVIDER
    && typeof settings.defaultModel === "string"
    && settings.defaultModel) {
    return settings.defaultModel;
  }
  return null;
}

/**
 * Build a Pi models.json entry for a Microsoft Foundry deployment.
 * Foundry deployment names are absent from Pi's built-in catalog, so
 * contextWindow/maxTokens must come from the mapped Fireworks model specs.
 * @param {string} deploymentName
 */
export function buildPiAzureModelEntry(deploymentName) {
  const limits = lookupAzureFoundryModelLimits(deploymentName);
  return {
    id: deploymentName,
    input: fireworksInputModalities(limits),
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
  };
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
    models: [buildPiAzureModelEntry(modelId)],
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
  const managedIds = cachedFireworksModelIds();
  const { provider, changed, dropProvider } = stripManagedFireworksProviderConfig(
    fireworks,
    managedIds,
  );
  if (!changed) {
    return config;
  }
  const next = { ...config, providers: { ...config.providers } };
  if (dropProvider) {
    delete next.providers[PI_PROVIDER];
  } else {
    next.providers[PI_PROVIDER] = provider;
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
  await writeFileAtomic(authPath, `${JSON.stringify(auth, null, 2)}\n`);
  await chmod(authPath, 0o600);
}

async function restoreSnapshot(filePath, snapshot) {
  if (snapshot.existed) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, snapshot.raw);
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
  home = "",
  apiKey,
  apiKeyFromFlag = false,
  effectiveApiKey = "",
  modelId,
  keyType = "fireworks",
  byokHeaders = {},
  telemetryHeaders = {},
  catalogModelIds = [],
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

  // Resolve the key for validation/model policy; the literal is baked into
  // auth.json and re-baked by refreshPiGatewayKey on login/rotation.
  const resolvedEffective = effectiveApiKey?.trim() || resolvePiApiKeyValue(apiKey);
  if (!resolvedEffective?.trim()) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }
  const resolvedKeyType = keyType === "fireworks"
    ? detectApiKeyType(resolvedEffective)
    : keyType;
  const previousKey = resolvePiApiKeyValue(auth[PI_PROVIDER]?.key ?? "");
  const previousKeyType = previousKey ? detectApiKeyType(previousKey) : "";
  const currentModel = piProviderStatus(settings) === "fireworks"
    ? settings.defaultModel
    : "";
  let effectiveModelId = modelId;
  // Repeat `on` is commonly used to refresh a key or catalog. Preserve the
  // user's active model when the credential type is unchanged; switching
  // between standard Fireworks and Fire Pass still selects that key type's
  // compatible default.
  if (!effectiveModelId && currentModel && (!previousKeyType || previousKeyType === resolvedKeyType)) {
    effectiveModelId = currentModel;
  } else if (!effectiveModelId && resolvedKeyType === "firepass") {
    effectiveModelId = DEFAULT_FIREPASS_MAIN_MODEL;
  }
  const resolvedModel = normalizeModelId(
    effectiveModelId || defaultMainModel(),
  );
  const storedModel = fullFireworksResourceId(resolvedModel);

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

  await warmServerlessPricingCache(resolvedEffective, resolvedKeyType);

  const apiKeyValue = resolvedEffective;
  await writeJson(settingsPath, {
    ...settings,
    defaultProvider: PI_PROVIDER,
    defaultModel: storedModel,
    // Scope Pi's picker to FireConnect's router rows only, hiding Pi's built-in
    // concrete Fireworks models (which surface because they share the fireworks
    // provider auth). A concrete --model selection still works as defaultModel;
    // it just isn't pickable. See PI_FIREWORKS_ROUTER_SCOPE.
    enabledModels: PI_ENABLED_MODELS,
  });
  await writeAuthFile(authPath, {
    ...auth,
    [PI_PROVIDER]: { type: "api_key", key: apiKeyValue, managedBy: PI_MANAGED_BY },
  });
  // Drop a leftover Azure provider when switching from Foundry to the gateway,
  // so only one FireConnect-managed provider remains (matches OpenCode/Codex).
  // Ids FireConnect registered on the previous `on`, so a rebuild from a fresh
  // catalog can drop them (no accumulation) without touching user-added entries.
  const previousManagedIds = await readManagedModelIds(home, dataDir);
  const fireworksModels = mergePiFireworksRouterModels(
    modelsConfig,
    resolvedModel,
    { ...telemetryHeaders, ...byokHeaders },
    catalogModelIds,
    previousManagedIds,
    { firepass: resolvedKeyType === "firepass" },
  );
  if (fireworksModels.providers?.[PI_AZURE_PROVIDER]) {
    delete fireworksModels.providers[PI_AZURE_PROVIDER];
  }
  await writeJson(modelsPath, fireworksModels);
  const managedModelIds = managedPiFireworksModelIds(resolvedModel, catalogModelIds);
  await persistManagedModelIds(home, dataDir, managedModelIds);

  return {
    model: storedModel,
    modelsAdded: managedModelIds,
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
  authPath = "",
  modelsPath,
  dataDir,
  home = "",
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
  const azureSettings = {
    ...settings,
    defaultProvider: PI_AZURE_PROVIDER,
    defaultModel: resolvedModel,
  };
  // Azure mode is unscaffolded (no picker scope). Drop a stale Fireworks
  // enabledModels so switching Fireworks → Azure doesn't leave the picker scoped
  // to Fireworks routers (which have no auth in Azure mode → empty picker) and
  // hide the Azure deployment.
  delete azureSettings.enabledModels;
  await writeJson(settingsPath, azureSettings);
  // Drop FireConnect-managed Fireworks gateway router models when switching to
  // Foundry, so only one managed provider remains (matches OpenCode/Codex).
  const azureModels = stripManagedFireworksModels(
    mergePiAzureProvider(modelsConfig, {
      baseUrl: normalizedBaseUrl,
      apiKey: apiKeyValue,
      modelId: resolvedModel,
    }),
  );
  await writeJson(modelsPath, azureModels, { mode: apiKeyFromFlag ? 0o600 : undefined });
  await persistManagedModelIds(home, dataDir, []);

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
  const wasFireworks = next.defaultProvider === PI_PROVIDER;
  if (wasFireworks || wasAzure) {
    delete next.defaultProvider;
    changed = true;
  }
  // Both direct Fireworks short IDs and Azure deployment names are opaque, so
  // clear defaultModel whenever FireConnect owned the provider.
  if (typeof next.defaultModel === "string"
    && (wasFireworks || wasAzure)) {
    delete next.defaultModel;
    changed = true;
  }
  // enabledModels is FireConnect's picker scope (routers only). Clear it on off
  // so Pi's picker returns to its default model set. The backup-restore path
  // already restores the pre-FireConnect settings; this handles the no-backup
  // strip path.
  if (Array.isArray(next.enabledModels) && (wasFireworks || wasAzure)) {
    delete next.enabledModels;
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

async function stripManagedModels(modelsPath, managedModelIds) {
  if (!(await readRawIfExists(modelsPath)).existed) {
    return false;
  }
  const config = await readJsonIfExists(modelsPath);
  const fireworks = config.providers?.[PI_PROVIDER];
  const { provider, changed, dropProvider } = stripManagedFireworksProviderConfig(
    fireworks,
    managedModelIds,
  );
  if (!changed) {
    return false;
  }

  const next = { ...config, providers: { ...config.providers } };
  if (dropProvider) {
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
    next.providers[PI_PROVIDER] = provider;
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

/**
 * @param {{
 *   settingsPath: string,
 *   authPath: string,
 *   modelsPath: string,
 *   dataDir: string,
 *   home?: string,
 *   wasEnabled?: boolean,
 * }} args
 * `wasEnabled` is the engine's flag (global config cross-checked against
 * providerStatus); it decides restore-vs-strip alongside backup presence.
 */
export async function disablePiFireworks({ settingsPath, authPath, modelsPath, dataDir, home = "", wasEnabled = false }) {
  const managedModelIds = await readManagedModelIds(home, dataDir);
  const settingsBackup = backupPath(dataDir, settingsPath, "settings");
  const hasBackup = (await readJsonIfExists(settingsBackup)).snapshot !== undefined;

  if (!wasEnabled && !hasBackup) {
    const auth = await readJsonIfExists(authPath);
    const settings = await readJsonIfExists(settingsPath);
    const hasManagedAuth = isFireconnectManagedAuth(auth);
    if (!hasManagedAuth) {
      const profiles = home
        ? (await readGlobalConfig(home)).harnesses[HARNESS.PI]?.profiles
        : undefined;
      const hasFireconnectState = (Array.isArray(profiles?.managedModelIds)
          && profiles.managedModelIds.length > 0)
        || (await readRawIfExists(legacyStatePath(dataDir))).existed;
      if (!hasFireconnectState || !isFireconnectActive(settings)) {
        return { changed: false };
      }
    }
    let changed = false;
    changed = (await stripManagedSettings(settingsPath)) || changed;
    if (hasManagedAuth) {
      changed = (await stripManagedAuth(authPath)) || changed;
    }
    changed = (await stripManagedModels(modelsPath, managedModelIds)) || changed;
    changed = (await stripManagedAzureModels(modelsPath)) || changed;
    if (!changed) {
      return { changed: false };
    }
    await persistManagedModelIds(home, dataDir, []);
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

  await persistManagedModelIds(home, dataDir, []);
  return { changed };
}
