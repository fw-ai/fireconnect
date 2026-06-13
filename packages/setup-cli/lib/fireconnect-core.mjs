import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference";
export const DEFAULT_OPUS_MODEL = "kimi-k2p6-turbo";
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
  ANTHROPIC_MODEL: "accounts/fireworks/routers/kimi-k2p6-turbo",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "accounts/fireworks/routers/kimi-k2p6-turbo",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "accounts/fireworks/models/glm-5p1",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "accounts/fireworks/models/minimax-m2p5",
  CLAUDE_CODE_SUBAGENT_MODEL: "accounts/fireworks/models/minimax-m2p5",
  ANTHROPIC_CUSTOM_MODEL_OPTION: "accounts/fireworks/routers/kimi-k2p6-turbo",
  ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Kimi K2.6 Turbo via Fireworks",
  ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Fireworks Anthropic-compatible open model",
  CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
  CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE: "0",
};

export const DEFAULT_FIREPASS_PRESET = {
  ...DEFAULT_FIREWORKS_PRESET,
  ANTHROPIC_DEFAULT_SONNET_MODEL: "accounts/fireworks/routers/kimi-k2p6-turbo",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "accounts/fireworks/routers/kimi-k2p6-turbo",
  CLAUDE_CODE_SUBAGENT_MODEL: "accounts/fireworks/routers/kimi-k2p6-turbo",
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

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
  if (model.startsWith("accounts/")) {
    return model;
  }
  if (model.includes("/")) {
    return model;
  }
  if (model === "kimi-k2p6-turbo") {
    return "accounts/fireworks/routers/kimi-k2p6-turbo";
  }
  return `accounts/fireworks/models/${model}`;
}

export function validateModelId(model, flag) {
  if (!model.startsWith("accounts/") && model.includes("/")) {
    throw new Error(`${flag} must be a Fireworks model or router ID like kimi-k2p6-turbo or accounts/fireworks/routers/kimi-k2p6-turbo`);
  }
}

export function defaultModelIds(keyType = "fireworks") {
  if (keyType === "firepass") {
    return {
      main: DEFAULT_MAIN_MODEL,
      opus: DEFAULT_MAIN_MODEL,
      sonnet: DEFAULT_MAIN_MODEL,
      haiku: DEFAULT_MAIN_MODEL,
      subagent: DEFAULT_MAIN_MODEL,
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
  return {
    main: env.ANTHROPIC_MODEL ?? null,
    opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? null,
    sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? null,
    haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? null,
    subagent: env.CLAUDE_CODE_SUBAGENT_MODEL ?? null,
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

export function modelEnvFromMapping(mapping) {
  return {
    ANTHROPIC_MODEL: mapping.main,
    ANTHROPIC_DEFAULT_OPUS_MODEL: mapping.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: mapping.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: mapping.haiku,
    CLAUDE_CODE_SUBAGENT_MODEL: mapping.subagent,
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
  const nextEnv = {
    ...env,
    ...resolvedPreset,
    ...mergeModelsIntoEnv({}, mapping),
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_AUTH_TOKEN: apiKey,
  };
  delete nextEnv.ANTHROPIC_SMALL_FAST_MODEL;
  delete nextEnv.ENABLE_TOOL_SEARCH;
  return nextEnv;
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

  const token = apiKey || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || state.fireworksApiKey;
  if (!token) {
    throw new Error("No Fireworks API key found. Pass --api-key or set FIREWORKS_API_KEY.");
  }

  const resolvedKeyType = keyType === "fireworks" ? detectApiKeyType(token) : keyType;

  const next = {
    ...settings,
    env: buildFireworksProviderEnv(env, { apiKey: token, baseUrl, mapping, preset, keyType: resolvedKeyType }),
  };

  await writeJson(settingsPath, next);
  await writeJson(statePath, { ...state, enabled: true, fireworksApiKey: token });
  return token;
}

export async function disableFireworksProvider({ settingsPath, dataDir }) {
  const backupPath = providerBackupPath(dataDir);
  const statePath = providerStatePath(dataDir);
  const settings = await readJsonIfExists(settingsPath);
  const backup = await readJsonIfExists(backupPath);
  const state = await readJsonIfExists(statePath);
  const env = settings.env ?? {};
  const nextEnv = { ...env };

  for (const key of FIREWORKS_ENV_KEYS) {
    delete nextEnv[key];
  }

  if (backup.values) {
    for (const [key, value] of Object.entries(backup.values)) {
      nextEnv[key] = value;
    }
    for (const key of backup.missing ?? []) {
      delete nextEnv[key];
    }
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
    enabled: false,
    fireworksApiKey: env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || state.fireworksApiKey,
  });

  if (backup.values) {
    await unlink(backupPath).catch(() => {});
  }
}

export async function applyModelMapping({ settingsPath, mapping }) {
  const settings = await readJsonIfExists(settingsPath);
  const env = settings.env ?? {};
  await writeJson(settingsPath, {
    ...settings,
    env: mergeModelsIntoEnv(env, mapping),
  });
}
