import { existsSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "./atomic-write.mjs";

import {
  applyClaudeCodeContextPolicy,
  claudeCodeModelId,
  stripClaudeCodeContextSuffix,
} from "./claude-code-context.mjs";
import { firerouterStatusFromEnv, stripFirerouterOwnedEnv } from "./firerouter-core.mjs";
import { formatPricingDescription, lookupFireworksPricing } from "./fireworks-pricing.mjs";

export { CLAUDE_CODE_1M_CONTEXT_MODELS } from "./claude-code-context.mjs";

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference";
export const MISSING_FIREWORKS_API_KEY_MESSAGE =
  "No Fireworks API key found. Run `fireconnect login` to sign in, export FIREWORKS_API_KEY, or pass --api-key.";
export const GLM_LATEST_ROUTER_ID = "accounts/fireworks/routers/glm-latest";
export const GLM_FAST_LATEST_ROUTER_ID = "accounts/fireworks/routers/glm-fast-latest";
export const DEFAULT_OPUS_MODEL = "glm-fast-latest";
export const DEFAULT_FABLE_MODEL = "glm-fast-latest";
export const DEFAULT_FIREPASS_MAIN_MODEL = "glm-fast-latest";
export const DEFAULT_MAIN_MODEL = "glm-fast-latest";
export const DEFAULT_SONNET_MODEL = "glm-5p1";
export const DEFAULT_HAIKU_MODEL = "deepseek-v4-flash";
export const DEFAULT_SUBAGENT_MODEL = DEFAULT_HAIKU_MODEL;

const FIREWORKS_ROUTER_SHORT_IDS = new Set([
  "glm-latest",
  "glm-fast-latest",
  "glm-5p2-fast",
  "kimi-fast-latest",
  "kimi-k2p6-turbo",
  "kimi-k2p7-code-fast",
  "kimi-latest",
]);

export const DEFAULT_DATA_DIR = ".fireconnect/claude";
export const USER_SETTINGS_RELATIVE_PATH = ".claude/settings.json";

export const FIREWORKS_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
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
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
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

export const FIREWORKS_TOP_LEVEL_KEYS = [
  "model",
  "effortLevel",
];

/** Claude Code behavior tuning shared by direct and router modes (not model mapping). */
export const CLAUDE_CODE_BEHAVIOR_ENV = {
  CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
  CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE: "0",
  // Cut Statsig/GrowthBook, Datadog, and other Anthropic-bound nonessential startup traffic.
  // See Claude Code env vars: DISABLE_TELEMETRY, DO_NOT_TRACK,
  // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC.
  DISABLE_TELEMETRY: "1",
  DO_NOT_TRACK: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

export const DEFAULT_FIREWORKS_PRESET = {
  ANTHROPIC_MODEL: GLM_FAST_LATEST_ROUTER_ID,
  ANTHROPIC_DEFAULT_OPUS_MODEL: GLM_FAST_LATEST_ROUTER_ID,
  ANTHROPIC_DEFAULT_SONNET_MODEL: "accounts/fireworks/models/glm-5p1",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "accounts/fireworks/models/deepseek-v4-flash",
  ANTHROPIC_DEFAULT_FABLE_MODEL: GLM_FAST_LATEST_ROUTER_ID,
  CLAUDE_CODE_SUBAGENT_MODEL: "accounts/fireworks/models/deepseek-v4-flash",
  ANTHROPIC_CUSTOM_MODEL_OPTION: GLM_FAST_LATEST_ROUTER_ID,
  ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "glm-fast-latest via Fireworks",
  ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Fireworks serverless model",
  ...CLAUDE_CODE_BEHAVIOR_ENV,
};

export const DEFAULT_FIREPASS_PRESET = {
  ...DEFAULT_FIREWORKS_PRESET,
  ANTHROPIC_MODEL: GLM_FAST_LATEST_ROUTER_ID,
  ANTHROPIC_DEFAULT_OPUS_MODEL: GLM_FAST_LATEST_ROUTER_ID,
  ANTHROPIC_DEFAULT_SONNET_MODEL: GLM_FAST_LATEST_ROUTER_ID,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: GLM_FAST_LATEST_ROUTER_ID,
  ANTHROPIC_DEFAULT_FABLE_MODEL: GLM_FAST_LATEST_ROUTER_ID,
  CLAUDE_CODE_SUBAGENT_MODEL: GLM_FAST_LATEST_ROUTER_ID,
  ANTHROPIC_CUSTOM_MODEL_OPTION: GLM_FAST_LATEST_ROUTER_ID,
  ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "glm-fast-latest via Fireworks",
};

export async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${filePath} is not valid JSON`);
    }
    throw error;
  }
}

export async function writeJson(filePath, value, { mode } = {}) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

export function isSafeDataDirRemoval(dataDir, home) {
  if (!dataDir || !home) {
    return false;
  }

  const resolvedHome = path.resolve(home);
  const resolvedDir = path.resolve(dataDir);
  const filesystemRoot = path.parse(resolvedDir).root;

  if (resolvedDir === filesystemRoot || resolvedDir === resolvedHome) {
    return false;
  }

  const defaultDir = path.join(resolvedHome, DEFAULT_DATA_DIR);
  if (resolvedDir === defaultDir) {
    return true;
  }

  const relativeToHome = path.relative(resolvedHome, resolvedDir);
  if (!relativeToHome || relativeToHome.startsWith("..") || path.isAbsolute(relativeToHome)) {
    return false;
  }

  const hasBackup = existsSync(path.join(resolvedDir, "provider-backup.json"));
  return hasBackup;
}

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

export function normalizeModelId(model) {
  model = stripClaudeCodeContextSuffix(model);
  if (model.startsWith("accounts/")) {
    return model;
  }
  if (model.includes("/")) {
    return model;
  }
  if (FIREWORKS_ROUTER_SHORT_IDS.has(model)) {
    return `accounts/fireworks/routers/${model}`;
  }
  return `accounts/fireworks/models/${model}`;
}

export function validateModelId(model, flag) {
  if (!model.startsWith("accounts/") && model.includes("/")) {
    throw new Error(`${flag} must be a Fireworks model ID like deepseek-v4-flash or a router ID like glm-latest`);
  }
}

export function defaultModelIds(keyType = "fireworks") {
  if (keyType === "firepass") {
    return {
      main: DEFAULT_FIREPASS_MAIN_MODEL,
      opus: DEFAULT_FIREPASS_MAIN_MODEL,
      sonnet: DEFAULT_FIREPASS_MAIN_MODEL,
      haiku: DEFAULT_FIREPASS_MAIN_MODEL,
      fable: DEFAULT_FIREPASS_MAIN_MODEL,
      subagent: DEFAULT_FIREPASS_MAIN_MODEL,
    };
  }
  return {
    main: DEFAULT_MAIN_MODEL,
    opus: DEFAULT_OPUS_MODEL,
    sonnet: DEFAULT_SONNET_MODEL,
    haiku: DEFAULT_HAIKU_MODEL,
    fable: DEFAULT_FABLE_MODEL,
    subagent: DEFAULT_SUBAGENT_MODEL,
  };
}

export function resolveModelMapping(overrides = {}, keyType = "fireworks") {
  const defaults = defaultModelIds(keyType);
  const main = normalizeModelId(overrides.main || defaults.main);
  const opus = normalizeModelId(overrides.opus || defaults.opus);
  const sonnet = normalizeModelId(overrides.sonnet || defaults.sonnet);
  const haiku = normalizeModelId(overrides.haiku || defaults.haiku);
  const fable = normalizeModelId(overrides.fable || defaults.fable);
  const subagent = normalizeModelId(overrides.subagent || defaults.subagent);

  validateModelId(main, "--main");
  validateModelId(opus, "--opus");
  validateModelId(sonnet, "--sonnet");
  validateModelId(haiku, "--haiku");
  validateModelId(fable, "--fable");
  validateModelId(subagent, "--subagent");

  return { main, opus, sonnet, haiku, fable, subagent };
}

export function mappingFromEnv(env) {
  const strip = (value) => (value ? stripClaudeCodeContextSuffix(value) : value);
  return {
    main: strip(env.ANTHROPIC_MODEL ?? null),
    opus: strip(env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? null),
    sonnet: strip(env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? null),
    haiku: strip(env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? null),
    fable: strip(env.ANTHROPIC_DEFAULT_FABLE_MODEL ?? null),
    subagent: strip(env.CLAUDE_CODE_SUBAGENT_MODEL ?? null),
  };
}

export function providerStatusFromEnv(env, { routerBaseUrl = "" } = {}) {
  if (firerouterStatusFromEnv(env, { routerBaseUrl }) === "firerouter") {
    return "firerouter";
  }
  if (env.ANTHROPIC_BASE_URL === FIREWORKS_BASE_URL) {
    return "fireworks";
  }
  if (env.ANTHROPIC_BASE_URL) {
    return "custom";
  }
  return "default";
}

export function backupFromEnv(env) {
  const values = {};
  const missing = [];
  for (const key of FIREWORKS_ENV_KEYS) {
    if (Object.hasOwn(env, key)) {
      values[key] = env[key];
    } else {
      missing.push(key);
    }
  }
  return { values, missing };
}

export function backupTopLevelFromSettings(settings) {
  const values = {};
  const missing = [];
  for (const key of FIREWORKS_TOP_LEVEL_KEYS) {
    if (Object.hasOwn(settings, key)) {
      values[key] = settings[key];
    } else {
      missing.push(key);
    }
  }
  return { values, missing };
}

export function backupFromSettings(settings) {
  return {
    ...backupFromEnv(settings.env ?? {}),
    topLevel: backupTopLevelFromSettings(settings),
  };
}

export function isFireworksModelId(model) {
  return typeof model === "string" && model.startsWith("accounts/fireworks/");
}

export function isFireworksShapedKey(key) {
  return typeof key === "string" && (key.startsWith("fw_") || key.startsWith("fpk_"));
}

export function fireworksKeyOrEmpty(key) {
  return isFireworksShapedKey(key) ? key.trim() : "";
}

export function claudeFireworksKeyFrom({ env = {} } = {}) {
  return fireworksKeyOrEmpty(env.ANTHROPIC_API_KEY)
    || fireworksKeyOrEmpty(env.ANTHROPIC_AUTH_TOKEN);
}

/** Detect whether a key is a Fire Pass subscription key (fpk_...) or a
 *  standard Fireworks API key (fw_...). Returns "firepass" or "fireworks". */
export function detectApiKeyType(key) {
  if (typeof key === "string" && key.trim().startsWith("fpk_")) {
    return "firepass";
  }
  return "fireworks";
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
  if (isFireworksModelId(next.model)) {
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
  if (managedHelper) {
    if (settings.apiKeyHelper !== managedHelper) {
      return { settings, changed: false };
    }
    const next = { ...settings };
    delete next.apiKeyHelper;
    return { settings: next, changed: true };
  }

  if (state.authMode === "apiKeyHelper") {
    const next = { ...settings };
    delete next.apiKeyHelper;
    return { settings: next, changed: true };
  }

  return { settings, changed: false };
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

export function fireworksCustomOptionFields(mainModelId) {
  const resolved = claudeCodeModelId(mainModelId);
  const shortId = stripClaudeCodeContextSuffix(mainModelId).split("/").at(-1) ?? "Fireworks model";
  return {
    ANTHROPIC_CUSTOM_MODEL_OPTION: resolved,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: `${shortId} via Fireworks`,
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: formatPricingDescription(lookupFireworksPricing(mainModelId)),
  };
}

export function fireworksFableOptionFields(fableModelId) {
  const resolved = claudeCodeModelId(fableModelId);
  const shortId = stripClaudeCodeContextSuffix(fableModelId).split("/").at(-1) ?? "Fireworks model";
  return {
    ANTHROPIC_DEFAULT_FABLE_MODEL: resolved,
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: `${shortId} via Fireworks`,
    ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION: formatPricingDescription(lookupFireworksPricing(fableModelId)),
  };
}

export function syncFireworksCustomOption(env, mapping) {
  return {
    ...env,
    ...fireworksCustomOptionFields(mapping.main),
    ...fireworksFableOptionFields(mapping.fable),
  };
}

export function modelEnvFromMapping(mapping) {
  return {
    ANTHROPIC_MODEL: claudeCodeModelId(mapping.main),
    ANTHROPIC_DEFAULT_OPUS_MODEL: claudeCodeModelId(mapping.opus),
    ANTHROPIC_DEFAULT_SONNET_MODEL: claudeCodeModelId(mapping.sonnet),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: claudeCodeModelId(mapping.haiku),
    ANTHROPIC_DEFAULT_FABLE_MODEL: claudeCodeModelId(mapping.fable),
    // Claude Code forwards the subagent model id verbatim to the provider API,
    // unlike ANTHROPIC_MODEL/DEFAULT_* slots where it consumes the [1m] beta tag.
    // Fireworks has no model literally named "...glm-latest[1m]", so the suffix
    // must be stripped here or subagent/agent-team spawns fail with "model may not exist".
    CLAUDE_CODE_SUBAGENT_MODEL: stripClaudeCodeContextSuffix(claudeCodeModelId(mapping.subagent)),
  };
}

export function mergeModelsIntoEnv(env, mapping) {
  const nextEnv = {
    ...env,
    ...modelEnvFromMapping(mapping),
  };
  delete nextEnv.ANTHROPIC_SMALL_FAST_MODEL;
  return nextEnv;
}

export function buildFireworksProviderEnv(env, {
  baseUrl = FIREWORKS_BASE_URL,
  mapping,
  preset = DEFAULT_FIREWORKS_PRESET,
  keyType = "fireworks",
}) {
  const resolvedPreset = keyType === "firepass" ? DEFAULT_FIREPASS_PRESET : preset;
  const mergedEnv = mergeModelsIntoEnv({}, mapping);
  const nextEnv = {
    ...env,
    ...resolvedPreset,
    ...syncFireworksCustomOption(mergedEnv, mapping),
    ANTHROPIC_BASE_URL: baseUrl,
  };
  delete nextEnv.ANTHROPIC_API_KEY;
  delete nextEnv.ANTHROPIC_AUTH_TOKEN;
  delete nextEnv.ANTHROPIC_SMALL_FAST_MODEL;
  delete nextEnv.ENABLE_TOOL_SEARCH;
  return applyClaudeCodeContextPolicy(nextEnv, mapping);
}

/**
 * Pure builder: the settings object `enableFireworksProvider` would write to
 * disk, WITHOUT reading or writing any file. Used by `fireconnect demo` to
 * produce a per-process `--settings` tmp file that routes the real Claude Code
 * tool to Fireworks direct (GLM 5.2 Fast) without touching the user's
 * ~/.claude/settings.json. Resolves the token the same way the writer does
 * (flag > existing env > FIREWORKS_API_KEY) and returns it so the caller can
 * avoid re-resolving.
 *
 * @param {Record<string, unknown>} settings  current settings (env read from here)
 * @param {{
 *   apiKey?: string,
 *   baseUrl?: string,
 *   mapping?: ReturnType<typeof resolveModelMapping>,
 *   preset?: Record<string, string>,
 *   keyType?: "fireworks" | "firepass",
 *   routerBaseUrl?: string,
 * }} [opts]
 * @returns {{ settings: Record<string, unknown>, token: string, keyType: "fireworks" | "firepass" }}
 */
export function buildFireworksSettings(settings, {
  apiKey = "",
  baseUrl = FIREWORKS_BASE_URL,
  mapping = resolveModelMapping(),
  preset = DEFAULT_FIREWORKS_PRESET,
  keyType = "fireworks",
  routerBaseUrl = "",
} = {}) {
  const env = settings.env ?? {};
  const routerOptions = { routerBaseUrl };
  const token = apiKey || claudeFireworksKeyFrom({ env }) || process.env.FIREWORKS_API_KEY || "";
  if (!token) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }
  const resolvedKeyType = keyType === "fireworks" ? detectApiKeyType(token) : keyType;
  const { env: strippedEnv } = stripFirerouterOwnedEnv(env, routerOptions);
  const next = {
    ...settings,
    env: buildFireworksProviderEnv(strippedEnv, { apiKey: token, baseUrl, mapping, preset, keyType: resolvedKeyType }),
  };
  if (providerStatusFromEnv(next.env, routerOptions) === "fireworks") {
    next.model = claudeCodeModelId(mapping.main);
  }
  return { settings: next, token, keyType: resolvedKeyType };
}

export async function enableFireworksProvider({
  settingsPath,
  dataDir,
  effectiveApiKey,
  apiKeyHelperPath,
  baseUrl = FIREWORKS_BASE_URL,
  mapping = resolveModelMapping(),
  preset = DEFAULT_FIREWORKS_PRESET,
  keyType = "fireworks",
  routerBaseUrl = "",
}) {
 const backupPath = providerBackupPath(dataDir);
 const settings = await readJsonIfExists(settingsPath);
 const statePath = providerStatePath(dataDir);
 const state = await readJsonIfExists(statePath);
 const env = settings.env ?? {};
 const routerOptions = { routerBaseUrl };

  if (providerStatusFromEnv(env, routerOptions) !== "fireworks") {
    // The backup can hold the user's pre-existing ANTHROPIC_API_KEY /
    // ANTHROPIC_AUTH_TOKEN, so write it with the same 0700/0600 hardening the
    // other harnesses apply to their backups (codex/cursor/vscode/pi/opencode).
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    const existingBackup = await readJsonIfExists(backupPath);
    if (!existingBackup.values) {
      const backup = backupFromSettings(settings);
      if (Object.hasOwn(settings, "apiKeyHelper")) {
        backup.topLevel = backup.topLevel ?? { values: {}, missing: [] };
        backup.topLevel.values.apiKeyHelper = settings.apiKeyHelper;
      } else if (backup.topLevel) {
        backup.topLevel.missing = [...(backup.topLevel.missing ?? []), "apiKeyHelper"];
      }
      await writeJson(backupPath, backup, { mode: 0o600 });
    } else if (!existingBackup.topLevel) {
      await writeJson(backupPath, {
        ...existingBackup,
        topLevel: backupTopLevelFromSettings(settings),
      }, { mode: 0o600 });
    }
  }

  const { settings: routed, token } = buildFireworksSettings(settings, {
    apiKey: effectiveApiKey, baseUrl, mapping, preset, keyType, routerBaseUrl,
  });
  const next = { ...routed, apiKeyHelper: apiKeyHelperPath };

  await writeJson(settingsPath, next);
  await writeJson(statePath, {
    ...state,
    authMode: "apiKeyHelper",
    managedApiKeyHelper: apiKeyHelperPath,
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
  const hasBackup = Boolean(backup.values);

  if (!wasEnabled && !hasBackup && status !== "fireworks") {
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

    let nextSettings = { ...settings, env: nextEnv };
    if (backup.topLevel?.values || backup.topLevel?.missing) {
      nextSettings = applyTopLevelBackup(nextSettings, backup.topLevel);
    } else {
      nextSettings = clearFireworksTopLevelWithoutBackup(nextSettings);
    }
    nextSettings = stripManagedApiKeyHelper(nextSettings, state).settings;

    await writeJson(settingsPath, nextSettings);
    await writeJson(statePath, {
      ...state,
      authMode: state.authMode === "apiKeyHelper" ? undefined : state.authMode,
      managedApiKeyHelper: undefined,
      fireworksApiKey: undefined,
    });
    await unlink(backupPath).catch(() => {});
    return;
  }

  const { env: nextEnv, changed: envChanged } = stripFireworksOwnedEnv(env);
  let nextSettings = { ...settings, env: nextEnv };
  const hadFireworksModel = isFireworksModelId(settings.model);
  if (hadFireworksModel) {
    nextSettings = clearFireworksTopLevelWithoutBackup(nextSettings);
  }

  const { settings: clearedSettings, changed: helperChanged } = stripManagedApiKeyHelper(nextSettings, state);
  nextSettings = clearedSettings;

  if (envChanged || hadFireworksModel || helperChanged) {
    await writeJson(settingsPath, nextSettings);
  }

  await writeJson(statePath, {
    ...state,
    authMode: undefined,
    managedApiKeyHelper: undefined,
    fireworksApiKey: undefined,
  });
}

export async function applyModelMapping({ settingsPath, mapping }) {
  const settings = await readJsonIfExists(settingsPath);
  const env = settings.env ?? {};
  const nextEnv = applyClaudeCodeContextPolicy(
    syncFireworksCustomOption(mergeModelsIntoEnv(env, mapping), mapping),
    mapping,
  );
  const next = {
    ...settings,
    env: nextEnv,
  };
  if (providerStatusFromEnv(nextEnv) === "fireworks") {
    next.model = claudeCodeModelId(mapping.main);
  }
  await writeJson(settingsPath, next);
}
