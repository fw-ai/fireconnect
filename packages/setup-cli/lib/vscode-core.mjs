import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GLM_LATEST_ROUTER_ID,
  detectApiKeyType,
  isFireworksShapedKey,
  normalizeModelId,
  readJsonIfExists,
  writeJson,
} from "./fireconnect-core.mjs";
import { lookupVscodeModelMetadata } from "./fireworks-model-specs.mjs";
import { FIREPASS_ROUTER_ID, prettyModelName } from "./fireworks-models.mjs";
import { assertIdeStopped, isIdeRunning } from "./ide-running.mjs";
import { detectVscodeInstall } from "./vscode-install.mjs";
import {
  decryptSecret,
  encryptSecret,
  isSecretEncryptionAvailable,
  secretEncryptionUnavailableMessage,
} from "./vscode-safestorage.mjs";
import {
  applyItemTableWrites,
  ensureItemTable,
  readItemTableValue,
  writeItemTableValue,
} from "./vscdb-sqlite.mjs";

/**
 * VS Code Chat's custom language models live in `chatLanguageModels.json` (a
 * JSON array of providers). fireconnect adds a "Fireworks" provider whose
 * `apiKey` is a `${input:chat.lm.secret.<id>}` reference.
 *
 * The real key is NOT a per-secret OS keychain entry: VS Code's
 * `LanguageModelsService` resolves the reference via
 * `ISecretStorageService.get(<id>)`, which reads an Electron `safeStorage`-
 * encrypted blob from the application-scoped `state.vscdb` (`ItemTable`, key
 * `secret://<id>`). The harness therefore writes the key there — encrypted via
 * `vscode-safestorage.mjs` — so VS Code can actually decrypt and use it.
 *
 * - Provider entry -> array element `{ name, vendor:"customendpoint",
 *   apiType:"chat-completions", apiKey:"${input:<secretId>}", models[] }`.
 * - Model          -> `{ id, name, url, toolCalling, vision,
 *   maxInputTokens, maxOutputTokens }`. VS Code's `resolveCustomEndpointUrl`
 *   appends `/v1/chat/completions` to `url` when no version segment is present,
 *   so `https://api.fireworks.ai/inference` resolves correctly.
 * - Secret         -> `state.vscdb` `ItemTable` row, key `secret://<secretId>`,
 *   value = `JSON.stringify(safeStorage.encryptString(key))`.
 *
 * Ownership: fireconnect-generated secret ids use the prefix
 * `chat.lm.secret.fw-`. A provider is fireconnect-owned iff its `apiKey`
 * references a `fw-` secret. This keeps `off` from touching a user's
 * manually-configured "Fireworks" entry (which uses a VS Code-generated id).
 */

/** Storage-key prefix VS Code's secret storage uses inside `state.vscdb`. */
const SECRET_STORAGE_PREFIX = "secret://";

export const VSCODE_FIREWORKS_MODEL_URL = "https://api.fireworks.ai/inference";
/** Provider display name fireconnect writes. */
export const FIRECONNECT_PROVIDER_NAME = "Fireworks";
/** Secret id prefix that marks a provider as fireconnect-owned. */
export const FIRECONNECT_SECRET_PREFIX = "chat.lm.secret.fw-";

/* -------------------------------------------------------------------------- */
/* Path resolution                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the path to VS Code's chatLanguageModels.json for the current platform.
 * @param {{ home?: string, vscodePath?: string }} opts
 * @returns {string}
 */
export function chatLanguageModelsPath({ home = "", vscodePath = "" } = {}) {
  if (vscodePath) {
    return path.resolve(vscodePath);
  }
  // Use the same install detection as the keychain service so the JSON path
  // and the keychain service always target the same variant (stable vs
  // Insiders). Falls back to the stable "Code" folder when no install is found.
  const folder = detectVscodeInstall()?.folder || "Code";
  const baseHome = home || process.env.HOME || "";
  const platform = os.platform();
  if (platform === "darwin") {
    return path.join(baseHome, "Library", "Application Support", folder, "User", "chatLanguageModels.json");
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(baseHome, "AppData", "Roaming");
    return path.join(appData, folder, "User", "chatLanguageModels.json");
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(baseHome, ".config");
  return path.join(configHome, folder, "User", "chatLanguageModels.json");
}

/**
 * Resolve the path to VS Code's application-scoped `state.vscdb` — the same
 * `User` dir as `chatLanguageModels.json` plus `globalStorage/state.vscdb`.
 * This is where VS Code's `ISecretStorageService` persists encrypted secrets.
 * @param {{ home?: string, vscodePath?: string }} opts
 * @returns {string}
 */
export function vscodeStateDbPath({ home = "", vscodePath = "" } = {}) {
  const jsonPath = chatLanguageModelsPath({ home, vscodePath });
  return path.join(path.dirname(jsonPath), "globalStorage", "state.vscdb");
}

/** @param {string} secretId @returns {string} the `secret://<id>` ItemTable key */
function secretStorageKey(secretId) {
  return `${SECRET_STORAGE_PREFIX}${secretId}`;
}

/* -------------------------------------------------------------------------- */
/* JSON I/O                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Parse raw chatLanguageModels.json text into the array shape callers expect:
 * non-arrays coerce to `[]`; a `SyntaxError` becomes a clear "not valid JSON"
 * message naming the file. Single source of truth for the parse/coercion rules.
 * @param {string} raw
 * @param {string} filePath  for error messages
 * @returns {object[]}
 */
function parseChatLanguageModelsRaw(raw, filePath) {
  try {
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${filePath} is not valid JSON`);
    }
    throw error;
  }
}

/**
 * Read the chatLanguageModels.json array. Returns `[]` when missing or empty.
 * @param {string} filePath
 * @returns {Promise<object[]>}
 */
export async function readChatLanguageModels(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return [];
  }
  const raw = await readFile(filePath, "utf8");
  return parseChatLanguageModelsRaw(raw, filePath);
}

/**
 * Write the array with VS Code's tab indentation (minimal diff).
 * @param {string} filePath
 * @param {object[]} arr
 * @returns {Promise<void>}
 */
export async function writeChatLanguageModels(filePath, arr) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(arr, null, "\t")}\n`, "utf8");
}

/** Read the raw file text for byte-for-byte snapshot/restore. */
async function readRawIfExists(filePath) {
  try {
    return { existed: true, raw: await readFile(filePath, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { existed: false, raw: "" };
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Ownership + secret id                                                       */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} apiKeyField the provider's `apiKey` value
 * @returns {string | null} the secret id if fireconnect-owned, else null
 */
export function fireconnectSecretId(apiKeyField) {
  if (typeof apiKeyField !== "string") {
    return null;
  }
  // apiKey is `${input:<secretId>}`; extract the secret id.
  const match = apiKeyField.match(/^\$\{input:(.+)\}$/);
  if (!match) {
    return null;
  }
  const secretId = match[1];
  return secretId.startsWith(FIRECONNECT_SECRET_PREFIX) ? secretId : null;
}

/** @returns {string} a fresh fireconnect-owned secret id */
export function makeFireconnectSecretId() {
  return `${FIRECONNECT_SECRET_PREFIX}${randomBytes(8).toString("hex")}`;
}

/**
 * @param {object} provider
 * @returns {boolean} whether the provider entry was created by fireconnect
 */
export function isFireconnectProvider(provider) {
  return fireconnectSecretId(provider?.apiKey) !== null;
}

/**
 * Find the fireconnect-owned provider entry, if any.
 * @param {object[]} arr
 * @returns {object | undefined}
 */
export function findFireconnectProvider(arr) {
  return (arr ?? []).find((p) => isFireconnectProvider(p));
}

/**
 * All fireconnect-owned secret ids referenced in the array (for `off` cleanup).
 * @param {object[]} arr
 * @returns {string[]}
 */
export function fireconnectSecretIds(arr) {
  return (arr ?? [])
    .map((p) => fireconnectSecretId(p?.apiKey))
    .filter(Boolean);
}

/**
 * @param {object[]} arr
 * @returns {"fireworks" | "none"}
 */
export function fireworksProviderStatus(arr) {
  return findFireconnectProvider(arr) ? "fireworks" : "none";
}

/** @param {object[]} arr @returns {string[]} model ids fireconnect registered */
export function fireconnectRegisteredModels(arr) {
  const provider = findFireconnectProvider(arr);
  return (provider?.models ?? []).map((m) => m.id);
}

/* -------------------------------------------------------------------------- */
/* Pure transforms (no I/O — unit-testable)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a model object for a Fireworks model id.
 * @param {string} modelId normalized Fireworks model id
 * @returns {object}
 */
export function buildModelEntry(modelId) {
  return {
    id: modelId,
    name: prettyModelName(modelId),
    url: VSCODE_FIREWORKS_MODEL_URL,
    ...lookupVscodeModelMetadata(modelId),
  };
}

/**
 * Add (or update) the fireconnect-owned Fireworks provider with the given
 * models. Replaces an existing fireconnect provider's models; leaves other
 * providers alone.
 * @param {object[]} arr
 * @param {{ secretId: string, models: object[] }} opts
 * @returns {object[]} new array
 */
export function addFireworksProvider(arr, { secretId, models }) {
  const next = [...(arr ?? [])];
  const idx = next.findIndex(isFireconnectProvider);
  const provider = {
    name: FIRECONNECT_PROVIDER_NAME,
    vendor: "customendpoint",
    apiType: "chat-completions",
    apiKey: `\${input:${secretId}}`,
    models: dedupeModels(models),
  };
  if (idx >= 0) {
    next[idx] = provider;
  } else {
    next.push(provider);
  }
  return next;
}

/**
 * Remove the fireconnect-owned provider entry. Other providers are untouched.
 * @param {object[]} arr
 * @returns {object[]} new array
 */
export function removeFireconnectProvider(arr) {
  return (arr ?? []).filter((p) => !isFireconnectProvider(p));
}

/**
 * Append a model to the fireconnect provider's `models[]` (dedupe by id).
 * No-op if no fireconnect provider exists.
 * @param {object[]} arr
 * @param {object} model
 * @returns {object[]} new array
 */
export function addProviderModel(arr, model) {
  const next = (arr ?? []).map((p) => ({ ...p, models: p.models ? [...p.models] : p.models }));
  const provider = next.find(isFireconnectProvider);
  if (!provider) {
    return arr ?? [];
  }
  provider.models = dedupeModels([...(provider.models ?? []), model]);
  return next;
}

/**
 * Reset the fireconnect provider's `models[]` to `[model]`.
 * No-op if no fireconnect provider exists.
 * @param {object[]} arr
 * @param {object} model
 * @returns {object[]} new array
 */
export function resetProviderModels(arr, model) {
  const next = (arr ?? []).map((p) => ({ ...p, models: p.models ? [...p.models] : p.models }));
  const provider = next.find(isFireconnectProvider);
  if (!provider) {
    return arr ?? [];
  }
  provider.models = [model];
  return next;
}

/* -------------------------------------------------------------------------- */
/* Model resolution                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Default model id fireconnect registers for VS Code. Fire Pass keys are
 * restricted to the glm-latest router; regular keys also default to it.
 * @param {"fireworks" | "firepass"} keyType
 * @returns {string}
 */
export function defaultModelIdFor(keyType) {
  return keyType === "firepass" ? FIREPASS_ROUTER_ID : GLM_LATEST_ROUTER_ID;
}

/**
 * Resolve a user-supplied model id (`--main`). Fire Pass keys are restricted
 * to the glm-latest router; otherwise the id is normalized.
 * @param {string | undefined} modelId
 * @param {"fireworks" | "firepass"} keyType
 * @returns {string}
 */
function resolveVscodeModelId(modelId, keyType) {
  if (keyType === "firepass") {
    return FIREPASS_ROUTER_ID;
  }
  return normalizeModelId(modelId || defaultModelIdFor(keyType));
}

/* -------------------------------------------------------------------------- */
/* Running-VS-Code guards.                                                     */
/*                                                                            */
/* `on`/`off` write the API key into `state.vscdb`, which a running VS Code     */
/* owns: it loads the DB into memory at startup and rewrites it on exit, so a   */
/* write made while it's open is silently lost (and won't be seen until the     */
/* next launch anyway). Those ops therefore HARD-ERROR when VS Code is running  */
/* (`--force` downgrades to a warning), mirroring the Cursor harness.           */
/*                                                                            */
/* `model add/reset/select` only touch `chatLanguageModels.json`, which VS Code */
/* hot-reloads via a file watcher — safe while running apart from a rare        */
/* concurrent-edit race, so those WARN only.                                    */
/* -------------------------------------------------------------------------- */

const VSCODE_PROCESS_SPEC = {
  // Match Stable and Insiders. `pgrep -f` matches the full command line, so
  // no `$` anchor (VS Code's cmdline has trailing args like --no-sandbox).
  darwinPattern: "Visual Studio Code( - Insiders)?.app/Contents/MacOS/Electron",
  linuxPattern: "[/]code(-insiders)?",
  windowsImage: "Code( - Insiders)?\\.exe",
};

const VSCODE_RUNNING_MESSAGE =
  "VS Code is running. Quit it first (Cmd-Q / File > Quit) so the API key write to state.vscdb isn't discarded when VS Code exits, then rerun. Or pass --force to write anyway (not recommended).";

const VSCODE_RUNNING_WARNING =
  "VS Code is running. It hot-reloads chatLanguageModels.json so the change applies immediately, but if you edit models in VS Code's UI at the same time the file may be clobbered. Quit VS Code first for maximum safety (or ignore this warning).";

/**
 * @returns {boolean} true if the VS Code GUI process is currently running.
 */
export function isVscodeRunning() {
  return isIdeRunning(VSCODE_PROCESS_SPEC);
}

/**
 * Hard-error if VS Code is running (writes to `state.vscdb` would be lost).
 * `force` downgrades to a stderr warning. Use for `on`/`off`.
 * @param {{ force?: boolean }} [opts]
 */
export function assertVscodeStopped({ force = false } = {}) {
  assertIdeStopped(VSCODE_PROCESS_SPEC, VSCODE_RUNNING_MESSAGE, { force });
}

/**
 * Warn (never throw) if VS Code is running. Use for JSON-only model ops, which
 * VS Code hot-reloads safely — so a running VS Code is never a hard error here,
 * only an informational warning. (Hence no `force` parameter: there is nothing
 * to suppress.)
 */
export function warnIfVscodeRunning() {
  assertIdeStopped(VSCODE_PROCESS_SPEC, VSCODE_RUNNING_WARNING, { force: true });
}

/* -------------------------------------------------------------------------- */
/* Snapshot/restore (mirror cursor-core's backup pattern)                      */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} dataDir
 * @param {string} filePath
 */
export function vscodeBackupPath(dataDir, filePath) {
  const key = createHash("sha256").update(path.resolve(filePath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `vscode-backup.${key}.json`);
}

/** @param {string} dataDir @param {string} filePath @returns {Promise<object>} */
export async function readVscodeBackup(dataDir, filePath) {
  return readJsonIfExists(vscodeBackupPath(dataDir, filePath));
}

/**
 * Persist a pre-Fireconnect snapshot (raw file text + the secret ids fireconnect
 * is about to create, for clean keychain cleanup on `off`). Owner-only perms.
 * @param {string} dataDir
 * @param {string} filePath
 * @param {{ fileExisted: boolean, fileRaw: string, secretIds: string[] }} snapshot
 * @returns {Promise<void>}
 */
export async function writeVscodeBackup(dataDir, filePath, snapshot) {
  const backupPath = vscodeBackupPath(dataDir, filePath);
  await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  await writeJson(backupPath, { filePath: path.resolve(filePath), snapshot });
  await chmod(backupPath, 0o600);
}

/** @param {string} dataDir @param {string} filePath @returns {Promise<void>} */
export async function removeVscodeBackup(dataDir, filePath) {
  try {
    await unlink(vscodeBackupPath(dataDir, filePath));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Enable / disable / reset                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The VS Code variant whose `state.vscdb` we're writing to. The encryption
 * master key is per-variant (Stable reads "Code Safe Storage", Insiders reads
 * "Code - Insiders Safe Storage"), so this MUST match the DB we target.
 *
 * When `--vscode-path` points inside a known user-data dir, infer the variant
 * from the path ("Code - Insiders" vs "Code"). Otherwise fall back to install
 * detection (Stable preferred when both are installed).
 *
 * @param {string} [vscodePath] the resolved chatLanguageModels.json path, if known
 * @returns {"stable" | "insiders"}
 */
function currentVariant(vscodePath) {
  if (vscodePath && /Code - Insiders/i.test(vscodePath)) {
    return "insiders";
  }
  return detectVscodeInstall()?.variant === "insiders" ? "insiders" : "stable";
}

/**
 * Enable Fireworks routing for VS Code Chat: snapshot the pre-Fireconnect file,
 * store the key (Electron `safeStorage`-encrypted) in `state.vscdb` under a
 * fresh `secret://chat.lm.secret.fw-<hex>` row, and add the Fireworks provider
 * entry with the resolved default model.
 *
 * @param {{ vscodePath: string, dataDir: string, apiKey: string, modelId?: string, keyType?: "fireworks" | "firepass", stateDbPath?: string }} opts
 * @returns {Promise<{ model: string, keyType: "fireworks" | "firepass", secretId: string, stateDbPath: string }>}
 */
export async function enableVscodeFireworks({
  vscodePath,
  dataDir,
  apiKey,
  modelId,
  keyType = "fireworks",
  stateDbPath,
}) {
  if (!apiKey) {
    throw new Error("No Fireworks API key found. Pass --api-key or set FIREWORKS_API_KEY.");
  }

  const variant = currentVariant(vscodePath);
  if (!isSecretEncryptionAvailable({ variant })) {
    throw new Error(secretEncryptionUnavailableMessage(variant));
  }

  const resolvedKeyType = keyType === "fireworks" ? detectApiKeyType(apiKey) : keyType;
  const resolvedModel = resolveVscodeModelId(modelId, resolvedKeyType);

  const { existed: fileExisted, raw: fileRaw } = await readRawIfExists(vscodePath);
  // Parse via the shared helper so the snapshot, the in-memory array, and
  // readChatLanguageModels all use identical coercion/error rules.
  const arr = parseChatLanguageModelsRaw(fileRaw, vscodePath);

  const backup = await readVscodeBackup(dataDir, vscodePath);
  const hasBackup = backup.snapshot !== undefined;
  const alreadyManaged = fireworksProviderStatus(arr) !== "none";
  // Only snapshot pre-Fireconnect state; never overwrite an existing backup
  // (so `off` can still restore the true original).
  if (!hasBackup && !alreadyManaged) {
    await writeVscodeBackup(dataDir, vscodePath, { fileExisted, fileRaw, secretIds: [] });
  }

  // If a fireconnect provider already exists, reuse its secret id; otherwise
  // generate one and store the key.
  const existing = findFireconnectProvider(arr);
  const secretId = existing ? fireconnectSecretId(existing.apiKey) : makeFireconnectSecretId();
  const dbPath = stateDbPath || vscodeStateDbPath({ vscodePath });
  // Ensure the ItemTable exists so `on` works against a profile VS Code has
  // never launched (no state.vscdb yet). Idempotent + mkdirs the parent.
  await ensureItemTable(dbPath);
  const encrypted = encryptSecret(apiKey, { variant });
  await writeItemTableValue(dbPath, secretStorageKey(secretId), encrypted);

  // Preserve models added via `model add`/`model select` when re-running `on`
  // (e.g. to rotate a key). With `--main`, ensure that model is present; without
  // `--main`, keep the existing list and only seed the default when it's empty.
  const models = computeVscodeModels(existing, modelId, resolvedModel);

  const next = addFireworksProvider(arr, {
    secretId,
    models,
  });
  await writeChatLanguageModels(vscodePath, next);

  return { model: resolvedModel, keyType: resolvedKeyType, secretId, stateDbPath: dbPath };
}

/**
 * Compute the models list for the fireconnect provider on `on`.
 * @param {object | undefined} existing the current fireconnect provider, if any
 * @param {string | undefined} modelId the `--main` argument (raw)
 * @param {string} resolvedModel the normalized default/`--main` model id
 * @returns {object[]}
 */
function computeVscodeModels(existing, modelId, resolvedModel) {
  const existingModels = existing?.models ?? [];
  if (modelId) {
    const entry = buildModelEntry(resolvedModel);
    return existingModels.some((m) => m.id === entry.id)
      ? existingModels
      : [...existingModels, entry];
  }
  return existingModels.length > 0 ? existingModels : [buildModelEntry(resolvedModel)];
}

/**
 * Disable Fireworks routing for VS Code Chat. If a pre-`on` snapshot exists,
 * restore the file byte-for-byte and delete the fireconnect secrets from
 * `state.vscdb`; otherwise strip only the fireconnect-owned provider + secrets.
 *
 * @param {{ vscodePath: string, dataDir: string, wasEnabled?: boolean, stateDbPath?: string }} opts
 * @returns {Promise<"restored" | "stripped" | "none">}
 */
export async function disableVscodeFireworks({
  vscodePath,
  dataDir,
  wasEnabled = false,
  stateDbPath,
}) {
  const dbPath = stateDbPath || vscodeStateDbPath({ vscodePath });
  const backup = await readVscodeBackup(dataDir, vscodePath);
  const hasBackup = backup.snapshot !== undefined;

  const arr = await readChatLanguageModels(vscodePath);
  const active = fireworksProviderStatus(arr) !== "none";

  if (hasBackup) {
    if (backup.filePath !== undefined && backup.filePath !== path.resolve(vscodePath)) {
      throw new Error(
        `VS Code backup was taken for ${backup.filePath}, not ${vscodePath}; refusing to restore.`,
      );
    }
    const { fileExisted, fileRaw, secretIds } = backup.snapshot;
    // Delete the secrets fireconnect created (snapshot-era + current) BEFORE
    // restoring the JSON. If this fails, abort with the file untouched so the
    // provider + secret stay consistent and the user can retry `off` (the
    // JSON restore and backup removal only run once the secrets are gone).
    const ids = new Set([...(secretIds ?? []), ...fireconnectSecretIds(arr)]);
    await deleteSecrets(dbPath, [...ids]);
    if (fileExisted) {
      await mkdir(path.dirname(vscodePath), { recursive: true });
      await writeFile(vscodePath, fileRaw, "utf8");
    } else {
      try {
        await unlink(vscodePath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    await removeVscodeBackup(dataDir, vscodePath);
    return "restored";
  }

  if (!wasEnabled && !active) {
    return "none";
  }

  // No backup: strip only what fireconnect owns. If the user configured a
  // Fireworks provider manually (no fw- secret), leave it alone.
  const ids = fireconnectSecretIds(arr);
  if (ids.length === 0) {
    return "none";
  }
  // Same ordering: remove the secrets first, then rewrite the JSON. A failure
  // here leaves an orphaned encrypted row (harmless) rather than a provider
  // entry pointing at a deleted secret.
  await deleteSecrets(dbPath, ids);
  const next = removeFireconnectProvider(arr);
  if (next.length === 0) {
    try {
      await unlink(vscodePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  } else {
    await writeChatLanguageModels(vscodePath, next);
  }
  return "stripped";
}

/**
 * Delete the given fireconnect secret ids from `state.vscdb` in one transaction.
 * @param {string} dbPath
 * @param {string[]} secretIds
 * @returns {Promise<void>}
 */
async function deleteSecrets(dbPath, secretIds) {
  if (!secretIds.length || !existsSync(dbPath)) {
    return;
  }
  await applyItemTableWrites(
    dbPath,
    secretIds.map((id) => ({ op: "del", key: secretStorageKey(id) })),
  );
}

/**
 * Reset the fireconnect provider's model list to `[model]`. Requires Fireworks
 * to be enabled (a fireconnect provider must exist).
 *
 * @param {{ vscodePath: string, modelId: string }} opts
 * @returns {Promise<void>}
 */
export async function resetVscodeModels({ vscodePath, modelId }) {
  const arr = await readChatLanguageModels(vscodePath);
  if (fireworksProviderStatus(arr) === "none") {
    throw new Error("model reset for vscode requires Fireworks to be enabled; run: fireconnect vscode on");
  }
  const next = resetProviderModels(arr, buildModelEntry(modelId));
  await writeChatLanguageModels(vscodePath, next);
}

/**
 * Append a model to the fireconnect provider. Requires Fireworks enabled.
 *
 * @param {{ vscodePath: string, modelId: string }} opts
 * @returns {Promise<{ model: string }>}
 */
export async function addVscodeModel({ vscodePath, modelId }) {
  const arr = await readChatLanguageModels(vscodePath);
  if (fireworksProviderStatus(arr) === "none") {
    throw new Error("model add for vscode requires Fireworks to be enabled; run: fireconnect vscode on");
  }
  const resolved = normalizeModelId(modelId);
  const next = addProviderModel(arr, buildModelEntry(resolved));
  await writeChatLanguageModels(vscodePath, next);
  return { model: resolved };
}

/**
 * Read the harness-local Fireworks key — decrypt the `secret://<id>` row from
 * `state.vscdb` referenced by the fireconnect provider in the JSON. Returns ""
 * when none is present or it can't be decrypted.
 *
 * Pass `arr` (the already-parsed chatLanguageModels.json array) when the caller
 * has it in hand to avoid re-reading the file; it's read from disk otherwise.
 * @param {string} vscodePath
 * @param {string} [stateDbPath]
 * @param {object[]} [arr] pre-parsed chatLanguageModels.json array
 * @returns {Promise<string>}
 */
export async function readVscodeStoredKey(vscodePath, stateDbPath, arr) {
  const providerArr = arr ?? await readChatLanguageModels(vscodePath);
  const secretId = fireconnectSecretIds(providerArr)[0];
  if (!secretId) {
    return "";
  }
  const dbPath = stateDbPath || vscodeStateDbPath({ vscodePath });
  const stored = await readItemTableValue(dbPath, secretStorageKey(secretId));
  if (!stored) {
    return "";
  }
  const key = decryptSecret(stored, { variant: currentVariant(vscodePath) });
  return isFireworksShapedKey(key) ? key.trim() : "";
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Dedupe model objects by id, preserving order. */
function dedupeModels(models) {
  const seen = new Set();
  const out = [];
  for (const m of models ?? []) {
    if (m && m.id && !seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

// prettyModelName is shared across harnesses — see fireworks-models.mjs for the
// canonical implementation. Re-exported here so existing vscode imports resolve
// to the single source of truth.
export { prettyModelName };
