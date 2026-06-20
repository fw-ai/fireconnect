import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_FIREPASS_MAIN_MODEL,
  DEFAULT_MAIN_MODEL,
  detectApiKeyType,
  normalizeModelId,
  readJsonIfExists,
  writeJson,
} from "./fireconnect-core.mjs";
import { readRawIfExists } from "./opencode-core.mjs";
import { parseToml } from "./codex-toml.mjs";
import {
  patchCodexModelRaw,
  patchCodexProviderAuthRaw,
  patchFireconnectRoutingRaw,
  stripFireconnectRoutingRaw,
} from "./codex-toml-patch.mjs";
import { writeCodexCatalog } from "./codex-catalog.mjs";

export const CODEX_CONFIG_RELATIVE_PATH = ".codex/config.toml";
export const CODEX_DATA_RELATIVE_DIR = ".fireconnect/codex";
export const CODEX_CATALOG_RELATIVE_PATH = ".codex/fireworks-model-catalog.json";
export const CODEX_CATALOG_TOML_REF = `~/${CODEX_CATALOG_RELATIVE_PATH}`;
export const CODEX_FIREWORKS_PROVIDER_ID = "fireworks-ai";
export const CODEX_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
export const CODEX_API_KEY_ENV_REF = "{env:FIREWORKS_API_KEY}";
export const CODEX_PROVIDER_TABLE = `model_providers.${CODEX_FIREWORKS_PROVIDER_ID}`;

export function printCodexRestartHint() {
  console.log(
    "To use the updated routing, run /model in Codex to activate it in the same session, "
    + "start a new session, or /exit and resume the conversation with codex resume <id>.",
  );
}

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

function isFireworksModelId(model) {
  return typeof model === "string" && model.startsWith("accounts/fireworks/");
}

function isManagedProviderTable(table) {
  return table
    && table.base_url === CODEX_FIREWORKS_BASE_URL
    && (table.env_key === "FIREWORKS_API_KEY"
      || typeof table.experimental_bearer_token === "string");
}

/**
 * FireConnect owns routing when root model_provider/model point at our managed
 * Fireworks provider table.
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function fireconnectManaged(doc) {
  const providerTable = doc.tables[CODEX_PROVIDER_TABLE];
  return doc.root.model_provider === CODEX_FIREWORKS_PROVIDER_ID
    && isFireworksModelId(doc.root.model)
    && isManagedProviderTable(providerTable);
}

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function codexCurrentModelId(doc) {
  if (!fireconnectManaged(doc)) {
    return null;
  }
  const model = doc.root.model;
  if (typeof model !== "string") {
    return null;
  }
  if (model.startsWith("accounts/fireworks/models/")) {
    return model.slice("accounts/fireworks/models/".length);
  }
  if (model.startsWith("accounts/fireworks/routers/")) {
    return model.slice("accounts/fireworks/routers/".length);
  }
  return model;
}

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function codexStoredAuthRef(doc) {
  const provider = doc.tables[CODEX_PROVIDER_TABLE];
  if (!provider || !isManagedProviderTable(provider)) {
    return "";
  }
  const bearer = provider.experimental_bearer_token;
  if (typeof bearer === "string" && bearer.trim()) {
    return bearer.trim();
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
  return storedRef;
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
  if (fireconnectManaged(doc)) {
    return "fireworks";
  }
  if (doc.tables[CODEX_PROVIDER_TABLE] || doc.root.model_provider === CODEX_FIREWORKS_PROVIDER_ID) {
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
  const stripped = stripFireconnectRoutingRaw(raw, { stripRootRouting: true });
  if (stripped !== raw) {
    await writeFile(configPath, stripped, "utf8");
    return true;
  }
  return false;
}

export async function enableCodexFireworks({
  configPath,
  dataDir,
  apiKey,
  apiKeyFromFlag = false,
  modelId,
  keyType = "fireworks",
  catalogPath = "",
  catalog = null,
}) {
  const effectiveApiKey = apiKey === CODEX_API_KEY_ENV_REF
    ? (process.env.FIREWORKS_API_KEY ?? "")
    : apiKey;
  if (!effectiveApiKey) {
    throw new Error("No Fireworks API key found. Pass --api-key or set FIREWORKS_API_KEY.");
  }

  const snapshot = await readRawIfExists(configPath);
  const doc = snapshot.existed && snapshot.raw.trim()
    ? readTomlDoc(snapshot.raw)
    : emptyTomlDoc();

  const resolvedKeyType = keyType === "fireworks" ? detectApiKeyType(effectiveApiKey) : keyType;

  let effectiveModelId = modelId;
  if (resolvedKeyType === "firepass" && !modelId) {
    effectiveModelId = DEFAULT_FIREPASS_MAIN_MODEL;
  }

  const resolvedModel = normalizeModelId(
    effectiveModelId || codexCurrentModelId(doc) || DEFAULT_MAIN_MODEL,
  );

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
  if (catalog && catalogPath) {
    try {
      await writeCodexCatalog(catalogPath, catalog);
      effectiveCatalogPath = CODEX_CATALOG_TOML_REF;
    } catch {
      effectiveCatalogPath = "";
    }
  }

  const nextRaw = patchFireconnectRoutingRaw(snapshot.raw, {
    providerId: CODEX_FIREWORKS_PROVIDER_ID,
    baseUrl: CODEX_FIREWORKS_BASE_URL,
    modelId: resolvedModel,
    catalogPath: effectiveCatalogPath,
    apiKey: effectiveApiKey,
    literalAuth: apiKeyFromFlag,
  });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, nextRaw, "utf8");
  // A literal bearer token can end up in config.toml when --api-key is passed.
  // Restrict to owner-only so a permissive umask can't leak the key to other users.
  if (apiKeyFromFlag) {
    await chmod(configPath, 0o600);
  }

  return {
    model: resolvedModel,
    keyType: resolvedKeyType,
    apiKeyMode: apiKeyFromFlag ? "literal" : "env-reference",
    catalogWritten: Boolean(effectiveCatalogPath),
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

  if (!wasEnabled && !hasBackup && codexProviderStatus(doc) !== "fireworks") {
    return "noop";
  }

  if (catalogPath) {
    try {
      await unlink(catalogPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
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

  return (await stripManagedRoutingFromConfig(configPath, snapshot.raw))
    ? "stripped"
    : "noop";
}

export async function readCodexTomlIfExists(configPath) {
  const snapshot = await readRawIfExists(configPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return { existed: false, doc: emptyTomlDoc() };
  }
  return { existed: true, doc: readTomlDoc(snapshot.raw) };
}

export async function updateCodexModel({
  configPath,
  modelId,
  apiKey = "",
  literalAuth = false,
  catalogPath = "",
  catalog = null,
}) {
  const snapshot = await readRawIfExists(configPath);
  if (!snapshot.existed) {
    throw new Error(`${configPath} does not exist; run: fireconnect codex on`);
  }
  const doc = readTomlDoc(snapshot.raw);
  if (codexProviderStatus(doc) !== "fireworks") {
    throw new Error("Codex Fireworks routing is not active; run: fireconnect codex on");
  }
  const resolvedModel = normalizeModelId(modelId);
  let nextRaw = patchCodexModelRaw(snapshot.raw, resolvedModel);
  const authKey = apiKey === CODEX_API_KEY_ENV_REF
    ? (process.env.FIREWORKS_API_KEY ?? "")
    : apiKey;
  if (authKey) {
    nextRaw = patchCodexProviderAuthRaw(nextRaw, { apiKey: authKey, literalAuth });
  }
  await writeFile(configPath, nextRaw, "utf8");
  // If we just wrote a literal bearer token, restrict the file to owner-only.
  if (authKey && literalAuth) {
    await chmod(configPath, 0o600);
  }
  if (catalog && catalogPath && !existsSync(catalogPath)) {
    await writeCodexCatalog(catalogPath, catalog);
  }
  return { model: resolvedModel };
}
