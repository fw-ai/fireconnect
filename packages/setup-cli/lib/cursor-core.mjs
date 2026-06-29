import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { chmod, mkdir, unlink } from "node:fs/promises";
import {
  GLM_LATEST_ROUTER_ID,
  detectApiKeyType,
  isFireworksShapedKey,
  normalizeModelId,
  readJsonIfExists,
  writeJson,
} from "./fireconnect-core.mjs";
import { FIREPASS_ROUTER_ID, prettyModelName } from "./fireworks-models.mjs";
import {
  applyCursorWrites,
  deleteCursorValue,
  readCursorValue,
  writeCursorValue,
} from "./cursor-sqlite.mjs";

/**
 * Cursor stores AI settings in a SQLite DB (`state.vscdb`), not a JSON file.
 *
 * - API key        -> ItemTable row `cursorAuth/openAIKey` (plaintext text cell).
 * - Base URL       -> field `openAIBaseUrl` on the `applicationUser` JSON blob.
 * - Custom models  -> `aiSettings.userAddedModels` + `aiSettings.modelOverrideEnabled`.
 * - Per-mode model -> `aiSettings.modelConfig[mode].{modelName, selectedModels}`.
 *
 * The `applicationUser` blob is one ItemTable row whose value is a compact JSON
 * string. We read/write it as text and re-serialize as compact JSON to keep the
 * on-disk byte delta minimal (Cursor's own format is compact).
 */

export { ensureCursorStopped } from "./cursor-sqlite.mjs";

export const CURSOR_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

export const APPLICATION_USER_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

export const CURSOR_AUTH_OPENAI_KEY = "cursorAuth/openAIKey";

/** Cursor "modes" that carry a selected model in aiSettings.modelConfig. */
export const CURSOR_MODES = Object.freeze([
  "composer",
  "cmd-k",
  "background-composer",
  "composer-ensemble",
  "plan-execution",
  "spec",
  "deep-search",
  "quick-agent",
]);

export const CURSOR_DEFAULT_MODE = "composer";

/** Field we own on the blob to track which models fireconnect registered. */
const FIRECONNECT_ADDED_FIELD = "fireconnectAddedModels";
/** Field we own to track which modes fireconnect touched (for clean reset). */
const FIRECONNECT_TOUCHED_MODES_FIELD = "fireconnectTouchedModes";

/**
 * Resolve the path to Cursor's state.vscdb for the current platform.
 * @param {{ home?: string, dbPath?: string }} opts
 * @returns {string}
 */
export function cursorStateDbPath({ home = "", dbPath = "" } = {}) {
  if (dbPath) {
    return path.resolve(dbPath);
  }
  const baseHome = home || process.env.HOME || "";
  const platform = os.platform();
  if (platform === "darwin") {
    return path.join(baseHome, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(baseHome, "AppData", "Roaming");
    return path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  // linux / others follow the XDG-ish Cursor layout
  const configHome = process.env.XDG_CONFIG_HOME || path.join(baseHome, ".config");
  return path.join(configHome, "Cursor", "User", "globalStorage", "state.vscdb");
}

/* -------------------------------------------------------------------------- */
/* Blob I/O                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Read the applicationUser blob + the OpenAI key cell.
 * @param {string} dbPath
 * @returns {Promise<{ blob: object, openAIKey: string, exists: boolean }>}
 */
export async function readCursorState(dbPath) {
  const raw = await readCursorValue(dbPath, APPLICATION_USER_KEY);
  let blob = {};
  let exists = false;
  if (raw) {
    blob = JSON.parse(raw);
    exists = true;
  }
  if (!blob || typeof blob !== "object") {
    blob = {};
  }
  if (!blob.aiSettings || typeof blob.aiSettings !== "object") {
    blob.aiSettings = {};
  }
  const openAIKey = await readCursorValue(dbPath, CURSOR_AUTH_OPENAI_KEY);
  return { blob, openAIKey, exists };
}

/**
 * Serialize the blob as compact JSON (matches Cursor's on-disk format) and
 * persist it.
 * @param {string} dbPath
 * @param {object} blob
 * @returns {Promise<void>}
 */
export async function writeApplicationUserBlob(dbPath, blob) {
  const raw = JSON.stringify(blob);
  await writeCursorValue(dbPath, APPLICATION_USER_KEY, raw);
}

/** @param {string} dbPath @param {string} key */
export async function setCursorOpenAiKey(dbPath, key) {
  await writeCursorValue(dbPath, CURSOR_AUTH_OPENAI_KEY, key);
}

/** @param {string} dbPath */
export async function clearCursorOpenAiKey(dbPath) {
  await deleteCursorValue(dbPath, CURSOR_AUTH_OPENAI_KEY);
}

/* -------------------------------------------------------------------------- */
/* Pure blob transforms (no I/O — easy to unit-test)                          */
/* -------------------------------------------------------------------------- */

/** @returns {object} a blank aiSettings-shaped object */
export function emptyAiSettings() {
  return {
    userAddedModels: [],
    modelOverrideEnabled: [],
    modelConfig: {},
    [FIRECONNECT_ADDED_FIELD]: [],
    [FIRECONNECT_TOUCHED_MODES_FIELD]: [],
  };
}

/**
 * Shallow-clone `blob` and its `aiSettings`, hand the aiSettings clone to `fn`
 * for mutation, then reattach it. Collapses the repeated clone-and-assign
 * ceremony shared by every blob transform.
 * @param {object} blob
 * @param {(ai: object) => void} fn
 * @returns {object} new blob
 */
function withAiSettings(blob, fn) {
  const next = { ...blob };
  const ai = { ...(blob.aiSettings ?? emptyAiSettings()) };
  fn(ai);
  next.aiSettings = ai;
  return next;
}

/**
 * Register a model id in the picker list (userAddedModels + modelOverrideEnabled),
 * dedup, and track it under fireconnectAddedModels so `off` only removes ours.
 * @param {object} blob
 * @param {string} modelId
 * @returns {object} new blob (shallow-cloned)
 */
export function addUserModel(blob, modelId) {
  return withAiSettings(blob, (ai) => {
    const uam = dedupe([...(ai.userAddedModels ?? [])]);
    const moe = dedupe([...(ai.modelOverrideEnabled ?? [])]);
    const added = dedupe([...(ai[FIRECONNECT_ADDED_FIELD] ?? [])]);
    if (!uam.includes(modelId)) {
      uam.push(modelId);
    }
    if (!moe.includes(modelId)) {
      moe.push(modelId);
    }
    if (!added.includes(modelId)) {
      added.push(modelId);
    }
    ai.userAddedModels = uam;
    ai.modelOverrideEnabled = moe;
    ai[FIRECONNECT_ADDED_FIELD] = added;
  });
}

/**
 * Remove exactly the models fireconnect registered (tracked in
 * fireconnectAddedModels) from userAddedModels + modelOverrideEnabled, then
 * clear the tracker. User-added custom models are never touched.
 * @param {object} blob
 * @returns {object} new blob
 */
export function removeFireconnectModels(blob) {
  const ours = new Set(blob?.aiSettings?.[FIRECONNECT_ADDED_FIELD] ?? []);
  if (ours.size === 0) {
    return { ...blob };
  }
  return withAiSettings(blob, (ai) => {
    ai.userAddedModels = (ai.userAddedModels ?? []).filter((m) => !ours.has(m));
    ai.modelOverrideEnabled = (ai.modelOverrideEnabled ?? []).filter((m) => !ours.has(m));
    ai[FIRECONNECT_ADDED_FIELD] = [];
  });
}

/**
 * Set the selected model for a Cursor mode, preserving maxMode and recording
 * the mode in fireconnectTouchedModes for clean reset.
 * @param {object} blob
 * @param {string} mode
 * @param {string} modelId
 * @returns {object} new blob
 */
export function setModeModel(blob, mode, modelId) {
  return withAiSettings(blob, (ai) => {
    const config = { ...(ai.modelConfig ?? {}) };
    const prev = config[mode] ?? {};
    config[mode] = {
      ...prev,
      modelName: modelId,
      selectedModels: [{ modelId, parameters: [] }],
    };
    ai.modelConfig = config;
    const touched = dedupe([...(ai[FIRECONNECT_TOUCHED_MODES_FIELD] ?? [])]);
    if (!touched.includes(mode)) {
      touched.push(mode);
    }
    ai[FIRECONNECT_TOUCHED_MODES_FIELD] = touched;
  });
}

/**
 * Reset every mode fireconnect touched back to `modelId`, then clear the
 * touched-modes tracker. Modes the user configured themselves are left alone.
 *
 * `modelId` defaults to Cursor's literal `"default"` — used by the `off`
 * strip fallback when no backup exists (Fireworks is being disabled, so Cursor
 * should fall back to its own default). `model reset` passes the Fireworks
 * default model so routing stays active and per-mode selections keep pointing
 * at a Fireworks model.
 * @param {object} blob
 * @param {string} [modelId]
 * @returns {object} new blob
 */
export function resetFireconnectModelConfig(blob, modelId = "default") {
  const touched = blob?.aiSettings?.[FIRECONNECT_TOUCHED_MODES_FIELD] ?? [];
  if (touched.length === 0) {
    return { ...blob };
  }
  return withAiSettings(blob, (ai) => {
    const config = { ...(ai.modelConfig ?? {}) };
    for (const mode of touched) {
      const prev = config[mode] ?? {};
      config[mode] = {
        ...prev,
        modelName: modelId,
        selectedModels: [{ modelId, parameters: [] }],
      };
    }
    ai.modelConfig = config;
    ai[FIRECONNECT_TOUCHED_MODES_FIELD] = [];
  });
}

/** @param {object} blob @param {string} url */
export function setOpenAiBaseUrl(blob, url) {
  return { ...blob, openAIBaseUrl: url };
}

/** @param {object} blob @param {boolean} enabled */
export function setUseOpenAiKey(blob, enabled) {
  return { ...blob, useOpenAIKey: Boolean(enabled) };
}

/**
 * @param {object} blob
 * @param {string} openAIKey
 * @returns {"fireworks" | "firepass" | "none"}
 */
export function cursorProviderStatus(blob, openAIKey) {
  const using = blob?.useOpenAIKey === true;
  const key = openAIKey || "";
  if (!using || !isFireworksShapedKey(key)) {
    return "none";
  }
  return detectApiKeyType(key);
}

/**
 * @param {object} blob
 * @param {string} mode
 * @returns {string} model id or "" if unset
 */
export function cursorCurrentModelId(blob, mode) {
  const cfg = blob?.aiSettings?.modelConfig?.[mode];
  return cfg?.modelName ?? cfg?.selectedModels?.[0]?.modelId ?? "";
}

/** @param {object} blob @returns {string[]} models fireconnect registered */
export function fireconnectRegisteredModels(blob) {
  return dedupe([...(blob?.aiSettings?.[FIRECONNECT_ADDED_FIELD] ?? [])]);
}

/** @param {object} blob @returns {string[]} modes that already exist in modelConfig */
export function existingModes(blob) {
  const cfg = blob?.aiSettings?.modelConfig;
  return cfg && typeof cfg === "object" ? Object.keys(cfg) : [];
}

/**
 * Set the same model on every mode that already exists in modelConfig.
 * Non-destructive: modes without an existing entry are not created.
 * @param {object} blob
 * @param {string} modelId
 * @returns {object} new blob
 */
export function setAllExistingModes(blob, modelId) {
  let next = blob;
  for (const mode of existingModes(blob)) {
    next = setModeModel(next, mode, modelId);
  }
  return next;
}

// prettyModelName is shared across harnesses — see fireworks-models.mjs for the
// canonical implementation. Re-exported here so existing cursor imports resolve
// to the single source of truth.
export { prettyModelName };

/** @param {string[]} arr */
function dedupe(arr) {
  return [...new Set(arr.filter((x) => x != null && x !== ""))];
}

/* -------------------------------------------------------------------------- */
/* Snapshot/restore — mirror the opencode/codex/pi backup pattern so `off`     */
/* recovers the pre-`on` applicationUser blob + OpenAI key cell, not just a    */
/* reset to Cursor's "default". Backups are keyed by the DB path so two        */
/* state.vscdb files can never restore each other.                             */
/* -------------------------------------------------------------------------- */

/**
 * Default model id fireconnect registers for Cursor. Fire Pass keys are
 * restricted to the glm-latest router; regular keys also default to it.
 * Users can pick more via `fireconnect cursor model select` or `on --main`.
 * @param {"fireworks" | "firepass"} keyType
 * @returns {string}
 */
export function defaultModelIdFor(keyType) {
  return keyType === "firepass" ? FIREPASS_ROUTER_ID : GLM_LATEST_ROUTER_ID;
}

/**
 * Resolve a user-supplied model id (`--main`) for `on`. Fire Pass keys are
 * restricted to the glm-latest router regardless of `--main`; otherwise the
 * id is normalized like OpenCode/Codex (e.g. `glm-5p2` ->
 * `accounts/fireworks/models/glm-5p2`), falling back to the key-type default.
 * @param {string | undefined} modelId
 * @param {"fireworks" | "firepass"} keyType
 * @returns {string}
 */
function resolveCursorModelId(modelId, keyType) {
  if (keyType === "firepass") {
    return FIREPASS_ROUTER_ID;
  }
  return normalizeModelId(modelId || defaultModelIdFor(keyType));
}

/** @param {string} dataDir @param {string} dbPath */
export function cursorBackupPath(dataDir, dbPath) {
  const key = createHash("sha256").update(path.resolve(dbPath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `cursor-backup.${key}.json`);
}

/**
 * Read any existing backup for this DB. Returns `{}` (no `.snapshot`) when none.
 * @param {string} dataDir
 * @param {string} dbPath
 * @returns {Promise<object>}
 */
export async function readCursorBackup(dataDir, dbPath) {
  return readJsonIfExists(cursorBackupPath(dataDir, dbPath));
}

/**
 * Persist a pre-Fireconnect snapshot. The backup can hold the user's prior API
 * key, so the file (and its directory) are kept owner-only.
 * @param {string} dataDir
 * @param {string} dbPath
 * @param {{ appUserExisted: boolean, appUserRaw: string, openAIKey: string }} snapshot
 * @returns {Promise<void>}
 */
export async function writeCursorBackup(dataDir, dbPath, snapshot) {
  const backupPath = cursorBackupPath(dataDir, dbPath);
  // The backup can hold the user's prior API key — keep the dir + file
  // owner-only so a permissive umask can't leak it.
  await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  await writeJson(backupPath, { dbPath: path.resolve(dbPath), snapshot });
  await chmod(backupPath, 0o600);
}

/** @param {string} dataDir @param {string} dbPath @returns {Promise<void>} */
export async function removeCursorBackup(dataDir, dbPath) {
  try {
    await unlink(cursorBackupPath(dataDir, dbPath));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Enable Fireworks routing for Cursor: snapshot the pre-Fireconnect state, set
 * the base URL + OpenAI-key flag, register the resolved model, and point every
 * existing mode at it. Re-`on` without a prior backup does not overwrite the
 * original snapshot (so `off` can still restore it).
 *
 * @param {{ dbPath: string, dataDir: string, apiKey: string, modelId?: string, keyType?: "fireworks" | "firepass" }} opts
 * @returns {Promise<{ model: string, keyType: "fireworks" | "firepass" }>}
 */
export async function enableCursorFireworks({ dbPath, dataDir, apiKey, modelId, keyType = "fireworks" }) {
  if (!apiKey) {
    throw new Error("No Fireworks API key found. Pass --api-key or set FIREWORKS_API_KEY.");
  }

  const resolvedKeyType = keyType === "fireworks" ? detectApiKeyType(apiKey) : keyType;
  const resolvedModel = resolveCursorModelId(modelId, resolvedKeyType);

  const appUserRaw = await readCursorValue(dbPath, APPLICATION_USER_KEY);
  const appUserExisted = Boolean(appUserRaw);
  const priorKey = await readCursorValue(dbPath, CURSOR_AUTH_OPENAI_KEY);

  const blob = appUserRaw ? JSON.parse(appUserRaw) : {};
  normalizeAiSettingsInPlace(blob);

  const backup = await readCursorBackup(dataDir, dbPath);
  const hasBackup = backup.snapshot !== undefined;
  // Only snapshot pre-Fireconnect state. If routing is already active and a
  // backup exists, keep it; if routing is active with no backup, the original
  // is unrecoverable and we must not snapshot the Fireworks config (or `off`
  // would "restore" routing).
  const alreadyManaged = cursorProviderStatus(blob, priorKey) !== "none";
  const shouldSnapshot = !hasBackup && !alreadyManaged;
  if (shouldSnapshot) {
    await writeCursorBackup(dataDir, dbPath, { appUserExisted, appUserRaw, openAIKey: priorKey });
  }

  let next = setOpenAiBaseUrl(blob, CURSOR_FIREWORKS_BASE_URL);
  next = setUseOpenAiKey(next, true);
  next = addUserModel(next, resolvedModel);
  next = setAllExistingModes(next, resolvedModel);

  // Write the blob + key atomically so a failure between the two can't
  // leave the DB with the Fireworks base URL but no key (or vice versa).
  const blobRaw = JSON.stringify(next);
  await applyCursorWrites(dbPath, [
    { op: "set", key: APPLICATION_USER_KEY, value: blobRaw },
    { op: "set", key: CURSOR_AUTH_OPENAI_KEY, value: apiKey },
  ]);

  return { model: resolvedModel, keyType: resolvedKeyType };
}

/**
 * Disable Fireworks routing for Cursor. If a pre-`on` snapshot exists, restore
 * the applicationUser blob + OpenAI key cell byte-for-byte; otherwise strip
 * only what fireconnect owns (legacy/no-backup case).
 *
 * @param {{ dbPath: string, dataDir: string, wasEnabled?: boolean }} opts
 * @returns {Promise<"restored" | "stripped" | "none">}
 */
export async function disableCursorFireworks({ dbPath, dataDir, wasEnabled = false }) {
  const backup = await readCursorBackup(dataDir, dbPath);
  const hasBackup = backup.snapshot !== undefined;

  const appUserRaw = await readCursorValue(dbPath, APPLICATION_USER_KEY);
  const blob = appUserRaw ? JSON.parse(appUserRaw) : {};
  normalizeAiSettingsInPlace(blob);
  const priorKey = await readCursorValue(dbPath, CURSOR_AUTH_OPENAI_KEY);
  const active = cursorProviderStatus(blob, priorKey) !== "none";

  if (hasBackup) {
    if (backup.dbPath !== undefined && backup.dbPath !== path.resolve(dbPath)) {
      throw new Error(
        `Cursor backup was taken for ${backup.dbPath}, not ${dbPath}; refusing to restore.`,
      );
    }
    const { appUserExisted, appUserRaw: savedRaw, openAIKey } = backup.snapshot;
    const writes = [];
    if (appUserExisted && savedRaw) {
      writes.push({ op: "set", key: APPLICATION_USER_KEY, value: savedRaw });
    } else {
      writes.push({ op: "del", key: APPLICATION_USER_KEY });
    }
    if (openAIKey) {
      writes.push({ op: "set", key: CURSOR_AUTH_OPENAI_KEY, value: openAIKey });
    } else {
      writes.push({ op: "del", key: CURSOR_AUTH_OPENAI_KEY });
    }
    await applyCursorWrites(dbPath, writes);
    await removeCursorBackup(dataDir, dbPath);
    return "restored";
  }

  if (!wasEnabled && !active) {
    return "none";
  }

  // Only strip what fireconnect owns. If the user set up Fireworks routing
  // manually (no fireconnectAddedModels / fireconnectTouchedModes markers),
  // there's nothing for us to clean up — touching their config would destroy
  // a setup we didn't create.
  const hasFireconnectMarkers =
    (blob.aiSettings?.fireconnectAddedModels?.length > 0)
    || (blob.aiSettings?.fireconnectTouchedModes?.length > 0);
  if (!hasFireconnectMarkers) {
    return "none";
  }

  let next = removeFireconnectModels(blob);
  next = resetFireconnectModelConfig(next);
  next = setUseOpenAiKey(next, false);
  next = setOpenAiBaseUrl(next, null);
  const blobRaw = JSON.stringify(next);
  await applyCursorWrites(dbPath, [
    { op: "set", key: APPLICATION_USER_KEY, value: blobRaw },
    { op: "del", key: CURSOR_AUTH_OPENAI_KEY },
  ]);
  return "stripped";
}

/**
 * Reset fireconnect-managed mode selections to `modelId` while leaving
 * Fireworks routing enabled. Used by `cursor model reset`.
 *
 * @param {{ dbPath: string, modelId: string }} opts
 * @returns {Promise<void>}
 */
export async function resetCursorModelConfig({ dbPath, modelId }) {
  const { blob } = await readCursorState(dbPath);
  const next = resetFireconnectModelConfig(blob, modelId);
  await writeApplicationUserBlob(dbPath, next);
}

/**
 * Register a model in Cursor's model picker (`userAddedModels` +
 * `modelOverrideEnabled`, tracked under `fireconnectAddedModels`) **without
 * changing any mode's active selection**. Used by `cursor model add`.
 *
 * Unlike `enableCursorFireworks`, this does NOT call `setAllExistingModes` —
 * the model simply becomes available in Cursor's picker for the user to select.
 * Requires Fireworks routing to already be enabled (run `cursor on` first).
 *
 * @param {{ dbPath: string, modelId: string }} opts
 * @returns {Promise<{ model: string }>}
 */
export async function addCursorUserModel({ dbPath, modelId }) {
  const { blob, openAIKey } = await readCursorState(dbPath);
  if (cursorProviderStatus(blob, openAIKey) === "none") {
    throw new Error("model add for cursor requires Fireworks to be enabled; run: fireconnect cursor on");
  }
  const keyType = detectApiKeyType(openAIKey);
  const resolvedModel = resolveCursorModelId(modelId, keyType);
  const next = addUserModel(blob, resolvedModel);
  await writeApplicationUserBlob(dbPath, next);
  return { model: resolvedModel };
}

/** Ensure `blob.aiSettings` is a well-formed object in place. */
function normalizeAiSettingsInPlace(blob) {
  if (!blob || typeof blob !== "object") {
    return;
  }
  if (!blob.aiSettings || typeof blob.aiSettings !== "object") {
    blob.aiSettings = {};
  }
}
