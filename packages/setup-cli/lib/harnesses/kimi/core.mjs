import { createHash } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_FIREPASS_MAIN_MODEL,
  defaultMainModel,
  normalizeModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import { lookupFireworksModelLimits } from "../../fireworks/model-specs.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import { warmServerlessPricingCache } from "../../fireworks/models.mjs";
import {
  detectApiKeyType,
  isFireworksShapedKey,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "../../keys/key-type.mjs";
import { readRawIfExists } from "../opencode/core.mjs";
import { parseToml } from "../codex/toml.mjs";
import {
  patchFireconnectAzureRoutingRaw,
  patchFireconnectRoutingRaw,
  stripFireconnectRoutingRaw,
  upsertProviderApiKeyRaw,
} from "./toml-patch.mjs";
import {
  AZURE_API_KEY_ENV,
  AZURE_API_KEY_ENV_REF,
  DEFAULT_AZURE_MODEL,
  MISSING_AZURE_API_KEY_MESSAGE,
  MISSING_AZURE_BASE_URL_MESSAGE,
  normalizeAzureBaseUrl,
} from "../../fireworks/azure-core.mjs";

export const KIMI_CONFIG_RELATIVE_PATH = ".kimi-code/config.toml";
export const KIMI_DATA_RELATIVE_DIR = ".fireconnect/kimi";
export const KIMI_API_KEY_ENV = "FIREWORKS_API_KEY";
export const KIMI_FIREWORKS_PROVIDER_ID = "fireworks";
export const KIMI_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
export const KIMI_PROVIDER_TABLE = `providers.${KIMI_FIREWORKS_PROVIDER_ID}`;
export const KIMI_AZURE_PROVIDER_ID = "fireworks-azure";
export const KIMI_AZURE_PROVIDER_TABLE = `providers.${KIMI_AZURE_PROVIDER_ID}`;

export function kimiConfigPath(home, configPath = "") {
  return configPath || path.join(home, KIMI_CONFIG_RELATIVE_PATH);
}

export function kimiDataDir(home, dataDir = "") {
  return dataDir || path.join(home, KIMI_DATA_RELATIVE_DIR);
}

export function kimiBackupPath(dataDir, configPath) {
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

function fireworksProviderTable(doc) {
  return doc.tables[KIMI_PROVIDER_TABLE] ?? {};
}

function azureProviderTable(doc) {
  return doc.tables[KIMI_AZURE_PROVIDER_TABLE] ?? {};
}

function defaultModelAlias(doc) {
  return typeof doc.root.default_model === "string" ? doc.root.default_model : "";
}

function isManagedProviderTable(table) {
  return table.type === "openai"
    && table.base_url === KIMI_FIREWORKS_BASE_URL
    && typeof table.api_key === "string";
}

function isManagedAzureProviderTable(table) {
  return table.type === "openai"
    && typeof table.base_url === "string"
    && table.base_url.length > 0
    && typeof table.api_key === "string";
}

export function fireconnectManagedVariant(doc) {
  const alias = defaultModelAlias(doc);
  if (alias.startsWith(`${KIMI_FIREWORKS_PROVIDER_ID}/`)
    && isManagedProviderTable(fireworksProviderTable(doc))) {
    return "fireworks";
  }
  if (alias.startsWith(`${KIMI_AZURE_PROVIDER_ID}/`)
    && isManagedAzureProviderTable(azureProviderTable(doc))) {
    return "azure";
  }
  return null;
}

export function fireconnectManaged(doc) {
  return fireconnectManagedVariant(doc) !== null;
}

export function kimiCurrentModelId(doc) {
  const variant = fireconnectManagedVariant(doc);
  if (!variant) {
    return null;
  }
  const prefix = variant === "azure"
    ? `${KIMI_AZURE_PROVIDER_ID}/`
    : `${KIMI_FIREWORKS_PROVIDER_ID}/`;
  return defaultModelAlias(doc).slice(prefix.length);
}

export function kimiFireworksStoredKey(doc) {
  const table = fireworksProviderTable(doc);
  return typeof table.api_key === "string" ? table.api_key.trim() : "";
}

export function kimiAuthMode(doc) {
  return kimiFireworksStoredKey(doc) ? "literal" : "missing";
}

export function kimiAzureStoredKey(doc) {
  const table = azureProviderTable(doc);
  return typeof table.api_key === "string" ? table.api_key.trim() : "";
}

export function kimiAzureBaseUrl(doc) {
  const table = azureProviderTable(doc);
  return typeof table.base_url === "string" ? table.base_url : null;
}

export function kimiProviderStatus(doc) {
  const variant = fireconnectManagedVariant(doc);
  if (variant) {
    return variant;
  }
  const alias = defaultModelAlias(doc);
  if (Object.keys(fireworksProviderTable(doc)).length > 0
    || alias.startsWith(`${KIMI_FIREWORKS_PROVIDER_ID}/`)
    || alias.startsWith(`${KIMI_AZURE_PROVIDER_ID}/`)) {
    return "custom";
  }
  return "default";
}

function kimiModelCapabilities(limits) {
  return limits.vision
    ? ["image_in", "tool_use", "thinking"]
    : ["tool_use", "thinking"];
}

function assertBackupMatchesConfig(backup, configPath, backupPath) {
  if (backup.snapshot !== undefined
    && backup.configPath !== undefined
    && backup.configPath !== path.resolve(configPath)) {
    throw new Error(
      `Backup at ${backupPath} was taken for ${backup.configPath}, not ${configPath}; refusing to restore.`,
    );
  }
}

function backupContainsManagedRouting(backup) {
  if (backup.snapshot === undefined
    || !backup.snapshot.existed
    || !backup.snapshot.raw.trim()) {
    return false;
  }
  return fireconnectManaged(readTomlDoc(backup.snapshot.raw));
}

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

async function snapshotConfigIfNeeded({ configPath, dataDir, snapshot, doc }) {
  const backupPath = kimiBackupPath(dataDir, configPath);
  const hasBackup = (await readJsonIfExists(backupPath)).snapshot !== undefined;
  if (hasBackup || fireconnectManaged(doc)) {
    return;
  }
  await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  await writeJson(backupPath, { configPath: path.resolve(configPath), snapshot });
  await chmod(backupPath, 0o600);
}

export async function readKimiTomlIfExists(configPath) {
  const snapshot = await readRawIfExists(configPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return { existed: false, doc: emptyTomlDoc() };
  }
  return { existed: true, doc: readTomlDoc(snapshot.raw) };
}

export async function enableKimiFireworks({
  configPath,
  dataDir,
  effectiveApiKey = "",
  modelId,
  keyType = "fireworks",
}) {
  const apiKey = effectiveApiKey.trim();
  if (!apiKey) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }

  const snapshot = await readRawIfExists(configPath);
  const doc = snapshot.existed && snapshot.raw.trim()
    ? readTomlDoc(snapshot.raw)
    : emptyTomlDoc();

  const resolvedKeyType = keyType === "fireworks" ? detectApiKeyType(apiKey) : keyType;
  if (resolvedKeyType === "fireworks") {
    await warmServerlessPricingCache(apiKey, resolvedKeyType);
  }

  let effectiveModelId = modelId;
  if (resolvedKeyType === "firepass" && !modelId) {
    effectiveModelId = DEFAULT_FIREPASS_MAIN_MODEL;
  }
  const currentGatewayModel = fireconnectManagedVariant(doc) === "fireworks"
    ? kimiCurrentModelId(doc)
    : "";
  const resolvedModel = normalizeModelId(
    effectiveModelId || currentGatewayModel || defaultMainModel(),
  );
  const storedModel = shortFireworksModelRef(resolvedModel);

  await snapshotConfigIfNeeded({ configPath, dataDir, snapshot, doc });

  const limits = lookupFireworksModelLimits(storedModel);
  const nextRaw = patchFireconnectRoutingRaw(snapshot.raw, {
    alias: `${KIMI_FIREWORKS_PROVIDER_ID}/${storedModel}`,
    modelId: storedModel,
    baseUrl: KIMI_FIREWORKS_BASE_URL,
    apiKey,
    maxContextSize: limits.contextWindow,
    capabilities: kimiModelCapabilities(limits),
  });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, nextRaw, "utf8");
  await chmod(configPath, 0o600);

  return {
    model: storedModel,
    modelsAdded: [storedModel],
    keyType: resolvedKeyType,
    authMode: "literal",
    apiKeyMode: "literal",
  };
}

export async function enableKimiAzure({
  configPath,
  dataDir,
  apiKey,
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
  const doc = snapshot.existed && snapshot.raw.trim()
    ? readTomlDoc(snapshot.raw)
    : emptyTomlDoc();

  const currentAzureModel = fireconnectManagedVariant(doc) === "azure"
    ? kimiCurrentModelId(doc)
    : "";
  const resolvedModel = modelId || currentAzureModel || DEFAULT_AZURE_MODEL;

  await snapshotConfigIfNeeded({ configPath, dataDir, snapshot, doc });

  const limits = lookupFireworksModelLimits(resolvedModel);
  const nextRaw = patchFireconnectAzureRoutingRaw(snapshot.raw, {
    alias: `${KIMI_AZURE_PROVIDER_ID}/${resolvedModel}`,
    modelId: resolvedModel,
    baseUrl: normalizedBaseUrl,
    apiKey: effectiveApiKey,
    maxContextSize: limits.contextWindow,
    capabilities: kimiModelCapabilities(limits),
  });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, nextRaw, "utf8");
  await chmod(configPath, 0o600);

  return {
    model: resolvedModel,
    baseUrl: normalizedBaseUrl,
    apiKeyMode: "literal",
  };
}

export async function refreshKimiGatewayKey({ configPath, fireworksKey }) {
  const key = fireworksKey?.trim();
  if (!key) return false;
  const snapshot = await readRawIfExists(configPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return false;
  }
  const doc = readTomlDoc(snapshot.raw);
  if (fireconnectManagedVariant(doc) !== "fireworks") {
    return false;
  }
  const current = kimiFireworksStoredKey(doc);
  if (!current || !isFireworksShapedKey(current) || current === key) {
    return false;
  }
  await writeFile(configPath, upsertProviderApiKeyRaw(snapshot.raw, key), "utf8");
  await chmod(configPath, 0o600);
  return true;
}

export async function disableKimiFireworks({
  configPath,
  dataDir,
  wasEnabled = false,
}) {
  const backupPath = kimiBackupPath(dataDir, configPath);
  const backup = await readJsonIfExists(backupPath);
  const snapshot = await readRawIfExists(configPath);
  const doc = snapshot.existed && snapshot.raw.trim()
    ? readTomlDoc(snapshot.raw)
    : emptyTomlDoc();
  const hasBackup = backup.snapshot !== undefined;

  if (!wasEnabled && !hasBackup && kimiProviderStatus(doc) !== "fireworks") {
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

  const stripped = stripFireconnectRoutingRaw(snapshot.raw);
  if (stripped !== snapshot.raw) {
    await writeFile(configPath, stripped, "utf8");
    return "stripped";
  }
  return "noop";
}
