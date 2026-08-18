import { createHash } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseDocument, stringify } from "yaml";
import {
  DEFAULT_FIREPASS_MAIN_MODEL,
  defaultMainModel,
  normalizeModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import { resolveFireworksCatalog } from "../../fireworks/model-specs.mjs";
import { prettyModelName, warmServerlessPricingCache } from "../../fireworks/models.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import { writeFileAtomic } from "../../io/atomic-write.mjs";
import {
  detectApiKeyType,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "../../keys/key-type.mjs";
import { readRawIfExists } from "../opencode/core.mjs";
import {
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_DATA_RELATIVE_DIR,
  DEEPSEEK_DEFAULT_MODEL_NS,
  DEEPSEEK_FIREWORKS_BASE_URL,
  DEEPSEEK_FIREWORKS_PROVIDER_ID,
  DEEPSEEK_HOME_RELATIVE_DIR,
  DEEPSEEK_LLM_PI_AI_NS,
} from "./constants.mjs";

export {
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_DATA_RELATIVE_DIR,
  DEEPSEEK_FIREWORKS_BASE_URL,
  DEEPSEEK_FIREWORKS_PROVIDER_ID,
} from "./constants.mjs";

/** @typedef {"literal" | "env-reference" | "missing"} DeepseekAuthMode */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/** Resolve DeepSeek Harness home: `$DSH_HOME`, else `~/.dsh`. */
export function deepseekHomePath(home) {
  const fromEnv = process.env.DSH_HOME?.trim();
  return fromEnv || path.join(home, DEEPSEEK_HOME_RELATIVE_DIR);
}

export function deepseekSettingsPath(home, settingsPath = "") {
  return settingsPath || path.join(deepseekHomePath(home), "settings.yaml");
}

/**
 * Credentials sit beside settings when `--config-path` overrides settings.
 * @param {string} home
 * @param {{ settingsPath?: string, credentialsPath?: string }} [opts]
 */
export function deepseekCredentialsPath(home, opts = {}) {
  if (opts.credentialsPath) {
    return opts.credentialsPath;
  }
  if (opts.settingsPath) {
    return path.join(path.dirname(opts.settingsPath), ".credentials.yaml");
  }
  return path.join(deepseekHomePath(home), ".credentials.yaml");
}

export function deepseekDataDir(home, dataDir = "") {
  return dataDir || path.join(home, DEEPSEEK_DATA_RELATIVE_DIR);
}

export function deepseekBackupPath(dataDir, settingsPath) {
  const key = createHash("sha256").update(path.resolve(settingsPath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `settings-backup.${key}.json`);
}

/**
 * @param {string} raw
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function parseYamlMapping(raw, label) {
  if (!raw.trim()) {
    return {};
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new Error(`Invalid DeepSeek Harness ${label}: ${doc.errors[0].message}`);
  }
  const data = doc.toJS();
  if (data === null || data === undefined) {
    return {};
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`DeepSeek Harness ${label} must be a mapping`);
  }
  return /** @type {Record<string, unknown>} */ (data);
}

export function parseDeepseekSettings(raw) {
  return parseYamlMapping(raw, "settings.yaml");
}

export function parseDeepseekCredentials(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(parseYamlMapping(raw, ".credentials.yaml"))) {
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

function fireworksProvider(settings) {
  const providers = asPlainObject(asPlainObject(settings[DEEPSEEK_LLM_PI_AI_NS])?.providers);
  return asPlainObject(providers?.[DEEPSEEK_FIREWORKS_PROVIDER_ID]);
}

function isManagedFireworksProvider(settings) {
  const provider = fireworksProvider(settings);
  if (!provider
    || provider.apiKeyEnv !== DEEPSEEK_API_KEY_ENV
    || provider.api !== "openai-completions"
    || provider.baseURL !== DEEPSEEK_FIREWORKS_BASE_URL) {
    return false;
  }
  return asPlainObject(settings[DEEPSEEK_DEFAULT_MODEL_NS])?.provider
    === DEEPSEEK_FIREWORKS_PROVIDER_ID;
}

/** @returns {"fireworks" | null} */
export function deepseekProviderStatus(settings) {
  return isManagedFireworksProvider(settings) ? "fireworks" : null;
}

/** @returns {string | null} */
export function deepseekCurrentModelId(settings) {
  if (!isManagedFireworksProvider(settings)) {
    return null;
  }
  const model = asPlainObject(settings[DEEPSEEK_DEFAULT_MODEL_NS])?.model;
  return typeof model === "string" && model.trim()
    ? shortFireworksModelRef(model)
    : null;
}

/** @returns {DeepseekAuthMode} */
export function deepseekAuthMode(settings, credentials) {
  if (!isManagedFireworksProvider(settings)) {
    return "missing";
  }
  const stored = credentials[DEEPSEEK_API_KEY_ENV];
  return typeof stored === "string" && stored.trim() ? "literal" : "env-reference";
}

/**
 * @param {{
 *   mode: DeepseekAuthMode,
 *   credentials: Record<string, string>,
 *   envApiKey?: string,
 * }} args
 */
export function resolveDeepseekApiKey({
  mode,
  credentials,
  envApiKey = process.env.FIREWORKS_API_KEY ?? "",
}) {
  if (mode === "literal") {
    return credentials[DEEPSEEK_API_KEY_ENV]?.trim() ?? "";
  }
  if (mode === "env-reference") {
    return envApiKey.trim();
  }
  return "";
}

export async function readDeepseekSettingsIfExists(settingsPath) {
  const snapshot = await readRawIfExists(settingsPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return { existed: false, raw: "", settings: /** @type {Record<string, unknown>} */ ({}) };
  }
  return {
    existed: true,
    raw: snapshot.raw,
    settings: parseDeepseekSettings(snapshot.raw),
  };
}

export async function readDeepseekCredentialsIfExists(credentialsPath) {
  const snapshot = await readRawIfExists(credentialsPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return { existed: false, raw: "", credentials: /** @type {Record<string, string>} */ ({}) };
  }
  return {
    existed: true,
    raw: snapshot.raw,
    credentials: parseDeepseekCredentials(snapshot.raw),
  };
}

/**
 * DeepSeek Harness provider.models row from the canonical Fireworks catalog.
 * @param {string} modelId
 * @param {string} name
 */
export function buildDeepseekFireworksModelEntry(modelId, name) {
  const slug = shortFireworksModelRef(normalizeModelId(modelId));
  const { limits, cost, input } = resolveFireworksCatalog(slug);
  return {
    id: slug,
    name: name || prettyModelName(slug) || slug,
    reasoning: true,
    input,
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
    ...(cost ? { cost } : {}),
  };
}

/**
 * Persist short gateway slugs (`kimi-k2p5`, `firerouter`, …) — not full
 * `accounts/fireworks/...` resource ids. Catalog limits come from the shared
 * serverless/static helpers via {@link buildDeepseekFireworksModelEntry}.
 * @param {Record<string, unknown>} settings
 * @param {{ modelId: string, modelName?: string }} opts
 */
export function patchDeepseekFireworksSettings(settings, { modelId, modelName }) {
  const slug = shortFireworksModelRef(normalizeModelId(modelId));
  const next = structuredClone(settings);
  const llm = asPlainObject(next[DEEPSEEK_LLM_PI_AI_NS]) ?? {};
  const providers = asPlainObject(llm.providers) ?? {};

  providers[DEEPSEEK_FIREWORKS_PROVIDER_ID] = {
    displayName: "Fireworks",
    apiKeyEnv: DEEPSEEK_API_KEY_ENV,
    api: "openai-completions",
    baseURL: DEEPSEEK_FIREWORKS_BASE_URL,
    models: [buildDeepseekFireworksModelEntry(slug, modelName)],
  };
  llm.providers = providers;
  next[DEEPSEEK_LLM_PI_AI_NS] = llm;
  next[DEEPSEEK_DEFAULT_MODEL_NS] = {
    provider: DEEPSEEK_FIREWORKS_PROVIDER_ID,
    model: slug,
  };
  return next;
}

export function stripDeepseekFireworksSettings(settings) {
  const next = structuredClone(settings);
  const llm = asPlainObject(next[DEEPSEEK_LLM_PI_AI_NS]);
  if (llm) {
    const providers = asPlainObject(llm.providers);
    if (providers) {
      delete providers[DEEPSEEK_FIREWORKS_PROVIDER_ID];
      if (Object.keys(providers).length === 0) {
        delete llm.providers;
      }
    }
    if (Object.keys(llm).length === 0) {
      delete next[DEEPSEEK_LLM_PI_AI_NS];
    }
  }
  const defaults = asPlainObject(next[DEEPSEEK_DEFAULT_MODEL_NS]);
  if (defaults?.provider === DEEPSEEK_FIREWORKS_PROVIDER_ID) {
    delete next[DEEPSEEK_DEFAULT_MODEL_NS];
  }
  return next;
}

function serializeYaml(doc) {
  if (Object.keys(doc).length === 0) {
    return "";
  }
  return `${stringify(doc, { lineWidth: 0 }).trimEnd()}\n`;
}

/**
 * @param {{
 *   settingsPath: string,
 *   credentialsPath: string,
 *   dataDir: string,
 *   effectiveApiKey: string,
 *   modelId?: string,
 *   keyType?: string,
 * }} args
 */
export async function enableDeepseekFireworks({
  settingsPath,
  credentialsPath,
  dataDir,
  effectiveApiKey: effectiveApiKeyInput = "",
  modelId,
  keyType = "fireworks",
}) {
  const effectiveApiKey = effectiveApiKeyInput.trim();
  if (!effectiveApiKey) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }

  const [settingsSnap, credentialsSnap] = await Promise.all([
    readDeepseekSettingsIfExists(settingsPath),
    readDeepseekCredentialsIfExists(credentialsPath),
  ]);

  const resolvedKeyType = keyType === "fireworks"
    ? detectApiKeyType(effectiveApiKey)
    : keyType;

  if (resolvedKeyType === "fireworks") {
    await warmServerlessPricingCache(effectiveApiKey, resolvedKeyType);
  }

  const effectiveModelId = modelId
    || (resolvedKeyType === "firepass" ? DEFAULT_FIREPASS_MAIN_MODEL : "")
    || deepseekCurrentModelId(settingsSnap.settings)
    || defaultMainModel(resolvedKeyType);
  const storedModel = shortFireworksModelRef(normalizeModelId(effectiveModelId));

  const backupPath = deepseekBackupPath(dataDir, settingsPath);
  const existingBackup = await readJsonIfExists(backupPath);
  const shouldSnapshot = existingBackup.settingsSnapshot === undefined
    && !isManagedFireworksProvider(settingsSnap.settings);

  if (shouldSnapshot) {
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, {
      settingsPath: path.resolve(settingsPath),
      credentialsPath: path.resolve(credentialsPath),
      settingsSnapshot: {
        existed: settingsSnap.existed,
        raw: settingsSnap.raw,
      },
      credentialsSnapshot: {
        existed: credentialsSnap.existed,
        raw: credentialsSnap.raw,
      },
    });
    await chmod(backupPath, 0o600);
  }

  const nextSettings = patchDeepseekFireworksSettings(settingsSnap.settings, {
    modelId: storedModel,
  });
  const nextCredentials = {
    ...credentialsSnap.credentials,
    [DEEPSEEK_API_KEY_ENV]: effectiveApiKey,
  };

  await mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  await writeFileAtomic(settingsPath, serializeYaml(nextSettings), { mode: 0o600 });
  await writeFileAtomic(credentialsPath, serializeYaml(nextCredentials), { mode: 0o600 });

  return {
    model: storedModel,
    modelsAdded: [storedModel],
    modelSpec: `${DEEPSEEK_FIREWORKS_PROVIDER_ID}:${storedModel}`,
    keyType: resolvedKeyType,
    authMode: "literal",
    apiKeyMode: "literal",
  };
}

/**
 * Re-bake credentials after login/rotation.
 * @param {{ settingsPath: string, credentialsPath: string, fireworksKey: string }} opts
 */
export async function refreshDeepseekGatewayKey({
  settingsPath,
  credentialsPath,
  fireworksKey,
}) {
  const key = fireworksKey?.trim();
  if (!key) {
    return false;
  }
  const settingsSnap = await readDeepseekSettingsIfExists(settingsPath);
  if (!isManagedFireworksProvider(settingsSnap.settings)) {
    return false;
  }
  const credentialsSnap = await readDeepseekCredentialsIfExists(credentialsPath);
  const current = credentialsSnap.credentials[DEEPSEEK_API_KEY_ENV] ?? "";
  if (current === key) {
    return false;
  }
  await mkdir(path.dirname(credentialsPath), { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    credentialsPath,
    serializeYaml({
      ...credentialsSnap.credentials,
      [DEEPSEEK_API_KEY_ENV]: key,
    }),
    { mode: 0o600 },
  );
  return true;
}

/**
 * @param {{ existed: boolean, raw: string }} snapshot
 * @param {string} filePath
 * @param {number} [mode]
 */
async function restoreRawSnapshot(snapshot, filePath, mode = 0o600) {
  if (snapshot.existed) {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFileAtomic(filePath, snapshot.raw, { mode });
    return;
  }
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * @param {{
 *   settingsPath: string,
 *   credentialsPath: string,
 *   dataDir: string,
 *   wasEnabled?: boolean,
 * }} args
 * @returns {Promise<"restored" | "stripped" | "unchanged">}
 */
export async function disableDeepseekFireworks({
  settingsPath,
  credentialsPath,
  dataDir,
  wasEnabled = false,
}) {
  const backupPath = deepseekBackupPath(dataDir, settingsPath);
  const backup = await readJsonIfExists(backupPath);
  const settingsSnap = await readDeepseekSettingsIfExists(settingsPath);
  const hasBackup = backup.settingsSnapshot !== undefined;

  if (!wasEnabled && !hasBackup && deepseekProviderStatus(settingsSnap.settings) !== "fireworks") {
    return "unchanged";
  }

  if (backup.settingsPath !== undefined && backup.settingsPath !== path.resolve(settingsPath)) {
    throw new Error(
      `Backup at ${backupPath} was taken for ${backup.settingsPath}, not ${settingsPath}; refusing to restore.`,
    );
  }

  if (hasBackup) {
    if (backup.settingsSnapshot) {
      await restoreRawSnapshot(backup.settingsSnapshot, settingsPath);
    }
    if (backup.credentialsSnapshot) {
      await restoreRawSnapshot(backup.credentialsSnapshot, credentialsPath);
    }
    try {
      await unlink(backupPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    return "restored";
  }

  if (!settingsSnap.existed) {
    return "unchanged";
  }

  const nextRaw = serializeYaml(stripDeepseekFireworksSettings(settingsSnap.settings));
  if (nextRaw) {
    await writeFileAtomic(settingsPath, nextRaw, { mode: 0o600 });
  } else {
    await restoreRawSnapshot({ existed: false, raw: "" }, settingsPath);
  }

  const credentialsSnap = await readDeepseekCredentialsIfExists(credentialsPath);
  if (credentialsSnap.existed) {
    const nextCreds = { ...credentialsSnap.credentials };
    delete nextCreds[DEEPSEEK_API_KEY_ENV];
    const credRaw = serializeYaml(nextCreds);
    if (credRaw) {
      await writeFileAtomic(credentialsPath, credRaw, { mode: 0o600 });
    } else {
      await restoreRawSnapshot({ existed: false, raw: "" }, credentialsPath);
    }
  }

  return "stripped";
}
