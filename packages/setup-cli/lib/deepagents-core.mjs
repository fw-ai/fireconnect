import { createHash } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
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
import { parseToml } from "./codex-toml.mjs";
import {
  mergeDuplicateModelsSections,
  normalizeDeepagentsToml,
  patchDeepagentsModelRaw,
  patchDeepagentsProviderModelsRaw,
  patchFireconnectRoutingRaw,
  stripFireconnectRoutingRaw,
  deepagentsProviderModelIdsFromRaw,
} from "./deepagents-toml-patch.mjs";
import {
  deepagentsAuthMode,
  resolveDeepagentsEffectiveApiKey,
} from "./deepagents-auth.mjs";
export {
  deepagentsAuthMode,
  resolveDeepagentsOnAuth,
  resolveDeepagentsApiKey,
  resolveDeepagentsEffectiveApiKey,
} from "./deepagents-auth.mjs";
import {
  DEEPAGENTS_API_KEY_ENV,
  DEEPAGENTS_AUTH_RELATIVE_PATH,
  DEEPAGENTS_CONFIG_RELATIVE_PATH,
  DEEPAGENTS_DATA_RELATIVE_DIR,
  DEEPAGENTS_FIREWORKS_BASE_URL,
  DEEPAGENTS_FIREWORKS_PROVIDER_ID,
  DEEPAGENTS_PROVIDER_TABLE,
  DEEPAGENTS_STATE_RELATIVE_DIR,
} from "./deepagents-constants.mjs";

export {
  DEEPAGENTS_API_KEY_ENV,
  DEEPAGENTS_AUTH_RELATIVE_PATH,
  DEEPAGENTS_CONFIG_RELATIVE_PATH,
  DEEPAGENTS_DATA_RELATIVE_DIR,
  DEEPAGENTS_FIREWORKS_BASE_URL,
  DEEPAGENTS_FIREWORKS_PROVIDER_ID,
  DEEPAGENTS_PROVIDER_TABLE,
  DEEPAGENTS_STATE_RELATIVE_DIR,
} from "./deepagents-constants.mjs";

/** @param {{ tables: Record<string, Record<string, unknown>> }} doc */
export function deepagentsUsesEnvAuth(doc) {
  return deepagentsAuthMode(doc) === "env-reference";
}

export function printDeepagentsRestartHint() {
  console.log(
    "Restart Deep Agents Code (dcode) or start a new session to use the updated routing.",
  );
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
    && table.enabled === true;
}

function isFireworksModelSpec(value) {
  return typeof value === "string"
    && value.startsWith(`${DEEPAGENTS_FIREWORKS_PROVIDER_ID}:accounts/fireworks/`);
}

function modelsSection(doc) {
  return doc.tables.models ?? {};
}

function fireworksProviderTable(doc) {
  return doc.tables[DEEPAGENTS_PROVIDER_TABLE] ?? {};
}

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function fireconnectManaged(doc) {
  const models = modelsSection(doc);
  const providerTable = fireworksProviderTable(doc);
  return isFireworksModelSpec(models.default)
    && isManagedProviderTable(providerTable);
}

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function deepagentsCurrentModelId(doc) {
  if (!fireconnectManaged(doc)) {
    return null;
  }
  const modelSpec = modelsSection(doc).default;
  if (typeof modelSpec !== "string") {
    return null;
  }
  const prefix = `${DEEPAGENTS_FIREWORKS_PROVIDER_ID}:`;
  if (!modelSpec.startsWith(prefix)) {
    return null;
  }
  return modelSpec.slice(prefix.length);
}

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 */
export function deepagentsProviderStatus(doc) {
  if (fireconnectManaged(doc)) {
    return "fireworks";
  }
  const models = modelsSection(doc);
  if (fireworksProviderTable(doc)
    || (typeof models.default === "string"
      && models.default.startsWith(`${DEEPAGENTS_FIREWORKS_PROVIDER_ID}:`))) {
    return "custom";
  }
  return "default";
}

export function deepagentsModelSpec(modelId) {
  return `${DEEPAGENTS_FIREWORKS_PROVIDER_ID}:${modelId}`;
}

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 * @param {string} raw
 * @param {string} resolvedModel
 */
export function deepagentsModelConfigured(doc, raw, resolvedModel) {
  const current = deepagentsCurrentModelId(doc);
  if (!current || normalizeModelId(current) !== resolvedModel) {
    return false;
  }
  const providerModels = deepagentsProviderModelIdsFromRaw(raw);
  if (providerModels.length === 0) {
    return false;
  }
  return providerModels.some(
    (entry) => normalizeModelId(entry) === resolvedModel,
  );
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

  let effectiveModelId = modelId;
  if (resolvedKeyType === "firepass" && !modelId) {
    effectiveModelId = DEFAULT_FIREPASS_MAIN_MODEL;
  }

  const resolvedModel = normalizeModelId(
    effectiveModelId || deepagentsCurrentModelId(doc) || DEFAULT_MAIN_MODEL,
  );
  const modelSpec = deepagentsModelSpec(resolvedModel);

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
    modelId: resolvedModel,
    baseUrl: DEEPAGENTS_FIREWORKS_BASE_URL,
    authMode: "env-reference",
  });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, nextRaw, "utf8");

  return {
    model: resolvedModel,
    modelSpec,
    keyType: resolvedKeyType,
    authMode: "env-reference",
    apiKeyMode: "env-reference",
  };
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

export async function updateDeepagentsModel({
  configPath,
  modelId,
}) {
  const snapshot = await readRawIfExists(configPath);
  if (!snapshot.existed) {
    throw new Error(`${configPath} does not exist; run: fireconnect deepagents on`);
  }
  const doc = readTomlDoc(snapshot.raw);
  if (deepagentsProviderStatus(doc) !== "fireworks") {
    throw new Error("Deep Agents Fireworks routing is not active; run: fireconnect deepagents on");
  }

  const resolvedModel = normalizeModelId(modelId);
  const modelSpec = deepagentsModelSpec(resolvedModel);
  if (deepagentsModelConfigured(doc, snapshot.raw, resolvedModel)) {
    return {
      model: resolvedModel,
      modelSpec,
      unchanged: true,
    };
  }

  const authMode = deepagentsAuthMode(doc);
  const normalizedRaw = mergeDuplicateModelsSections(snapshot.raw);
  let nextRaw = patchDeepagentsModelRaw(normalizedRaw, modelSpec);
  nextRaw = patchDeepagentsProviderModelsRaw(nextRaw, resolvedModel, authMode);
  if (nextRaw === normalizedRaw) {
    return {
      model: resolvedModel,
      modelSpec,
      unchanged: true,
    };
  }
  await writeFile(configPath, nextRaw, "utf8");
  return {
    model: resolvedModel,
    modelSpec,
  };
}
