import {
  FIREWORKS_API_KEY_ENV_REF,
  FIREWORKS_API_KEY_KEYCHAIN_REF,
  readGlobalConfig,
  writeGlobalConfig,
} from "../config/global-config.mjs";
import { getSecret, setSecret } from "./secret-store.mjs";
import { isFireworksShapedKey } from "./key-type.mjs";

export function isKeychainConfigRef(stored) {
  return stored === FIREWORKS_API_KEY_KEYCHAIN_REF;
}

export function isEnvConfigRef(stored) {
  return stored === FIREWORKS_API_KEY_ENV_REF;
}

export function isLegacyLiteralConfigRef(stored) {
  return Boolean(stored)
    && !isKeychainConfigRef(stored)
    && !isEnvConfigRef(stored);
}

export async function ensureKeychainSecret(key, home) {
  if (!key) {
    return true;
  }
  const existing = await getSecret(home);
  if (existing && existing.trim() !== key.trim()) {
    return false;
  }
  if (!existing) {
    await setSecret(key, home);
  }
  return true;
}

export async function migrateLegacyGlobalApiKey(home) {
  const config = await readGlobalConfig(home);
  if (
    !isLegacyLiteralConfigRef(config.apiKey)
    || !isFireworksShapedKey(config.apiKey)
  ) {
    return { status: "unchanged", apiKey: config.apiKey };
  }

  if (!await ensureKeychainSecret(config.apiKey, home)) {
    return { status: "conflict", apiKey: config.apiKey };
  }
  await writeGlobalConfig(home, {
    apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF,
  });
  return {
    status: "migrated",
    apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF,
  };
}
