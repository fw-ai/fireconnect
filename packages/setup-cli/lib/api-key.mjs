import process from "node:process";
import {
  FIREWORKS_API_KEY_ENV_REF,
  FIREWORKS_API_KEY_KEYCHAIN_REF,
  harnessModeFromConfig,
  readGlobalConfig,
  writeGlobalConfig,
} from "./global-config.mjs";
import { deleteSecret, detectSecretBackend, getSecret, hasSecret, setSecret } from "./secret-store.mjs";
import { plaintextSecretStoreAvailable } from "./plaintext-secret-store.mjs";
import { isKeyStorageForcedNull } from "./key-storage-env.mjs";
import { isFireworksShapedKey } from "./fireconnect-core.mjs";
import { clearMintedKeyState } from "./mint-api-key.mjs";
import { HARNESS } from "./harness.mjs";
import { chatLanguageModelsPath, fireworksProviderStatus, readChatLanguageModels } from "./vscode-core.mjs";
import { vscodeFirerouterProviderStatus } from "./vscode-firerouter-core.mjs";

/**
 * Static description of where each harness reads its Fireworks key from at
 * runtime. Entries WITHOUT a `storage` field are keychain-backed (their
 * storage is filled in dynamically from the detected backend); entries WITH a
 * `storage` field use the IDE's own Electron safeStorage.
 *
 * `routerReadsFrom` / `routerStorage`, when present, override the above while
 * the harness is in FireRouter (`--router`) mode. VS Code router mode (Layout A)
 * writes the Fireworks key as a PLAINTEXT literal in `chatLanguageModels.json`
 * (VS Code's one secret-storage slot holds the Anthropic key instead), so
 * `fireconnect status` must surface that location for auditing rather than claiming the
 * key is encrypted in safeStorage.
 */
const HARNESS_KEY_SOURCE = {
  claude: { readsFrom: "apiKeyHelper → fireconnect key export" },
  codex: { readsFrom: "{env:FIREWORKS_API_KEY} + shell hook → fireconnect key export" },
  opencode: { readsFrom: "{env:FIREWORKS_API_KEY} + shell hook → fireconnect key export" },
  pi: { readsFrom: "{env:FIREWORKS_API_KEY} + shell hook → fireconnect key export" },
  deepagents: { readsFrom: "{env:FIREWORKS_API_KEY} + shell hook → dcode api_key_env" },
  vscode: {
    readsFrom: "VS Code Electron safeStorage (state.vscdb)",
    storage: "IDE Electron safeStorage (encrypted)",
    routerReadsFrom: "X-FireRouter-Fireworks-Key header in chatLanguageModels.json",
    routerStorage: "chatLanguageModels.json requestHeaders — PLAINTEXT (Anthropic key is the encrypted secret in state.vscdb)",
  },
  cursor: { readsFrom: "Cursor SQLite (cursorAuth/openAIKey cell)", storage: "Cursor SQLite (plaintext cell)" },
};

/**
 * @param {string} stored
 */
export function isKeychainConfigRef(stored) {
  return stored === FIREWORKS_API_KEY_KEYCHAIN_REF;
}

/**
 * @param {string} stored
 */
export function isEnvConfigRef(stored) {
  return stored === FIREWORKS_API_KEY_ENV_REF;
}

/**
 * @param {string} stored
 */
export function isLegacyLiteralConfigRef(stored) {
  return Boolean(stored) && !isKeychainConfigRef(stored) && !isEnvConfigRef(stored);
}

/**
 * @param {string} stored
 */
export function shouldInstallShellEnvHook(stored) {
  return isKeychainConfigRef(stored);
}

/**
 * Normalize apiKey before writing. Legacy plaintext keys are migrated to the
 * keychain first so the on-disk ref never outruns stored secrets.
 * @param {string} home
 * @param {string} apiKey
 */
export async function apiKeyRefForWrite(home, apiKey) {
  const trimmed = apiKey?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  if (isKeychainConfigRef(trimmed) || isEnvConfigRef(trimmed)) {
    return trimmed;
  }
  if (isLegacyLiteralConfigRef(trimmed) && isFireworksShapedKey(trimmed)) {
    await setSecret(trimmed, home);
    return FIREWORKS_API_KEY_KEYCHAIN_REF;
  }
  return trimmed;
}

/**
 * @param {string} home
 * @param {string} apiKey
 */
export async function persistApiKeyToKeychain(home, apiKey, options = {}) {
  // Refuse early with a friendly, actionable error when no backend can store a
  // key (e.g. HOME unset on headless Linux). `setSecret` readback-verifies the
  // write below; this guard just gives a clearer message before the attempt.
  const backend = options.backend ?? await detectSecretBackend(home);
  if (backend.backend === "unavailable" && (isKeyStorageForcedNull() || !plaintextSecretStoreAvailable(home))) {
    throw new Error(
      backend.error
        ? `Cannot store the API key: ${backend.error}`
        : "Cannot store the API key: no secret storage backend is available.",
    );
  }
  const trimmed = apiKey?.trim() ?? "";
  // Idempotent: if the store already holds this key (e.g. runHarnessCommand's
  // persistGlobalApiKey just stored it), skip the write+readback to avoid a
  // duplicate keychain round-trip on every `<harness> on --api-key`.
  const existing = await getSecret(home);
  const keyChanged = !existing || existing.trim() !== trimmed;
  if (keyChanged) {
    await setSecret(trimmed, home);
    // The minted-key record describes the credential the browser flow stored;
    // once a path stores a DIFFERENT key, `logout` must not offer to revoke
    // the old one on its behalf. Only clear on a real change — an idempotent
    // re-store of the same key (config repair, repeated `login --api-key`) must keep
    // the record so a still-held minted key stays revocable. The browser flow
    // re-records its mint right after this call.
    await clearMintedKeyState(home);
  }
  const config = await readGlobalConfig(home);
  await writeGlobalConfig(home, {
    apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF,
    harnesses: config.harnesses,
  });
}

/**
 * @param {string} home
 * @param {string} apiKey
 * @param {{ backend?: import("./secret-store.mjs").SecretBackend }} [options]
 */
export async function persistApiKeyFromFlag(home, apiKey, options = {}) {
  if (!apiKey?.trim()) {
    return;
  }
  await persistApiKeyToKeychain(home, apiKey.trim(), options);
}

/**
 * Resolve stored config ref to a key value.
 * @param {string} stored
 */
export async function resolveStoredApiKeyValue(stored, home) {
  if (!stored) {
    return "";
  }
  if (isEnvConfigRef(stored)) {
    return process.env.FIREWORKS_API_KEY?.trim() ?? "";
  }
  if (isKeychainConfigRef(stored)) {
    return (await getSecret(home))?.trim() ?? "";
  }
  if (isLegacyLiteralConfigRef(stored) && isFireworksShapedKey(stored)) {
    return stored.trim();
  }
  return "";
}

/**
 * @param {{ apiKey?: string, home?: string }} args
 */
export async function resolveFireworksApiKeyValue({
  apiKey = "",
  home = process.env.HOME ?? "",
}) {
  if (apiKey?.trim()) {
    return apiKey.trim();
  }

  if (process.env.FIREWORKS_API_KEY?.trim()) {
    return process.env.FIREWORKS_API_KEY.trim();
  }

  if (home) {
    const config = await readGlobalConfig(home);
    const resolved = await resolveStoredApiKeyValue(config.apiKey, home);
    if (resolved) {
      return resolved;
    }
  }

  return "";
}

/**
 * Last-resort keychain read: the stored Fireworks key (trimmed) or "". Shared
 * by `exportFireworksApiKey` and `resolveHarnessOnApiKey`'s fallback so the
 * keychain-read logic lives in one place.
 * @param {string} home
 * @returns {Promise<string>}
 */
export async function tryReadKeychainSecret(home) {
  return (await getSecret(home))?.trim() ?? "";
}

/**
 * For `fireconnect key export` and Claude apiKeyHelper.
 * @param {string} [home]
 * @param {{ storedOnly?: boolean }} [opts]
 */
export async function exportFireworksApiKey(home = process.env.HOME ?? "", { storedOnly = false } = {}) {
  if (!storedOnly && process.env.FIREWORKS_API_KEY?.trim()) {
    return process.env.FIREWORKS_API_KEY.trim();
  }

  const fromKeychain = await tryReadKeychainSecret(home);
  if (fromKeychain) {
    return fromKeychain;
  }

  if (home) {
    const config = await readGlobalConfig(home);
    if (isLegacyLiteralConfigRef(config.apiKey) && isFireworksShapedKey(config.apiKey)) {
      return config.apiKey.trim();
    }
  }

  throw new Error("No Fireworks API key found. Run `fireconnect login` to sign in.");
}

/**
 * Whether a harness is in FireRouter mode for `fireconnect status`. VS Code trusts
 * chatLanguageModels.json when a fireconnect provider is present so config/disk
 * divergence (e.g. `setHarnessEnabled` did not run) reflects the last `on`.
 * @param {import("./global-config.mjs").GlobalConfig} config
 * @param {string} home
 * @param {string} harnessId
 */
async function harnessRouterModeForKeyStatus(config, home, harnessId) {
  if (harnessId === HARNESS.VSCODE) {
    const arr = await readChatLanguageModels(chatLanguageModelsPath({ home }));
    if (vscodeFirerouterProviderStatus(arr) === "firerouter") {
      return true;
    }
    if (fireworksProviderStatus(arr) !== "none") {
      return false;
    }
  }
  return harnessModeFromConfig(config, harnessId) === "router";
}

/**
 * @param {string} home
 */
export async function keyStatusSummary(home) {
  const config = await readGlobalConfig(home);
  const keychainPresent = await hasSecret(home);
  const backend = await detectSecretBackend(home);

  /** @type {Array<{ id: string, enabled: boolean, readsFrom: string, storage: string }>} */
  const perHarness = [];
  for (const [id, src] of Object.entries(HARNESS_KEY_SOURCE)) {
    const enabled = config.harnesses[id]?.enabled === true;
    const routerMode = await harnessRouterModeForKeyStatus(config, home, id);
    const readsFrom = routerMode && src.routerReadsFrom ? src.routerReadsFrom : src.readsFrom;
    const staticStorage = routerMode && src.routerStorage ? src.routerStorage : src.storage;
    // Keychain-backed harnesses are the ones without a (static or router) `storage`.
    const storage = staticStorage
      ? staticStorage
      : keychainPresent
        ? backend.label
        : "(no key stored)";
    perHarness.push({ id, enabled, readsFrom, storage });
  }

  // Don't surface a legacy literal key in `fireconnect status` output — mask it. Only
  // refs ({env:…}, {keychain:…}) and "(unset)" are reported verbatim; the kind
  // is derivable from configRef by the caller.
  const rawRef = config.apiKey || "";
  const configRef = isKeychainConfigRef(rawRef) || isEnvConfigRef(rawRef)
    ? rawRef
    : rawRef
      ? "(legacy literal — run `fireconnect upgrade` to move it into secure storage)"
      : "(unset)";

  return {
    configRef,
    keychainPresent,
    envPresent: Boolean(process.env.FIREWORKS_API_KEY?.trim()),
    backend: backend.backend,
    backendLabel: backend.label,
    location: backend.location ?? null,
    backendError: backend.error ?? null,
    perHarness,
  };
}

/**
 * @param {string} home
 */
export async function deleteStoredApiKey(home) {
  await deleteSecret(home);
  const config = await readGlobalConfig(home);
  if (isKeychainConfigRef(config.apiKey)) {
    await writeGlobalConfig(home, {
      apiKey: "",
      harnesses: config.harnesses,
    });
  }
}
