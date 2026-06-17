import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  applyClaudeCodeContextPolicy,
  claudeCodeModelId,
  stripClaudeCodeContextSuffix,
} from "./claude-code-context.mjs";

export { CLAUDE_CODE_1M_CONTEXT_MODELS } from "./claude-code-context.mjs";

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference";
export const DEFAULT_OPUS_MODEL = "kimi-k2p7-code-fast";
export const DEFAULT_FIREPASS_MAIN_MODEL = "kimi-k2p7-code-fast";
export const DEFAULT_SONNET_MODEL = "glm-5p1";
export const DEFAULT_HAIKU_MODEL = "minimax-m2p5";
export const DEFAULT_MAIN_MODEL = DEFAULT_OPUS_MODEL;
export const DEFAULT_SUBAGENT_MODEL = DEFAULT_HAIKU_MODEL;

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
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
  "CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE",
  "ENABLE_TOOL_SEARCH",
];

export const FIREWORKS_TOP_LEVEL_KEYS = [
  "model",
  "effortLevel",
];

export const DEFAULT_FIREWORKS_PRESET = {
  ANTHROPIC_MODEL: "accounts/fireworks/routers/kimi-k2p7-code-fast",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "accounts/fireworks/routers/kimi-k2p7-code-fast",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "accounts/fireworks/models/glm-5p1",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "accounts/fireworks/models/minimax-m2p5",
  CLAUDE_CODE_SUBAGENT_MODEL: "accounts/fireworks/models/minimax-m2p5",
  ANTHROPIC_CUSTOM_MODEL_OPTION: "accounts/fireworks/routers/kimi-k2p7-code-fast",
  ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Kimi K2.7 Code Fast via Fireworks",
  ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Fireworks Anthropic-compatible open model",
  CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
  CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE: "0",
};

export const DEFAULT_FIREPASS_PRESET = {
  ...DEFAULT_FIREWORKS_PRESET,
  ANTHROPIC_MODEL: "accounts/fireworks/routers/kimi-k2p7-code-fast",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "accounts/fireworks/routers/kimi-k2p7-code-fast",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "accounts/fireworks/routers/kimi-k2p7-code-fast",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "accounts/fireworks/routers/kimi-k2p7-code-fast",
  CLAUDE_CODE_SUBAGENT_MODEL: "accounts/fireworks/routers/kimi-k2p7-code-fast",
  ANTHROPIC_CUSTOM_MODEL_OPTION: "accounts/fireworks/routers/kimi-k2p7-code-fast",
  ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Kimi K2.7 Code Fast via Fireworks",
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
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (mode !== undefined) await chmod(filePath, mode);
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

  const hasState = existsSync(path.join(resolvedDir, "provider-state.json"));
  const hasBackup = existsSync(path.join(resolvedDir, "provider-backup.json"));
  return hasState || hasBackup;
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

export function providerStatePath(dataDir) {
  return path.join(dataDir, "provider-state.json");
}

export function providerBackupPath(dataDir) {
  return path.join(dataDir, "provider-backup.json");
}

export function normalizeModelId(model) {
  model = stripClaudeCodeContextSuffix(model);
  if (model.startsWith("accounts/")) {
    return model;
  }
  if (model.includes("/")) {
    return model;
  }
  if (model === "kimi-k2p6-turbo") {
    return "accounts/fireworks/routers/kimi-k2p6-turbo";
  }
  if (model === "kimi-k2p7-code-fast") {
    return "accounts/fireworks/routers/kimi-k2p7-code-fast";
  }
  return `accounts/fireworks/models/${model}`;
}

export function validateModelId(model, flag) {
  if (!model.startsWith("accounts/") && model.includes("/")) {
    throw new Error(`${flag} must be a Fireworks model or router ID like kimi-k2p7-code-fast or accounts/fireworks/routers/kimi-k2p7-code-fast`);
  }
}

export function defaultModelIds(keyType = "fireworks") {
  if (keyType === "firepass") {
    return {
      main: DEFAULT_FIREPASS_MAIN_MODEL,
      opus: DEFAULT_FIREPASS_MAIN_MODEL,
      sonnet: DEFAULT_FIREPASS_MAIN_MODEL,
      haiku: DEFAULT_FIREPASS_MAIN_MODEL,
      subagent: DEFAULT_FIREPASS_MAIN_MODEL,
    };
  }
  return {
    main: DEFAULT_MAIN_MODEL,
    opus: DEFAULT_OPUS_MODEL,
    sonnet: DEFAULT_SONNET_MODEL,
    haiku: DEFAULT_HAIKU_MODEL,
    subagent: DEFAULT_SUBAGENT_MODEL,
  };
}

export function resolveModelMapping(overrides = {}, keyType = "fireworks") {
  const defaults = defaultModelIds(keyType);
  const main = normalizeModelId(overrides.main || defaults.main);
  const opus = normalizeModelId(overrides.opus || defaults.opus);
  const sonnet = normalizeModelId(overrides.sonnet || defaults.sonnet);
  const haiku = normalizeModelId(overrides.haiku || defaults.haiku);
  const subagent = normalizeModelId(overrides.subagent || defaults.subagent);

  validateModelId(main, "--main");
  validateModelId(opus, "--opus");
  validateModelId(sonnet, "--sonnet");
  validateModelId(haiku, "--haiku");
  validateModelId(subagent, "--subagent");

  return { main, opus, sonnet, haiku, subagent };
}

export function mappingFromEnv(env) {
  const strip = (value) => (value ? stripClaudeCodeContextSuffix(value) : value);
  return {
    main: strip(env.ANTHROPIC_MODEL ?? null),
    opus: strip(env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? null),
    sonnet: strip(env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? null),
    haiku: strip(env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? null),
    subagent: strip(env.CLAUDE_CODE_SUBAGENT_MODEL ?? null),
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

export function claudeFireworksKeyFrom({ env = {}, state = {} } = {}) {
  return fireworksKeyOrEmpty(env.ANTHROPIC_API_KEY)
    || fireworksKeyOrEmpty(env.ANTHROPIC_AUTH_TOKEN)
    || fireworksKeyOrEmpty(state.fireworksApiKey);
}

export function resolveClaudeToken({ apiKeyFromFlag, apiKey }, { env, state }) {
  if (apiKeyFromFlag) {
    return apiKey;
  }
  return claudeFireworksKeyFrom({ env, state }) || process.env.FIREWORKS_API_KEY || "";
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

export function fireworksCustomOptionFields(mainModelId) {
  const resolved = claudeCodeModelId(mainModelId);
  const shortId = stripClaudeCodeContextSuffix(mainModelId).split("/").at(-1) ?? "Fireworks model";
  return {
    ANTHROPIC_CUSTOM_MODEL_OPTION: resolved,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: `${shortId} via Fireworks`,
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Fireworks Anthropic-compatible open model",
  };
}

export function syncFireworksCustomOption(env, mapping) {
  return {
    ...env,
    ...fireworksCustomOptionFields(mapping.main),
  };
}

export function modelEnvFromMapping(mapping) {
  return {
    ANTHROPIC_MODEL: claudeCodeModelId(mapping.main),
    ANTHROPIC_DEFAULT_OPUS_MODEL: claudeCodeModelId(mapping.opus),
    ANTHROPIC_DEFAULT_SONNET_MODEL: claudeCodeModelId(mapping.sonnet),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: claudeCodeModelId(mapping.haiku),
    CLAUDE_CODE_SUBAGENT_MODEL: claudeCodeModelId(mapping.subagent),
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
  apiKey,
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
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_AUTH_TOKEN: apiKey,
  };
  delete nextEnv.ANTHROPIC_SMALL_FAST_MODEL;
  delete nextEnv.ENABLE_TOOL_SEARCH;
  return applyClaudeCodeContextPolicy(nextEnv, mapping);
}

export async function enableFireworksProvider({
  settingsPath,
  dataDir,
  apiKey,
  baseUrl = FIREWORKS_BASE_URL,
  mapping = resolveModelMapping(),
  preset = DEFAULT_FIREWORKS_PRESET,
  keyType = "fireworks",
}) {
  const backupPath = providerBackupPath(dataDir);
  const statePath = providerStatePath(dataDir);
  const settings = await readJsonIfExists(settingsPath);
  const state = await readJsonIfExists(statePath);
  const env = settings.env ?? {};

  if (providerStatusFromEnv(env) !== "fireworks") {
    const existingBackup = await readJsonIfExists(backupPath);
    if (!existingBackup.values) {
      await writeJson(backupPath, backupFromSettings(settings));
    } else if (!existingBackup.topLevel) {
      await writeJson(backupPath, {
        ...existingBackup,
        topLevel: backupTopLevelFromSettings(settings),
      });
    }
  }

  const token = apiKey || claudeFireworksKeyFrom({ env, state }) || process.env.FIREWORKS_API_KEY || "";
  if (!token) {
    throw new Error("No Fireworks API key found. Pass --api-key or set FIREWORKS_API_KEY.");
  }

  const resolvedKeyType = keyType === "fireworks" ? detectApiKeyType(token) : keyType;

  const next = {
    ...settings,
    env: buildFireworksProviderEnv(env, { apiKey: token, baseUrl, mapping, preset, keyType: resolvedKeyType }),
  };

  if (providerStatusFromEnv(next.env) === "fireworks") {
    next.model = claudeCodeModelId(mapping.main);
  }

  await writeJson(settingsPath, next);
  await writeJson(statePath, { ...state, fireworksApiKey: token });
  return token;
}

export async function disableFireworksProvider({ settingsPath, dataDir, wasEnabled = false }) {
  const backupPath = providerBackupPath(dataDir);
  const statePath = providerStatePath(dataDir);
  const settings = await readJsonIfExists(settingsPath);
  const backup = await readJsonIfExists(backupPath);
  const state = await readJsonIfExists(statePath);
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

    await writeJson(settingsPath, nextSettings);
    await writeJson(statePath, {
      ...state,
      fireworksApiKey: env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || state.fireworksApiKey,
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

  if (envChanged || hadFireworksModel) {
    await writeJson(settingsPath, nextSettings);
  }

  await writeJson(statePath, {
    ...state,
    fireworksApiKey: env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || state.fireworksApiKey,
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
