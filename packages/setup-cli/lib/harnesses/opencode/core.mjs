import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { writeFileAtomic } from "../../io/atomic-write.mjs";
import path from "node:path";
import process from "node:process";
import {
  AZURE_API_KEY_ENV_REF,
  AZURE_OPENAI_COMPATIBLE_NPM,
  AZURE_PROVIDER_LABEL,
  DEFAULT_AZURE_MODEL,
  effectiveAzureApiKey,
  lookupAzureFoundryModelLimits,
  normalizeAzureBaseUrl,
} from "../../fireworks/azure-core.mjs";
import {
  DEFAULT_FIREPASS_MAIN_MODEL,
  defaultMainModel,
  fireworksModelSlug,
  fullFireworksResourceId,
  isFirerouterGatewayPattern,
  isFirerouterModel,
  normalizeModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import {
  appendLatestRouterSuffix,
  assumedModelsDevListed,
  hasRichFireworksLimits,
  lookupFireworksModelLimits,
  lookupModelSpec,
  opencodeModalitiesField,
  resolveFireworksModelLabel,
  ROUTER_SPEC_ALIASES,
} from "../../fireworks/model-specs.mjs";
import { prettyModelName } from "../../fireworks/models.mjs";
import {
  modelsDevRegistryStatus,
  refreshModelsDevFireworksRegistry,
} from "../../fireworks/models-dev-registry.mjs";
import { lookupCachedContextLength } from "../../fireworks/serverless-catalog-cache.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import {
  detectApiKeyType,
  isFireworksShapedKey,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "../../keys/key-type.mjs";
import { isHarnessEnabled } from "../../config/global-config.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { mergeFireconnectTelemetryHeaders } from "../../telemetry/request-headers.mjs";

/**
 * Restore a raw config snapshot from a backup (or delete the config when the
 * snapshot recorded that it didn't exist), then remove the backup. Returns true
 * when it restored, false when the backup carried no snapshot.
 * @param {{ configPath: string, backupPath: string, backup: { snapshot?: { existed: boolean, raw: string }, configPath?: string } }} args
 */
export async function restoreOpencodeSnapshot({ configPath, backupPath, backup }) {
  if (!backup || backup.snapshot === undefined) {
    return false;
  }
  // Refuse to restore a snapshot taken for a different config file.
  if (backup.configPath !== undefined && backup.configPath !== path.resolve(configPath)) {
    throw new Error(
      `Backup at ${backupPath} was taken for ${backup.configPath}, not ${configPath}; refusing to restore.`,
    );
  }
  if (backup.snapshot.existed) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFileAtomic(configPath, backup.snapshot.raw);
  } else {
    try {
      await unlink(configPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await unlink(backupPath);
  return true;
}

export const OPENCODE_CONFIG_RELATIVE_PATH = ".config/opencode/opencode.json";
export const OPENCODE_DATA_RELATIVE_DIR = ".fireconnect/opencode";
export const OPENCODE_API_KEY_ENV_REF = "{env:FIREWORKS_API_KEY}";
export const OPENCODE_FIREWORKS_PROVIDER_ID = "fireworks-ai";
export const OPENCODE_AZURE_PROVIDER_ID = "fireworks-azure";

/**
 * Whether FireConnect should write a provider.models entry for this model.
 * FireRouter, ROUTER_SPEC_ALIASES "latest" routers, and catalog models absent
 * from models.dev need provider overrides (display name, modalities, limits).
 * Standard catalog entries on models.dev only need config.model.
 * @param {string} modelId
 */
export function opencodeNeedsProviderModelOverride(modelId) {
  if (!modelId || typeof modelId !== "string") {
    return false;
  }
  if (isFirerouterGatewayPattern(modelId)) {
    return true;
  }
  const slug = fireworksModelSlug(normalizeModelId(modelId));
  if (Object.hasOwn(ROUTER_SPEC_ALIASES, slug)) {
    return true;
  }

  const canonical = fullFireworksResourceId(modelId);
  if (!canonical.startsWith("accounts/fireworks/")) {
    return false;
  }

  const limits = lookupFireworksModelLimits(modelId);
  if (!hasRichFireworksLimits(limits)) {
    return false;
  }

  const registryStatus = modelsDevRegistryStatus(canonical);
  if (registryStatus === "present") {
    return false;
  }
  if (registryStatus === "absent") {
    return true;
  }

  // Registry unavailable: override serverless-catalog models not assumed on models.dev.
  return Boolean(lookupCachedContextLength(canonical)) && !assumedModelsDevListed(modelId);
}

/**
 * Model ref written to `config.model` for OpenCode. Router aliases and
 * FireRouter use short gateway slugs with provider overrides; catalog models
 * use full accounts/fireworks/... ids so models.dev can resolve them.
 * @param {string} modelId
 * @returns {string}
 */
export function opencodeConfigModelRef(modelId) {
  const stored = shortFireworksModelRef(normalizeModelId(modelId));
  if (opencodeNeedsProviderModelOverride(stored)) {
    return stored;
  }
  return fullFireworksResourceId(modelId);
}

function opencodeFireworksDisplayName(modelId) {
  if (isFirerouterModel(modelId)) {
    return "FireRouter";
  }
  const liveLabel = resolveFireworksModelLabel(modelId);
  if (liveLabel) {
    return liveLabel;
  }
  const spec = lookupModelSpec(modelId);
  if (spec?.label) {
    return appendLatestRouterSuffix(modelId, spec.label);
  }
  return prettyModelName(modelId);
}

export function effectiveOpencodeApiKey(storedKey) {
  if (!storedKey) {
    return "";
  }
  return storedKey === OPENCODE_API_KEY_ENV_REF
    ? (process.env.FIREWORKS_API_KEY ?? "")
    : storedKey;
}

export function opencodeConfigPath(home, configPath) {
  if (configPath) {
    return configPath;
  }
  return path.join(home, OPENCODE_CONFIG_RELATIVE_PATH);
}

export function opencodeDataDir(home, dataDir) {
  if (dataDir) {
    return dataDir;
  }
  return path.join(home, OPENCODE_DATA_RELATIVE_DIR);
}

// Backups are keyed by the config file they snapshot, so enabling Fireworks on
// two different opencode.json paths (e.g. via --config-path) can never restore
// one file's content onto the other.
export function opencodeBackupPath(dataDir, configPath) {
  const key = createHash("sha256").update(path.resolve(configPath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `config-backup.${key}.json`);
}

// Raw-text snapshot (not parsed JSON) so `off` can restore the user's file
// byte-for-byte, preserving their formatting and key order.
export async function readRawIfExists(filePath) {
  try {
    return { existed: true, raw: await readFile(filePath, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { existed: false, raw: "" };
    }
    throw error;
  }
}

export function opencodeCurrentModelId(config) {
  const modelRef = typeof config.model === "string" ? config.model : "";
  const azurePrefix = `${OPENCODE_AZURE_PROVIDER_ID}/`;
  if (modelRef.startsWith(azurePrefix)) {
    return modelRef.slice(azurePrefix.length);
  }
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  if (modelRef.startsWith(prefix)) {
    return shortFireworksModelRef(modelRef.slice(prefix.length));
  }
  if (modelRef.startsWith("fireworks/")) {
    return shortFireworksModelRef(modelRef.slice("fireworks/".length));
  }
  return null;
}

export function opencodeProviderStatus(config) {
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  const azurePrefix = `${OPENCODE_AZURE_PROVIDER_ID}/`;
  const hasAzure = Boolean(config.provider?.[OPENCODE_AZURE_PROVIDER_ID]);
  const hasFireworksAi = Boolean(config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]);
  const hasLegacy = Boolean(config.provider?.fireworks);
  const model = typeof config.model === "string" ? config.model : "";
  const azureModel = model.startsWith(azurePrefix);
  if (hasAzure && azureModel) {
    return "azure";
  }
  const fireworksModel = model.startsWith(prefix) || model.startsWith("fireworks/");
  if ((hasFireworksAi || hasLegacy) && fireworksModel) {
    return "fireworks";
  }
  if (hasAzure || azureModel || hasFireworksAi || hasLegacy || fireworksModel) {
    return "custom";
  }
  return "default";
}

/**
 * @param {string} storedRef
 * @returns {"literal" | "env-reference" | "missing"}
 */
export function opencodeAuthKeyMode(storedRef) {
  if (!storedRef) {
    return "missing";
  }
  if (storedRef === OPENCODE_API_KEY_ENV_REF || storedRef === AZURE_API_KEY_ENV_REF) {
    return "env-reference";
  }
  return "literal";
}

/**
 * Build an OpenCode `provider.models` entry for a Fireworks model id.
 * Vision-capable models (including latest router aliases and FireRouter)
 * get image input modalities from the shared Fireworks model specs.
 * Latest router aliases are absent from models.dev, so limit.context/output
 * must be set explicitly or OpenCode falls back to ~128k.
 * @param {string} modelId
 * @returns {{ name: string, limit: { context: number, output: number }, modalities?: { input: string[] } }}
 */
export function buildOpencodeModelEntry(modelId) {
  const normalized = normalizeModelId(modelId);
  const limits = lookupFireworksModelLimits(normalized);
  const entry = {
    name: opencodeFireworksDisplayName(normalized),
    limit: {
      context: limits.contextWindow,
      output: limits.maxTokens,
    },
  };
  const modalities = opencodeModalitiesField(limits);
  if (modalities) {
    entry.modalities = modalities;
  }
  return entry;
}

/**
 * Build an OpenCode `provider.models` entry for a Microsoft Foundry deployment.
 * Foundry deployment names (FW-GLM-5.2, etc.) are absent from models.dev, so
 * limit.context/output must be set from the mapped Fireworks model specs.
 * @param {string} deploymentName
 * @returns {{ name: string, limit: { context: number, output: number }, modalities?: { input: string[] } }}
 */
export function buildOpencodeAzureModelEntry(deploymentName) {
  const limits = lookupAzureFoundryModelLimits(deploymentName);
  const entry = {
    name: deploymentName,
    limit: {
      context: limits.contextWindow,
      output: limits.maxTokens,
    },
  };
  const modalities = opencodeModalitiesField(limits);
  if (modalities) {
    entry.modalities = modalities;
  }
  return entry;
}

/** Canonical `provider.models` key — collapses full resource ids and legacy prefixed refs. */
export function opencodeProviderModelKey(modelId) {
  const stored = shortFireworksModelRef(normalizeModelId(modelId));
  // Path-shaped gateway IDs (firerouter/...) must match config.model after the
  // fireworks-ai/ prefix; last-segment collapse would orphan the override.
  if (
    stored.includes("/")
    && !stored.startsWith("accounts/")
    && !stored.startsWith("fireworks-ai/")
    && !stored.startsWith("fireworks/")
  ) {
    return stored;
  }
  return fireworksModelSlug(stored);
}

function homeFromDataDir(dataDir) {
  if (path.basename(dataDir) !== "opencode" || path.basename(path.dirname(dataDir)) !== ".fireconnect") {
    return "";
  }
  return path.dirname(path.dirname(dataDir));
}

export async function enableOpencodeFireworks({
  configPath,
  dataDir,
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

  await refreshModelsDevFireworksRegistry();

  const snapshot = await readRawIfExists(configPath);
  let config = {};
  if (snapshot.existed && snapshot.raw.trim()) {
    try {
      config = JSON.parse(snapshot.raw);
    } catch {
      throw new Error(`${configPath} is not valid JSON`);
    }
  }

  // Resolve the reference for validation/model policy, but keep the reference
  // on disk so an environment-key rotation takes effect without re-running on.
  const resolvedEffective = effectiveApiKey?.trim()
    || (apiKey === OPENCODE_API_KEY_ENV_REF ? (process.env.FIREWORKS_API_KEY ?? "") : apiKey);
  if (!resolvedEffective?.trim()) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }
  const resolvedKeyType = keyType === "fireworks" ? detectApiKeyType(resolvedEffective) : keyType;

  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  const modelRef = typeof config.model === "string" ? config.model : "";
  // Model precedence: explicit request > model already configured by a previous
  // `on` > default. A repeat `on` without --model must not reset the user's choice.
  const currentModelId = modelRef.startsWith(prefix)
    ? modelRef.slice(prefix.length)
    : modelRef.startsWith("fireworks/")
      ? modelRef.slice("fireworks/".length)
      : "";

  // Fire Pass defaults to the GLM Latest router; when no explicit model is
  // requested, use that so the user gets a working config out of the box.
  let effectiveModelId = modelId;
  if (resolvedKeyType === "firepass" && !modelId) {
    effectiveModelId = DEFAULT_FIREPASS_MAIN_MODEL;
  }

  const resolvedModel = normalizeModelId(effectiveModelId || currentModelId || defaultMainModel());
  const storedModel = shortFireworksModelRef(resolvedModel);

  const backupPath = opencodeBackupPath(dataDir, configPath);
  const hasBackup = (await readJsonIfExists(backupPath)).snapshot !== undefined;
  const providerStatus = opencodeProviderStatus(config);
  const hasFireconnectRouting = providerStatus === "fireworks"
    || providerStatus === "azure";
  const home = homeFromDataDir(dataDir);
  const wasGloballyEnabled = home ? await isHarnessEnabled(home, HARNESS.OPENCODE) : false;
  const shouldSnapshot = !hasBackup
    ? !hasFireconnectRouting || !wasGloballyEnabled
    : !hasFireconnectRouting;
  if (shouldSnapshot) {
    // The snapshot can contain credentials from the user's other providers —
    // keep the backup (and its directory) private to the owner.
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, { configPath: path.resolve(configPath), snapshot });
    await chmod(backupPath, 0o600);
  }

  const provider = { ...(config.provider ?? {}) };
  delete provider.fireworks;
  delete provider[OPENCODE_AZURE_PROVIDER_ID];

  const existing = provider[OPENCODE_FIREWORKS_PROVIDER_ID] ?? {};
  // FireRouter BYOK header (x-anthropic-api-key) lets the gateway pass hard
  // requests through to Anthropic. Drop any stale one when none is supplied
  // (e.g. switching firerouter → a direct model). x-openai-api-key is dropped
  // too, to clean up configs written before OpenAI BYOK was removed.
  const byokHeaderNames = ["x-anthropic-api-key", "x-openai-api-key"];
  const priorHeaders = Object.fromEntries(
    Object.entries(existing.options?.headers ?? {}).filter(
      ([name]) => !byokHeaderNames.includes(name.toLowerCase()),
    ),
  );
  const nextHeaders = {
    ...mergeFireconnectTelemetryHeaders(priorHeaders, telemetryHeaders),
    ...(byokHeaders ?? {}),
  };
  const storedApiKey = resolvedEffective;
  const nextOptions = { ...(existing.options ?? {}), apiKey: storedApiKey };
  if (Object.keys(nextHeaders).length > 0) {
    nextOptions.headers = nextHeaders;
  } else {
    delete nextOptions.headers;
  }
  // Register the models FireConnect manages for OpenCode's `/model` picker.
  // Rebuild the set from the current catalog on every `on` so the live config
  // always matches the latest catalog (no accumulation across re-runs). When the
  // catalog can't be fetched (offline), keep the existing set so a transient
  // failure doesn't wipe the picker. FireRouter routes server-side → only the
  // firerouter model.
  const catalog = catalogModelIds.filter((id) => typeof id === "string" && id.startsWith("accounts/"));
  const buildModels = (ids) => {
    /** @type {Record<string, { name: string, modalities?: { input: string[] } }>} */
    const out = {};
    for (const id of ids) {
      if (!opencodeNeedsProviderModelOverride(id)) {
        continue;
      }
      const normalized = normalizeModelId(id);
      const stored = opencodeProviderModelKey(normalized);
      if (stored) {
        out[stored] = buildOpencodeModelEntry(normalized);
      }
    }
    return out;
  };
  let models;
  if (isFirerouterGatewayPattern(storedModel)) {
    models = buildModels([storedModel]);
  } else if (catalog.length) {
    models = buildModels([storedModel, ...catalog]);
  } else {
    models = {};
    for (const [id] of Object.entries(existing.models ?? {})) {
      if (!opencodeNeedsProviderModelOverride(id)) {
        continue;
      }
      const normalized = normalizeModelId(id);
      const stored = opencodeProviderModelKey(id);
      models[stored] = buildOpencodeModelEntry(normalized);
    }
    const activeModelKey = opencodeProviderModelKey(storedModel);
    if (storedModel && opencodeNeedsProviderModelOverride(storedModel) && !models[activeModelKey]) {
      models[activeModelKey] = buildOpencodeModelEntry(storedModel);
    }
  }
  provider[OPENCODE_FIREWORKS_PROVIDER_ID] = {
    ...existing,
    options: nextOptions,
    models,
  };

  const next = {
    ...config,
    provider,
    model: `${prefix}${opencodeConfigModelRef(resolvedModel)}`,
  };

  const hasLiteralSecret = Boolean(storedApiKey)
    || Object.keys(byokHeaders ?? {}).length > 0;
  await writeJson(configPath, next, {
    mode: hasLiteralSecret ? 0o600 : undefined,
  });
  return {
    model: next.model,
    modelsAdded: Object.keys(next.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]?.models ?? {}),
    apiKeyMode: "literal",
    keyType: resolvedKeyType,
  };
}

export async function enableOpencodeAzure({
  configPath,
  dataDir,
  apiKey,
  apiKeyFromFlag = false,
  baseUrl,
  modelId,
}) {
  if (!apiKey || (apiKey === AZURE_API_KEY_ENV_REF && !effectiveAzureApiKey(apiKey))) {
    throw new Error("No Azure API key found. Export AZURE_API_KEY or pass --api-key with your Foundry key.");
  }

  const normalizedBaseUrl = normalizeAzureBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    throw new Error(
      "No Azure endpoint found. Pass --base-url with your Microsoft Foundry project endpoint "
      + "(e.g. https://<resource>.services.ai.azure.com).",
    );
  }

  const snapshot = await readRawIfExists(configPath);
  let config = {};
  if (snapshot.existed && snapshot.raw.trim()) {
    try {
      config = JSON.parse(snapshot.raw);
    } catch {
      throw new Error(`${configPath} is not valid JSON`);
    }
  }

  const backupPath = opencodeBackupPath(dataDir, configPath);
  const hasBackup = (await readJsonIfExists(backupPath)).snapshot !== undefined;
  const hasFireconnectRouting = opencodeProviderStatus(config) === "fireworks"
    || opencodeProviderStatus(config) === "azure";
  const home = homeFromDataDir(dataDir);
  const wasGloballyEnabled = home ? await isHarnessEnabled(home, HARNESS.OPENCODE) : false;
  const shouldSnapshot = !hasBackup
    ? !hasFireconnectRouting || !wasGloballyEnabled
    : !hasFireconnectRouting;
  if (shouldSnapshot) {
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, { configPath: path.resolve(configPath), snapshot });
    await chmod(backupPath, 0o600);
  }

  const provider = { ...(config.provider ?? {}) };
  delete provider.fireworks;
  delete provider[OPENCODE_FIREWORKS_PROVIDER_ID];

  const existing = provider[OPENCODE_AZURE_PROVIDER_ID] ?? {};
  const resolvedModel = modelId || opencodeProviderStatus(config) === "azure"
    ? (modelId || opencodeCurrentModelId(config) || DEFAULT_AZURE_MODEL)
    : DEFAULT_AZURE_MODEL;
  const apiKeyValue = apiKeyFromFlag ? apiKey : AZURE_API_KEY_ENV_REF;
  provider[OPENCODE_AZURE_PROVIDER_ID] = {
    ...existing,
    npm: AZURE_OPENAI_COMPATIBLE_NPM,
    name: AZURE_PROVIDER_LABEL,
    options: {
      ...(existing.options ?? {}),
      baseURL: normalizedBaseUrl,
      apiKey: apiKeyValue,
    },
    models: {
      ...(existing.models ?? {}),
      [resolvedModel]: buildOpencodeAzureModelEntry(resolvedModel),
    },
  };

  const next = {
    ...config,
    provider,
    model: `${OPENCODE_AZURE_PROVIDER_ID}/${resolvedModel}`,
  };

  await writeJson(configPath, next, { mode: apiKeyFromFlag ? 0o600 : undefined });
  return {
    model: next.model,
    baseUrl: normalizedBaseUrl,
    apiKeyMode: apiKeyFromFlag ? "literal" : "env-reference",
  };
}

export async function disableOpencodeFireworks({ configPath, dataDir, wasEnabled = false }) {
  const backupPath = opencodeBackupPath(dataDir, configPath);
  const backup = await readJsonIfExists(backupPath);
  const config = await readJsonIfExists(configPath);
  const hasBackup = backup.snapshot !== undefined;
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  const azurePrefix = `${OPENCODE_AZURE_PROVIDER_ID}/`;
  const hasOwnedProvider = Boolean(
    config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]
      || config.provider?.[OPENCODE_AZURE_PROVIDER_ID]
      || config.provider?.fireworks,
  );
  const hasOwnedModel = typeof config.model === "string"
    && (
      config.model.startsWith(prefix)
      || config.model.startsWith(azurePrefix)
      || config.model.startsWith("fireworks/")
    );

  if (!wasEnabled && !hasBackup && !hasOwnedProvider && !hasOwnedModel) {
    return "unchanged";
  }

  if (await restoreOpencodeSnapshot({ configPath, backupPath, backup })) {
    return "restored";
  }

  // No backup: strip only what we own, and only touch the file if we actually
  // removed something — never create a config that didn't exist, and never
  // re-serialize an unrelated config.
  const { existed } = await readRawIfExists(configPath);
  if (!existed) {
    return "unchanged";
  }
  const liveConfig = await readJsonIfExists(configPath);
  let changed = false;
  for (const providerId of [
    OPENCODE_FIREWORKS_PROVIDER_ID,
    OPENCODE_AZURE_PROVIDER_ID,
    "fireworks",
  ]) {
    if (liveConfig.provider?.[providerId]) {
      delete liveConfig.provider[providerId];
      changed = true;
    }
  }
  if (typeof liveConfig.model === "string"
    && (
      liveConfig.model.startsWith(prefix)
      || liveConfig.model.startsWith(azurePrefix)
      || liveConfig.model.startsWith("fireworks/")
    )) {
    delete liveConfig.model;
    changed = true;
  }
  if (liveConfig.provider && Object.keys(liveConfig.provider).length === 0) {
    delete liveConfig.provider;
    changed = true;
  }
  if (!changed) {
    return "unchanged";
  }
  await writeJson(configPath, liveConfig);
  return "stripped";
}

/**
 * Re-bake the gateway `fireworks-ai` provider's `options.apiKey` after a
 * login`/rotation. Converts legacy env-reference auth to a literal. Skips
 * unmanaged providers and Azure routes.
 * @param {{ configPath: string, fireworksKey: string }} opts
 * @returns {Promise<boolean>}
 */
export async function refreshOpencodeGatewayKey({ configPath, fireworksKey }) {
  const key = fireworksKey?.trim();
  if (!key) return false;
  const config = await readJsonIfExists(configPath);
  const gateway = config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID];
  const current = gateway?.options?.apiKey;
  const mode = opencodeAuthKeyMode(typeof current === "string" ? current : "");
  if (mode === "env-reference") {
    const next = {
      ...config,
      provider: {
        ...config.provider,
        [OPENCODE_FIREWORKS_PROVIDER_ID]: {
          ...gateway,
          options: { ...gateway.options, apiKey: key },
        },
      },
    };
    await writeJson(configPath, next, { mode: 0o600 });
    return true;
  }
  if (typeof current !== "string" || !isFireworksShapedKey(current) || current === key) {
    return false;
  }
  const next = {
    ...config,
    provider: {
      ...config.provider,
      [OPENCODE_FIREWORKS_PROVIDER_ID]: {
        ...gateway,
        options: { ...gateway.options, apiKey: key },
      },
    },
  };
  await writeJson(configPath, next, { mode: 0o600 });
  return true;
}
