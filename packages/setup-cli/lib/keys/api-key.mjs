import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  FIREWORKS_API_KEY_ENV_REF,
  FIREWORKS_API_KEY_KEYCHAIN_REF,
  readGlobalConfig,
  writeGlobalConfig,
} from "../config/global-config.mjs";
import { detectSecretBackend, getSecret, hasSecret, setSecret } from "./secret-store.mjs";
import { plaintextSecretStoreAvailable } from "./plaintext-secret-store.mjs";
import { isKeyStorageForcedNull } from "./storage-env.mjs";
import { cannotStoreKeyMessage, keyStorageSummaryLine } from "./storage-report.mjs";
import { syncBakedKeysAfterStore } from "./sync.mjs";
import { FIREPASS_KEY_UNSUPPORTED_MESSAGE, isFirePassKey, isFireworksShapedKey } from "./key-type.mjs";
import { clearMintedKeyState } from "./mint-api-key.mjs";
import { expireCatalogCache } from "../fireworks/serverless-catalog-cache.mjs";
import { refreshServerlessCatalogCache } from "../fireworks/models.mjs";
import { readSecret } from "../ui/read-secret.mjs";
import { link } from "../ui/term.mjs";
import { printInfo, printNote } from "../cli/messages.mjs";
import { withSpinner } from "../ui/spinner.mjs";
import { verifyFireworksApiKey } from "./verify-api-key.mjs";
import {
  isEnvConfigRef,
  isKeychainConfigRef,
  isLegacyLiteralConfigRef,
  migrateLegacyGlobalApiKey,
} from "./config-ref.mjs";

export {
  isEnvConfigRef,
  isKeychainConfigRef,
  isLegacyLiteralConfigRef,
} from "./config-ref.mjs";

/** Where Fireworks Platform users create API keys, and the default when the account kind isn't known. */
export const FIREWORKS_KEYS_URL = "https://app.fireworks.ai/settings/users/api-keys";
/** The same page on the Nexus site, for Nexus accounts. */
export const NEXUS_KEYS_URL = "https://nexus.fireworks.ai/settings/api-keys";

/**
 * The API-keys page for an account: Nexus accounts manage keys on the Nexus
 * site, everyone else (and an unknown account) on the Platform.
 * @param {boolean} nexusAccount
 */
export function keysUrlFor(nexusAccount) {
  return nexusAccount === true ? NEXUS_KEYS_URL : FIREWORKS_KEYS_URL;
}

/**
 * The API-keys page for whoever last signed in on this machine. Reads the
 * account kind browser sign-in saved; never throws (Platform on any error).
 * @param {string} home
 */
export async function keysUrlForHome(home) {
  try {
    return keysUrlFor((await readGlobalConfig(home)).nexusAccount);
  } catch {
    return FIREWORKS_KEYS_URL;
  }
}

/**
 * One-line recovery copy for a failed key verification, shared by every
 * key-entry path so `login` and `<harness> on` phrase the same failure the same
 * way.
 * @param {import("./verify-api-key.mjs").VerifyResult} result
 * @param {{ interactive?: boolean, keysUrl?: string }} [options]
 */
export function verifyFailureLine(result, { interactive = false, keysUrl = FIREWORKS_KEYS_URL } = {}) {
  if (result.reason === "rejected") {
    return interactive
      ? `That key didn't work. Check it at ${link(keysUrl)} or paste another.`
      : `That key didn't work. Check it at ${keysUrl}`;
  }
  if (result.reason === "network") {
    return `Couldn't reach the Fireworks API (${result.detail}). Check your connection and try again.`;
  }
  return `The Fireworks API returned an unexpected response (${result.status}). Try again in a moment.`;
}

export function assertFireworksKeyShape(key) {
  const trimmed = key?.trim() ?? "";
  if (isFirePassKey(trimmed)) {
    throw new Error(FIREPASS_KEY_UNSUPPORTED_MESSAGE);
  }
  if (!isFireworksShapedKey(trimmed)) {
    throw new Error(
      `That doesn't look like a Fireworks key (expected it to start with fw_). Get one at ${FIREWORKS_KEYS_URL}`,
    );
  }
  return trimmed;
}

/**
 * Shape-check then strict-verify a Fireworks key before it is stored or baked
 * into a harness config, throwing a friendly one-line error on failure. Shared
 * by `login --api-key`/`--with-token` so non-interactive sign-ins validate
 * identically (a typo or dead key fails fast with a clear message instead of
 * a 401 surfacing later inside the tool). Returns the VerifyResult
 * on success so callers can print the resolved identity.
 * @param {string} key
 * @returns {Promise<import("./verify-api-key.mjs").VerifyResult>}
 */
export async function assertFireworksKeyUsable(key) {
  const trimmed = assertFireworksKeyShape(key);
  const result = await verifyFireworksApiKey(trimmed);
  if (!result.ok) {
    throw new Error(verifyFailureLine(result));
  }
  return result;
}

const ON_KEY_VERIFY_TIMEOUT_MS = 5000;

/**
 * Stop `<harness> on` before it bakes an env or saved key that the gateway
 * rejects (deleted or revoked) into a harness config, where it would only
 * surface later as a 401 inside the tool. Only a definitive 401/403 stops the
 * command; offline or an unexpected status keeps `on` working without network.
 * @param {string} key
 * @param {{ harnessId?: string }} [options]
 */
export async function assertResolvedKeyNotRejected(key, { harnessId = "" } = {}) {
  const result = await verifyFireworksApiKey(key, { timeoutMs: ON_KEY_VERIFY_TIMEOUT_MS });
  if (result.reason !== "rejected") {
    return;
  }
  const rerun = harnessId ? `nexus ${harnessId} on` : "nexus login";
  throw new Error(
    "The Fireworks API rejected your saved Fireworks key (it may have been deleted or revoked). "
      + `Run \`nexus login\` to sign in with a new key, then run: ${rerun}`,
  );
}

/**
 * Static description of where each harness reads its Fireworks key from at
 * runtime. Entries WITHOUT a `storage` field are keychain-backed (their
 * storage is filled in dynamically from the detected backend); entries WITH a
 * `storage` field use the IDE's own Electron safeStorage. FireRouter is just a
 * model on each harness's normal provider, so it reads the key from the same
 * place as any other model.
 */
const HARNESS_KEY_SOURCE = {
  claude: {
    readsFrom: "X-Fireworks-Api-Key header in settings.json",
  },
  "claude-desktop": {
    readsFrom: "the stored key, via the Nexus loopback shim",
  },
  codex: {
    readsFrom: "experimental_bearer_token in config.toml",
  },
  opencode: {
    readsFrom: "literal apiKey in opencode.json",
  },
  pi: {
    readsFrom: "literal key in auth.json",
  },
  deepseek: {
    readsFrom: "FIREWORKS_API_KEY in ~/.dsh/.credentials.yaml",
  },
  vscode: {
    readsFrom: "VS Code safeStorage (state.vscdb)",
    storage: "IDE Electron safeStorage (encrypted)",
  },
  cursor: {
    readsFrom: "Cursor SQLite / safeStorage",
    storage: "Cursor Electron safeStorage (secret://, encrypted; legacy plaintext fallback)",
  },
  "copilot-app": {
    readsFrom: "Authorization header on the BYOK provider row",
    storage: "Copilot data.db (owner-only)",
  },
  "copilot-cli": {
    readsFrom: "apiKey in the BYOK provider entry",
    storage: "~/.copilot/providers.json (owner-only)",
  },
};

/**
 * Short label for where a harness reads its Fireworks key at runtime.
 * @param {string} harnessId
 */
export function harnessKeySourceLabel(harnessId) {
  return HARNESS_KEY_SOURCE[harnessId]?.readsFrom ?? "";
}

/**
 * Key-source label for per-harness status when the harness is routed through
 * Fireworks (or, for IDE harnesses, any non-none provider).
 * @param {string} harnessId
 * @param {string} provider
 * @param {{ whenFireworks?: boolean, authMode?: string }} [options]
 */
export function harnessStatusKeySource(harnessId, provider, { whenFireworks = true, authMode } = {}) {
  const routed = whenFireworks
    ? provider === "fireworks"
    : provider !== "none";
  if (!routed) {
    return "";
  }
  if (harnessId === "claude" && authMode === "apiKeyHelper") {
    return "nexus key export hook";
  }
  return harnessKeySourceLabel(harnessId);
}

/**
 * @param {string} stored
 */
export function shouldInstallShellEnvHook(stored) {
  return isKeychainConfigRef(stored);
}

/**
 * Refetch the model catalog cache for `apiKey`'s account (bounded, never
 * throws). The cache lives under the process HOME, so a `home` that isn't
 * it (an in-process caller pointing elsewhere) is left alone.
 * @param {string} home
 * @param {string} apiKey
 */
export async function refreshCatalogCacheForHome(home, apiKey) {
  if (path.resolve(home) !== path.resolve(process.env.HOME ?? os.homedir())) {
    return false;
  }
  return await refreshServerlessCatalogCache(apiKey);
}

/**
 * @param {string} home
 * @param {string} apiKey
 * @param {{ backend?: import("./secret-store.mjs").SecretBackend, accountType?: "nexus"|"platform"|"unknown", onNote?: (line: string) => void }} [options]
 *   `onNote` receives baked-key sync notes (default: console.log) — callers
 *   that compose their own success block collect them instead.
 */
export async function persistApiKeyToKeychain(home, apiKey, options = {}) {
  // Refuse early with a friendly, actionable error when no backend can store a
  // key (e.g. HOME unset on headless Linux). `setSecret` readback-verifies the
  // write below; this guard just gives a clearer message before the attempt.
  const backend = options.backend ?? await detectSecretBackend(home);
  if (backend.backend === "unavailable" && (isKeyStorageForcedNull() || !plaintextSecretStoreAvailable(home))) {
    throw new Error(cannotStoreKeyMessage(backend.error));
  }
  const trimmed = apiKey?.trim() ?? "";
  // Idempotent: if the store already holds this key (e.g. login just stored
  // it), skip the write+readback to avoid a duplicate keychain round-trip.
  const existing = await getSecret(home);
  const keyChanged = !existing || existing.trim() !== trimmed;
  if (keyChanged) {
    await setSecret(trimmed, home);
    // The model catalog belongs to the account the old key signed in to:
    // refetch it for the new one, so the next harness `on` lists its models.
    expireCatalogCache(home);
    await refreshCatalogCacheForHome(home, trimmed);
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
    // Keep the reference and its account metadata in the same config write.
    // Unknown replacements cannot inherit the previous credential's kind;
    // ordinary idempotent config repair preserves known metadata.
    ...(options.accountType !== undefined || keyChanged
      ? { nexusAccount: options.accountType === "nexus" } : {}),
    harnesses: config.harnesses,
  });
  // Re-point router configs that bake the key as a literal — AFTER the store
  // succeeds, so no config ever points at a key that failed to persist. Runs
  // even when the stored key didn't change: the baked copies can be stale
  // independently of the keychain (that staleness is the 401 this exists to
  // fix), and the sync is a cheap no-op when everything already matches.
  const onNote = options.onNote ?? ((line) => console.log(line));
  for (const note of await syncBakedKeysAfterStore(home, trimmed)) {
    onNote(note);
  }
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
  // A stored {env:FIREWORKS_API_KEY} ref is dead — env is not a credential
  // source anymore; fall through to the keychain so a secret sitting beside
  // the legacy ref still resolves (upgrade reconciliation will rewrite the
  // ref on the next migration pass).
  if (isEnvConfigRef(stored)) {
    return tryReadKeychainSecret(home);
  }
  if (isKeychainConfigRef(stored)) {
    return tryReadKeychainSecret(home);
  }
  if (isLegacyLiteralConfigRef(stored) && isFireworksShapedKey(stored)) {
    return stored.trim();
  }
  return "";
}

/**
 * @typedef {"flag" | "env" | "stored" | "none"} FireworksKeySource
 * @typedef {{ key: string, source: FireworksKeySource }} FireworksKeyResolution
 */

/**
 * THE single precedence definition for the active Fireworks key, so every
 * caller resolves it the same way and can report which source won:
 *   1. an explicit `--api-key` flag,
 *   2. the stored credential (keychain / encrypted file / plaintext, via the
 *      `config.json` ref).
 * `FIREWORKS_API_KEY` is deliberately not a source — `nexus login` is the
 * only key entry, and env-injected keys are ignored.
 * `resolveFireworksApiKeyValue` returns just the value; callers that need to
 * tell the user which key is in effect use `.source` here.
 * @param {{ apiKey?: string, home?: string }} args
 * @returns {Promise<FireworksKeyResolution>}
 */
export async function resolveFireworksKeyWithSource({
  apiKey = "",
  home = process.env.HOME ?? "",
}) {
  const flagKey = apiKey?.trim() ?? "";
  let config = null;
  if (home) {
    const migration = await migrateLegacyGlobalApiKey(home);
    config = { apiKey: migration.apiKey };
  }

  if (flagKey) {
    return { key: flagKey, source: "flag" };
  }

  if (config) {
    const resolved = await resolveStoredApiKeyValue(config.apiKey, home);
    if (resolved) {
      return { key: resolved, source: "stored" };
    }
  }

  return { key: "", source: "none" };
}

/**
 * Whether `resolveFireworksKeyWithSource` would find a key, answered without
 * reading the stored one: the keychain is only asked whether the item exists
 * (see `hasSecret`), so status-style callers that report presence don't cost
 * the user a keychain prompt. Same precedence and config refs as the resolver;
 * it doesn't migrate a legacy literal (the next real resolve does).
 * @param {{ apiKey?: string, home?: string }} args
 * @returns {Promise<boolean>}
 */
export async function fireworksKeyPresent({
  apiKey = "",
  home = process.env.HOME ?? "",
}) {
  if (apiKey?.trim()) {
    return true;
  }
  if (!home) {
    return false;
  }
  const stored = (await readGlobalConfig(home)).apiKey;
  if (isKeychainConfigRef(stored)) {
    return hasSecret(home);
  }
  if (isEnvConfigRef(stored)) {
    // A dead env-ref resolves through the keychain (see
    // resolveStoredApiKeyValue); presence checks the same secret.
    return hasSecret(home);
  }
  return isLegacyLiteralConfigRef(stored) && isFireworksShapedKey(stored);
}

/**
 * @param {{ apiKey?: string, home?: string }} args
 */
export async function resolveFireworksApiKeyValue({
  apiKey = "",
  home = process.env.HOME ?? "",
}) {
  return (await resolveFireworksKeyWithSource({ apiKey, home })).key;
}

/**
 * Interactive last resort for `<harness> on`: when no Fireworks key resolves
 * anywhere, ask for one on the TTY instead of failing — the Fireworks
 * counterpart of firerouter-core's Anthropic-key prompt. Persists the entered
 * key to the keychain so the prompt only ever happens once. Returns "" (the
 * caller throws its usual error) on non-interactive stdin, a missing home, or
 * after too many blank/malformed attempts.
 *
 * @param {string} home
 * @param {{ input?: { isTTY?: boolean }, readSecretFn?: typeof readSecret, verifyApiKey?: typeof verifyFireworksApiKey }} [options] test seams
 */
export async function promptForFireworksApiKey(home, options = {}) {
  const input = options.input ?? process.stdin;
  if (!input.isTTY || !home) {
    return "";
  }
  const read = options.readSecretFn ?? readSecret;
  const verify = options.verifyApiKey ?? verifyFireworksApiKey;
  printInfo("No Fireworks API key is stored yet — enter one now to finish setup.");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const entered = await read("Fireworks API key (fw_...): ", { allowEmpty: true });
    if (!entered) {
      printNote("No key entered — try again, or press Ctrl+C to cancel.");
      continue;
    }
    if (isFirePassKey(entered)) {
      printNote(FIREPASS_KEY_UNSUPPORTED_MESSAGE);
      continue;
    }
    if (!isFireworksShapedKey(entered)) {
      printNote("That doesn't look like a Fireworks API key (should start with fw_). Try again.");
      continue;
    }
    const result = await withSpinner("Checking your key…", () => verify(entered));
    if (!result.ok) {
      printNote(verifyFailureLine(result, { interactive: true }));
      continue;
    }
    await persistApiKeyToKeychain(home, entered);
    const { message } = await keyStorageSummaryLine(home);
    console.log(message);
    return entered;
  }
  return "";
}

/**
 * Last-resort keychain read: the stored Fireworks key (trimmed) or "". Shared
 * by `exportFireworksApiKey`, `resolveHarnessOnApiKey`'s fallback, and stored
 * key resolution so the keychain-read logic lives in one place. A leftover
 * Fire Pass key reads as missing, so callers fall through to `login`.
 * @param {string} home
 * @returns {Promise<string>}
 */
export async function tryReadKeychainSecret(home) {
  const secret = (await getSecret(home))?.trim() ?? "";
  return isFirePassKey(secret) ? "" : secret;
}

/**
 * For `nexus key export` and Claude apiKeyHelper.
 * @param {string} [home]
 * @param {{ storedOnly?: boolean }} [opts]
 */
export async function exportFireworksApiKey(home = process.env.HOME ?? "", { storedOnly = false } = {}) {
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

  throw new Error("No Fireworks API key found. Run `nexus login` to sign in.");
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
    // Keychain-backed harnesses are the ones without a static `storage`.
    const storage = src.storage
      ? src.storage
      : keychainPresent
        ? backend.label
        : "(no key stored)";
    perHarness.push({
      id,
      enabled,
      readsFrom: src.readsFrom,
      storage,
    });
  }

  // Don't surface a legacy literal key in `nexus status` output — mask it. Only
  // refs ({env:…}, {keychain:…}) and "(unset)" are reported verbatim; the kind
  // is derivable from configRef by the caller.
  const rawRef = config.apiKey || "";
  const configRef = isKeychainConfigRef(rawRef) || isEnvConfigRef(rawRef)
    ? rawRef
    : rawRef
      ? "(legacy literal — run `nexus login` to move it into secure storage)"
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
