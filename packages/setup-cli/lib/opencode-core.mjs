import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_MAIN_MODEL,
  detectApiKeyType,
  normalizeModelId,
  readJsonIfExists,
  writeJson,
} from "./fireconnect-core.mjs";

export const OPENCODE_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
export const OPENCODE_CONFIG_RELATIVE_PATH = ".config/opencode/opencode.json";
export const OPENCODE_DATA_RELATIVE_DIR = ".fireconnect/opencode";
export const OPENCODE_API_KEY_ENV_REF = "{env:FIREWORKS_API_KEY}";

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

export function opencodeStatePath(dataDir) {
  return path.join(dataDir, "state.json");
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

export function buildFireworksProviderBlock({ apiKeyValue, modelId }) {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Fireworks",
    options: {
      baseURL: OPENCODE_FIREWORKS_BASE_URL,
      apiKey: apiKeyValue,
    },
    models: {
      [modelId]: { name: `${modelId} (Fireworks)` },
    },
  };
}

export function opencodeProviderStatus(config) {
  const hasProvider = Boolean(config.provider?.fireworks);
  const model = typeof config.model === "string" ? config.model : "";
  if (hasProvider && model.startsWith("fireworks/")) {
    return "fireworks";
  }
  if (hasProvider || model.startsWith("fireworks/")) {
    return "custom";
  }
  return "default";
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

  // Model precedence: explicit request > model already configured by a previous
  // `on` > default. A repeat `on` without --main must not reset the user's choice.
  const currentModelId = typeof config.model === "string" && config.model.startsWith("fireworks/")
    ? config.model.slice("fireworks/".length)
    : "";

  // Fire Pass only covers kimi-k2p6-turbo; when no explicit model is requested,
  // default to that router so the user gets a working config out of the box.
  let effectiveModelId = modelId;
  if (resolvedKeyType === "firepass" && !modelId) {
    effectiveModelId = DEFAULT_MAIN_MODEL;
  }

  const resolvedModel = normalizeModelId(effectiveModelId || currentModelId || DEFAULT_MAIN_MODEL);

  const backupPath = opencodeBackupPath(dataDir, configPath);
  // Snapshot only when the live config carries no trace of FireConnect (no
  // provider.fireworks block):
  // - first `on`: captures the true pre-Fireworks state;
  // - repeat `on` while enabled, or in a PARTIAL state (our provider block
  //   present but the model switched away): the existing backup is still the
  //   true pre-`on` original — keep it, never overwrite with an intermediate;
  // - `on` after the config was reverted/replaced outside `off` (our block
  //   gone): any leftover backup is stale — overwrite with a fresh snapshot so
  //   `off` can never clobber the user's current config with old content.
  // If our block is present but no backup exists (data dir wiped), we record
  // nothing: `off` then falls back to stripping only what we own.
  const hasOurProvider = Boolean(config.provider?.fireworks);
  if (!hasOurProvider) {
    // The snapshot can contain credentials from the user's other providers —
    // keep the backup (and its directory) private to the owner.
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, { configPath: path.resolve(configPath), snapshot });
    await chmod(backupPath, 0o600);
  }

  // Keep the secret off disk when it came from the environment; only write the
  // literal value when the user explicitly passed --api-key.
  const apiKeyValue = apiKeyFromFlag ? apiKey : OPENCODE_API_KEY_ENV_REF;

  const next = {
    ...config,
    provider: {
      ...(config.provider ?? {}),
      fireworks: buildFireworksProviderBlock({ apiKeyValue, modelId: resolvedModel }),
    },
    model: `fireworks/${resolvedModel}`,
  };

  await writeJson(configPath, next);
  await writeJson(opencodeStatePath(dataDir), { enabled: true });

  return { model: next.model, apiKeyMode: apiKeyFromFlag ? "literal" : "env-reference", keyType: resolvedKeyType };
}

export async function disableOpencodeFireworks({ configPath, dataDir }) {
  const backupPath = opencodeBackupPath(dataDir, configPath);
  const backup = await readJsonIfExists(backupPath);

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
      const config = await readJsonIfExists(configPath);
      let changed = false;
      if (config.provider?.fireworks) {
        delete config.provider.fireworks;
        if (Object.keys(config.provider).length === 0) {
          delete config.provider;
        }
        changed = true;
      }
      if (typeof config.model === "string" && config.model.startsWith("fireworks/")) {
        delete config.model;
        changed = true;
      }
      if (changed) {
        await writeJson(configPath, config);
      }
    }
  }

  await writeJson(opencodeStatePath(dataDir), { enabled: false });
}
