import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readJsonIfExists, writeJson } from "./fireconnect-core.mjs";
import {
  buildFirerouterHttpHeaders,
  FIREROUTER_BASE_URL,
  FIREROUTER_FIREWORKS_HEADER,
  isFirerouterBaseUrl,
  normalizeFirerouterUrl,
} from "./firerouter-core.mjs";
import { isHarnessEnabled } from "./global-config.mjs";
import { HARNESS } from "./harness.mjs";

export { FIREROUTER_BASE_URL } from "./firerouter-core.mjs";
export const FIREROUTER_DATA_RELATIVE_DIR = ".fireconnect/opencode/firerouter";
export const ANTHROPIC_KEY_ENV_REF = "{env:ANTHROPIC_API_KEY}";
export const FIREWORKS_KEY_ENV_REF = "{env:FIREWORKS_API_KEY}";

// We retarget OpenCode's built-in Anthropic provider instead of adding our own.
// Users keep `anthropic/<model>` references and can switch models in-session;
// FireRouter mode only redirects where those requests are sent.
export const OPENCODE_ANTHROPIC_PROVIDER_ID = "anthropic";

// OpenCode merges provider.name into the built-in registry for UI display.
export const FIREROUTER_ANTHROPIC_PROVIDER_NAME = "Anthropic (FireRouter)";

// Last-resort default for the active model when none can be derived from the
// flag, env override, or FireRouter's advertised config (offline first run).
// Prefer resolveFirerouterDefaultModel() — the deployment is the source of truth.
export const FALLBACK_FIREROUTER_MAIN_MODEL = "claude-opus-4-8";

// Operator/CI override so a default model can be pinned without --main and
// without a network call. Takes precedence over the well-known fetch.
export const FIREROUTER_MAIN_MODEL_ENV = "FIRECONNECT_ROUTER_MAIN_MODEL";

// FireRouter advertises its configured opencode bootstrap (incl. the default
// model) at this path off the proxy root.
const WELL_KNOWN_OPENCODE_PATH = "/.well-known/opencode.json";
const WELL_KNOWN_TIMEOUT_MS = 5000;

// Provider ids owned by fireconnect's direct (Fireworks) mode. Mirrors
// OPENCODE_FIREWORKS_PROVIDER_ID + its legacy alias from opencode-core.mjs.
const DIRECT_FIREWORKS_PROVIDER_IDS = ["fireworks-ai", "fireworks"];

/**
 * Resolve the default Anthropic model for FireRouter mode. The deployment is the
 * source of truth: read it from `{baseUrl}/.well-known/opencode.json` (the same
 * config OpenCode/Claude Code bootstrap from). Precedence:
 *   FIRECONNECT_ROUTER_MAIN_MODEL env > well-known fetch > bundled fallback.
 * Only Claude-shaped server defaults are honored (this retargets the Anthropic
 * provider, so a gpt-5.x deployment default wouldn't apply); anything else falls
 * back. Always resolves — never throws — so `on` works offline.
 * @param {string} baseUrl FireRouter root (no /v1 suffix)
 * @returns {Promise<string>} bare model id (no provider prefix)
 */
export async function resolveFirerouterDefaultModel(baseUrl) {
  const override = process.env[FIREROUTER_MAIN_MODEL_ENV]?.trim();
  if (override) return override;
  const fetched = await _fetchFirerouterMainModel(baseUrl);
  if (fetched && /^claude/i.test(fetched)) return fetched;
  return FALLBACK_FIREROUTER_MAIN_MODEL;
}

async function _fetchFirerouterMainModel(baseUrl) {
  const root = normalizeFirerouterUrl(baseUrl || FIREROUTER_BASE_URL);
  try {
    const res = await fetch(`${root}${WELL_KNOWN_OPENCODE_PATH}`, {
      signal: AbortSignal.timeout(WELL_KNOWN_TIMEOUT_MS),
    });
    if (!res.ok) return "";
    const config = await res.json();
    const model = typeof config?.model === "string" ? config.model : "";
    // Advertised as "<provider>/<id>" (e.g. firerouter/claude-opus-4-8); we want
    // the bare id to hang off the Anthropic provider.
    const slash = model.indexOf("/");
    return slash === -1 ? model : model.slice(slash + 1);
  } catch {
    return "";
  }
}

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
  const hasFirerouterRouting = firerouterProviderStatus(config) === "firerouter";
  const home = _homeFromDataDir(dataDir);
  const wasGloballyEnabled = home ? await isHarnessEnabled(home, HARNESS.OPENCODE) : false;
  const shouldSnapshot = !hasBackup
    ? !hasFirerouterRouting || !wasGloballyEnabled
    : !hasFirerouterRouting;

  if (shouldSnapshot) {
    // The snapshot can contain credentials from the user's other providers —
    // keep the backup (and its directory) private to the owner.
    const priorDisplayName = config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.name;
    /** @type {{ configPath: string, snapshot: { existed: boolean, raw: string }, anthropicDisplayNameBeforeRouter?: string }} */
    const backupPayload = { configPath: path.resolve(configPath), snapshot };
    if (
      typeof priorDisplayName === "string"
      && priorDisplayName
      && priorDisplayName !== FIREROUTER_ANTHROPIC_PROVIDER_NAME
    ) {
      backupPayload.anthropicDisplayNameBeforeRouter = priorDisplayName;
    }
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, backupPayload);
    await chmod(backupPath, 0o600);
  }

  const storedFireworksKey = fireworksKeyFromFlag ? fireworksKey : FIREWORKS_KEY_ENV_REF;
  const storedAnthropicKey = anthropicKey
    ? (anthropicKeyFromFlag ? anthropicKey : ANTHROPIC_KEY_ENV_REF)
    : "";

  const headers = buildFirerouterHttpHeaders({
    fireworksKey: storedFireworksKey,
    anthropicKey: storedAnthropicKey,
  });

  const anthropic = { ...(config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID] ?? {}) };
  const existingOptions = anthropic.options ?? {};
  // Drop any FireRouter-owned headers we set on a prior `on` (e.g. a stale
  // x-api-key) before re-applying.
  const carriedHeaders = stripFirerouterHeaders({ ...(existingOptions.headers ?? {}) });
  anthropic.options = {
    ...existingOptions,
    baseURL: firerouterAnthropicBaseUrl(baseUrl),
    headers: { ...carriedHeaders, ...headers },
  };
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

  await writeJson(configPath, next);
  return {
    baseUrl: anthropic.options.baseURL,
    model,
    fireworksKeyMode: fireworksKeyFromFlag ? "literal" : "env-reference",
    anthropicKeyMode: storedAnthropicKey
      ? (anthropicKeyFromFlag ? "literal" : "env-reference")
      : "unset",
  };
}

/** Remove FireRouter-owned header entries from a headers object (returns it). */
function stripFirerouterHeaders(headers) {
  delete headers[FIREROUTER_FIREWORKS_HEADER];
  delete headers["x-api-key"];
  return headers;
}

export async function disableFirerouterOpencode({ configPath, dataDir, wasEnabled = false }) {
  const backupPath = firerouterBackupPath(dataDir, configPath);
  const backup = await readJsonIfExists(backupPath);
  const config = await readJsonIfExists(configPath);
  const status = firerouterProviderStatus(config);
  const hasBackup = backup.snapshot !== undefined;

  if (!wasEnabled && !hasBackup && status !== "firerouter") {
    return;
  }

  // Refuse to restore a snapshot taken for a different config file.
  if (
    backup.configPath !== undefined &&
    backup.configPath !== path.resolve(configPath)
  ) {
    throw new Error(
      `Backup at ${backupPath} was taken for ${backup.configPath}, not ${configPath}; refusing to restore.`,
    );
  }

  if (backup.snapshot !== undefined) {
    if (backup.snapshot.existed) {
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, backup.snapshot.raw, "utf8");
    } else {
      try {
        await unlink(configPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await unlink(backupPath);
    return;
  }

  // No backup: strip only the FireRouter wiring we own from the anthropic
  // provider, and only touch the file if we actually removed something.
  const { existed } = await readRawIfExists(configPath);
  if (!existed) return;
  const liveConfig = await readJsonIfExists(configPath);
  const restoreName = backup.anthropicDisplayNameBeforeRouter;
  if (stripFirerouterFromConfig(liveConfig, { restoreAnthropicDisplayName: restoreName })) {
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
 * Remove the FireRouter wiring we own (baseURL, headers, display name) from the
 * Anthropic provider, cleaning up any containers we leave empty. Mutates
 * `config` and returns whether anything changed. Used by `off` (no-backup path)
 * and by the direct Fireworks path, so the two modes never coexist on one config.
 * @param {object} config parsed opencode.json
 * @param {{ restoreAnthropicDisplayName?: string }} [options]
 */
export function stripFirerouterFromConfig(config, stripOptions = {}) {
  const anthropic = config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID];
  if (!anthropic) return false;

  let changed = false;
  const options = anthropic.options;
  if (options) {
    if (options.headers && FIREROUTER_FIREWORKS_HEADER in options.headers) {
      stripFirerouterHeaders(options.headers);
      changed = true;
    }
    if (typeof options.baseURL === "string" && isFirerouterBaseUrl(options.baseURL)) {
      delete options.baseURL;
      changed = true;
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
