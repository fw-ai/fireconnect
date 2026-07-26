import { createHash } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_FIREPASS_MAIN_MODEL,
  defaultMainModel,
  fireworksModelSlug,
  normalizeModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import { warmServerlessPricingCache } from "../../fireworks/models.mjs";
import {
  detectApiKeyType,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "../../keys/key-type.mjs";
import { readRawIfExists } from "../opencode/core.mjs";
import { parseToml } from "../codex/toml.mjs";
import {
  normalizeDeepagentsToml,
  patchFireconnectAzureRoutingRaw,
  patchFireconnectRoutingRaw,
  stripFireconnectRoutingRaw,
} from "./toml-patch.mjs";
import {
  AZURE_API_KEY_ENV,
  AZURE_API_KEY_ENV_REF,
  DEFAULT_AZURE_MODEL,
  MISSING_AZURE_API_KEY_MESSAGE,
  MISSING_AZURE_BASE_URL_MESSAGE,
  normalizeAzureBaseUrl,
} from "../../fireworks/azure-core.mjs";
import {
  deepagentsAuthMode,
  resolveDeepagentsEffectiveApiKey,
} from "./auth.mjs";
export {
  deepagentsAuthMode,
  resolveDeepagentsApiKey,
  resolveDeepagentsEffectiveApiKey,
} from "./auth.mjs";
import {
  DEEPAGENTS_API_KEY_ENV,
  DEEPAGENTS_AUTH_RELATIVE_PATH,
  DEEPAGENTS_AZURE_PROVIDER_ID,
  DEEPAGENTS_AZURE_PROVIDER_TABLE,
  DEEPAGENTS_CONFIG_RELATIVE_PATH,
  DEEPAGENTS_DATA_RELATIVE_DIR,
  DEEPAGENTS_FIREWORKS_BASE_URL,
  DEEPAGENTS_FIREWORKS_PROVIDER_ID,
  DEEPAGENTS_PROVIDER_TABLE,
  DEEPAGENTS_STATE_RELATIVE_DIR,
} from "./constants.mjs";
export { printDeepagentsRestartHint } from "../../cli/messages.mjs";

export {
  DEEPAGENTS_API_KEY_ENV,
  DEEPAGENTS_AUTH_RELATIVE_PATH,
  DEEPAGENTS_AZURE_PROVIDER_ID,
  DEEPAGENTS_AZURE_PROVIDER_TABLE,
  DEEPAGENTS_CONFIG_RELATIVE_PATH,
  DEEPAGENTS_DATA_RELATIVE_DIR,
  DEEPAGENTS_FIREWORKS_BASE_URL,
  DEEPAGENTS_FIREWORKS_PROVIDER_ID,
  DEEPAGENTS_PROVIDER_TABLE,
  DEEPAGENTS_STATE_RELATIVE_DIR,
} from "./constants.mjs";

/** @param {{ tables: Record<string, Record<string, unknown>> }} doc */
export function deepagentsUsesEnvAuth(doc) {
  return deepagentsAuthMode(doc) === "env-reference";
}

export function deepagentsConfigPath(home, configPath = "") {
  return configPath || path.join(home, DEEPAGENTS_CONFIG_RELATIVE_PATH);
}

export function deepagentsDataDir(home, dataDir = "") {
  return dataDir || path.join(home, DEEPAGENTS_DATA_RELATIVE_DIR);
}

/** dcode credential path — FireConnect does not read or write this file. */
export function deepagentsAuthPath(home, authPath = "", configPath = "") {
  if (authPath) {
    return authPath;
  }
  if (configPath) {
    return path.join(path.dirname(configPath), ".state", "auth.json");
  }
  return path.join(home, DEEPAGENTS_AUTH_RELATIVE_PATH);
}

export function deepagentsBackupPath(dataDir, configPath) {
  const key = createHash("sha256").update(path.resolve(configPath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `config-backup.${key}.json`);
}

function emptyTomlDoc() {
  return { root: {}, tables: {} };
}

function readTomlDoc(raw) {
  if (!raw.trim()) {
    return emptyTomlDoc();
  }
  return parseToml(raw);
}

function isManagedProviderTable(table) {
  return table
    && table.base_url === DEEPAGENTS_FIREWORKS_BASE_URL
    && table.enabled === true
    && (table.api_key_env === DEEPAGENTS_API_KEY_ENV
      || typeof table.api_key === "string");
}

// The Azure provider table is identified by our FireConnect-owned table name
// (`fireworks-azure`) plus a base_url and an auth marker (literal api_key or the
// AZURE_API_KEY env reference) — NOT by the host being *.azure.com, so
// documented non-Azure proxy/APIM endpoints stay managed.
function isManagedAzureProviderTable(table) {
  return Boolean(table)
    && typeof table.base_url === "string"
    && table.base_url.length > 0
    && table.enabled === true
    && (table.api_key_env === AZURE_API_KEY_ENV || typeof table.api_key === "string");
}

function isFireworksModelSpec(value) {
  const prefix = `${DEEPAGENTS_FIREWORKS_PROVIDER_ID}:`;
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    return false;
  }
  const modelId = value.slice(prefix.length);
  return Boolean(fireworksModelSlug(modelId));
}

function isAzureModelSpec(value) {
  return typeof value === "string"
    && value.startsWith(`${DEEPAGENTS_AZURE_PROVIDER_ID}:`);
}

function modelsSection(doc) {
  return doc.tables.models ?? {};
}

function fireworksProviderTable(doc) {
  return doc.tables[DEEPAGENTS_PROVIDER_TABLE] ?? {};
}

function azureProviderTable(doc) {
  return doc.tables[DEEPAGENTS_AZURE_PROVIDER_TABLE] ?? {};
}

/**
 * Which FireConnect-managed provider, if any, owns routing in this doc.
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 * @returns {"fireworks" | "azure" | null}
 */
export function fireconnectManagedVariant(doc) {
  const models = modelsSection(doc);
  if (isFireworksModelSpec(models.default) && isManagedProviderTable(fireworksProviderTable(doc))) {
    return "fireworks";
  }
  if (isAzureModelSpec(models.default) && isManagedAzureProviderTable(azureProviderTable(doc))) {
    return "azure";
  }
  return null;
}

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function fireconnectManaged(doc) {
  return fireconnectManagedVariant(doc) !== null;
}

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function deepagentsCurrentModelId(doc) {
  const variant = fireconnectManagedVariant(doc);
  if (!variant) {
    return null;
  }
  const modelSpec = modelsSection(doc).default;
  if (typeof modelSpec !== "string") {
    return null;
  }
  const prefix = variant === "azure"
    ? `${DEEPAGENTS_AZURE_PROVIDER_ID}:`
    : `${DEEPAGENTS_FIREWORKS_PROVIDER_ID}:`;
  if (!modelSpec.startsWith(prefix)) {
    return null;
  }
  const modelId = modelSpec.slice(prefix.length);
  return variant === "azure" ? modelId : shortFireworksModelRef(modelId);
}

/**
 * Fireworks gateway auth stored in config.toml: a literal api_key when written
 * via `on`, otherwise the FIREWORKS_API_KEY env reference.
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function deepagentsFireworksStoredAuthRef(doc) {
  const table = fireworksProviderTable(doc);
  if (typeof table.api_key === "string" && table.api_key.trim()) {
    return table.api_key.trim();
  }
  if (table.api_key_env === DEEPAGENTS_API_KEY_ENV) {
    return DEEPAGENTS_API_KEY_ENV;
  }
  return "";
}

/**
 * Azure provider auth stored in config.toml: a literal api_key when written via
 * --api-key, otherwise the {env:AZURE_API_KEY} reference. "" when not azure.
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function deepagentsAzureStoredAuthRef(doc) {
  const table = azureProviderTable(doc);
  if (typeof table.api_key === "string" && table.api_key.trim()) {
    return table.api_key.trim();
  }
  if (table.api_key_env === AZURE_API_KEY_ENV) {
    return AZURE_API_KEY_ENV_REF;
  }
  return "";
}

/**
 * @param {string} storedRef
 * @returns {"literal" | "env-reference" | "missing"}
 */
export function deepagentsAzureAuthKeyMode(storedRef) {
  if (!storedRef) {
    return "missing";
  }
  if (storedRef === AZURE_API_KEY_ENV_REF) {
    return "env-reference";
  }
  return "literal";
}

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function deepagentsAzureBaseUrl(doc) {
  const table = azureProviderTable(doc);
  return typeof table.base_url === "string" ? table.base_url : null;
}

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function deepagentsProviderStatus(doc) {
  const variant = fireconnectManagedVariant(doc);
  if (variant) {
    return variant;
  }
  const models = modelsSection(doc);
  if (Object.keys(fireworksProviderTable(doc)).length > 0
    || (typeof models.default === "string"
      && (models.default.startsWith(`${DEEPAGENTS_FIREWORKS_PROVIDER_ID}:`)
        || isAzureModelSpec(models.default)))) {
    return "custom";
  }
  return "default";
}

export function deepagentsModelSpec(modelId) {
  return `${DEEPAGENTS_FIREWORKS_PROVIDER_ID}:${shortFireworksModelRef(modelId)}`;
}

/**
 * @param {{ snapshot?: { existed: boolean, raw: string }, configPath?: string }} backup
 * @param {string} configPath
 * @param {string} backupPath
 */
function assertBackupMatchesConfig(backup, configPath, backupPath) {
  if (backup.snapshot !== undefined
    && backup.configPath !== undefined
    && backup.configPath !== path.resolve(configPath)) {
    throw new Error(
      `Backup at ${backupPath} was taken for ${backup.configPath}, not ${configPath}; refusing to restore.`,
    );
  }
}

/**
 * @param {{ snapshot?: { existed: boolean, raw: string } }} backup
 */
function backupContainsManagedRouting(backup) {
  if (backup.snapshot === undefined
    || !backup.snapshot.existed
    || !backup.snapshot.raw.trim()) {
    return false;
  }
  const raw = backup.snapshot.raw;
  const normalized = normalizeDeepagentsToml(raw);
  if (normalized !== raw) {
    return false;
  }
  return fireconnectManaged(readTomlDoc(normalized));
}

/**
 * @param {{ snapshot: { existed: boolean, raw: string } }} backup
 * @param {string} configPath
 * @param {string} backupPath
 */
async function restoreConfigFromBackup(backup, configPath, backupPath) {
  if (backup.snapshot.existed) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, backup.snapshot.raw, "utf8");
  } else {
    try {
      await unlink(configPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  await unlink(backupPath);
}

/**
 * @param {string} configPath
 * @param {string} raw
 */
async function stripManagedRoutingFromConfig(configPath, raw) {
  const stripped = stripFireconnectRoutingRaw(raw, { stripModelsDefault: true });
  if (stripped !== raw) {
    await writeFile(configPath, stripped, "utf8");
    return true;
  }
  return false;
}

export async function readDeepagentsTomlIfExists(configPath) {
  const snapshot = await readRawIfExists(configPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return { existed: false, doc: emptyTomlDoc() };
  }
  return { existed: true, doc: readTomlDoc(snapshot.raw) };
}

export async function enableDeepagentsFireworks({
  configPath,
  dataDir,
  effectiveApiKey: effectiveApiKeyInput = "",
  modelId,
  keyType = "fireworks",
}) {
  const effectiveApiKey = effectiveApiKeyInput.trim()
    || resolveDeepagentsEffectiveApiKey({
      routingApiKey: DEEPAGENTS_API_KEY_ENV,
      mode: "env-reference",
    });
  if (!effectiveApiKey) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }

  const snapshot = await readRawIfExists(configPath);
  const normalizedRaw = snapshot.existed && snapshot.raw.trim()
    ? normalizeDeepagentsToml(snapshot.raw)
    : "";
  const doc = normalizedRaw
    ? readTomlDoc(normalizedRaw)
    : emptyTomlDoc();
  const rawNeedsRepair = Boolean(
    snapshot.existed && snapshot.raw.trim() && normalizedRaw !== snapshot.raw,
  );

  const resolvedKeyType = keyType === "fireworks" ? detectApiKeyType(effectiveApiKey) : keyType;

  if (resolvedKeyType === "fireworks") {
    await warmServerlessPricingCache(effectiveApiKey, resolvedKeyType);
  }

  let effectiveModelId = modelId;
  if (resolvedKeyType === "firepass" && !modelId) {
    effectiveModelId = DEFAULT_FIREPASS_MAIN_MODEL;
  }

  const resolvedModel = normalizeModelId(
    effectiveModelId || deepagentsCurrentModelId(doc) || defaultMainModel(),
  );
  const storedModel = shortFireworksModelRef(resolvedModel);
  const modelSpec = deepagentsModelSpec(storedModel);

  const backupPath = deepagentsBackupPath(dataDir, configPath);
  const hasBackup = (await readJsonIfExists(backupPath)).snapshot !== undefined;
  const shouldSnapshot = !hasBackup && (!fireconnectManaged(doc) || rawNeedsRepair);

  if (shouldSnapshot) {
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, { configPath: path.resolve(configPath), snapshot });
    await chmod(backupPath, 0o600);
  }

  const nextRaw = patchFireconnectRoutingRaw(snapshot.raw, {
    modelSpec,
    modelId: storedModel,
    baseUrl: DEEPAGENTS_FIREWORKS_BASE_URL,
    authMode: "literal",
    apiKey: effectiveApiKey,
  });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, nextRaw, "utf8");
  await chmod(configPath, 0o600);

  return {
    model: storedModel,
    modelsAdded: [storedModel],
    modelSpec,
    keyType: resolvedKeyType,
    authMode: "literal",
    apiKeyMode: "literal",
  };
}

/**
 * Route Deep Agents through Fireworks models served on Microsoft Foundry (Azure).
 * Writes a distinct `[models.providers.fireworks-azure]` table pointed at the
 * Foundry resource's OpenAI-compatible base, authenticated by a literal
 * `api_key` (when --api-key) or `api_key_env = "AZURE_API_KEY"`. No Fireworks
 * catalog is written — Foundry deployment names are used verbatim.
 *
 * @param {{
 *   configPath: string,
 *   dataDir: string,
 *   apiKey: string,
 *   apiKeyFromFlag?: boolean,
 *   baseUrl: string,
 *   modelId?: string,
 * }} args
 */
export async function enableDeepagentsAzure({
  configPath,
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
  const effectiveApiKey = apiKey === AZURE_API_KEY_ENV_REF
    ? (process.env[AZURE_API_KEY_ENV] ?? "")
    : apiKey;
  if (!effectiveApiKey) {
    throw new Error(MISSING_AZURE_API_KEY_MESSAGE);
  }

  const snapshot = await readRawIfExists(configPath);
  const normalizedRaw = snapshot.existed && snapshot.raw.trim()
    ? normalizeDeepagentsToml(snapshot.raw)
    : "";
  const doc = normalizedRaw ? readTomlDoc(normalizedRaw) : emptyTomlDoc();
  const rawNeedsRepair = Boolean(
    snapshot.existed && snapshot.raw.trim() && normalizedRaw !== snapshot.raw,
  );

  // Only reuse an existing model when it's already an Azure deployment name.
  // Switching from the Fireworks gateway must not carry over a gateway catalog
  // id (e.g. glm-5p1) — Foundry has no such deployment.
  const currentAzureModel = fireconnectManagedVariant(doc) === "azure"
    ? deepagentsCurrentModelId(doc)
    : "";
  const resolvedModel = modelId || currentAzureModel || DEFAULT_AZURE_MODEL;

  const backupPath = deepagentsBackupPath(dataDir, configPath);
  const hasBackup = (await readJsonIfExists(backupPath)).snapshot !== undefined;
  const shouldSnapshot = !hasBackup && (!fireconnectManaged(doc) || rawNeedsRepair);
  if (shouldSnapshot) {
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, { configPath: path.resolve(configPath), snapshot });
    await chmod(backupPath, 0o600);
  }

  const nextRaw = patchFireconnectAzureRoutingRaw(snapshot.raw, {
    modelId: resolvedModel,
    baseUrl: normalizedBaseUrl,
    apiKey: effectiveApiKey,
    literalAuth: apiKeyFromFlag,
  });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, nextRaw, "utf8");
  if (apiKeyFromFlag) {
    await chmod(configPath, 0o600);
  }

  return {
    model: resolvedModel,
    baseUrl: normalizedBaseUrl,
    apiKeyMode: apiKeyFromFlag ? "literal" : "env-reference",
  };
}

/**
 * Re-bake the gateway `api_key` after a `login`/rotation. Converts legacy
 * env-reference auth to a literal.
 * @param {{ configPath: string, fireworksKey: string }} opts
 * @returns {Promise<boolean>}
 */
export async function refreshDeepagentsGatewayKey({ configPath, fireworksKey }) {
  const key = fireworksKey?.trim();
  if (!key) return false;
  const snapshot = await readRawIfExists(configPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return false;
  }
  const doc = readTomlDoc(snapshot.raw);
  if (deepagentsAuthMode(doc) === "env-reference") {
    const model = deepagentsCurrentModelId(doc);
    if (!model) {
      return false;
    }
    const nextRaw = patchFireconnectRoutingRaw(snapshot.raw, {
      modelSpec: `fireworks:${model}`,
      modelId: model,
      baseUrl: DEEPAGENTS_FIREWORKS_BASE_URL,
      authMode: "literal",
      apiKey: key,
    });
    await writeFile(configPath, nextRaw, "utf8");
    await chmod(configPath, 0o600);
    return true;
  }
  if (deepagentsAuthMode(doc) !== "literal") {
    return false;
  }
  const current = deepagentsFireworksStoredAuthRef(doc);
  if (!current || !isFireworksShapedKey(current) || current === key) {
    return false;
  }
  const model = deepagentsCurrentModelId(doc);
  if (!model) {
    return false;
  }
  const nextRaw = patchFireconnectRoutingRaw(snapshot.raw, {
    modelSpec: `fireworks:${model}`,
    modelId: model,
    baseUrl: DEEPAGENTS_FIREWORKS_BASE_URL,
    authMode: "literal",
    apiKey: key,
  });
  await writeFile(configPath, nextRaw, "utf8");
  await chmod(configPath, 0o600);
  return true;
}

export async function disableDeepagentsFireworks({
  configPath,
  dataDir,
  wasEnabled = false,
}) {
  const backupPath = deepagentsBackupPath(dataDir, configPath);
  const backup = await readJsonIfExists(backupPath);
  const snapshot = await readRawIfExists(configPath);
  const doc = snapshot.existed && snapshot.raw.trim()
    ? readTomlDoc(snapshot.raw)
    : emptyTomlDoc();
  const hasBackup = backup.snapshot !== undefined;

  if (!wasEnabled && !hasBackup && deepagentsProviderStatus(doc) !== "fireworks") {
    return "noop";
  }

  assertBackupMatchesConfig(backup, configPath, backupPath);

  if (hasBackup) {
    if (backupContainsManagedRouting(backup)) {
      await unlink(backupPath);
    } else {
      await restoreConfigFromBackup(backup, configPath, backupPath);
      return "restored";
    }
  }

  if (!snapshot.existed) {
    return "noop";
  }

  const stripped = await stripManagedRoutingFromConfig(configPath, snapshot.raw);
  return stripped ? "stripped" : "noop";
}
