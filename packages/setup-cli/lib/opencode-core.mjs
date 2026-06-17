import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_FIREPASS_MAIN_MODEL,
  DEFAULT_MAIN_MODEL,
  detectApiKeyType,
  normalizeModelId,
  readJsonIfExists,
  writeJson,
} from "./fireconnect-core.mjs";
import { isHarnessEnabled } from "./global-config.mjs";
import { HARNESS } from "./harness.mjs";

export const OPENCODE_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
export const OPENCODE_CONFIG_RELATIVE_PATH = ".config/opencode/opencode.json";
export const OPENCODE_DATA_RELATIVE_DIR = ".fireconnect/opencode";
export const OPENCODE_API_KEY_ENV_REF = "{env:FIREWORKS_API_KEY}";
export const OPENCODE_FIREWORKS_PROVIDER_ID = "fireworks-ai";

export function opencodeConfigPath(home, configPath) {
  if (configPath) {
    return configPath;
  }
  return path.join(home, OPENCODE_CONFIG_RELATIVE_PATH);
}

export function opencodeDataDir(home, dataDir) {
  if (dataDir) {
    return dataDir;
  }
  return path.join(home, OPENCODE_DATA_RELATIVE_DIR);
}

// Backups are keyed by the config file they snapshot, so enabling Fireworks on
// two different opencode.json paths (e.g. via --config-path) can never restore
// one file's content onto the other.
export function opencodeBackupPath(dataDir, configPath) {
  const key = createHash("sha256").update(path.resolve(configPath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `config-backup.${key}.json`);
}

// Raw-text snapshot (not parsed JSON) so `off` can restore the user's file
// byte-for-byte, preserving their formatting and key order.
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

export function opencodeCurrentModelId(config) {
  const modelRef = typeof config.model === "string" ? config.model : "";
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  if (modelRef.startsWith(prefix)) {
    return modelRef.slice(prefix.length);
  }
  if (modelRef.startsWith("fireworks/")) {
    return modelRef.slice("fireworks/".length);
  }
  return null;
}

export function opencodeProviderStatus(config) {
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  const hasFireworksAi = Boolean(config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]);
  const hasLegacy = Boolean(config.provider?.fireworks);
  const model = typeof config.model === "string" ? config.model : "";
  const fireworksModel = model.startsWith(prefix) || model.startsWith("fireworks/");
  if ((hasFireworksAi || hasLegacy) && fireworksModel) {
    return "fireworks";
  }
  if (hasFireworksAi || hasLegacy || fireworksModel) {
    return "custom";
  }
  return "default";
}

function homeFromDataDir(dataDir) {
  if (path.basename(dataDir) !== "opencode" || path.basename(path.dirname(dataDir)) !== ".fireconnect") {
    return "";
  }
  return path.dirname(path.dirname(dataDir));
}

export async function enableOpencodeFireworks({
  configPath,
  dataDir,
  apiKey,
  apiKeyFromFlag = false,
  modelId,
  keyType = "fireworks",
}) {
  if (!apiKey) {
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

  // Resolve the {env:FIREWORKS_API_KEY} placeholder to the real env value before
  // detecting key type — otherwise env-ref stored keys always detect as "fireworks".
  const effectiveApiKey = apiKey === OPENCODE_API_KEY_ENV_REF
    ? (process.env.FIREWORKS_API_KEY ?? "")
    : apiKey;
  const resolvedKeyType = keyType === "fireworks" ? detectApiKeyType(effectiveApiKey) : keyType;

  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  const modelRef = typeof config.model === "string" ? config.model : "";
  // Model precedence: explicit request > model already configured by a previous
  // `on` > default. A repeat `on` without --main must not reset the user's choice.
  const currentModelId = modelRef.startsWith(prefix)
    ? modelRef.slice(prefix.length)
    : modelRef.startsWith("fireworks/")
      ? modelRef.slice("fireworks/".length)
      : "";

  // Fire Pass defaults to the K2.7 Code Fast router; when no explicit model is
  // requested, use that so the user gets a working config out of the box.
  let effectiveModelId = modelId;
  if (resolvedKeyType === "firepass" && !modelId) {
    effectiveModelId = DEFAULT_FIREPASS_MAIN_MODEL;
  }

  const resolvedModel = normalizeModelId(effectiveModelId || currentModelId || DEFAULT_MAIN_MODEL);

  const backupPath = opencodeBackupPath(dataDir, configPath);
  const hasBackup = (await readJsonIfExists(backupPath)).snapshot !== undefined;
  const hasFireconnectRouting = Boolean(
    config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID] || config.provider?.fireworks,
  );
  const home = homeFromDataDir(dataDir);
  const wasGloballyEnabled = home ? await isHarnessEnabled(home, HARNESS.OPENCODE) : false;
  const shouldSnapshot = !hasBackup
    ? !hasFireconnectRouting || !wasGloballyEnabled
    : !hasFireconnectRouting;
  if (shouldSnapshot) {
    // The snapshot can contain credentials from the user's other providers —
    // keep the backup (and its directory) private to the owner.
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, { configPath: path.resolve(configPath), snapshot });
    await chmod(backupPath, 0o600);
  }

  const shortName = resolvedModel.split("/").at(-1) ?? resolvedModel;
  const provider = { ...(config.provider ?? {}) };
  delete provider.fireworks;

  const existing = provider[OPENCODE_FIREWORKS_PROVIDER_ID] ?? {};
  const apiKeyValue = apiKeyFromFlag ? apiKey : OPENCODE_API_KEY_ENV_REF;
  provider[OPENCODE_FIREWORKS_PROVIDER_ID] = {
    ...existing,
    options: { ...(existing.options ?? {}), apiKey: apiKeyValue },
    models: {
      ...(existing.models ?? {}),
      [shortName]: { name: shortName },
    },
  };

  const next = {
    ...config,
    provider,
    model: `${prefix}${shortName}`,
  };

  await writeJson(configPath, next);
  return { model: next.model, apiKeyMode: apiKeyFromFlag ? "literal" : "env-reference", keyType: resolvedKeyType };
}

export async function disableOpencodeFireworks({ configPath, dataDir, wasEnabled = false }) {
  const backupPath = opencodeBackupPath(dataDir, configPath);
  const backup = await readJsonIfExists(backupPath);
  const config = await readJsonIfExists(configPath);
  const status = opencodeProviderStatus(config);
  const hasBackup = backup.snapshot !== undefined;
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;

  if (!wasEnabled && !hasBackup && status !== "fireworks") {
    return;
  }

  // Refuse to restore a snapshot that was taken for a different config file
  // (legacy un-keyed backups have no configPath recorded).
  if (backup.snapshot !== undefined
    && backup.configPath !== undefined
    && backup.configPath !== path.resolve(configPath)) {
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
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    await unlink(backupPath);
  } else {
    // No backup: strip only what we own, and only touch the file if we actually
    // removed something — never create a config that didn't exist, and never
    // re-serialize a config Fireworks was not enabled on.
    const { existed } = await readRawIfExists(configPath);
    if (existed) {
      const liveConfig = await readJsonIfExists(configPath);
      let changed = false;
      if (liveConfig.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]) {
        delete liveConfig.provider[OPENCODE_FIREWORKS_PROVIDER_ID];
        changed = true;
      }
      if (liveConfig.provider?.fireworks) {
        delete liveConfig.provider.fireworks;
        changed = true;
      }
      if (typeof liveConfig.model === "string"
        && (liveConfig.model.startsWith(prefix) || liveConfig.model.startsWith("fireworks/"))) {
        delete liveConfig.model;
        changed = true;
      }
      if (liveConfig.provider && Object.keys(liveConfig.provider).length === 0) {
        delete liveConfig.provider;
        changed = true;
      }
      if (changed) {
        await writeJson(configPath, liveConfig);
      }
    }
  }
}
