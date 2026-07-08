import { writeFileAtomic } from "./atomic-write.mjs";
import { createHash } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_FIREPASS_MAIN_MODEL,
  DEFAULT_MAIN_MODEL,
  detectApiKeyType,
  isFireworksModelId,
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
import {
  buildFirerouterHttpHeaders,
  FALLBACK_FIREROUTER_MAIN_MODEL,
  FIREROUTER_BASE_URL,
  FIREROUTER_FIREWORKS_HEADER,
  isFirerouterBaseUrl,
  normalizeFirerouterUrl,
} from "./firerouter-core.mjs";
import {
  managedPiFireworksModelIds,
  mergePiFireworksRouterModels,
  PI_FIREWORKS_ROUTER_ENTRIES,
} from "./pi-fireworks-models.mjs";

export {
  mergePiFireworksRouterModels,
  PI_BUILTIN_FIREWORKS_MODEL_IDS,
  resolvePiEffectiveFireworksModel,
} from "./pi-fireworks-models.mjs";

export const PI_SETTINGS_RELATIVE_PATH = ".pi/agent/settings.json";
export const PI_MODELS_RELATIVE_PATH = ".pi/agent/models.json";
export const PI_DATA_RELATIVE_DIR = ".fireconnect/pi";
export const PI_API_KEY_ENV_REF = "$FIREWORKS_API_KEY";
export const PI_ANTHROPIC_API_KEY_ENV_REF = "$ANTHROPIC_API_KEY";
const PI_PROVIDER = "fireworks";
export const PI_ANTHROPIC_PROVIDER = "anthropic";
export const PI_FIREROUTER_PROVIDER_NAME = "Anthropic (FireRouter)";
const PI_MANAGED_BY = "fireconnect";
// Pi routes Foundry through a distinct custom provider (openai-completions) so
// it never collides with the built-in Fireworks provider.
export const PI_AZURE_PROVIDER = "fireworks-azure";
export const PI_AZURE_API_KEY_ENV_REF = `$${AZURE_API_KEY_ENV}`;

function isFireconnectActive(settings, modelsConfig = {}) {
  if (settings.defaultProvider === PI_AZURE_PROVIDER
    && typeof settings.defaultModel === "string"
    && settings.defaultModel.length > 0) {
    return true;
  }
  // FireRouter wiring in models.json is FireConnect-managed even when Pi's active
  // provider was switched away from anthropic (routingActive may be false).
  if (piFirerouterConfigured(modelsConfig)) {
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
  const managed = managedModelIds instanceof Set
    ? managedModelIds
    : new Set(managedModelIds);
  let changed = false;
  let next = { ...fireworks };

  if (Array.isArray(next.models)) {
    const remaining = next.models.filter((model) => !managed.has(model.id));
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
    for (const id of managed) {
      if (id in overrides) {
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

  const hasModels = Array.isArray(next.models) && next.models.length > 0;
  const hasOverrides = Boolean(
    next.modelOverrides && Object.keys(next.modelOverrides).length > 0,
  );
  return {
    provider: next,
    changed,
    dropProvider: !hasModels && !hasOverrides,
  };
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

async function writeState(dataDir, enabled, managedModelIds = [], mode = "direct") {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeJson(statePath(dataDir), { enabled, managedModelIds, mode });
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

export function piFirerouterConfigured(modelsConfig) {
  const anthropic = modelsConfig.providers?.[PI_ANTHROPIC_PROVIDER];
  const headers = anthropic?.headers ?? {};
  return Boolean(
    headers[FIREROUTER_FIREWORKS_HEADER]
    || (typeof anthropic?.baseUrl === "string" && isFirerouterBaseUrl(anthropic.baseUrl)),
  );
}

export function isPiAnthropicModelId(model) {
  if (typeof model !== "string" || !model) return false;
  const bare = model.replace(/^anthropic\//, "");
  return !isFireworksModelId(bare) && /^claude/i.test(bare);
}

export function piFirerouterCurrentModel(settings) {
  if (settings.defaultProvider !== PI_ANTHROPIC_PROVIDER) return null;
  const model = typeof settings.defaultModel === "string" ? settings.defaultModel : "";
  if (!isPiAnthropicModelId(model)) return null;
  return model.replace(/^anthropic\//, "");
}

export function piFirerouterAnthropicKeyRef(auth) {
  const entry = auth?.[PI_ANTHROPIC_PROVIDER];
  return entry?.type === "api_key" && typeof entry.key === "string" ? entry.key : "";
}

function stripManagedFirerouterProvider(config) {
  const anthropic = config.providers?.[PI_ANTHROPIC_PROVIDER];
  if (!anthropic) return config;
  const nextAnthropic = { ...anthropic };
  const headers = { ...(nextAnthropic.headers ?? {}) };
  delete headers[FIREROUTER_FIREWORKS_HEADER];
  if (Object.keys(headers).length) nextAnthropic.headers = headers;
  else delete nextAnthropic.headers;
  if (typeof nextAnthropic.baseUrl === "string" && isFirerouterBaseUrl(nextAnthropic.baseUrl)) {
    delete nextAnthropic.baseUrl;
  }
  if (nextAnthropic.name === PI_FIREROUTER_PROVIDER_NAME) {
    delete nextAnthropic.name;
  }
  const strippedAnthropic = stripManagedSessionAffinityCompat(nextAnthropic);
  const next = { ...config, providers: { ...config.providers } };
  if (Object.keys(strippedAnthropic).length) {
    next.providers[PI_ANTHROPIC_PROVIDER] = strippedAnthropic;
  } else {
    delete next.providers[PI_ANTHROPIC_PROVIDER];
  }
  return next;
}

function stripManagedAnthropicAuthObject(auth) {
  if (auth?.[PI_ANTHROPIC_PROVIDER]?.managedBy !== PI_MANAGED_BY) return auth;
  const next = { ...auth };
  delete next[PI_ANTHROPIC_PROVIDER];
  return next;
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
  const managedIds = PI_FIREWORKS_ROUTER_ENTRIES.map((entry) => entry.id);
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
  apiKey,
  apiKeyFromFlag = false,
  effectiveApiKey = "",
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

  // Resolved plaintext key (from the harness: flag > stored > env > keychain
  // fallback). Written into auth.json directly so Pi loads it immediately — no
  // shell env hook / new shell needed. The OS keychain stays the source of truth.
  const resolvedEffective = effectiveApiKey?.trim() || resolvePiApiKeyValue(apiKey);
  if (!resolvedEffective?.trim()) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }
  const resolvedKeyType = keyType === "fireworks"
    ? detectApiKeyType(resolvedEffective)
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
  if (!hasActiveBackup || !isFireconnectActive(settings, modelsConfig)) {
    await writePrivateBackup(dataDir, settingsBackup, settingsPath, settingsSnapshot);
    if (authSnapshot.existed) {
      await writePrivateBackup(dataDir, backupPath(dataDir, authPath, "auth"), authPath, authSnapshot);
    }
    await writePrivateBackup(dataDir, backupPath(dataDir, modelsPath, "models"), modelsPath, modelsSnapshot);
  }

  const apiKeyValue = resolvedEffective;
  await writeJson(settingsPath, {
    ...settings,
    defaultProvider: PI_PROVIDER,
    defaultModel: resolvedModel,
  });
  await writeAuthFile(authPath, {
    ...stripManagedAnthropicAuthObject(auth),
    [PI_PROVIDER]: { type: "api_key", key: apiKeyValue, managedBy: PI_MANAGED_BY },
  });
  // Drop a leftover Azure provider when switching from Foundry to the gateway,
  // so only one FireConnect-managed provider remains (matches OpenCode/Codex).
  const fireworksModels = mergePiFireworksRouterModels(
    stripManagedFirerouterProvider(modelsConfig),
    resolvedModel,
  );
  if (fireworksModels.providers?.[PI_AZURE_PROVIDER]) {
    delete fireworksModels.providers[PI_AZURE_PROVIDER];
  }
  await writeJson(modelsPath, fireworksModels);
  const managedModelIds = managedPiFireworksModelIds(resolvedModel);
  await writeState(dataDir, true, managedModelIds);

  return {
    model: resolvedModel,
    apiKeyMode: piAuthKeyMode(apiKeyValue),
    keyType: resolvedKeyType,
  };
}

export async function enablePiFirerouter({
  settingsPath,
  authPath,
  modelsPath,
  dataDir,
  baseUrl = FIREROUTER_BASE_URL,
  modelId,
  fireworksKey,
  anthropicKey = "",
  anthropicKeyFromFlag = false,
}) {
  if (!fireworksKey) throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);

  const settingsSnapshot = await readRawIfExists(settingsPath);
  const authSnapshot = await readRawIfExists(authPath);
  const modelsSnapshot = await readRawIfExists(modelsPath);
  const settings = await parseJsonFile(settingsPath, settingsSnapshot);
  const auth = await parseJsonFile(authPath, authSnapshot);
  const modelsConfig = await parseJsonFile(modelsPath, modelsSnapshot);
  const resolvedModel = (
    modelId
    || piFirerouterCurrentModel(settings)
    || FALLBACK_FIREROUTER_MAIN_MODEL
  )
    .replace(/^anthropic\//, "");
  // Pi's Anthropic SDK appends `/v1/messages` to the configured base URL, so a
  // trailing `/v1` (e.g. a user passing `--base-url https://router.fireworks.ai/v1`,
  // matching what the README advertises as the endpoint) must be stripped here —
  // otherwise requests go to `/v1/v1/messages`.
  const normalizedBaseUrl = normalizeFirerouterUrl(baseUrl).replace(/\/v1$/, "");

  const settingsBackup = backupPath(dataDir, settingsPath, "settings");
  const hasActiveBackup = (await readJsonIfExists(settingsBackup)).snapshot !== undefined;
  if (!hasActiveBackup || !isFireconnectActive(settings, modelsConfig)) {
    await writePrivateBackup(dataDir, settingsBackup, settingsPath, settingsSnapshot);
    if (authSnapshot.existed) {
      await writePrivateBackup(dataDir, backupPath(dataDir, authPath, "auth"), authPath, authSnapshot);
    }
    await writePrivateBackup(dataDir, backupPath(dataDir, modelsPath, "models"), modelsPath, modelsSnapshot);
  }

  await writeJson(settingsPath, {
    ...settings,
    defaultProvider: PI_ANTHROPIC_PROVIDER,
    defaultModel: resolvedModel,
  });

  let nextAuth = { ...auth };
  delete nextAuth[PI_PROVIDER];
  if (anthropicKey) {
    // Plaintext resolved key so Pi loads it immediately (auth.json is 0600).
    nextAuth[PI_ANTHROPIC_PROVIDER] = {
      type: "api_key",
      key: anthropicKey,
      managedBy: PI_MANAGED_BY,
    };
  }
  if (Object.keys(nextAuth).length) await writeAuthFile(authPath, nextAuth);

  let nextModels = stripManagedFireworksModels(modelsConfig);
  nextModels = structuredClone(nextModels);
  nextModels.providers ??= {};
  delete nextModels.providers[PI_AZURE_PROVIDER];
  const anthropic = { ...(nextModels.providers[PI_ANTHROPIC_PROVIDER] ?? {}) };
  const carriedHeaders = { ...(anthropic.headers ?? {}) };
  delete carriedHeaders[FIREROUTER_FIREWORKS_HEADER];
  anthropic.name = PI_FIREROUTER_PROVIDER_NAME;
  anthropic.baseUrl = normalizedBaseUrl;
  anthropic.compat = {
    ...(anthropic.compat ?? {}),
    sendSessionAffinityHeaders: true,
  };
  anthropic.headers = {
    ...carriedHeaders,
    // Plaintext Fireworks key in the FireRouter header so Pi authenticates
    // immediately; models.json is written 0600 below since it now holds a key.
    ...buildFirerouterHttpHeaders({ fireworksKey }),
  };
  nextModels.providers[PI_ANTHROPIC_PROVIDER] = anthropic;
  await writeJson(modelsPath, nextModels, { mode: 0o600 });
  await writeState(dataDir, true, [], "router");

  return { model: resolvedModel, baseUrl: normalizedBaseUrl };
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
  if (!hasActiveBackup || !isFireconnectActive(settings, modelsConfig)) {
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
    mergePiAzureProvider(stripManagedFirerouterProvider(modelsConfig), {
      baseUrl: normalizedBaseUrl,
      apiKey: apiKeyValue,
      modelId: resolvedModel,
    }),
  );
  await writeJson(modelsPath, azureModels, { mode: apiKeyFromFlag ? 0o600 : undefined });
  if (authPath) {
    const auth = await readJsonIfExists(authPath);
    const nextAuth = stripManagedAnthropicAuthObject(auth);
    if (nextAuth !== auth) {
      if (Object.keys(nextAuth).length) {
        await writeAuthFile(authPath, nextAuth);
      } else {
        await unlink(authPath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
  }
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
  const wasRouter = next.defaultProvider === PI_ANTHROPIC_PROVIDER;
  if (next.defaultProvider === PI_PROVIDER || wasAzure || wasRouter) {
    delete next.defaultProvider;
    changed = true;
  }
  // Azure deployment names are opaque, so clear defaultModel whenever we owned
  // the provider; the Fireworks gateway model is recognized by its prefix.
  if (typeof next.defaultModel === "string"
    && (wasAzure || wasRouter || next.defaultModel.startsWith("accounts/fireworks/"))) {
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

async function stripManagedFirerouterModels(modelsPath) {
  if (!(await readRawIfExists(modelsPath)).existed) return false;
  const config = await readJsonIfExists(modelsPath);
  const next = stripManagedFirerouterProvider(config);
  if (JSON.stringify(next) === JSON.stringify(config)) return false;
  if (Object.keys(next.providers ?? {}).length === 0) {
    await unlink(modelsPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  } else {
    await writeJson(modelsPath, next);
  }
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
  const hasManagedAnthropic = auth?.[PI_ANTHROPIC_PROVIDER]?.managedBy === PI_MANAGED_BY;
  if (!isFireconnectManagedAuth(auth) && !hasManagedAnthropic) {
    return false;
  }
  const next = { ...auth };
  delete next[PI_PROVIDER];
  if (hasManagedAnthropic) delete next[PI_ANTHROPIC_PROVIDER];
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
    const models = await readJsonIfExists(modelsPath);
    const hasManagedAuth = isFireconnectManagedAuth(auth)
      || auth?.[PI_ANTHROPIC_PROVIDER]?.managedBy === PI_MANAGED_BY;
    if (!hasManagedAuth) {
      if (!hasFireconnectState || !isFireconnectActive(settings, models)) {
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
    changed = (await stripManagedFirerouterModels(modelsPath)) || changed;
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
    changed = (await stripManagedFirerouterModels(modelsPath)) || changed;
  }

  await writeState(dataDir, false, []);
  return { changed };
}
