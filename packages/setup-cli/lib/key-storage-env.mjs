/** Force key storage mode: `file`, `keychain`, or `null`. */
export const FIRECONNECT_KEY_STORAGE_ENV = "FIRECONNECT_KEY_STORAGE";

/** @deprecated Renamed to {@link FIRECONNECT_KEY_STORAGE_ENV}. Still read for compatibility. */
export const LEGACY_FIRECONNECT_KEY_STORAGE_ENV = "FIRECONNECT_SECRET_BACKEND";

/**
 * @returns {string}
 */
export function readKeyStorageOverride() {
  return process.env[FIRECONNECT_KEY_STORAGE_ENV]?.trim()
    || process.env[LEGACY_FIRECONNECT_KEY_STORAGE_ENV]?.trim()
    || "";
}

/**
 * @returns {boolean}
 */
export function isKeyStorageForcedNull() {
  return readKeyStorageOverride() === "null";
}

/**
 * @param {string} value
 * @returns {string}
 */
export function formatKeyStorageOverrideHint(value) {
  return `FIRECONNECT_KEY_STORAGE=${value}`;
}
