import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { chmod, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  defaultMainModel,
  fullFireworksResourceId,
  isFireworksModelId,
  isFirerouterModel,
  normalizeModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import {
  detectApiKeyType,
  isFireworksShapedKey,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "../../keys/key-type.mjs";
import { FIREPASS_ROUTER_ID, prettyModelName } from "../../fireworks/models.mjs";
import {
  AZURE_API_KEY_ENV,
  AZURE_API_KEY_ENV_REF,
  DEFAULT_AZURE_MODEL,
  MISSING_AZURE_API_KEY_MESSAGE,
  MISSING_AZURE_BASE_URL_MESSAGE,
  normalizeAzureBaseUrl,
} from "../../fireworks/azure-core.mjs";
import {
  applyCursorWrites,
  deleteCursorValue,
  readCursorValue,
  writeCursorValue,
} from "./sqlite.mjs";
import {
  decryptSecret,
  encryptSecret,
  isSecretEncryptionAvailable,
  linuxEncryptUsesBasicTextBackend,
} from "../vscode/safestorage.mjs";

/**
 * Cursor stores AI settings in a SQLite DB (`state.vscdb`), not a JSON file.
 *
 * - API key        -> ItemTable row `secret://cursorAuth/openAIKey`, an Electron
 *                     `safeStorage`-encrypted cell (same scheme VS Code Chat uses
 *                     for `secret://<id>`). Older Cursor builds used a plaintext
 *                     `cursorAuth/openAIKey` cell — we still write that as a
 *                     fallback so either Cursor version can read the key.
 * - Base URL       -> field `openAIBaseUrl` on the `applicationUser` JSON blob.
 * - Custom models  -> `aiSettings.userAddedModels` + `aiSettings.modelOverrideEnabled`.
 * - Hidden models  -> `aiSettings.modelOverrideDisabled` (picker hides these).
 * - Per-mode model -> `aiSettings.modelConfig[mode].{modelName, selectedModels}`.
 *
 * The `applicationUser` blob is one ItemTable row whose value is a compact JSON
 * string. We read/write it as text and re-serialize as compact JSON to keep the
 * on-disk byte delta minimal (Cursor's own format is compact).
 */

export { ensureCursorStopped } from "./sqlite.mjs";

export const CURSOR_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

export const APPLICATION_USER_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

export const CURSOR_AUTH_OPENAI_KEY = "cursorAuth/openAIKey";

/**
 * The encrypted key cell modern Cursor reads. The value is
 * `JSON.stringify(safeStorage.encryptString(plaintext))` — the same form VS Code
 * Chat stores under `secret://<id>`. Cursor writes an empty ciphertext
 * (`{"type":"Buffer","data":[]}`) here when the user clears the key in the IDE,
 * which is why a stale plaintext `cursorAuth/openAIKey` cell can't override it.
 */
export const CURSOR_AUTH_OPENAI_KEY_SECRET = "secret://cursorAuth/openAIKey";

/**
 * The empty ciphertext Cursor itself writes to the `secret://` cell when the
 * user clears the key in the IDE (`safeStorage.encryptString("")` round-trips to
 * an empty buffer). Used by `off`/restore so a "no key" state matches Cursor's
 * own on-disk shape rather than a missing row.
 */
const EMPTY_SAFE_STORAGE_CIPHERTEXT = JSON.stringify({ type: "Buffer", data: [] });

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

/** User-facing note: only Fireworks picker models work while FireConnect routes Cursor. */
export const CURSOR_FIREWORKS_ONLY_NOTE =
  "Only Fireworks models work while FireConnect is on; Cursor's built-ins are hidden. "
  + "Run `fireconnect cursor off` to restore them.";

/** Field we own on the blob to track which models fireconnect registered. */
const FIRECONNECT_ADDED_FIELD = "fireconnectAddedModels";
/** Field we own to track which modes fireconnect touched (for clean reset). */
const FIRECONNECT_TOUCHED_MODES_FIELD = "fireconnectTouchedModes";
/** Field we own to track which built-in models fireconnect hid (for clean reset). */
const FIRECONNECT_DISABLED_FIELD = "fireconnectDisabledModels";
/**
 * Field we own to track which models fireconnect removed from
 * modelOverrideEnabled while hiding them. Cursor's picker treats
 * modelOverrideEnabled as overriding modelOverrideDisabled, so a model the
 * user once toggled on stays visible unless it leaves the enabled list too.
 */
const FIRECONNECT_TOGGLED_OFF_FIELD = "fireconnectToggledOffModels";

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

/**
 * Resolve Cursor's `Local State` file — the Chromium user-data root that holds
 * the OSCrypt `os_crypt.encrypted_key` (DPAPI-protected AES-256 key) on Windows.
 * state.vscdb lives at `<userData>/User/globalStorage/state.vscdb`, so `Local
 * State` is three levels up. Only used on Windows; harmless elsewhere.
 * @param {string} dbPath
 * @returns {string}
 */
export function cursorLocalStatePath(dbPath) {
  return path.join(path.dirname(path.dirname(path.dirname(path.resolve(dbPath)))), "Local State");
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
  const openAIKey = await readCursorOpenAiKey(dbPath);
  return { blob, openAIKey, exists };
}

/**
 * Read the OpenAI key Cursor actually uses, decrypting the `secret://` cell that
 * modern Cursor reads. Falls back to the legacy plaintext `cursorAuth/openAIKey`
 * cell for older Cursor builds. Returns "" when no usable key is present (e.g.
 * the user cleared it in the IDE, which leaves an empty ciphertext).
 * @param {string} dbPath
 * @returns {Promise<string>}
 */
export async function readCursorOpenAiKey(dbPath) {
  const secretRaw = await readCursorValue(dbPath, CURSOR_AUTH_OPENAI_KEY_SECRET);
  const secret = decryptSecret(secretRaw ?? "", {
    variant: "cursor",
    localStatePath: cursorLocalStatePath(dbPath),
  });
  if (secret) {
    return secret;
  }
  const legacy = await readCursorValue(dbPath, CURSOR_AUTH_OPENAI_KEY);
  return legacy ?? "";
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
 * @param {{ shortenFireworks?: boolean }} [options]
 * @returns {object} new blob (shallow-cloned)
 */
export function addUserModel(blob, modelId, { shortenFireworks = true } = {}) {
  return withAiSettings(blob, (ai) => {
    const toStoredRef = shortenFireworks
      ? shortFireworksModelRef
      : (value) => value;
    const storedModelId = toStoredRef(modelId);
    const uam = dedupe(
      [...(ai.userAddedModels ?? [])].map(toStoredRef),
    );
    const moe = dedupe(
      [...(ai.modelOverrideEnabled ?? [])].map(toStoredRef),
    );
    const added = dedupe(
      [...(ai[FIRECONNECT_ADDED_FIELD] ?? [])].map(toStoredRef),
    );
    if (!uam.includes(storedModelId)) {
      uam.push(storedModelId);
    }
    if (!moe.includes(storedModelId)) {
      moe.push(storedModelId);
    }
    if (!added.includes(storedModelId)) {
      added.push(storedModelId);
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
  const ours = new Set(
    (blob?.aiSettings?.[FIRECONNECT_ADDED_FIELD] ?? [])
      .map(shortFireworksModelRef),
  );
  if (ours.size === 0) {
    return { ...blob };
  }
  return withAiSettings(blob, (ai) => {
    ai.userAddedModels = (ai.userAddedModels ?? []).filter(
      (model) => !ours.has(shortFireworksModelRef(model)),
    );
    ai.modelOverrideEnabled = (ai.modelOverrideEnabled ?? []).filter(
      (model) => !ours.has(shortFireworksModelRef(model)),
    );
    ai[FIRECONNECT_ADDED_FIELD] = [];
  });
}

/**
 * Migrate public Fireworks refs in Cursor's direct-routing fields to short IDs.
 * Azure deployment names and unrelated models pass through unchanged.
 */
export function shortenCursorFireworksModelRefs(blob) {
  return withAiSettings(blob, (ai) => {
    ai.userAddedModels = dedupe(
      [...(ai.userAddedModels ?? [])].map(shortFireworksModelRef),
    );
    ai.modelOverrideEnabled = dedupe(
      [...(ai.modelOverrideEnabled ?? [])].map(shortFireworksModelRef),
    );
    ai[FIRECONNECT_ADDED_FIELD] = dedupe(
      [...(ai[FIRECONNECT_ADDED_FIELD] ?? [])].map(shortFireworksModelRef),
    );

    const config = { ...(ai.modelConfig ?? {}) };
    for (const [mode, value] of Object.entries(config)) {
      config[mode] = {
        ...value,
        ...(typeof value?.modelName === "string"
          ? { modelName: shortFireworksModelRef(value.modelName) }
          : {}),
        ...(Array.isArray(value?.selectedModels)
          ? {
            selectedModels: value.selectedModels.map((selected) => ({
              ...selected,
              modelId: shortFireworksModelRef(selected.modelId),
            })),
          }
          : {}),
      };
    }
    ai.modelConfig = config;
  });
}

/**
 * Build a predicate: can this model id actually be served by the active
 * provider (Fireworks gateway or Foundry resource)? True for known Fireworks
 * ids plus the explicit servable set (the resolved model + registered catalog).
 * Cursor-native ids (`auto-smart`, `composer-2.5`, `claude-sonnet-4-6`, …)
 * return false — routing them through the override base URL only 404s.
 * @param {string[]} servableIds
 * @param {{ includeKnownFireworks?: boolean }} [opts]  Pass false for Azure,
 *   where only the Foundry deployment itself is servable.
 * @returns {(id: string) => boolean}
 */
function servableChecker(servableIds, { includeKnownFireworks = true } = {}) {
  const set = new Set(
    servableIds
      .map((id) => shortFireworksModelRef(String(id ?? "").trim()))
      .filter(Boolean),
  );
  return (id) => {
    const ref = shortFireworksModelRef(String(id ?? "").trim());
    if (!ref) {
      return false;
    }
    return set.has(ref) || (includeKnownFireworks && isFireworksModelId(ref));
  };
}

/**
 * Drop fireconnect-registered models the provider can't serve (e.g. an
 * `auto-smart` an earlier version registered by preserving Cursor's native
 * selection). Only ids in our own fireconnectAddedModels tracker are removed —
 * user-added customs are never touched.
 * @param {object} blob
 * @param {{ servable: (id: string) => boolean }} opts
 * @returns {object} new blob
 */
export function pruneUnservableAddedModels(blob, { servable }) {
  const tracked = blob?.aiSettings?.[FIRECONNECT_ADDED_FIELD] ?? [];
  const stale = tracked.filter((id) => !servable(id));
  if (stale.length === 0) {
    return { ...blob };
  }
  return withAiSettings(blob, (ai) => {
    ai.userAddedModels = (ai.userAddedModels ?? []).filter((id) => !stale.includes(id));
    ai.modelOverrideEnabled = (ai.modelOverrideEnabled ?? []).filter((id) => !stale.includes(id));
    ai[FIRECONNECT_ADDED_FIELD] = tracked.filter((id) => !stale.includes(id));
  });
}

/**
 * Hide Cursor's built-in models from the picker while routing is active:
 * every model Cursor itself offers (`availableDefaultModels2`) or the user
 * once enabled (`modelOverrideEnabled`) that the provider can't serve is added
 * to `modelOverrideDisabled` AND removed from `modelOverrideEnabled` — the
 * picker lets an enabled id override a disabled one, so both lists must agree
 * for a model to actually disappear. Both edits are tracked
 * (fireconnectDisabledModels / fireconnectToggledOffModels) so `off` restores
 * exactly what we changed. User-added custom models are never hidden, and
 * tracked ids that became servable (catalog grew) are re-enabled.
 * @param {object} blob
 * @param {{ servable: (id: string) => boolean, extraCandidates?: string[] }} opts
 *   `extraCandidates`: additional ids to consider hiding even though they're no
 *   longer in the picker lists (e.g. stale registrations just pruned above).
 * @returns {object} new blob
 */
export function disableUnservableModels(blob, { servable, extraCandidates = [] }) {
  const userOwns = new Set(blob?.aiSettings?.userAddedModels ?? []);
  // Cursor's reserved picker sentinels, never real models.
  const sentinels = new Set(["default", "inherit", "none"]);
  const candidates = dedupe([
    ...(Array.isArray(blob?.availableDefaultModels2) ? blob.availableDefaultModels2 : [])
      .map((model) => model?.name)
      .filter(Boolean),
    ...(blob?.aiSettings?.modelOverrideEnabled ?? []),
    ...extraCandidates,
  ]).filter((id) => !sentinels.has(id));
  return withAiSettings(blob, (ai) => {
    let disabled = [...(ai.modelOverrideDisabled ?? [])];
    let tracked = [...(ai[FIRECONNECT_DISABLED_FIELD] ?? [])];
    let enabled = [...(ai.modelOverrideEnabled ?? [])];
    let toggledOff = [...(ai[FIRECONNECT_TOGGLED_OFF_FIELD] ?? [])];
    // Re-enable models we hid that are servable now (e.g. catalog grew).
    for (const id of tracked.filter((id) => servable(id))) {
      disabled = disabled.filter((hidden) => hidden !== id);
      tracked = tracked.filter((hidden) => hidden !== id);
      if (toggledOff.includes(id)) {
        if (!enabled.includes(id)) {
          enabled.push(id);
        }
        toggledOff = toggledOff.filter((hidden) => hidden !== id);
      }
    }
    for (const id of candidates) {
      if (servable(id) || userOwns.has(id)) {
        continue;
      }
      if (!disabled.includes(id)) {
        disabled.push(id);
        if (!tracked.includes(id)) {
          tracked.push(id);
        }
      }
      // An enabled id overrides a disabled one in Cursor's picker — strip it
      // from enabled too, even if we (or the user) already disabled it.
      if (enabled.includes(id)) {
        enabled = enabled.filter((model) => model !== id);
        if (!toggledOff.includes(id)) {
          toggledOff.push(id);
        }
      }
    }
    ai.modelOverrideDisabled = disabled;
    ai[FIRECONNECT_DISABLED_FIELD] = tracked;
    ai.modelOverrideEnabled = enabled;
    ai[FIRECONNECT_TOGGLED_OFF_FIELD] = toggledOff;
  });
}

/**
 * Un-hide exactly the built-in models fireconnect hid (tracked in
 * fireconnectDisabledModels) and restore the enabled-list entries we stripped
 * (fireconnectToggledOffModels), then clear both trackers. Models the user
 * disabled or enabled themselves are never touched. No-backup `off` strip
 * path only.
 * @param {object} blob
 * @returns {object} new blob
 */
export function reenableFireconnectDisabledModels(blob) {
  const tracked = blob?.aiSettings?.[FIRECONNECT_DISABLED_FIELD] ?? [];
  const toggledOff = blob?.aiSettings?.[FIRECONNECT_TOGGLED_OFF_FIELD] ?? [];
  if (tracked.length === 0 && toggledOff.length === 0) {
    return { ...blob };
  }
  return withAiSettings(blob, (ai) => {
    ai.modelOverrideDisabled = (ai.modelOverrideDisabled ?? []).filter(
      (id) => !tracked.includes(id),
    );
    const enabled = [...(ai.modelOverrideEnabled ?? [])];
    for (const id of toggledOff) {
      if (!enabled.includes(id)) {
        enabled.push(id);
      }
    }
    ai.modelOverrideEnabled = enabled;
    ai[FIRECONNECT_DISABLED_FIELD] = [];
    ai[FIRECONNECT_TOGGLED_OFF_FIELD] = [];
  });
}

/**
 * Set the selected model for a Cursor mode, preserving maxMode and recording
 * the mode in fireconnectTouchedModes for clean reset.
 * @param {object} blob
 * @param {string} mode
 * @param {string} modelId
 * @param {{ shortenFireworks?: boolean }} [options]
 * @returns {object} new blob
 */
export function setModeModel(blob, mode, modelId, { shortenFireworks = true } = {}) {
  const storedModelId = shortenFireworks
    ? shortFireworksModelRef(modelId)
    : modelId;
  return withAiSettings(blob, (ai) => {
    const config = { ...(ai.modelConfig ?? {}) };
    const prev = config[mode] ?? {};
    config[mode] = {
      ...prev,
      modelName: storedModelId,
      selectedModels: [{ modelId: storedModelId, parameters: [] }],
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
 * strip fallback when no backup exists so Cursor falls back to its own model.
 * @param {object} blob
 * @param {string} [modelId]
 * @returns {object} new blob
 */
export function resetFireconnectModelConfig(blob, modelId = "default") {
  const storedModelId = shortFireworksModelRef(modelId);
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
        modelName: storedModelId,
        selectedModels: [{ modelId: storedModelId, parameters: [] }],
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
 * @returns {"fireworks" | "azure" | "none"}
 */
export function cursorProviderStatus(blob, openAIKey) {
  const using = blob?.useOpenAIKey === true;
  const key = openAIKey || "";
  if (!using || !key) {
    return "none";
  }
  if (isFireworksShapedKey(key)) {
    return "fireworks";
  }
  // A non-Fireworks key with a fireconnect-managed base URL that isn't the
  // Fireworks gateway means we pointed Cursor at Microsoft Foundry (Azure) or a
  // documented OpenAI-compatible proxy. Gate on our markers so a user's own
  // OpenAI/Azure setup (which we didn't create) is never treated as managed.
  const managed = (blob?.aiSettings?.fireconnectAddedModels?.length ?? 0) > 0;
  const base = typeof blob?.openAIBaseUrl === "string" ? blob.openAIBaseUrl : "";
  if (managed && base && base !== CURSOR_FIREWORKS_BASE_URL) {
    return "azure";
  }
  return "none";
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
 * @param {{ shortenFireworks?: boolean }} [options]
 * @returns {object} new blob
 */
export function setAllExistingModes(blob, modelId, options) {
  let next = blob;
  for (const mode of existingModes(blob)) {
    next = setModeModel(next, mode, modelId, options);
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
 * restricted to the glm-fast-latest router; regular keys default to the shared
 * Fireworks main model (kimi-fast-latest when Kimi K3 is serverless-listed).
 * `on --model` ensures an explicit model is registered and selected.
 * @param {"fireworks" | "firepass"} keyType
 * @returns {string}
 */
export function defaultModelIdFor(keyType) {
  return keyType === "firepass"
    ? FIREPASS_ROUTER_ID
    : fullFireworksResourceId(defaultMainModel());
}

/**
 * Resolve a user-supplied model id (`--model`) for `on`. Fire Pass keys are
 * restricted to the glm-fast-latest router regardless of `--model`; otherwise the
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

export const CURSOR_DATA_RELATIVE_DIR = ".fireconnect/cursor";

/**
 * Cursor's FireConnect data dir (backup + state). Defaults to
 * `~/.fireconnect/cursor` unless overridden via `--data-dir`.
 * @param {string} home
 * @param {string} [dataDir]
 * @returns {string}
 */
export function cursorDataDir(home, dataDir = "") {
  return dataDir || path.join(home, CURSOR_DATA_RELATIVE_DIR);
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
 * One-time relocation of Cursor backups from the legacy shared Claude data dir
 * (`~/.fireconnect/claude`, where older releases wrote them because the
 * Cursor harness reused Claude's `resolveDataDir`) into Cursor's own data dir.
 * Idempotent; safe to call on every command. Leaves any claude-owned
 * `provider-*` files untouched.
 * @param {{ home: string, dataDir: string }} opts
 */
export async function relocateLegacyCursorBackups({ home, dataDir }) {
  const newDir = cursorDataDir(home, dataDir);
  const legacyDir = path.join(home, ".fireconnect/claude");
  if (path.resolve(newDir) === path.resolve(legacyDir) || !existsSync(legacyDir)) {
    return;
  }
  let entries;
  try {
    entries = await readdir(legacyDir);
  } catch {
    return; // legacy dir absent — nothing to relocate
  }
  await mkdir(newDir, { recursive: true, mode: 0o700 }).catch(() => {});
  for (const name of entries) {
    if (!name.startsWith("cursor-backup.")) continue;
    const from = path.join(legacyDir, name);
    const to = path.join(newDir, name);
    if (existsSync(to)) continue; // already migrated or a new `on` wrote here
    try {
      await rename(from, to);
    } catch {
      /* dest appeared between check and move; leave the legacy file in place */
    }
  }
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
 * the base URL + OpenAI-key flag, register the resolved model, point every
 * existing mode at it, and hide built-in models the gateway can't serve.
 * Re-`on` without a prior backup does not overwrite the original snapshot
 * (so `off` can still restore it).
 *
 * @param {{ dbPath: string, dataDir: string, apiKey: string, modelId?: string, keyType?: "fireworks" | "firepass", catalogUnavailable?: boolean }} opts
 * @returns {Promise<{ model: string, keyType: "fireworks" | "firepass" }>}
 */
export async function enableCursorFireworks({ dbPath, dataDir, apiKey, modelId, keyType = "fireworks", extraModels = [], catalogUnavailable = false }) {
  if (!apiKey) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }

  const resolvedKeyType = keyType === "fireworks" ? detectApiKeyType(apiKey) : keyType;

  const appUserRaw = await readCursorValue(dbPath, APPLICATION_USER_KEY);
  const appUserExisted = Boolean(appUserRaw);
  const priorKey = await readCursorOpenAiKey(dbPath);

  let blob = appUserRaw ? JSON.parse(appUserRaw) : {};
  normalizeAiSettingsInPlace(blob);

  const backup = await readCursorBackup(dataDir, dbPath);
  const hasBackup = backup.snapshot !== undefined;
  // Only snapshot pre-Fireconnect state. If routing is already active and a
  // backup exists, keep it; if routing is active with no backup, the original
  // is unrecoverable and we must not snapshot the Fireworks config (or `off`
  // would "restore" routing).
  const providerStatus = cursorProviderStatus(blob, priorKey);
  const previousKeyType = isFireworksShapedKey(priorKey)
    ? detectApiKeyType(priorKey)
    : "";
  const alreadyManaged = providerStatus !== "none";
  const shouldSnapshot = !hasBackup && !alreadyManaged;
  if (shouldSnapshot) {
    await writeCursorBackup(dataDir, dbPath, { appUserExisted, appUserRaw, openAIKey: priorKey });
  }

  if (providerStatus === "azure") {
    blob = removeFireconnectModels(blob);
  }
  blob = shortenCursorFireworksModelRefs(blob);
  const requestedModel = modelId?.trim() ?? "";
  // What the gateway can serve: the key-type default plus the registerable
  // catalog. Used to tell real Fireworks ids apart from Cursor-native ones.
  // When the catalog fetch failed, also trust what a previous online run
  // registered — pruning/hiding those just because we're offline would
  // destroy a working setup. Ids Cursor itself offers as built-ins (and that
  // aren't known Fireworks ids) stay untrusted, so stale native registrations
  // like auto-smart still self-heal offline.
  const cursorBuiltinNames = new Set(
    (Array.isArray(blob?.availableDefaultModels2) ? blob.availableDefaultModels2 : [])
      .map((model) => model?.name)
      .filter(Boolean),
  );
  const servable = servableChecker([
    resolveCursorModelId(requestedModel, resolvedKeyType),
    ...extraModels,
    ...(catalogUnavailable
      ? fireconnectRegisteredModels(blob).filter(
        (id) => !cursorBuiltinNames.has(id) || isFireworksModelId(id),
      )
      : []),
  ]);
  const currentMode = existingModes(blob).includes(CURSOR_DEFAULT_MODE)
    ? CURSOR_DEFAULT_MODE
    : existingModes(blob)[0];
  const currentModel = currentMode ? cursorCurrentModelId(blob, currentMode) : "";
  // Re-`on` keeps the user's selection — but only when the gateway can serve
  // it. A Cursor-native id (auto-smart & friends) would 404 on Fireworks, so
  // it falls through to the default and is reported as `replacedModel`.
  const preserveModeSelections = !requestedModel
    && providerStatus === "fireworks"
    && (!previousKeyType || previousKeyType === resolvedKeyType)
    && currentModel
    && currentModel !== "default"
    && !isFirerouterModel(currentModel)
    && servable(currentModel);
  const resolvedModel = shortFireworksModelRef(
    preserveModeSelections
      ? normalizeModelId(currentModel)
      : resolveCursorModelId(requestedModel, resolvedKeyType),
  );
  // Only unservable picks earn the "isn't on Fireworks" note — explicit
  // --model switches, firerouter picks, and key-type changes drop a perfectly
  // valid Fireworks model too, and the note would be wrong for those.
  const replacedModel = !preserveModeSelections
    && providerStatus === "fireworks"
    && currentModel
    && currentModel !== "default"
    && currentModel !== resolvedModel
    && !servable(currentModel)
    ? currentModel
    : "";

  let next = setOpenAiBaseUrl(blob, CURSOR_FIREWORKS_BASE_URL);
  next = setUseOpenAiKey(next, true);
  // Self-heal registrations an earlier version made from Cursor-native picks.
  // Capture them first: pruning drops them from the picker lists, but they
  // should still end up hidden via modelOverrideDisabled below.
  const staleRegistered = (next.aiSettings?.fireconnectAddedModels ?? [])
    .filter((id) => !servable(id));
  next = pruneUnservableAddedModels(next, { servable });
  // Register the resolved active model plus the caller's preferred catalog.
  for (const id of [resolvedModel, ...extraModels]) {
    if (id) {
      next = addUserModel(next, id);
    }
  }
  if (!preserveModeSelections) {
    next = setAllExistingModes(next, resolvedModel);
  }
  next = disableUnservableModels(next, { servable, extraCandidates: staleRegistered });

  const blobRaw = JSON.stringify(next);
  const { writes, obfuscatedKey } = cursorKeyWrites(dbPath, blobRaw, apiKey);
  await applyCursorWrites(dbPath, writes);

  return {
    model: resolvedModel,
    replacedModel,
    modelsAdded: fireconnectRegisteredModels(next),
    keyType: resolvedKeyType,
    encrypted: isSecretEncryptionAvailable({ variant: "cursor", localStatePath: cursorLocalStatePath(dbPath) }),
    obfuscatedKey,
  };
}

/**
 * Build the atomic write set for the applicationUser blob + the OpenAI key.
 * The key goes to the encrypted `secret://` cell modern Cursor reads; we also
 * write the legacy plaintext cell as a fallback for older Cursor builds. When
 * the encrypted cell can't be produced (Cursor's Safe Storage key isn't in the
 * keychain yet — e.g. Cursor never launched), only the legacy cell is written so
 * `on` still works for older Cursor builds.
 * @param {string} dbPath @param {string} blobRaw @param {string} apiKey
 * @returns {{ writes: Array<{op: string, key: string, value?: string}>, obfuscatedKey: boolean }}
 */
function cursorKeyWrites(dbPath, blobRaw, apiKey) {
  const writes = [
    { op: "set", key: APPLICATION_USER_KEY, value: blobRaw },
    { op: "set", key: CURSOR_AUTH_OPENAI_KEY, value: apiKey },
  ];
  const localStatePath = cursorLocalStatePath(dbPath);
  let obfuscatedKey = false;
  if (isSecretEncryptionAvailable({ variant: "cursor", localStatePath })) {
    const encrypted = encryptSecret(apiKey, { variant: "cursor", localStatePath });
    obfuscatedKey = linuxEncryptUsesBasicTextBackend(encrypted);
    writes.push({
      op: "set",
      key: CURSOR_AUTH_OPENAI_KEY_SECRET,
      value: encrypted,
    });
  }
  return { writes, obfuscatedKey };
}

/**
 * Route Cursor through Fireworks models served on Microsoft Foundry (Azure).
 * Cursor's OpenAI-compatible override (base URL + key) points at the Foundry
 * resource; the Foundry deployment name is registered verbatim (no
 * accounts/fireworks/ prefix) and set on every existing mode. Cursor stores the
 * key literally in its own DB cell, so an env-provided key is resolved and
 * written literally. `off` reuses the shared snapshot/strip path.
 *
 * @param {{ dbPath: string, dataDir: string, apiKey: string, baseUrl: string, modelId?: string }} opts
 * @returns {Promise<{ model: string, baseUrl: string, apiKeyMode: "literal" }>}
 */
export async function enableCursorAzure({ dbPath, dataDir, apiKey, baseUrl, modelId = "" }) {
  const normalizedBaseUrl = normalizeAzureBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    throw new Error(MISSING_AZURE_BASE_URL_MESSAGE);
  }
  const effectiveApiKey = apiKey === AZURE_API_KEY_ENV_REF
    ? (process.env[AZURE_API_KEY_ENV] ?? "")
    : apiKey;
  if (!effectiveApiKey) {
    throw new Error(MISSING_AZURE_API_KEY_MESSAGE);
  }

  const appUserRaw = await readCursorValue(dbPath, APPLICATION_USER_KEY);
  const appUserExisted = Boolean(appUserRaw);
  const priorKey = await readCursorOpenAiKey(dbPath);
  const blob = appUserRaw ? JSON.parse(appUserRaw) : {};
  normalizeAiSettingsInPlace(blob);

  // Only reuse a deployment when Azure is already the active provider — never
  // carry over a Fireworks gateway catalog id (Foundry has no such deployment).
  const azureActive = cursorProviderStatus(blob, priorKey) === "azure";
  const currentDeployment = azureActive ? (cursorCurrentModelId(blob, CURSOR_DEFAULT_MODE) || "") : "";
  const resolvedModel = modelId || currentDeployment || DEFAULT_AZURE_MODEL;

  const backup = await readCursorBackup(dataDir, dbPath);
  const hasBackup = backup.snapshot !== undefined;
  const alreadyManaged = cursorProviderStatus(blob, priorKey) !== "none";
  const shouldSnapshot = !hasBackup && !alreadyManaged;
  if (shouldSnapshot) {
    await writeCursorBackup(dataDir, dbPath, { appUserExisted, appUserRaw, openAIKey: priorKey });
  }

  // Drop any previously registered fireconnect models (e.g. a prior Fireworks
  // gateway catalog) so only the Foundry deployment remains in the picker.
  const servable = servableChecker([resolvedModel], { includeKnownFireworks: false });
  let next = removeFireconnectModels(blob);
  next = setOpenAiBaseUrl(next, normalizedBaseUrl);
  next = setUseOpenAiKey(next, true);
  next = addUserModel(next, resolvedModel, { shortenFireworks: false });
  next = setAllExistingModes(next, resolvedModel, { shortenFireworks: false });
  next = disableUnservableModels(next, { servable });

  // Write to the encrypted secret:// cell (modern Cursor) + legacy plaintext
  // fallback, exactly like the gateway path — otherwise a key the user cleared
  // in the IDE would keep winning over the Azure key.
  const blobRaw = JSON.stringify(next);
  await applyCursorWrites(dbPath, cursorKeyWrites(dbPath, blobRaw, effectiveApiKey).writes);

  return { model: resolvedModel, baseUrl: normalizedBaseUrl, apiKeyMode: "literal" };
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
  const priorKey = await readCursorOpenAiKey(dbPath);
  const active = cursorProviderStatus(blob, priorKey) !== "none";

  if (hasBackup) {
    if (backup.dbPath !== undefined && backup.dbPath !== path.resolve(dbPath)) {
      throw new Error(
        `Cursor backup was taken for ${backup.dbPath}, not ${dbPath}; refusing to restore.`,
      );
    }
    const localStatePath = cursorLocalStatePath(dbPath);
    const canEncrypt = isSecretEncryptionAvailable({ variant: "cursor", localStatePath });
    const { appUserExisted, appUserRaw: savedRaw, openAIKey } = backup.snapshot;
    const writes = [];
    if (appUserExisted && savedRaw) {
      writes.push({ op: "set", key: APPLICATION_USER_KEY, value: savedRaw });
    } else {
      writes.push({ op: "del", key: APPLICATION_USER_KEY });
    }
    if (openAIKey) {
      writes.push({ op: "set", key: CURSOR_AUTH_OPENAI_KEY, value: openAIKey });
      if (canEncrypt) {
        writes.push({ op: "set", key: CURSOR_AUTH_OPENAI_KEY_SECRET, value: encryptSecret(openAIKey, { variant: "cursor", localStatePath }) });
      } else {
        writes.push({ op: "del", key: CURSOR_AUTH_OPENAI_KEY_SECRET });
      }
    } else {
      // Match Cursor's own on-disk shape for "no key": an empty ciphertext in
      // the `secret://` cell, and no legacy plaintext row.
      writes.push({ op: "set", key: CURSOR_AUTH_OPENAI_KEY_SECRET, value: EMPTY_SAFE_STORAGE_CIPHERTEXT });
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
    || (blob.aiSettings?.fireconnectTouchedModes?.length > 0)
    || (blob.aiSettings?.fireconnectDisabledModels?.length > 0)
    || (blob.aiSettings?.fireconnectToggledOffModels?.length > 0);
  if (!hasFireconnectMarkers) {
    return "none";
  }

  let next = removeFireconnectModels(blob);
  next = resetFireconnectModelConfig(next);
  next = reenableFireconnectDisabledModels(next);
  next = setUseOpenAiKey(next, false);
  next = setOpenAiBaseUrl(next, null);
  const blobRaw = JSON.stringify(next);
  await applyCursorWrites(dbPath, [
    { op: "set", key: APPLICATION_USER_KEY, value: blobRaw },
    // Match Cursor's own "no key" shape: empty ciphertext in the secret cell,
    // legacy plaintext row removed.
    { op: "set", key: CURSOR_AUTH_OPENAI_KEY_SECRET, value: EMPTY_SAFE_STORAGE_CIPHERTEXT },
    { op: "del", key: CURSOR_AUTH_OPENAI_KEY },
  ]);
  return "stripped";
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
