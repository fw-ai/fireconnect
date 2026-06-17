import path from "node:path";
import process from "node:process";
import { readJsonIfExists, writeJson } from "./fireconnect-core.mjs";

export const GLOBAL_CONFIG_RELATIVE_PATH = ".fireconnect/config.json";
export const FIREWORKS_API_KEY_ENV_REF = "{env:FIREWORKS_API_KEY}";

/** @typedef {{ enabled: boolean }} HarnessConfigEntry */
/** @typedef {Record<string, HarnessConfigEntry>} HarnessConfigMap */

export function globalConfigPath(home) {
  return path.join(home, GLOBAL_CONFIG_RELATIVE_PATH);
}

/**
 * @param {string} stored
 */
export function resolveStoredApiKey(stored) {
  if (!stored) {
    return "";
  }
  if (stored === FIREWORKS_API_KEY_ENV_REF) {
    return process.env.FIREWORKS_API_KEY?.trim() ?? "";
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
    return { enabled: entry.enabled === true };
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
    apiKey: existing.apiKey ?? FIREWORKS_API_KEY_ENV_REF,
    harnesses: normalizeHarnessMap(existing.harnesses),
    _exists: Object.keys(existing).length > 0,
  };
}

/**
 * @param {string} home
 * @param {{ apiKey?: string, harnesses?: HarnessConfigMap }} config
 */
export async function writeGlobalConfig(home, config) {
  const filePath = globalConfigPath(home);
  const payload = {
    apiKey: config.apiKey ?? FIREWORKS_API_KEY_ENV_REF,
    harnesses: config.harnesses ?? {},
  };
  const hasLiteralKey = payload.apiKey && payload.apiKey !== FIREWORKS_API_KEY_ENV_REF;
  await writeJson(filePath, payload, { mode: hasLiteralKey ? 0o600 : undefined });
  return payload;
}

/**
 * @param {string} home
 * @param {string} harnessId
 * @param {boolean} enabled
 */
export async function setHarnessEnabled(home, harnessId, enabled) {
  const config = await readGlobalConfig(home);
  const harnesses = {
    ...config.harnesses,
    [harnessId]: { enabled },
  };
  await writeGlobalConfig(home, {
    apiKey: config.apiKey,
    harnesses,
  });
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
 * Harnesses to disable during uninstall — all registered harnesses, regardless
 * of enabled state, so uninstall fully restores configs even for harnesses that
 * were manually turned off before uninstalling.
 * @param {string} home
 */
export async function discoverHarnessesForUninstall(home) {
  const config = await readGlobalConfig(home);
  return listRegisteredHarnesses(config.harnesses);
}
