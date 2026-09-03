import { writeFileAtomic } from "../../io/atomic-write.mjs";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_FIREPASS_MAIN_MODEL,
  defaultMainModel,
  isFireworksModelId,
  normalizeModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import {
  detectApiKeyType,
  isFireworksShapedKey,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "../../keys/key-type.mjs";
import { readRawIfExists } from "../opencode/core.mjs";
import { parseToml } from "./toml.mjs";
import {
  patchCodexCatalogRefRaw,
  patchCodexProviderAuthRaw,
  patchFireconnectRoutingRaw,
  stripFireconnectRoutingRaw,
} from "./toml-patch.mjs";
import {
  buildCodexCatalogFromSnapshot,
  codexCatalogContainsModel,
  codexModelExclusionReason,
  ensureCodexOffCatalogEntry,
} from "./catalog.mjs";
import {
  buildServerlessCatalogSnapshot,
  fetchServerlessCatalogRaw,
  filterCatalogForKeyType,
  firerouterCatalogEntry,
  FIREPASS_FALLBACK_ROUTERS,
  preferLatestAliases,
} from "../../fireworks/models.mjs";
import {
  cacheServerlessCatalogSnapshot,
  setServerlessCatalogSnapshot,
} from "../../fireworks/serverless-catalog-cache.mjs";
import {
  AZURE_API_KEY_ENV,
  AZURE_PROVIDER_LABEL,
  DEFAULT_AZURE_MODEL,
  MISSING_AZURE_API_KEY_MESSAGE,
  MISSING_AZURE_BASE_URL_MESSAGE,
  normalizeAzureBaseUrl,
} from "../../fireworks/azure-core.mjs";
import { mergeFireconnectTelemetryHeaders } from "../../telemetry/request-headers.mjs";
export { printCodexRestartHint } from "../../cli/messages.mjs";

export const CODEX_CONFIG_RELATIVE_PATH = ".codex/config.toml";
export const CODEX_DATA_RELATIVE_DIR = ".fireconnect/codex";
export const CODEX_CATALOG_RELATIVE_PATH = ".codex/fireworks-model-catalog.json";
export const CODEX_CATALOG_TOML_REF = `~/${CODEX_CATALOG_RELATIVE_PATH}`;
export const CODEX_FIREWORKS_PROVIDER_ID = "fireworks-ai";
export const CODEX_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
export const CODEX_API_KEY_ENV_REF = "{env:FIREWORKS_API_KEY}";
export const CODEX_PROVIDER_TABLE = `model_providers.${CODEX_FIREWORKS_PROVIDER_ID}`;
// Codex routes Foundry through a distinct provider table so it never collides
// with the direct Fireworks gateway. Foundry exposes Chat Completions at the
// resource-root /openai/v1, so the Azure variant uses wire_api = "chat".
export const CODEX_AZURE_PROVIDER_ID = "fireworks-azure";
export const CODEX_AZURE_PROVIDER_TABLE = `model_providers.${CODEX_AZURE_PROVIDER_ID}`;
export const CODEX_AZURE_API_KEY_ENV_REF = `{env:${AZURE_API_KEY_ENV}}`;

export function codexConfigPath(home, configPath = "") {
  return configPath || path.join(home, CODEX_CONFIG_RELATIVE_PATH);
}

export function codexDataDir(home, dataDir = "") {
  return dataDir || path.join(home, CODEX_DATA_RELATIVE_DIR);
}

export function codexCatalogPath(home, catalogPath = "") {
  return catalogPath || path.join(home, CODEX_CATALOG_RELATIVE_PATH);
}

export function codexBackupPath(dataDir, configPath) {
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
    && table.base_url === CODEX_FIREWORKS_BASE_URL
    && (table.env_key === "FIREWORKS_API_KEY"
      || typeof table.experimental_bearer_token === "string");
}

// The Azure provider table is identified by its FireConnect-owned table name
// (`fireworks-azure`) plus a base_url and our auth marker — NOT by the host
// being *.azure.com, so documented non-Azure proxy/APIM endpoints stay managed.
function isManagedAzureProviderTable(table) {
  return table
    && typeof table.base_url === "string"
    && table.base_url.length > 0
    && (table.env_key === AZURE_API_KEY_ENV
      || typeof table.experimental_bearer_token === "string");
}

/**
 * Which FireConnect-managed provider, if any, owns routing in this doc. The
 * `firerouter` model is served on the normal Fireworks gateway provider, so it
 * reports "fireworks" with model `firerouter` — not a distinct variant.
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 * @returns {"fireworks" | "azure" | null}
 */
export function fireconnectManagedVariant(doc) {
  if (doc.root.model_provider === CODEX_FIREWORKS_PROVIDER_ID
    && isFireworksModelId(doc.root.model)
    && isManagedProviderTable(doc.tables[CODEX_PROVIDER_TABLE])) {
    return "fireworks";
  }
  if (doc.root.model_provider === CODEX_AZURE_PROVIDER_ID
    && typeof doc.root.model === "string"
    && doc.root.model.length > 0
    && isManagedAzureProviderTable(doc.tables[CODEX_AZURE_PROVIDER_TABLE])) {
    return "azure";
  }
  return null;
}

/**
 * FireConnect owns routing when root model_provider/model point at one of our
 * managed provider tables (Fireworks gateway or Azure/Foundry).
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function fireconnectManaged(doc) {
  return fireconnectManagedVariant(doc) !== null;
}

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function codexCurrentModelId(doc) {
  const variant = fireconnectManagedVariant(doc);
  if (!variant) {
    return null;
  }
  const model = doc.root.model;
  if (typeof model !== "string") {
    return null;
  }
  if (variant === "azure") {
    // Foundry deployment names are used verbatim — no accounts/ prefix.
    return model;
  }
  return shortFireworksModelRef(model);
}

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function codexStoredAuthRef(doc) {
  const variant = fireconnectManagedVariant(doc);
  if (!variant) {
    return "";
  }
  const provider = variant === "azure"
    ? doc.tables[CODEX_AZURE_PROVIDER_TABLE]
    : doc.tables[CODEX_PROVIDER_TABLE];
  const bearer = provider.experimental_bearer_token;
  if (typeof bearer === "string" && bearer.trim()) {
    return bearer.trim();
  }
  if (variant === "azure" && provider.env_key === AZURE_API_KEY_ENV) {
    return CODEX_AZURE_API_KEY_ENV_REF;
  }
  if (provider.env_key === "FIREWORKS_API_KEY") {
    return CODEX_API_KEY_ENV_REF;
  }
  return "";
}

/**
 * @param {string} storedRef
 */
export function effectiveCodexApiKey(storedRef) {
  if (!storedRef) {
    return "";
  }
  if (storedRef === CODEX_API_KEY_ENV_REF) {
    return process.env.FIREWORKS_API_KEY?.trim() ?? "";
  }
  if (storedRef === CODEX_AZURE_API_KEY_ENV_REF) {
    return process.env[AZURE_API_KEY_ENV]?.trim() ?? "";
  }
  return storedRef;
}

/**
 * @param {string} storedRef
 * @returns {"literal" | "env-reference" | "missing"}
 */
export function codexAuthKeyMode(storedRef) {
  if (!storedRef) {
    return "missing";
  }
  if (storedRef === CODEX_API_KEY_ENV_REF || storedRef === CODEX_AZURE_API_KEY_ENV_REF) {
    return "env-reference";
  }
  return "literal";
}

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function codexLiteralAuthFromDoc(doc) {
  const provider = doc.tables[CODEX_PROVIDER_TABLE];
  return typeof provider?.experimental_bearer_token === "string"
    && provider.experimental_bearer_token.trim().length > 0;
}

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function codexProviderStatus(doc) {
  const variant = fireconnectManagedVariant(doc);
  if (variant) {
    return variant;
  }
  if (doc.tables[CODEX_PROVIDER_TABLE]
    || doc.tables[CODEX_AZURE_PROVIDER_TABLE]
    || doc.root.model_provider === CODEX_FIREWORKS_PROVIDER_ID
    || doc.root.model_provider === CODEX_AZURE_PROVIDER_ID) {
    return "custom";
  }
  return "default";
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
  return backup.snapshot !== undefined
    && backup.snapshot.existed
    && backup.snapshot.raw.trim()
    && fireconnectManaged(readTomlDoc(backup.snapshot.raw));
}

export function snapshotReferencesFireworksCatalog(raw) {
  if (!raw.trim()) {
    return false;
  }
  const ref = readTomlDoc(raw).root.model_catalog_json;
  return typeof ref === "string" && ref.trim() === CODEX_CATALOG_TOML_REF;
}

/**
 * @param {string} catalogPath
 */
async function unlinkCatalogIfExists(catalogPath) {
  if (!catalogPath) {
    return;
  }
  try {
    await unlink(catalogPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * @param {{ snapshot: { existed: boolean, raw: string } }} backup
 * @param {string} configPath
 * @param {string} backupPath
 */
async function restoreConfigFromBackup(backup, configPath, backupPath) {
  if (backup.snapshot.existed) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFileAtomic(configPath, backup.snapshot.raw);
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
  const stripped = stripFireconnectRoutingRaw(raw, { stripRootRouting: true });
  if (stripped !== raw) {
    await writeFileAtomic(configPath, stripped);
    return true;
  }
  return false;
}

async function writeCodexCatalogFile(catalogPath, catalog) {
  await writeJson(catalogPath, catalog, { mode: 0o600 });
}

/**
 * @param {string} catalogPath
 * @returns {Promise<{ models: unknown[] } | null>}
 */
async function readCodexCatalogIfValid(catalogPath) {
  try {
    const catalog = await readJsonIfExists(catalogPath);
    return catalog?.models ? catalog : null;
  } catch (error) {
    if (error instanceof Error && error.message.endsWith(" is not valid JSON")) {
      return null;
    }
    throw error;
  }
}

function codexCatalogFetchWarning(error) {
  console.log(`Warning: could not generate model catalog: ${error.message}`);
  console.log("Codex will use default model metadata. Re-run 'fireconnect codex on' to retry.");
}

/**
 * Single API fetch for Codex provider registration and metadata catalog.
 * @param {string} apiKey
 * @returns {Promise<{ pickerCatalog: import("../../fireworks/models.mjs").CatalogEntry[] | null, codexCatalog: { models: unknown[] } | null, keyType: string }>}
 */
export async function loadCodexCatalogBundle(apiKey, { includeFirerouter = false } = {}) {
  if (!apiKey) {
    return { pickerCatalog: null, codexCatalog: null, keyType: "" };
  }

  const keyType = detectApiKeyType(apiKey);
  if (keyType === "firepass") {
    return {
      pickerCatalog: preferLatestAliases(
        filterCatalogForKeyType(FIREPASS_FALLBACK_ROUTERS, "firepass"),
      ),
      codexCatalog: null,
      keyType,
    };
  }

  try {
    const rawModels = await fetchServerlessCatalogRaw(apiKey);
    const snapshot = buildServerlessCatalogSnapshot(rawModels);
    cacheServerlessCatalogSnapshot(snapshot);
    const entries = preferLatestAliases(filterCatalogForKeyType(snapshot.entries, keyType));
    if (includeFirerouter && !entries.some((entry) => entry.shortId === "firerouter")) {
      entries.unshift(firerouterCatalogEntry());
    }
    const preferredSnapshot = { ...snapshot, entries };
    return {
      pickerCatalog: entries,
      codexCatalog: buildCodexCatalogFromSnapshot(preferredSnapshot, rawModels),
      keyType,
    };
  } catch (error) {
    codexCatalogFetchWarning(error);
    return { pickerCatalog: null, codexCatalog: null, keyType };
  }
}

export async function enableCodexFireworks({
  configPath,
  dataDir,
  apiKey,
  effectiveApiKey = "",
  apiKeyFromFlag = false,
  modelId,
  keyType = "fireworks",
  catalogPath = "",
  catalog = null,
  envHttpHeaders = {},
  telemetryHeaders = {},
}) {
  const resolvedEffective = effectiveApiKey
    || (apiKey === CODEX_API_KEY_ENV_REF ? (process.env.FIREWORKS_API_KEY ?? "") : apiKey);
  if (!resolvedEffective) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }

  const snapshot = await readRawIfExists(configPath);
  const doc = snapshot.existed && snapshot.raw.trim()
    ? readTomlDoc(snapshot.raw)
    : emptyTomlDoc();

  const resolvedKeyType = keyType === "fireworks" ? detectApiKeyType(resolvedEffective) : keyType;

  let effectiveModelId = modelId;
  if (resolvedKeyType === "firepass" && !modelId) {
    effectiveModelId = DEFAULT_FIREPASS_MAIN_MODEL;
  }

  // Only reuse the current model when the gateway provider is already active —
  // switching from Foundry must not carry over a Foundry deployment name and
  // mangle it into accounts/fireworks/models/<deployment>.
  const currentGatewayModel = fireconnectManagedVariant(doc) === "fireworks"
    ? codexCurrentModelId(doc)
    : "";
  const resolvedModel = normalizeModelId(
    effectiveModelId || currentGatewayModel || defaultMainModel(),
  );
  const storedModel = shortFireworksModelRef(resolvedModel);
  const exclusionReason = codexModelExclusionReason(storedModel);
  if (exclusionReason) {
    throw new Error(exclusionReason);
  }

  const backupPath = codexBackupPath(dataDir, configPath);
  const hasBackup = (await readJsonIfExists(backupPath)).snapshot !== undefined;
  // Only snapshot pre-Fireconnect config. If routing is already active but the
  // backup file is gone, the original cannot be recovered — re-on must not
  // snapshot the Fireworks config or off would restore routing.
  const shouldSnapshot = !hasBackup && !fireconnectManaged(doc);

  if (shouldSnapshot) {
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, { configPath: path.resolve(configPath), snapshot });
    await chmod(backupPath, 0o600);
  }

  let effectiveCatalogPath = "";
  let catalogWritten = false;
  if (catalog && catalogPath) {
    const catalogToWrite = ensureCodexOffCatalogEntry(catalog, storedModel);
    await writeCodexCatalogFile(catalogPath, catalogToWrite);
    if (codexCatalogContainsModel(catalogToWrite, storedModel)) {
      effectiveCatalogPath = CODEX_CATALOG_TOML_REF;
      catalogWritten = true;
    }
  } else if (
    catalogPath
    && existsSync(catalogPath)
    && snapshotReferencesFireworksCatalog(snapshot.raw)
  ) {
    const existingCatalog = await readCodexCatalogIfValid(catalogPath);
    const catalogToWrite = ensureCodexOffCatalogEntry(existingCatalog, storedModel);
    if (catalogToWrite !== existingCatalog && catalogToWrite) {
      await writeCodexCatalogFile(catalogPath, catalogToWrite);
    }
    if (catalogToWrite && codexCatalogContainsModel(catalogToWrite, storedModel)) {
      effectiveCatalogPath = CODEX_CATALOG_TOML_REF;
    }
  }

  const providerTable = doc.tables[CODEX_PROVIDER_TABLE] ?? {};
  const priorHttpHeaders = providerTable.http_headers
    && typeof providerTable.http_headers === "object"
    ? providerTable.http_headers
    : {};
  const priorEnvHeaders = providerTable.env_http_headers
    && typeof providerTable.env_http_headers === "object"
    ? providerTable.env_http_headers
    : {};
  const byokHeaderNames = new Set(["x-anthropic-api-key", "x-openai-api-key"]);
  const preservedEnvHeaders = Object.fromEntries(
    Object.entries(priorEnvHeaders).filter(
      ([name]) => !byokHeaderNames.has(name.toLowerCase()),
    ),
  );

  const nextRaw = patchFireconnectRoutingRaw(snapshot.raw, {
    providerId: CODEX_FIREWORKS_PROVIDER_ID,
    baseUrl: CODEX_FIREWORKS_BASE_URL,
    modelId: storedModel,
    catalogPath: effectiveCatalogPath,
    apiKey: resolvedEffective,
    literalAuth: true,
    // codex 0.153+ injects a server-executed web_search tool; Fireworks Responses API rejects the mix (#320).
    webSearch: "disabled",
    httpHeaders: mergeFireconnectTelemetryHeaders(
      priorHttpHeaders,
      telemetryHeaders,
    ),
    envHttpHeaders: { ...preservedEnvHeaders, ...envHttpHeaders },
  });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFileAtomic(configPath, nextRaw, { mode: 0o600 });

  return {
    model: storedModel,
    modelsAdded: catalogWritten
      ? (catalog?.models ?? []).map((entry) => entry.slug).filter(Boolean)
      : [storedModel],
    keyType: resolvedKeyType,
    apiKeyMode: "literal",
    catalogWritten,
  };
}

/**
 * Re-bake the gateway `[model_providers.fireworks-ai]` auth after a `login`/rotation.
 * Converts legacy env-reference auth to a literal. Azure (`fireworks-azure`) is skipped.
 * @param {{ configPath: string, fireworksKey: string }} opts
 * @returns {Promise<boolean>}
 */
export async function refreshCodexGatewayKey({ configPath, fireworksKey }) {
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
  const stored = codexStoredAuthRef(doc);
  const mode = codexAuthKeyMode(stored);
  if (mode === "env-reference") {
    const nextRaw = patchCodexProviderAuthRaw(snapshot.raw, { apiKey: key, literalAuth: true });
    await writeFileAtomic(configPath, nextRaw, { mode: 0o600 });
    return true;
  }
  if (!stored || !isFireworksShapedKey(stored) || stored === key) {
    return false;
  }
  const nextRaw = patchCodexProviderAuthRaw(snapshot.raw, { apiKey: key, literalAuth: true });
  await writeFileAtomic(configPath, nextRaw, { mode: 0o600 });
  return true;
}

/**
 * Route Codex through Fireworks models served on Microsoft Foundry (Azure).
 * Writes a distinct `[model_providers.fireworks-azure]` table pointed at the
 * Foundry resource's OpenAI-compatible base with `wire_api = "chat"`,
 * authenticated by an Azure key (literal bearer when --api-key, otherwise the
 * `env_key = "AZURE_API_KEY"` reference). No Fireworks catalog is written —
 * Foundry deployment names are used verbatim.
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
export async function enableCodexAzure({
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
  const effectiveApiKey = apiKey === CODEX_AZURE_API_KEY_ENV_REF
    ? (process.env[AZURE_API_KEY_ENV] ?? "")
    : apiKey;
  if (!effectiveApiKey) {
    throw new Error(MISSING_AZURE_API_KEY_MESSAGE);
  }

  const snapshot = await readRawIfExists(configPath);
  const doc = snapshot.existed && snapshot.raw.trim()
    ? readTomlDoc(snapshot.raw)
    : emptyTomlDoc();

  // Only reuse an existing model when it's already an Azure deployment name.
  // Switching from the Fireworks gateway must not carry over a gateway catalog
  // id (e.g. glm-5p1) — Foundry has no such deployment.
  const currentAzureModel = fireconnectManagedVariant(doc) === "azure"
    ? codexCurrentModelId(doc)
    : "";
  const resolvedModel = modelId || currentAzureModel || DEFAULT_AZURE_MODEL;

  const backupPath = codexBackupPath(dataDir, configPath);
  const hasBackup = (await readJsonIfExists(backupPath)).snapshot !== undefined;
  const shouldSnapshot = !hasBackup && !fireconnectManaged(doc);
  if (shouldSnapshot) {
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, { configPath: path.resolve(configPath), snapshot });
    await chmod(backupPath, 0o600);
  }

  const nextRaw = patchFireconnectRoutingRaw(snapshot.raw, {
    providerId: CODEX_AZURE_PROVIDER_ID,
    baseUrl: normalizedBaseUrl,
    modelId: resolvedModel,
    apiKey: effectiveApiKey,
    literalAuth: apiKeyFromFlag,
    wireApi: "chat",
    providerName: AZURE_PROVIDER_LABEL,
    authEnvKey: AZURE_API_KEY_ENV,
  });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFileAtomic(configPath, nextRaw);
  if (apiKeyFromFlag) {
    await chmod(configPath, 0o600);
  }

  return {
    model: resolvedModel,
    baseUrl: normalizedBaseUrl,
    apiKeyMode: apiKeyFromFlag ? "literal" : "env-reference",
  };
}

export async function disableCodexFireworks({ configPath, dataDir, catalogPath = "", wasEnabled = false }) {
  const backupPath = codexBackupPath(dataDir, configPath);
  const backup = await readJsonIfExists(backupPath);
  const snapshot = await readRawIfExists(configPath);
  const doc = snapshot.existed && snapshot.raw.trim()
    ? readTomlDoc(snapshot.raw)
    : emptyTomlDoc();
  const hasBackup = backup.snapshot !== undefined;

  if (!wasEnabled && !hasBackup && !fireconnectManaged(doc)) {
    if (catalogPath && !snapshotReferencesFireworksCatalog(snapshot.raw)) {
      await unlinkCatalogIfExists(catalogPath);
    }
    return "noop";
  }

  assertBackupMatchesConfig(backup, configPath, backupPath);

  if (hasBackup) {
    if (backupContainsManagedRouting(backup)) {
      await unlink(backupPath);
    } else {
      await restoreConfigFromBackup(backup, configPath, backupPath);
      if (!snapshotReferencesFireworksCatalog(backup.snapshot.raw)) {
        await unlinkCatalogIfExists(catalogPath);
      }
      return "restored";
    }
  }

  if (!snapshot.existed) {
    await unlinkCatalogIfExists(catalogPath);
    return "noop";
  }

  const stripped = await stripManagedRoutingFromConfig(configPath, snapshot.raw);
  const currentSnapshot = stripped ? await readRawIfExists(configPath) : snapshot;
  if (!snapshotReferencesFireworksCatalog(currentSnapshot.raw)) {
    await unlinkCatalogIfExists(catalogPath);
  }
  return stripped ? "stripped" : "noop";
}

export async function readCodexTomlIfExists(configPath) {
  const snapshot = await readRawIfExists(configPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return { existed: false, doc: emptyTomlDoc() };
  }
  return { existed: true, doc: readTomlDoc(snapshot.raw) };
}
