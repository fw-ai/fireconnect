import path from "node:path";
import process from "node:process";
import {
  AZURE_API_KEY_ENV,
  AZURE_API_KEY_ENV_REF,
  normalizeAzureBaseUrl,
} from "./azure-core.mjs";
import { readJsonIfExists, writeJson } from "./fireconnect-core.mjs";
import { isFireworksShapedKey } from "./fireconnect-core.mjs";

export const GLOBAL_CONFIG_RELATIVE_PATH = ".fireconnect/config.json";
export const FIREWORKS_API_KEY_ENV_REF = "{env:FIREWORKS_API_KEY}";
export const ANTHROPIC_API_KEY_ENV_REF = "{env:ANTHROPIC_API_KEY}";
// The keychain ref names the account the key is stored under — SECRET_ACCOUNT
// ("fireworks-api-key") in secret-store.mjs. It's a fixed sentinel, not parsed;
// getSecret() always reads that one account. The `keychain-ref-account-name`
// test guards this string against drift from SECRET_ACCOUNT.
export const FIREWORKS_API_KEY_KEYCHAIN_REF = "{keychain:fireworks-api-key}";

/** Harnesses that read FIREWORKS_API_KEY from the shell at runtime. */
export const ENV_SHELL_HARNESS_IDS = ["codex", "opencode", "pi", "deepagents"];

/** @typedef {{ enabled: boolean, mode?: "router" | "direct" }} HarnessConfigEntry */
/** @typedef {Record<string, HarnessConfigEntry>} HarnessConfigMap */

export function globalConfigPath(home) {
  return path.join(home, GLOBAL_CONFIG_RELATIVE_PATH);
}

/**
 * @param {string} stored
 */
export function isKnownApiKeyRef(stored) {
  return stored === FIREWORKS_API_KEY_ENV_REF || stored === FIREWORKS_API_KEY_KEYCHAIN_REF;
}

/**
 * Sync resolver for env ref only (legacy callers/tests).
 * Prefer resolveStoredApiKeyValue() for keychain-aware resolution.
 * @param {string} stored
 */
export function resolveStoredApiKey(stored) {
  if (!stored) {
    return "";
  }
  if (stored === FIREWORKS_API_KEY_ENV_REF) {
    return process.env.FIREWORKS_API_KEY?.trim() ?? "";
  }
  if (stored === FIREWORKS_API_KEY_KEYCHAIN_REF) {
    return "";
  }
  if (isFireworksShapedKey(stored)) {
    return stored.trim();
  }
  return stored.trim();
}

/**
 * @param {string} stored
 */
export function resolveStoredAnthropicApiKey(stored) {
  if (!stored) {
    return "";
  }
  if (stored === ANTHROPIC_API_KEY_ENV_REF) {
    return process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  }
  return stored.trim();
}

/**
 * @param {HarnessConfigMap} harnesses
 * @returns {string[]}
 */
export function listRegisteredHarnesses(harnesses) {
  return Object.keys(harnesses);
}

/**
 * @param {HarnessConfigMap} harnesses
 * @returns {string[]}
 */
export function listEnabledHarnesses(harnesses) {
  return Object.entries(harnesses)
    .filter(([, entry]) => entry.enabled === true)
    .map(([id]) => id);
}

/**
 * @param {unknown} entry
 * @returns {HarnessConfigEntry}
 */
function normalizeHarnessEntry(entry) {
  if (entry && typeof entry === "object" && "enabled" in entry) {
    /** @type {HarnessConfigEntry} */
    const normalized = { enabled: entry.enabled === true };
    if (entry.mode === "router" || entry.mode === "direct") {
      normalized.mode = entry.mode;
    }
    return normalized;
  }
  return { enabled: false };
}

/**
 * @param {unknown} raw
 * @returns {HarnessConfigMap}
 */
function normalizeHarnessMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  /** @type {HarnessConfigMap} */
  const map = {};
  for (const [harnessId, entry] of Object.entries(raw)) {
    map[harnessId] = normalizeHarnessEntry(entry);
  }
  return map;
}

/**
 * @param {unknown} raw
 * @returns {{ baseUrl: string, apiKey: string }}
 */
function normalizeAzureSettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { baseUrl: "", apiKey: "" };
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  return {
    baseUrl: typeof record.baseUrl === "string" ? normalizeAzureBaseUrl(record.baseUrl) : "",
    apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
  };
}

/**
 * @param {unknown} raw
 * @returns {"azure" | "fireworks"}
 */
function normalizeProvider(raw) {
  return raw === "azure" ? "azure" : "fireworks";
}

/**
 * @param {string[]} harnessIds
 * @param {HarnessConfigMap} [existingMap]
 * @returns {HarnessConfigMap}
 */
export function buildHarnessMapForConfigure(harnessIds, existingMap = {}) {
  /** @type {HarnessConfigMap} */
  const map = {};
  for (const harnessId of harnessIds) {
    map[harnessId] = existingMap[harnessId] ?? { enabled: false };
  }
  return map;
}

/**
 * @param {string} home
 */
export async function readGlobalConfig(home) {
  const existing = await readJsonIfExists(globalConfigPath(home));
  return {
    apiKey: typeof existing.apiKey === "string" ? existing.apiKey : "",
    anthropicApiKey: typeof existing.anthropicApiKey === "string" ? existing.anthropicApiKey : "",
    routerBaseUrl: typeof existing.routerBaseUrl === "string" ? existing.routerBaseUrl : "",
    provider: normalizeProvider(existing.provider),
    azure: normalizeAzureSettings(existing.azure),
    harnesses: normalizeHarnessMap(existing.harnesses),
    _exists: Object.keys(existing).length > 0,
  };
}

/**
 * @param {string} home
 */
export async function readProviderSettings(home) {
  const config = await readGlobalConfig(home);
  return {
    provider: config.provider,
    azure: {
      baseUrl: config.azure.baseUrl,
      apiKey: config.azure.apiKey === AZURE_API_KEY_ENV_REF
        ? (process.env[AZURE_API_KEY_ENV] ? AZURE_API_KEY_ENV_REF : "")
        : config.azure.apiKey,
    },
  };
}

/**
 * Store a Fireworks API key in global config (e.g. from `on --api-key`).
 * @param {string} home
 * @param {string} apiKey
 */
export async function persistGlobalApiKey(home, apiKey) {
  const trimmed = apiKey?.trim() ?? "";
  if (!home || !trimmed) {
    return false;
  }
  await writeGlobalConfig(home, { apiKey: trimmed });
  return true;
}

/**
 * Store an Anthropic API key in global config (e.g. from on --anthropic-api-key).
 * @param {string} home
 * @param {string} anthropicApiKey
 */
export async function persistGlobalAnthropicApiKey(home, anthropicApiKey) {
  const trimmed = anthropicApiKey?.trim() ?? "";
  if (!home || !trimmed) {
    return false;
  }
  await writeGlobalConfig(home, { anthropicApiKey: trimmed });
  return true;
}

/**
 * Store the FireRouter base URL in global config (e.g. from `on --router --base-url`).
 * @param {string} home
 * @param {string} routerBaseUrl
 */
export async function persistGlobalRouterBaseUrl(home, routerBaseUrl) {
  const trimmed = routerBaseUrl?.trim() ?? "";
  if (!home || !trimmed) {
    return false;
  }
  await writeGlobalConfig(home, { routerBaseUrl: trimmed });
  return true;
}

/**
 * @param {string} home
 * @param {{
 *   apiKey?: string,
 *   anthropicApiKey?: string,
 *   routerBaseUrl?: string,
 *   provider?: "azure" | "fireworks",
 *   azure?: { baseUrl?: string, apiKey?: string },
 *   harnesses?: HarnessConfigMap,
 * }} config
 */
export async function writeGlobalConfig(home, config) {
  const { apiKeyRefForWrite } = await import("./api-key.mjs");
  const filePath = globalConfigPath(home);
  const existing = await readJsonIfExists(filePath);
  const existingAzure = normalizeAzureSettings(existing.azure);
  const apiKey = config.apiKey !== undefined ? config.apiKey : (existing.apiKey ?? "");
  const anthropicApiKey = config.anthropicApiKey !== undefined
    ? config.anthropicApiKey
    : (existing.anthropicApiKey ?? "");
  const routerBaseUrl = config.routerBaseUrl !== undefined
    ? config.routerBaseUrl
    : (existing.routerBaseUrl ?? "");
  const provider = config.provider !== undefined
    ? normalizeProvider(config.provider)
    : normalizeProvider(existing.provider);
  const azure = config.azure !== undefined
    ? {
      baseUrl: config.azure.baseUrl !== undefined
        ? normalizeAzureBaseUrl(config.azure.baseUrl)
        : existingAzure.baseUrl,
      apiKey: config.azure.apiKey !== undefined ? config.azure.apiKey : existingAzure.apiKey,
    }
    : existingAzure;
  const harnesses = config.harnesses !== undefined
    ? config.harnesses
    : normalizeHarnessMap(existing.harnesses);
const payload = {
    apiKey: await apiKeyRefForWrite(home, apiKey),
    anthropicApiKey,
    routerBaseUrl,
    provider,
    azure,
    harnesses,
 };
  const hasLiteralKey = (payload.apiKey && payload.apiKey !== FIREWORKS_API_KEY_ENV_REF && payload.apiKey !== FIREWORKS_API_KEY_KEYCHAIN_REF)
    || (payload.anthropicApiKey && payload.anthropicApiKey !== ANTHROPIC_API_KEY_ENV_REF);
  await writeJson(filePath, payload, { mode: hasLiteralKey ? 0o600 : undefined });
  return payload;
}

/**
 * @param {string} home
 * @param {string} harnessId
 * @param {boolean} enabled
 * @param {{ mode?: "router" | "direct" }} [options]
 */
export async function setHarnessEnabled(home, harnessId, enabled, { mode } = {}) {
  const config = await readGlobalConfig(home);
  /** @type {HarnessConfigEntry} */
  const entry = { enabled };
  if (enabled && (mode === "router" || mode === "direct")) {
    entry.mode = mode;
  }
  const harnesses = {
    ...config.harnesses,
    [harnessId]: entry,
  };
  await writeGlobalConfig(home, {
    apiKey: config.apiKey,
    anthropicApiKey: config.anthropicApiKey,
    routerBaseUrl: config.routerBaseUrl,
    harnesses,
  });
}

/**
 * @param {string} home
 * @param {string} harnessId
 * @returns {"router" | "direct" | ""}
 */
export function harnessModeFromConfig(config, harnessId) {
  const mode = config.harnesses[harnessId]?.mode;
  return mode === "router" || mode === "direct" ? mode : "";
}

/**
 * @param {string} home
 * @param {string} harnessId
 */
export async function isHarnessEnabled(home, harnessId) {
  const config = await readGlobalConfig(home);
  return config.harnesses[harnessId]?.enabled === true;
}

/**
 * @param {string} home
 */
export async function discoverHarnessesForUninstall(home) {
  const config = await readGlobalConfig(home);
  return listRegisteredHarnesses(config.harnesses);
}
