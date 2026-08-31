import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../../io/atomic-write.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";

import {
  applyClaudeCodeContextPolicy,
  claudeCodeModelId,
  ensureCatalogForClaudeCodeContext,
  stripClaudeCodeContextSuffix,
} from "./code-context.mjs";
import {
  buildClaudeCustomHeaders,
  fireworksKeyFromCustomHeaders,
  setFireworksKeyInCustomHeaders,
  stripFireworksKeyFromCustomHeaders,
  stripFirerouterOwnedEnv,
  stripManagedCustomHeaderLines,
} from "../../firerouter/core.mjs";
import { lookupModelSpec, FIREWORKS_PRICING_DOCS_URL, resolveFireworksModelLabel, appendLatestRouterSuffix } from "../../fireworks/model-specs.mjs";
import { formatPricingDescription, lookupFireworksPricing } from "../../fireworks/pricing.mjs";
import { autoDisplayName, prettyModelName, stripViaFireworksSuffix } from "../../fireworks/models.mjs";
import {
  CLAUDE_NATIVE_MODEL_ID,
  DEEPSEEK_FLASH_LATEST_ROUTER_ID,
  DEEPSEEK_PRO_LATEST_ROUTER_ID,
  FIREWORKS_BASE_URL,
  GLM_FAST_LATEST_ROUTER_ID,
  KIMI_FAST_LATEST_ROUTER_ID,
  isAutoModelId,
  isClaudeModelAlias,
  isClaudeNativeModel,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import {
  detectApiKeyType,
  fireworksKeyOrEmpty,
  isFireworksShapedKey,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "../../keys/key-type.mjs";
import {
  buildFireconnectTelemetryHeaders,
  mergeFireconnectTelemetryHeaderLines,
  stripFireconnectTelemetryHeaderLines,
} from "../../telemetry/request-headers.mjs";
import {
  mappingUsesFirerouter,
  resolveClaudeModelMapping,
} from "./model-profile.mjs";
import { stripClaudeStatusLine, withClaudeStatusLine } from "./statusline.mjs";

export const DEFAULT_DATA_DIR = ".fireconnect/claude";
export const USER_SETTINGS_RELATIVE_PATH = ".claude/settings.json";

/** Legacy main-default env keys stripped when writing FireConnect-managed settings. */
const LEGACY_ANTHROPIC_MAIN_ENV_KEYS = ["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"];

export const FIREWORKS_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  // Legacy main default; kept so off/restore paths can strip pre-v0.9 installs.
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
  "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
  "CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE",
  "DISABLE_TELEMETRY",
  "DO_NOT_TRACK",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "ENABLE_TOOL_SEARCH",
];

/** Env keys that steer Claude Code client-side model selection. */
export const MODEL_MAPPING_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
];

/** Claude Code behavior tuning shared by direct and router modes (not model mapping). */
export const CLAUDE_CODE_BEHAVIOR_ENV = {
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
  CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE: "0",
  // Cut Statsig/GrowthBook, Datadog, and other Anthropic-bound nonessential startup traffic.
  // See Claude Code env vars: DISABLE_TELEMETRY, DO_NOT_TRACK,
  // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC.
  DISABLE_TELEMETRY: "1",
  DO_NOT_TRACK: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  // Claude Code disables MCP tool search when ANTHROPIC_BASE_URL is not
  // api.anthropic.com. Force it on so deferred tool_reference loading still
  // works through the Fireworks gateway.
  ENABLE_TOOL_SEARCH: "true",
};

export const DEFAULT_FIREWORKS_PRESET = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: KIMI_FAST_LATEST_ROUTER_ID,
  ANTHROPIC_DEFAULT_SONNET_MODEL: GLM_FAST_LATEST_ROUTER_ID,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: DEEPSEEK_FLASH_LATEST_ROUTER_ID,
  ANTHROPIC_DEFAULT_FABLE_MODEL: DEEPSEEK_PRO_LATEST_ROUTER_ID,
  ...CLAUDE_CODE_BEHAVIOR_ENV,
};

export const DEFAULT_FIREPASS_PRESET = {
  ...DEFAULT_FIREWORKS_PRESET,
  ANTHROPIC_DEFAULT_OPUS_MODEL: KIMI_FAST_LATEST_ROUTER_ID,
  ANTHROPIC_DEFAULT_SONNET_MODEL: KIMI_FAST_LATEST_ROUTER_ID,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: KIMI_FAST_LATEST_ROUTER_ID,
  ANTHROPIC_DEFAULT_FABLE_MODEL: KIMI_FAST_LATEST_ROUTER_ID,
  CLAUDE_CODE_SUBAGENT_MODEL: KIMI_FAST_LATEST_ROUTER_ID,
};

export function resolveDataDir({ home, dataDir = "" }) {
  if (dataDir) {
    return dataDir;
  }

  return path.join(home, DEFAULT_DATA_DIR);
}

export function userSettingsPath(home, settingsPath = "") {
  if (settingsPath) {
    return settingsPath;
  }
  return path.join(home, USER_SETTINGS_RELATIVE_PATH);
}

export function providerBackupPath(dataDir) {
  return path.join(dataDir, "provider-backup.json");
}

export function providerStatePath(dataDir) {
  return path.join(dataDir, "provider-state.json");
}

function stripMappedModelId(value) {
  return value ? stripClaudeCodeContextSuffix(value) : value;
}

/**
 * Read the active Claude Code slot mapping from settings on disk. Main uses the
 * top-level `model` field (where `/model` persists); legacy installs may still
 * have `env.ANTHROPIC_MODEL`, which is honored as a fallback until
 * `fireconnect claude` strips it.
 *
 * @param {{ model?: string, env?: Record<string, string> }} settings
 */
export function mappingFromSettings(settings = {}) {
  const env = settings.env ?? {};
  const mainFromModel = typeof settings.model === "string" && settings.model.trim()
    ? stripMappedModelId(settings.model.trim())
    : null;
  // A bare Claude Code `/model` picker alias (opus/sonnet/haiku/fable) names no
  // concrete model: it resolves at request time through the alias's own env slot,
  // which the slot rows below already report. Treat it as unpinned (native) main
  // instead of misreading the user's picker choice as a FireConnect model pin.
  const mainAliasPicked = isClaudeModelAlias(mainFromModel);
  const mainFromEnv = env.ANTHROPIC_MODEL
    ? stripMappedModelId(env.ANTHROPIC_MODEL)
    : null;
  const routed = providerStatusFromEnv(env) === "fireworks";
  // A routed install with an unset alias slot means "use Claude's own default
  // (Anthropic) model" — but only for non-Fire Pass keys (Fire Pass skips the
  // native-Claude setup entirely). Unset pins surface as the native sentinel so
  // live reads agree with what `on` persisted; Fire Pass falls through to the
  // Fireworks default display instead.
  const gatewayKey = fireworksKeyOrEmpty(
    fireworksKeyFromCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS),
  ) || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "";
  const firepass = routed && detectApiKeyType(gatewayKey) === "firepass";
  const native = routed && !firepass ? CLAUDE_NATIVE_MODEL_ID : null;
  const resolvedMain = (mainFromModel && !mainAliasPicked ? mainFromModel : null) || mainFromEnv;
  return {
    main: resolvedMain || native,
    opus: stripMappedModelId(env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? null) || native,
    sonnet: stripMappedModelId(env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? null) || native,
    haiku: stripMappedModelId(env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? null) || native,
    fable: stripMappedModelId(env.ANTHROPIC_DEFAULT_FABLE_MODEL ?? null) || native,
    subagent: stripMappedModelId(env.CLAUDE_CODE_SUBAGENT_MODEL ?? null) || native,
  };
}

function withoutLegacyAnthropicMainEnv(env = {}) {
  if (!env.ANTHROPIC_MODEL && !env.ANTHROPIC_SMALL_FAST_MODEL) {
    return env;
  }
  const next = { ...env };
  for (const key of LEGACY_ANTHROPIC_MAIN_ENV_KEYS) {
    delete next[key];
  }
  return next;
}

/**
 * Return true when FireConnect-routed settings still carry the legacy main env key
 * that overrides Claude Code's top-level `model` field (including `/model` picks).
 *
 * @param {{ env?: Record<string, string> }} settings
 */
export function hasLegacyAnthropicMainEnv(settings = {}) {
  const env = settings.env ?? {};
  return Boolean(
    (env.ANTHROPIC_MODEL || env.ANTHROPIC_SMALL_FAST_MODEL)
    && providerStatusFromEnv(env) === "fireworks",
  );
}

export function fireworksHostnameFromBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return "";
  }
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "fireworks.ai" || hostname.endsWith(".fireworks.ai")
      ? hostname
      : "";
  } catch {
    return "";
  }
}

/**
 * Recover active FireConnect intent from current settings. A Fireworks
 * hostname is not sufficient by itself: backup/state, a managed helper/header,
 * telemetry, or FireConnect's model mapping must also identify ownership.
 */
export function claudeFireconnectIntent(settings, { backup = {}, state = {} } = {}) {
  const env = settings.env ?? {};
  const hostname = fireworksHostnameFromBaseUrl(env.ANTHROPIC_BASE_URL);
  if (!hostname) {
    return null;
  }

  const mapping = mappingFromSettings(settings);
  const headers = env.ANTHROPIC_CUSTOM_HEADERS;
  const hasFireworksMapping = Object.values(mapping).some(Boolean);
  const hasTelemetry = typeof headers === "string"
    && stripFireconnectTelemetryHeaderLines(headers) !== headers;
  const hasCurrentManagedHeader = isFireworksShapedKey(
    fireworksKeyFromCustomHeaders(headers),
  ) && hasFireworksMapping;
  const hasManagedEvidence = backup.snapshot !== undefined
    || backup.values !== undefined
    || Boolean(state.authMode || state.managedApiKeyHelper)
    || stripManagedApiKeyHelper(settings, state).changed
    || env.ANTHROPIC_API_KEY === "fireconnect"
    || hasTelemetry
    || hasCurrentManagedHeader;
  if (!hasManagedEvidence) {
    return null;
  }

  return {
    hostname,
    mode: "direct",
    mapping,
    needsUpgrade: backup.snapshot === undefined,
  };
}

export function providerStatusFromEnv(env) {
  if (env.ANTHROPIC_BASE_URL === FIREWORKS_BASE_URL) {
    return "fireworks";
  }
  if (env.ANTHROPIC_BASE_URL) {
    return "custom";
  }
  return "default";
}

/**
 * Raw-text snapshot of a settings file (not parsed JSON) so `off` can restore it
 * byte-for-byte, preserving the user's formatting and key order — the same
 * approach the other harnesses use.
 * @param {string} filePath
 * @returns {Promise<{ existed: boolean, raw: string }>}
 */
export async function readRawIfExists(filePath) {
  try {
    return { existed: true, raw: await readFile(filePath, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { existed: false, raw: "" };
    }
    throw error;
  }
}

/**
 * Snapshot the settings file at `settingsPath` into `backupPath` as raw text,
 * recording the absolute path it was taken for. Owner-private (0600 file in a
 * 0700 dir) since the settings can hold credentials.
 * @param {{ settingsPath: string, backupPath: string }} opts
 */
export async function writeSettingsSnapshotBackup({ settingsPath, backupPath }) {
  await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  const snapshot = await readRawIfExists(settingsPath);
  await writeJson(backupPath, { configPath: path.resolve(settingsPath), snapshot }, { mode: 0o600 });
}

/**
 * Restore a raw settings snapshot byte-for-byte (or delete the file when it
 * didn't exist), then remove the backup. Returns false when `backup` isn't a
 * raw snapshot (caller falls back to a legacy/surgical path). Refuses to restore
 * a snapshot taken for a different file.
 * @param {{ settingsPath: string, backupPath: string, backup: any }} opts
 * @returns {Promise<boolean>}
 */
export async function restoreSettingsSnapshotBackup({ settingsPath, backupPath, backup }) {
  if (!backup || backup.snapshot === undefined) {
    return false;
  }
  if (backup.configPath !== undefined && backup.configPath !== path.resolve(settingsPath)) {
    throw new Error(
      `Backup at ${backupPath} was taken for ${backup.configPath}, not ${settingsPath}; refusing to restore.`,
    );
  }
  if (backup.snapshot.existed) {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFileAtomic(settingsPath, backup.snapshot.raw);
  } else {
    await unlink(settingsPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  await unlink(backupPath).catch(() => {});
  return true;
}

export function claudeFireworksKeyFrom({ env = {} } = {}) {
  return fireworksKeyOrEmpty(env.ANTHROPIC_API_KEY)
    || fireworksKeyOrEmpty(env.ANTHROPIC_AUTH_TOKEN)
    // Direct mode stores the key in the X-Fireworks-Api-Key custom header.
    || fireworksKeyOrEmpty(fireworksKeyFromCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS));
}

export function applyTopLevelBackup(settings, topLevelBackup) {
  const next = { ...settings };
  if (!topLevelBackup?.values) {
    return next;
  }

  for (const [key, value] of Object.entries(topLevelBackup.values)) {
    next[key] = value;
  }
  for (const key of topLevelBackup.missing ?? []) {
    delete next[key];
  }
  return next;
}

export function clearFireworksTopLevelWithoutBackup(settings) {
  const next = { ...settings };
  if (Object.hasOwn(next, "model")) {
    delete next.model;
  }
  return next;
}

/**
 * Remove FireConnect-managed apiKeyHelper after disable. Returns
 * { settings, changed } like the sibling strip helpers (stripFireworksOwnedEnv,
 * stripModelMappingEnv) so callers don't have to compare apiKeyHelper before
 * and after to detect a change.
 * @param {Record<string, unknown>} settings
 * @param {{ authMode?: string, managedApiKeyHelper?: string }} state
 * @returns {{ settings: Record<string, unknown>, changed: boolean }}
 */
export function stripManagedApiKeyHelper(settings, state = {}) {
  if (!Object.hasOwn(settings, "apiKeyHelper")) {
    return { settings, changed: false };
  }

  const managedHelper = state.managedApiKeyHelper;
  const currentHelper = settings.apiKeyHelper;
  const isRecordedHelper = Boolean(managedHelper) && currentHelper === managedHelper;
  const isLegacyFireconnectHelper = typeof currentHelper === "string"
    && /(?:^|[/\\])fireconnect(?:\.mjs)?['"]?(?:\s|$)/.test(currentHelper)
    && /(?:^|\s)key\s+export(?:\s|$)/.test(currentHelper);
  // authMode describes the prior FireConnect configuration, not ownership of
  // a helper that may just have been restored from the user's backup.
  if (isRecordedHelper || isLegacyFireconnectHelper) {
    const next = { ...settings };
    delete next.apiKeyHelper;
    return { settings: next, changed: true };
  }

  return { settings, changed: false };
}

/**
 * Construct the safest baseline possible when upgrading a managed legacy
 * configuration that has no backup. The caller must establish ownership with
 * claudeFireconnectIntent before using this destructive strip.
 */
export function stripFireconnectManagedClaudeSettings(settings, state = {}) {
  const nextEnv = { ...(settings.env ?? {}) };
  for (const key of FIREWORKS_ENV_KEYS) {
    delete nextEnv[key];
  }
  if (typeof nextEnv.ANTHROPIC_CUSTOM_HEADERS === "string") {
    const headers = stripManagedCustomHeaderLines(nextEnv.ANTHROPIC_CUSTOM_HEADERS);
    if (headers) {
      nextEnv.ANTHROPIC_CUSTOM_HEADERS = headers;
    } else {
      delete nextEnv.ANTHROPIC_CUSTOM_HEADERS;
    }
  }

  let nextSettings = { ...settings, env: nextEnv };
  nextSettings = clearFireworksTopLevelWithoutBackup(nextSettings);
  nextSettings = stripClaudeStatusLine(nextSettings).settings;
  return stripManagedApiKeyHelper(nextSettings, state).settings;
}

function isFireworksOwnedEnvEntry(key, value, env) {
  if (key === "ANTHROPIC_BASE_URL") {
    return value === FIREWORKS_BASE_URL;
  }
  if (key === "ANTHROPIC_API_KEY" || key === "ANTHROPIC_AUTH_TOKEN") {
    return isFireworksShapedKey(value);
  }
  if (env.ANTHROPIC_BASE_URL === FIREWORKS_BASE_URL) {
    return true;
  }
  return false;
}

/**
 * Remove only env entries FireConnect owns — never strip user Anthropic keys.
 * @param {Record<string, string>} env
 */
export function stripFireworksOwnedEnv(env) {
  const nextEnv = { ...env };
  let changed = false;
  for (const key of FIREWORKS_ENV_KEYS) {
    if (!Object.hasOwn(nextEnv, key)) {
      continue;
    }
    if (isFireworksOwnedEnvEntry(key, nextEnv[key], env)) {
      delete nextEnv[key];
      changed = true;
    }
  }
  // Direct mode authenticates via an X-Fireworks-Api-Key line in
  // ANTHROPIC_CUSTOM_HEADERS (not one of FIREWORKS_ENV_KEYS); strip that line so
  // `off` never leaves a plaintext Fireworks key, preserving any user lines.
  if (typeof nextEnv.ANTHROPIC_CUSTOM_HEADERS === "string") {
    const stripped = stripFireconnectTelemetryHeaderLines(
      stripFireworksKeyFromCustomHeaders(nextEnv.ANTHROPIC_CUSTOM_HEADERS),
    );
    if (stripped !== nextEnv.ANTHROPIC_CUSTOM_HEADERS) {
      if (stripped) {
        nextEnv.ANTHROPIC_CUSTOM_HEADERS = stripped;
      } else {
        delete nextEnv.ANTHROPIC_CUSTOM_HEADERS;
      }
      changed = true;
    }
  }
  return { env: nextEnv, changed };
}

/**
 * Remove client-side model mapping env entries (for FireRouter server-side routing).
 * @param {Record<string, string>} env
 */
export function stripModelMappingEnv(env) {
  const nextEnv = { ...env };
  let changed = false;
  for (const key of MODEL_MAPPING_ENV_KEYS) {
    if (Object.hasOwn(nextEnv, key)) {
      delete nextEnv[key];
      changed = true;
    }
  }
  return { env: nextEnv, changed };
}

/**
 * Human-readable label for Fireworks models in Claude Code's subscription picker.
 * Prefer catalog/spec labels over raw slugs.
 * @param {string} modelId
 * @returns {string}
 */
export function fireworksModelPickerName(modelId) {
  if (isAutoModelId(modelId)) {
    return autoDisplayName(modelId);
  }
  const liveLabel = resolveFireworksModelLabel(modelId);
  if (liveLabel) {
    return stripViaFireworksSuffix(liveLabel);
  }
  const spec = lookupModelSpec(modelId);
  if (spec?.label) {
    return stripViaFireworksSuffix(appendLatestRouterSuffix(modelId, spec.label));
  }
  const pricing = lookupFireworksPricing(modelId);
  const label = pricing?.label ?? prettyModelName(modelId);
  return stripViaFireworksSuffix(appendLatestRouterSuffix(modelId, label));
}

function fireworksModelPickerDescription(modelId) {
  const liveLabel = resolveFireworksModelLabel(modelId);
  const pricing = lookupFireworksPricing(modelId);
  if (pricing) {
    const label = liveLabel
      ?? appendLatestRouterSuffix(modelId, stripViaFireworksSuffix(pricing.label));
    return formatPricingDescription({
      ...pricing,
      label: stripViaFireworksSuffix(label),
    });
  }
  const label = stripViaFireworksSuffix(
    liveLabel
      ?? appendLatestRouterSuffix(modelId, lookupModelSpec(modelId)?.label ?? prettyModelName(modelId)),
  );
  return `Fireworks serverless (${label}). Rates: ${FIREWORKS_PRICING_DOCS_URL}`;
}

/**
 * Human-readable name + pricing blurb for a Claude Code alias slot env prefix
 * (e.g. ANTHROPIC_DEFAULT_OPUS_MODEL -> ..._NAME / ..._DESCRIPTION).
 * @param {string} modelId
 * @param {string} envPrefix
 * @returns {Record<string, string>}
 */
export function fireworksModelDisplayFields(modelId, envPrefix) {
  const description = fireworksModelPickerDescription(modelId);
  return {
    [`${envPrefix}_NAME`]: fireworksModelPickerName(modelId),
    [`${envPrefix}_DESCRIPTION`]: description,
  };
}

/** Env keys for the extra /model picker row; not set (main uses top-level `model`). */
const CUSTOM_MODEL_OPTION_ENV_KEYS = [
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
];

export function stripCustomModelOptionEnv(env) {
  const nextEnv = { ...env };
  for (const key of CUSTOM_MODEL_OPTION_ENV_KEYS) {
    delete nextEnv[key];
  }
  return nextEnv;
}

export function fireworksFableOptionFields(fableModelId) {
  const resolved = shortFireworksModelRef(claudeCodeModelId(fableModelId));
  return {
    ANTHROPIC_DEFAULT_FABLE_MODEL: resolved,
    ...fireworksModelDisplayFields(fableModelId, "ANTHROPIC_DEFAULT_FABLE_MODEL"),
  };
}

/** Subscription picker labels for opus/sonnet/haiku/fable alias slots. */
export function syncFireworksModelDisplay(env, mapping) {
  const fields = {};
  for (const [slot, prefix] of [
    ["opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"],
    ["sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"],
    ["haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"],
    ["fable", "ANTHROPIC_DEFAULT_FABLE_MODEL"],
  ]) {
    if (!isClaudeNativeModel(mapping[slot])) {
      Object.assign(fields, fireworksModelDisplayFields(mapping[slot], prefix));
    }
  }
  return stripCustomModelOptionEnv({ ...env, ...fields });
}

/** @deprecated Use {@link syncFireworksModelDisplay} */
export function syncFireworksFableOption(env, mapping) {
  return syncFireworksModelDisplay(env, mapping);
}

const SLOT_MODEL_ENV_KEY = Object.freeze({
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
  subagent: "CLAUDE_CODE_SUBAGENT_MODEL",
});

function envKeysToClearForNativeSlot(slot) {
  const key = SLOT_MODEL_ENV_KEY[slot];
  if (!key) {
    return [];
  }
  return slot === "subagent"
    ? [key]
    : [key, `${key}_NAME`, `${key}_DESCRIPTION`];
}

export function modelEnvFromMapping(mapping) {
  const merged = {};
  for (const [slot, modelId] of Object.entries(mapping)) {
    if (modelId == null || isClaudeNativeModel(modelId)) {
      continue; // native/unset slots pin nothing (main uses top-level `model`)
    }
    const envKey = SLOT_MODEL_ENV_KEY[slot];
    if (!envKey) continue;
    const ref = shortFireworksModelRef(claudeCodeModelId(modelId));
    merged[envKey] = slot === "subagent"
      // Claude Code forwards the subagent model id verbatim to the provider API,
      // unlike ANTHROPIC_MODEL/DEFAULT_* slots where it consumes the [1m] beta tag.
      // Fireworks has no model literally named "glm-latest[1m]", so the suffix
      // must be stripped here or subagent/agent-team spawns fail with "model may not exist".
      ? stripClaudeCodeContextSuffix(ref)
      : ref;
  }
  return merged;
}

export function mergeModelsIntoEnv(env, mapping) {
  return withoutLegacyAnthropicMainEnv({
    ...env,
    ...modelEnvFromMapping(mapping),
  });
}

export function buildFireworksProviderEnv(env, {
  apiKey = "",
  baseUrl = FIREWORKS_BASE_URL,
  mapping,
  preset = DEFAULT_FIREWORKS_PRESET,
  keyType = "fireworks",
  anthropicKey = "",
  anthropicAuthToken = "",
  routingPreference = null,
  useApiKeySentinel = true,
  telemetryHeaders = buildFireconnectTelemetryHeaders("claude"),
}) {
  const resolvedPreset = keyType === "firepass" ? DEFAULT_FIREPASS_PRESET : preset;
  const mergedEnv = mergeModelsIntoEnv({}, mapping);
  const nextEnv = withoutLegacyAnthropicMainEnv({
    ...env,
    ...resolvedPreset,
    ...syncFireworksModelDisplay(mergedEnv, mapping),
    ANTHROPIC_BASE_URL: baseUrl,
  });
  delete nextEnv.ANTHROPIC_API_KEY;
  delete nextEnv.ANTHROPIC_AUTH_TOKEN;
  // Let Claude Code emit its normal attribution block. The Fireworks gateway
  // strips that synthetic block before inference, while disabling it client-side
  // breaks Claude Code's classifier/auto-mode behavior.
  delete nextEnv.CLAUDE_CODE_ATTRIBUTION_HEADER;
  // Authenticate the gateway via X-Fireworks-Api-Key. Native Claude auth stays
  // in Claude's own env fields; it must never be copied to x-anthropic-api-key.
  if (apiKey?.trim()) {
    const preservedHeaders = env.ANTHROPIC_CUSTOM_HEADERS ?? "";
    nextEnv.ANTHROPIC_CUSTOM_HEADERS = mappingUsesFirerouter(mapping)
      ? [
        buildClaudeCustomHeaders({
          fireworksKey: apiKey.trim(),
          routingPreference,
          telemetryHeaders,
        }),
        preservedHeaders,
      ].filter(Boolean).join("\n")
      : setFireworksKeyInCustomHeaders(
        mergeFireconnectTelemetryHeaderLines(preservedHeaders, telemetryHeaders),
        apiKey.trim(),
      );
  }
  if (anthropicKey?.trim()) {
    nextEnv.ANTHROPIC_API_KEY = anthropicKey.trim();
  } else if (useApiKeySentinel) {
    // Claude Code's fresh-profile login gate requires an API-key-shaped env
    // field before it will send custom headers. This non-secret sentinel unlocks
    // that gate; X-Fireworks-Api-Key remains the real gateway credential.
    nextEnv.ANTHROPIC_API_KEY = "fireconnect";
  }
  if (anthropicAuthToken?.trim()) {
    nextEnv.ANTHROPIC_AUTH_TOKEN = anthropicAuthToken.trim();
  }
  // Native Claude slots leave no pin behind: clear the slot's model + picker
  // label keys (including any pre-existing user values that survived the env
  // spread) so Claude Code falls back to its own (Anthropic) default model.
  for (const [slot, modelId] of Object.entries(mapping)) {
    if (!isClaudeNativeModel(modelId)) {
      continue;
    }
    for (const key of envKeysToClearForNativeSlot(slot)) {
      delete nextEnv[key];
    }
  }
  return applyClaudeCodeContextPolicy(nextEnv, mapping);
}

/**
 * Pure builder: the settings object `enableFireworksProvider` would write to
 * disk, WITHOUT reading or writing any file.
 *
 * @param {Record<string, unknown>} settings  current settings (env read from here)
 * @param {{
 *   apiKey?: string,
 *   baseUrl?: string,
 *   mapping?: ReturnType<typeof resolveClaudeModelMapping>,
 *   preset?: Record<string, string>,
 *   keyType?: "fireworks" | "firepass",
 *   anthropicKey?: string,
 *   anthropicAuthToken?: string,
 *   useApiKeySentinel?: boolean,
 * }} [opts]
 * @returns {{ settings: Record<string, unknown>, token: string, keyType: "fireworks" | "firepass" }}
 */
export function buildFireworksSettings(settings, {
  apiKey = "",
  baseUrl = FIREWORKS_BASE_URL,
  mapping = resolveClaudeModelMapping(),
  preset = DEFAULT_FIREWORKS_PRESET,
  keyType = "fireworks",
  anthropicKey = "",
  anthropicAuthToken = "",
  routingPreference = null,
  useApiKeySentinel = true,
} = {}) {
  const env = settings.env ?? {};
  const token = apiKey || claudeFireworksKeyFrom({ env }) || process.env.FIREWORKS_API_KEY || "";
  if (!token) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }
  const resolvedKeyType = keyType === "fireworks" ? detectApiKeyType(token) : keyType;
  // stripFirerouterOwnedEnv keeps any user-added ANTHROPIC_CUSTOM_HEADERS lines
  // (only FireConnect-managed lines are removed), so buildFireworksProviderEnv
  // can re-add just the Fireworks key alongside them.
  const { env: strippedEnv } = stripFirerouterOwnedEnv(env);
  const next = {
    ...settings,
    env: buildFireworksProviderEnv(strippedEnv, {
      apiKey: token,
      baseUrl,
      mapping,
      preset,
      keyType: resolvedKeyType,
      anthropicKey,
      anthropicAuthToken,
      routingPreference,
      useApiKeySentinel,
    }),
  };
  if (providerStatusFromEnv(next.env) === "fireworks") {
    if (isClaudeNativeModel(mapping.main)) {
      // Native main: leave Claude Code's own default (Anthropic) model in charge
      // and drop any previously pinned model (incl. one from an earlier `on`).
      delete next.model;
    } else {
      next.model = shortFireworksModelRef(claudeCodeModelId(mapping.main));
    }
    // Claude Code prices the routed model against Anthropic's list, so its own
    // status line reports a cost the user is never billed. Ours reads the
    // transcript at Fireworks rates. A user's existing statusLine is left as-is.
    return { settings: withClaudeStatusLine(next), token, keyType: resolvedKeyType };
  }
  return { settings: next, token, keyType: resolvedKeyType };
}

export async function enableFireworksProvider({
  settingsPath,
  dataDir,
  effectiveApiKey,
  baseUrl = FIREWORKS_BASE_URL,
  mapping = resolveClaudeModelMapping(),
  preset = DEFAULT_FIREWORKS_PRESET,
  keyType = "fireworks",
  anthropicKey = "",
  anthropicAuthToken = "",
  nativeApiKeyHelper = null,
  routingPreference = null,
  useApiKeySentinel = true,
}) {
 const backupPath = providerBackupPath(dataDir);
 const settings = await readJsonIfExists(settingsPath);
 const statePath = providerStatePath(dataDir);
 const state = await readJsonIfExists(statePath);
 const env = settings.env ?? {};

  // Snapshot the raw settings file once, before any modification, so `off`
  // restores it byte-for-byte (like the other harnesses). Skip when a backup
  // already exists (preserve the true original across repeat `on`s) or when the
  // file is already Fireworks/FireRouter-routed (don't capture a
  // fireconnect-modified file as the "original").
  await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  const existingBackup = await readJsonIfExists(backupPath);
  const alreadyRouted = providerStatusFromEnv(env) === "fireworks";
  if (existingBackup.snapshot === undefined && existingBackup.values === undefined && !alreadyRouted) {
    await writeSettingsSnapshotBackup({ settingsPath, backupPath });
  }

  await ensureCatalogForClaudeCodeContext({ apiKey: effectiveApiKey, keyType });

  const built = buildFireworksSettings(settings, {
    apiKey: effectiveApiKey,
    baseUrl,
    mapping,
    preset,
    keyType,
    anthropicKey,
    anthropicAuthToken,
    routingPreference,
    useApiKeySentinel,
  });
  const token = built.token;
  const routed = nativeApiKeyHelper === null
    ? built.settings
    : { ...built.settings, apiKeyHelper: nativeApiKeyHelper };
  // Direct mode now authenticates via the X-Fireworks-Api-Key custom header
  // (written into env by buildFireworksProviderEnv), not apiKeyHelper. Drop a
  // previously FireConnect-managed apiKeyHelper; a user's own helper is left
  // untouched (the raw snapshot restores it on `off`).
  const { settings: next } = stripManagedApiKeyHelper(routed, {
    authMode: state.authMode,
    managedApiKeyHelper: state.managedApiKeyHelper,
  });

  await writeJson(settingsPath, next, { mode: 0o600 });
  await writeJson(statePath, {
    ...state,
    authMode: "customHeader",
    keyType: built.keyType,
    managedApiKeyHelper: undefined,
    fireworksApiKey: undefined,
  });
  return token;
}

export async function disableFireworksProvider({ settingsPath, dataDir, wasEnabled = false }) {
  const backupPath = providerBackupPath(dataDir);
  const statePath = providerStatePath(dataDir);
  const state = await readJsonIfExists(statePath);
  const settings = await readJsonIfExists(settingsPath);
  const backup = await readJsonIfExists(backupPath);
  const env = settings.env ?? {};
  const status = providerStatusFromEnv(env);
  const hasSnapshot = backup.snapshot !== undefined;
  const hasBackup = Boolean(backup.values);

  if (!wasEnabled && !hasBackup && !hasSnapshot && status !== "fireworks") {
    return;
  }

  // Preferred path: restore the raw settings snapshot byte-for-byte.
  if (hasSnapshot) {
    await restoreSettingsSnapshotBackup({ settingsPath, backupPath, backup });
    await writeJson(statePath, {
      ...state,
      authMode: undefined,
      keyType: undefined,
      managedApiKeyHelper: undefined,
      fireworksApiKey: undefined,
    });
    return;
  }

  if (hasBackup) {
    const nextEnv = { ...env };
    for (const key of FIREWORKS_ENV_KEYS) {
      delete nextEnv[key];
    }
    for (const [key, value] of Object.entries(backup.values)) {
      nextEnv[key] = value;
    }
    for (const key of backup.missing ?? []) {
      delete nextEnv[key];
    }
    // ANTHROPIC_CUSTOM_HEADERS isn't in FIREWORKS_ENV_KEYS; strip the Fireworks
    // key line so a legacy (values-only) restore never leaves it in plaintext.
    if (typeof nextEnv.ANTHROPIC_CUSTOM_HEADERS === "string") {
      const stripped = stripFireconnectTelemetryHeaderLines(
        stripFireworksKeyFromCustomHeaders(nextEnv.ANTHROPIC_CUSTOM_HEADERS),
      );
      if (stripped) {
        nextEnv.ANTHROPIC_CUSTOM_HEADERS = stripped;
      } else {
        delete nextEnv.ANTHROPIC_CUSTOM_HEADERS;
      }
    }

    let nextSettings = { ...settings, env: nextEnv };
    if (backup.topLevel?.values || backup.topLevel?.missing) {
      nextSettings = applyTopLevelBackup(nextSettings, backup.topLevel);
    } else {
      nextSettings = clearFireworksTopLevelWithoutBackup(nextSettings);
    }
    nextSettings = stripManagedApiKeyHelper(nextSettings, state).settings;
    // This legacy backup predates the managed status line, so it cannot restore
    // its absence — strip it explicitly (a user's own statusLine is untouched).
    nextSettings = stripClaudeStatusLine(nextSettings).settings;

    await writeJson(settingsPath, nextSettings);
    await writeJson(statePath, {
      ...state,
      authMode: state.authMode === "apiKeyHelper" ? undefined : state.authMode,
      keyType: undefined,
      managedApiKeyHelper: undefined,
      fireworksApiKey: undefined,
    });
    await unlink(backupPath).catch(() => {});
    return;
  }

  const { env: nextEnv, changed: envChanged } = stripFireworksOwnedEnv(env);
  let nextSettings = { ...settings, env: nextEnv };
  const clearedTopLevel = status === "fireworks";
  if (clearedTopLevel) {
    nextSettings = clearFireworksTopLevelWithoutBackup(nextSettings);
  }

  const { settings: clearedSettings, changed: helperChanged } = stripManagedApiKeyHelper(nextSettings, state);
  nextSettings = clearedSettings;

  const { settings: withoutStatusLine, changed: statusLineChanged } = stripClaudeStatusLine(nextSettings);
  nextSettings = withoutStatusLine;

  if (envChanged || clearedTopLevel || helperChanged || statusLineChanged) {
    await writeJson(settingsPath, nextSettings);
  }

  await writeJson(statePath, {
    ...state,
    authMode: undefined,
    keyType: undefined,
    managedApiKeyHelper: undefined,
    fireworksApiKey: undefined,
  });
}
