import { writeFileAtomic } from "./atomic-write.mjs";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { readJsonIfExists, writeJson } from "./fireconnect-core.mjs";
import {
  buildFirerouterHttpHeaders,
  FALLBACK_FIREROUTER_MAIN_MODEL,
  FIREROUTER_BASE_URL,
  FIREROUTER_FIREWORKS_HEADER,
  isFirerouterBaseUrl,
  normalizeFirerouterUrl,
} from "./firerouter-core.mjs";
import { isHarnessEnabled } from "./global-config.mjs";
import { HARNESS } from "./harness.mjs";

export { FIREROUTER_BASE_URL } from "./firerouter-core.mjs";
export { FALLBACK_FIREROUTER_MAIN_MODEL } from "./firerouter-core.mjs";
export const FIREROUTER_DATA_RELATIVE_DIR = ".fireconnect/opencode/firerouter";
export const ANTHROPIC_KEY_ENV_REF = "{env:ANTHROPIC_API_KEY}";
export const FIREWORKS_KEY_ENV_REF = "{env:FIREWORKS_API_KEY}";

// We retarget OpenCode's built-in Anthropic provider instead of adding our own.
// Users keep `anthropic/<model>` references and can switch models in-session;
// FireRouter mode only redirects where those requests are sent.
export const OPENCODE_ANTHROPIC_PROVIDER_ID = "anthropic";

// OpenCode merges provider.name into the built-in registry for UI display.
export const FIREROUTER_ANTHROPIC_PROVIDER_NAME = "Anthropic (FireRouter)";

// Provider ids owned by fireconnect's direct (Fireworks) mode. Mirrors
// OPENCODE_FIREWORKS_PROVIDER_ID + its legacy alias from opencode-core.mjs.
const DIRECT_FIREWORKS_PROVIDER_IDS = ["fireworks-ai", "fireworks"];

/**
 * Pick the `anthropic/<model>` reference to make active. An explicit model
 * (--main or a resolved default) wins; otherwise keep the current model when it
 * already targets the Anthropic provider (so in-session switches survive a
 * re-`on`); else fall back to the bundled default. Returning anything else would
 * leave router mode inert.
 * @param {string} mainModel
 * @param {unknown} currentModel
 */
export function resolveAnthropicModelRef(mainModel, currentModel) {
  const prefix = `${OPENCODE_ANTHROPIC_PROVIDER_ID}/`;
  if (mainModel) {
    return mainModel.startsWith(prefix) ? mainModel : `${prefix}${mainModel}`;
  }
  if (typeof currentModel === "string" && currentModel.startsWith(prefix)) {
    return currentModel;
  }
  return `${prefix}${FALLBACK_FIREROUTER_MAIN_MODEL}`;
}

export function firerouterDataDir(home, dataDir) {
  if (dataDir) return path.join(dataDir, "firerouter");
  return path.join(home, FIREROUTER_DATA_RELATIVE_DIR);
}

// Backups are keyed by the config file they snapshot, so enabling on two
// different opencode.json paths (e.g. via --config-path) can never restore one
// file's content onto the other.
export function firerouterBackupPath(dataDir, configPath) {
  const key = createHash("sha256").update(path.resolve(configPath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `config-backup.${key}.json`);
}

// Raw-text snapshot (not parsed JSON) so `off` can restore the user's file
// byte-for-byte, preserving their formatting and key order.
async function readRawIfExists(filePath) {
  try {
    return { existed: true, raw: await readFile(filePath, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") return { existed: false, raw: "" };
    throw error;
  }
}

/**
 * The @ai-sdk/anthropic provider appends `/messages` to its baseURL, so the
 * FireRouter base URL needs the `/v1` segment (FireRouter serves the Anthropic
 * Messages API at `/v1/messages`, same endpoint Claude Code targets).
 * @param {string} baseUrl
 */
export function firerouterAnthropicBaseUrl(baseUrl) {
  return `${normalizeFirerouterUrl(baseUrl || FIREROUTER_BASE_URL)}/v1`;
}

/** @param {object} config parsed opencode.json */
export function firerouterProviderStatus(config) {
  const options = config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.options ?? null;
  if (!options) return "other";
  if (options.headers?.[FIREROUTER_FIREWORKS_HEADER]) return "firerouter";
  if (typeof options.baseURL === "string" && isFirerouterBaseUrl(options.baseURL)) {
    return "firerouter";
  }
  return "other";
}

/** Current model id from opencode.json. We never pin it, so this is the user's. */
export function firerouterCurrentModel(config) {
  return typeof config.model === "string" && config.model ? config.model : null;
}

/**
 * Whether the Anthropic provider block still carries a direct Anthropic key after
 * FireRouter wiring is stripped. Used by the no-backup `off` path to avoid
 * dropping a user's pre-existing `anthropic/<model>` when direct Anthropic auth
 * remains usable.
 * @param {object} config parsed opencode.json (after stripFirerouterFromConfig)
 */
export function opencodeDirectAnthropicSetupWorks(config) {
  const apiKey = config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.options?.apiKey;
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}

/**
 * Whether `model` matches an `anthropic/<id>` ref the user had before router `on`.
 * @param {object | undefined | null} backup
 * @param {string} model
 */
export function hadPreExistingAnthropicModel(backup, model) {
  const priorModel = backup?.anthropicModelBeforeRouter;
  const prefix = `${OPENCODE_ANTHROPIC_PROVIDER_ID}/`;
  return typeof priorModel === "string"
    && priorModel.startsWith(prefix)
    && priorModel === model;
}

/**
 * Drop a router-injected `anthropic/<model>` ref when stripping leaves no direct
 * Anthropic auth and the model was not already the user's choice before router `on`.
 * @param {object} config parsed opencode.json (mutated)
 * @param {object | undefined | null} backup
 * @returns {boolean} whether config.model was removed
 */
export function dropStrandedAnthropicModelIfNeeded(config, backup) {
  const model = config.model;
  const prefix = `${OPENCODE_ANTHROPIC_PROVIDER_ID}/`;
  if (typeof model !== "string" || !model.startsWith(prefix)) {
    return false;
  }
  if (opencodeDirectAnthropicSetupWorks(config) || hadPreExistingAnthropicModel(backup, model)) {
    return false;
  }
  delete config.model;
  return true;
}

function _homeFromDataDir(dataDir) {
  // Mirror FIREROUTER_DATA_RELATIVE_DIR: <home>/.fireconnect/opencode/firerouter
  const opencodeDir = path.dirname(dataDir);
  const fireconnectDir = path.dirname(opencodeDir);
  if (
    path.basename(dataDir) !== "firerouter" ||
    path.basename(opencodeDir) !== "opencode" ||
    path.basename(fireconnectDir) !== ".fireconnect"
  ) {
    return "";
  }
  return path.dirname(fireconnectDir);
}

/**
 * Point OpenCode's Anthropic provider at FireRouter by overriding its baseURL
 * and adding the FireRouter auth headers. The provider, model references, and
 * the rest of opencode.json are left intact.
 *
 * @param {{
 *   configPath: string,
 *   dataDir: string,
 *   baseUrl?: string,
 *   mainModel?: string,
 *   fireworksKey: string,
 *   fireworksKeyFromFlag: boolean,
 *   anthropicKey?: string,
 *   anthropicKeyFromFlag?: boolean,
 * }} opts
 */
export async function enableFirerouterOpencode({
  configPath,
  dataDir,
  baseUrl = FIREROUTER_BASE_URL,
  mainModel = "",
  fireworksKey,
  fireworksKeyFromFlag,
  anthropicKey,
  anthropicKeyFromFlag,
}) {
  if (!fireworksKey) {
    throw new Error("No Fireworks API key found. Pass --api-key or set FIREWORKS_API_KEY.");
  }

  const snapshot = await readRawIfExists(configPath);
  let config = {};
  if (snapshot.existed && snapshot.raw.trim()) {
    try {
      config = JSON.parse(snapshot.raw);
    } catch {
      throw new Error(`${configPath} is not valid JSON`);
    }
  }

  // Snapshot the original config before the first change so `off` can restore it.
  const backupPath = firerouterBackupPath(dataDir, configPath);
  const hasBackup = (await readJsonIfExists(backupPath)).snapshot !== undefined;
  // A direct-mode backup (same filename, one dir up) means fireconnect is
  // already active on this config in direct mode — so the current config is
  // fireconnect-modified, and switching direct→router must not snapshot it over
  // the true original that the direct backup still holds. This is derived from
  // the backup's existence rather than `wasGloballyEnabled` so it also holds for
  // a custom --data-dir, where the home (hence global state) can't be derived.
  const directBackupPath = firerouterBackupPath(path.dirname(dataDir), configPath);
  const hasDirectBackup = (await readJsonIfExists(directBackupPath)).snapshot !== undefined;
  const hasAnyBackup = hasBackup || hasDirectBackup;
  // Treat both FireRouter routing and direct-mode Fireworks providers as
  // "already fireconnect-owned" so a fireconnect-modified config is never
  // mistaken for a user original worth backing up.
  const hasFirerouterRouting = firerouterProviderStatus(config) === "firerouter";
  const hasDirectFireworksProvider = DIRECT_FIREWORKS_PROVIDER_IDS.some(
    (id) => Boolean(config.provider?.[id]),
  );
  const hasFireconnectRouting = hasFirerouterRouting || hasDirectFireworksProvider;
  const home = _homeFromDataDir(dataDir);
  const wasGloballyEnabled = home ? await isHarnessEnabled(home, HARNESS.OPENCODE) : false;
  const shouldSnapshot = !hasAnyBackup
    ? !hasFireconnectRouting || !wasGloballyEnabled
    : !hasFireconnectRouting;

  if (shouldSnapshot) {
    // The snapshot can contain credentials from the user's other providers —
    // keep the backup (and its directory) private to the owner.
    const priorDisplayName = config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.name;
    const priorModel = typeof config.model === "string" ? config.model : "";
    /** @type {{ configPath: string, snapshot: { existed: boolean, raw: string }, anthropicDisplayNameBeforeRouter?: string, anthropicModelBeforeRouter?: string }} */
    const backupPayload = { configPath: path.resolve(configPath), snapshot };
    if (
      typeof priorDisplayName === "string"
      && priorDisplayName
      && priorDisplayName !== FIREROUTER_ANTHROPIC_PROVIDER_NAME
    ) {
      backupPayload.anthropicDisplayNameBeforeRouter = priorDisplayName;
    }
    if (priorModel.startsWith(`${OPENCODE_ANTHROPIC_PROVIDER_ID}/`)) {
      backupPayload.anthropicModelBeforeRouter = priorModel;
    }
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, backupPayload);
    await chmod(backupPath, 0o600);
  }

  // Write the resolved keys as PLAINTEXT so OpenCode loads them immediately — no
  // shell env hook / new shell required. Both values are already resolved to
  // real keys by the harness (flag > stored > env > keychain fallback);
  // `anthropicKey` is "" only in the auth.json runtime-auth case, where we leave
  // options.apiKey unset so OpenCode reads its own auth.json. The OS keychain
  // remains the source of truth (config.json {keychain:…}); the values written
  // here are just the immediately-usable copies. File is written 0600 below.
  const storedFireworksKey = fireworksKey;
  const storedAnthropicKey = anthropicKey || "";

  // Only the FireRouter Fireworks-key header is written. The Anthropic key goes
  // in options.apiKey (below) — OpenCode's @ai-sdk/anthropic provider derives
  // the x-api-key request header from apiKey itself, so a separate x-api-key
  // header entry is both redundant and insufficient (OpenCode resolves the
  // provider's auth from options.apiKey / auth.json, not from a raw header).
  const headers = buildFirerouterHttpHeaders({
    fireworksKey: storedFireworksKey,
  });

  const anthropic = { ...(config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID] ?? {}) };
  const existingOptions = anthropic.options ?? {};
  // Drop any FireRouter-owned headers we set on a prior `on` (e.g. a stale
  // x-api-key from an older FireConnect) before re-applying.
  const carriedHeaders = stripFirerouterHeaders({ ...(existingOptions.headers ?? {}) });
  const nextOptions = {
    ...existingOptions,
    baseURL: firerouterAnthropicBaseUrl(baseUrl),
    headers: { ...carriedHeaders, ...headers },
  };
  // OpenCode's @ai-sdk/anthropic provider reads `options.apiKey` (not a header)
  // to construct the client; without it the SDK throws "Anthropic API key is
  // missing" before any request. FireRouter authenticates via the
  // X-FireRouter-Fireworks-Key header, so this value is only passed through to
  // Anthropic. When there's no stored key (auth.json runtime auth), leave
  // apiKey unset so OpenCode resolves it from auth.json itself.
  if (storedAnthropicKey) {
    nextOptions.apiKey = storedAnthropicKey;
  } else {
    delete nextOptions.apiKey;
  }
  anthropic.options = nextOptions;
  anthropic.name = FIREROUTER_ANTHROPIC_PROVIDER_NAME;

  const provider = {
    ...(config.provider ?? {}),
    [OPENCODE_ANTHROPIC_PROVIDER_ID]: anthropic,
  };
  // Direct and FireRouter modes are mutually exclusive: drop the Fireworks
  // provider blocks that fireconnect's direct mode owns (kept as local strings
  // to avoid an import cycle with opencode-core.mjs).
  for (const id of DIRECT_FIREWORKS_PROVIDER_IDS) {
    delete provider[id];
  }
  // Make the active model reference the Anthropic provider so the retargeting
  // takes effect. An already-Anthropic model (incl. an in-session switch) is
  // preserved; only a non-Anthropic/unset model is replaced.
  const model = resolveAnthropicModelRef(mainModel, config.model);
  const next = { ...config, provider, model };

  // 0600: the config now holds plaintext API keys (Fireworks header + Anthropic apiKey).
  await writeJson(configPath, next, { mode: 0o600 });
  return {
    baseUrl: anthropic.options.baseURL,
    model,
    fireworksKeyMode: "literal",
    anthropicKeyMode: storedAnthropicKey ? "literal" : "unset",
  };
}

/** Remove FireRouter-owned header entries from a headers object (returns it). */
function stripFirerouterHeaders(headers) {
  delete headers[FIREROUTER_FIREWORKS_HEADER];
  delete headers["x-api-key"];
  return headers;
}

/**
 * Restore a config snapshot ({ existed, raw }) to `configPath` and remove the
 * backup file. Refuses to restore a snapshot recorded for a different config
 * file. Returns true when it restored (backup carried a snapshot), false when
 * the backup had nothing to restore. Shared by both the direct and FireRouter
 * `off` paths, including their cross-mode fallbacks.
 * @param {{ configPath: string, backupPath: string, backup: { snapshot?: { existed: boolean, raw: string }, configPath?: string } }} args
 */
export async function restoreOpencodeSnapshot({ configPath, backupPath, backup }) {
  if (!backup || backup.snapshot === undefined) {
    return false;
  }
  // Refuse to restore a snapshot taken for a different config file (legacy
  // un-keyed backups have no configPath recorded).
  if (backup.configPath !== undefined && backup.configPath !== path.resolve(configPath)) {
    throw new Error(
      `Backup at ${backupPath} was taken for ${backup.configPath}, not ${configPath}; refusing to restore.`,
    );
  }
  if (backup.snapshot.existed) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFileAtomic(configPath, backup.snapshot.raw);
  } else {
    try {
      await unlink(configPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await unlink(backupPath);
  return true;
}

export async function disableFirerouterOpencode({ configPath, dataDir, wasEnabled = false }) {
  const backupPath = firerouterBackupPath(dataDir, configPath);
  const backup = await readJsonIfExists(backupPath);
  const config = await readJsonIfExists(configPath);
  const status = firerouterProviderStatus(config);
  const hasBackup = backup.snapshot !== undefined;

  // Cross-mode fallback: when router `on` took over from direct mode, the true
  // pre-fireconnect original lives in the direct backup (same filename, one dir
  // up from the firerouter data dir). Consult it so router→direct→off never
  // strands a fireconnect-modified config.
  const directBackupPath = firerouterBackupPath(path.dirname(dataDir), configPath);
  const directBackup = hasBackup ? null : await readJsonIfExists(directBackupPath);
  const hasDirectBackup = directBackup?.snapshot !== undefined;

  if (!wasEnabled && !hasBackup && !hasDirectBackup && status !== "firerouter") {
    return;
  }

  if (await restoreOpencodeSnapshot({ configPath, backupPath, backup })) {
    return;
  }
  if (hasDirectBackup
    && await restoreOpencodeSnapshot({ configPath, backupPath: directBackupPath, backup: directBackup })) {
    return;
  }

  // No backup in either mode: strip only the FireRouter wiring we own from the
  // anthropic provider, and only touch the file if we actually removed something.
  const { existed } = await readRawIfExists(configPath);
  if (!existed) return;
  const liveConfig = await readJsonIfExists(configPath);
  const restoreName = backup.anthropicDisplayNameBeforeRouter;
  let changed = stripFirerouterFromConfig(liveConfig, { restoreAnthropicDisplayName: restoreName });
  // Drop only router-injected `anthropic/<model>` refs that would be stranded
  // after stripping (no direct Anthropic key and not the user's pre-router model).
  if (dropStrandedAnthropicModelIfNeeded(liveConfig, backup)) {
    changed = true;
  }
  if (changed) {
    await writeJson(configPath, liveConfig);
  }
}

/**
 * @param {object | undefined | null} backup
 */
export function anthropicDisplayNameBeforeRouter(backup) {
  const name = backup?.anthropicDisplayNameBeforeRouter;
  return typeof name === "string" && name ? name : "";
}

/**
 * The Anthropic provider's `options.apiKey` in the pre-router snapshot, if any.
 * Lets teardown tell a FireRouter-written key (strip) from a user's own
 * pre-existing key (preserve). Returns "" when the snapshot had no such key.
 * @param {object | undefined | null} backup
 */
export function anthropicApiKeyBeforeRouter(backup) {
  const raw = backup?.snapshot?.raw;
  if (typeof raw !== "string" || !raw.trim()) return "";
  try {
    const prior = JSON.parse(raw);
    const key = prior?.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.options?.apiKey;
    return typeof key === "string" ? key : "";
  } catch {
    return "";
  }
}

/**
 * Remove the FireRouter wiring we own (baseURL, headers, apiKey, display name)
 * from the Anthropic provider, cleaning up any containers we leave empty.
 * Mutates `config` and returns whether anything changed. Used by `off`
 * (no-backup path) and by the direct Fireworks path, so the two modes never
 * coexist on one config.
 *
 * `priorApiKey` (when the caller has the pre-router snapshot) is the Anthropic
 * `options.apiKey` from before router mode. A FireRouter-owned apiKey is removed
 * when it's the `{env:ANTHROPIC_API_KEY}` ref OR when it differs from
 * `priorApiKey` (i.e. we introduced it) — a user's own pre-existing key is kept.
 * When `priorApiKey` is undefined (no snapshot available), only the env ref is
 * stripped, so we never delete a literal key we can't prove we wrote.
 * @param {object} config parsed opencode.json
 * @param {{ restoreAnthropicDisplayName?: string, priorApiKey?: string }} [stripOptions]
 */
export function stripFirerouterFromConfig(config, stripOptions = {}) {
  const anthropic = config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID];
  if (!anthropic) return false;

  let changed = false;
  const options = anthropic.options;
  if (options) {
    // Only touch an apiKey in a block we own: FireRouter header and/or baseURL present.
    const firerouterOwned = Boolean(options.headers && FIREROUTER_FIREWORKS_HEADER in options.headers)
      || (typeof options.baseURL === "string" && isFirerouterBaseUrl(options.baseURL));
    if (options.headers && FIREROUTER_FIREWORKS_HEADER in options.headers) {
      stripFirerouterHeaders(options.headers);
      changed = true;
    }
    if (typeof options.baseURL === "string" && isFirerouterBaseUrl(options.baseURL)) {
      delete options.baseURL;
      changed = true;
    }
    // Strip the apiKey we wrote into options (the on-path now stores the
    // Anthropic key here, not as an x-api-key header). The env ref is
    // unambiguously ours; a literal is removed only when priorApiKey proves it
    // differs from the user's pre-router value.
    if (firerouterOwned && "apiKey" in options) {
      const isEnvRef = options.apiKey === ANTHROPIC_KEY_ENV_REF;
      const introducedByRouter = stripOptions.priorApiKey !== undefined
        && options.apiKey !== stripOptions.priorApiKey;
      if (isEnvRef || introducedByRouter) {
        delete options.apiKey;
        changed = true;
      }
    }
  }
  if (anthropic.name === FIREROUTER_ANTHROPIC_PROVIDER_NAME) {
    delete anthropic.name;
    const restoreName = stripOptions.restoreAnthropicDisplayName?.trim() ?? "";
    if (restoreName && restoreName !== FIREROUTER_ANTHROPIC_PROVIDER_NAME) {
      anthropic.name = restoreName;
    }
    changed = true;
  }
  if (!changed) return false;

  if (options) {
    if (options.headers && Object.keys(options.headers).length === 0) {
      delete options.headers;
    }
    if (Object.keys(options).length === 0) {
      delete anthropic.options;
    }
  }
  if (Object.keys(anthropic).length === 0) {
    delete config.provider[OPENCODE_ANTHROPIC_PROVIDER_ID];
  }
  if (config.provider && Object.keys(config.provider).length === 0) {
    delete config.provider;
  }
  return true;
}
