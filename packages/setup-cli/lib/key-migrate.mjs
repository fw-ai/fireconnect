import { writeFileAtomic } from "./atomic-write.mjs";
import path from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import {
  ENV_SHELL_HARNESS_IDS,
  FIREWORKS_API_KEY_ENV_REF,
  FIREWORKS_API_KEY_KEYCHAIN_REF,
  isHarnessEnabled,
  readGlobalConfig,
  writeGlobalConfig,
} from "./global-config.mjs";
import {
  isKeychainConfigRef,
  isLegacyLiteralConfigRef,
} from "./api-key.mjs";
import { getSecret, setSecret } from "./secret-store.mjs";
import { fireconnectKeyExportCommand } from "./cli-path.mjs";
import {
  providerStatePath,
  providerStatusFromEnv,
  readJsonIfExists,
  USER_SETTINGS_RELATIVE_PATH,
  writeJson,
} from "./fireconnect-core.mjs";
import { isFireworksKey } from "./fireworks-models.mjs";
import {
  CODEX_API_KEY_ENV_REF,
  CODEX_CONFIG_RELATIVE_PATH,
  codexStoredAuthRef,
  readCodexTomlIfExists,
} from "./codex-core.mjs";
import {
  OPENCODE_API_KEY_ENV_REF,
  OPENCODE_CONFIG_RELATIVE_PATH,
  OPENCODE_FIREWORKS_PROVIDER_ID,
} from "./opencode-core.mjs";
import { PI_API_KEY_ENV_REF, piAuthPath } from "./pi-core.mjs";
import {
  cursorStateDbPath,
  readCursorState,
} from "./cursor-core.mjs";
import { patchCodexProviderAuthRaw } from "./codex-toml-patch.mjs";
import {
  installShellEnvHook,
  resolveShellConfigPath,
} from "./shell-env-hook.mjs";

/**
 * Ensure the keychain/file store holds `key` (readback-verified) before any
 * destructive migration write. Returns:
 *   - true  if the store holds `key` (or just stored it) — safe to delete the literal.
 *   - false if the store holds a DIFFERENT key — caller must NOT delete the literal
 *           (silently overwriting a user's intentionally-stored key would lose it).
 *
 * `setSecret` readback-verifies and throws on a locked/null backend, so a throw
 * here aborts the caller's destructive write and the literal is preserved.
 *
 * @param {string} key
 * @param {string} home
 * @returns {Promise<boolean>}
 */
async function ensureKeychainSecret(key, home) {
  if (!key) {
    return true;
  }
  const existing = await getSecret(home);
  if (existing && existing.trim() !== key.trim()) {
    return false;
  }
  if (!existing) {
    await setSecret(key, home);
  }
  return true;
}

/**
 * @param {string} home
 * @param {import("./global-config.mjs").HarnessConfigMap} harnesses
 * @returns {Promise<string | null>}
 */
async function migrateGlobalConfigLiteral(home, harnesses) {
  const config = await readGlobalConfig(home);
  if (!isLegacyLiteralConfigRef(config.apiKey)) {
    return null;
  }

  const stored = await ensureKeychainSecret(config.apiKey, home);
  if (!stored) {
    return "Skipped global config migration: the keychain holds a different key; kept the literal in ~/.fireconnect/config.json.";
  }
  await writeGlobalConfig(home, {
    apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF,
    harnesses,
  });
  return "Migrated literal API key from ~/.fireconnect/config.json to keychain.";
}

/**
 * @param {string} home
 * @returns {Promise<string | null>}
 */
async function migrateClaudeSettings(home) {
  const claudeSettingsPath = path.join(home, USER_SETTINGS_RELATIVE_PATH);
  const claudeSettings = await readJsonIfExists(claudeSettingsPath);
  if (!Object.keys(claudeSettings).length) {
    return null;
  }

  const dataDir = path.join(home, ".fireconnect/claude");
  const statePath = providerStatePath(dataDir);
  const state = await readJsonIfExists(statePath);
  const env = claudeSettings.env ?? {};

  const claudeKey = isFireworksKey(env.ANTHROPIC_API_KEY)
    ? env.ANTHROPIC_API_KEY.trim()
    : isFireworksKey(env.ANTHROPIC_AUTH_TOKEN)
      ? env.ANTHROPIC_AUTH_TOKEN.trim()
      : isFireworksKey(state.fireworksApiKey)
        ? state.fireworksApiKey.trim()
        : "";

  if (!claudeKey) {
    return null;
  }

  const stored = await ensureKeychainSecret(claudeKey, home);
  if (!stored) {
    return "Skipped Claude settings migration: the keychain holds a different key; kept the literal in ~/.claude/settings.json.";
  }
  await writeGlobalConfig(home, {
    apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF,
    harnesses: (await readGlobalConfig(home)).harnesses,
  });

  if (providerStatusFromEnv(env) !== "fireworks") {
    return "Found literal Fireworks key in Claude settings — stored in keychain.";
  }

  const apiKeyHelperPath = fireconnectKeyExportCommand(home);
  const nextEnv = { ...env };
  delete nextEnv.ANTHROPIC_API_KEY;
  delete nextEnv.ANTHROPIC_AUTH_TOKEN;

  await writeJson(claudeSettingsPath, {
    ...claudeSettings,
    apiKeyHelper: apiKeyHelperPath,
    env: nextEnv,
  });
  await writeJson(statePath, {
    ...state,
    authMode: "apiKeyHelper",
    managedApiKeyHelper: apiKeyHelperPath,
    fireworksApiKey: undefined,
  });
  return "Migrated Claude settings from literal key to apiKeyHelper.";
}

/**
 * @param {string} home
 * @returns {Promise<string | null>}
 */
async function migrateCodexAuth(home) {
  const codexConfigPath = path.join(home, CODEX_CONFIG_RELATIVE_PATH);
  const { doc } = await readCodexTomlIfExists(codexConfigPath);
  const codexAuth = codexStoredAuthRef(doc);
  if (!codexAuth || codexAuth === CODEX_API_KEY_ENV_REF) {
    return null;
  }

  const stored = await ensureKeychainSecret(codexAuth, home);
  if (!stored) {
    return "Skipped Codex migration: the keychain holds a different key; kept the bearer token in ~/.codex/config.toml.";
  }
  const raw = await readFile(codexConfigPath, "utf8");
  const patched = patchCodexProviderAuthRaw(raw, { apiKey: "", literalAuth: false });
  await mkdir(path.dirname(codexConfigPath), { recursive: true });
  await writeFileAtomic(codexConfigPath, patched);
  return "Migrated Codex bearer token to env_key reference.";
}

/**
 * @param {unknown} apiKey
 */
function isOpencodeLiteralApiKey(apiKey) {
  return typeof apiKey === "string"
    && apiKey
    && apiKey !== OPENCODE_API_KEY_ENV_REF
    && !apiKey.startsWith("{env:");
}

/**
 * @param {Record<string, unknown>} opencode
 * @returns {string}
 */
function opencodeLiteralApiKey(opencode) {
  const aiKey = opencode.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]?.options?.apiKey;
  if (isOpencodeLiteralApiKey(aiKey)) {
    return aiKey.trim();
  }
  const legacyKey = opencode.provider?.fireworks?.options?.apiKey;
  if (isOpencodeLiteralApiKey(legacyKey)) {
    return legacyKey.trim();
  }
  return "";
}

/**
 * @param {string} home
 * @returns {Promise<string | null>}
 */
async function migrateOpencodeAuth(home) {
  const opencodePath = path.join(home, OPENCODE_CONFIG_RELATIVE_PATH);
  const opencode = await readJsonIfExists(opencodePath);
  if (!Object.keys(opencode).length) {
    return null;
  }

  const literalKey = opencodeLiteralApiKey(opencode);
  const hasLegacyProvider = Boolean(opencode.provider?.fireworks);
  if (!literalKey && !hasLegacyProvider) {
    return null;
  }

  if (literalKey) {
    const stored = await ensureKeychainSecret(literalKey, home);
    if (!stored) {
      return "Skipped OpenCode migration: the keychain holds a different key; kept the literal in opencode.json.";
    }
  }

  const provider = { ...(opencode.provider ?? {}) };
  if (provider.fireworks) {
    const legacy = provider.fireworks;
    if (!provider[OPENCODE_FIREWORKS_PROVIDER_ID]) {
      provider[OPENCODE_FIREWORKS_PROVIDER_ID] = {
        ...legacy,
        options: {
          ...(legacy.options ?? {}),
          apiKey: OPENCODE_API_KEY_ENV_REF,
        },
      };
    }
    delete provider.fireworks;
  }

  const fireworksAi = provider[OPENCODE_FIREWORKS_PROVIDER_ID];
  if (fireworksAi?.options) {
    provider[OPENCODE_FIREWORKS_PROVIDER_ID] = {
      ...fireworksAi,
      options: {
        ...fireworksAi.options,
        apiKey: OPENCODE_API_KEY_ENV_REF,
      },
    };
  }

  let model = opencode.model;
  if (typeof model === "string" && model.startsWith("fireworks/")) {
    model = `${OPENCODE_FIREWORKS_PROVIDER_ID}/${model.slice("fireworks/".length)}`;
  }

  await writeJson(opencodePath, { ...opencode, provider, model });
  return "Migrated OpenCode literal API key to env reference.";
}

/**
 * @param {string} home
 * @returns {Promise<string | null>}
 */
async function migratePiAuth(home) {
  const piAuthFile = piAuthPath(home);
  const piAuth = await readJsonIfExists(piAuthFile);
  const piKey = piAuth.fireworks?.key ?? "";
  if (!piKey || piKey === PI_API_KEY_ENV_REF || piKey === "${FIREWORKS_API_KEY}") {
    return null;
  }

  const stored = await ensureKeychainSecret(piKey, home);
  if (!stored) {
    return "Skipped Pi migration: the keychain holds a different key; kept the literal in auth.json.";
  }
  piAuth.fireworks.key = PI_API_KEY_ENV_REF;
  await writeJson(piAuthFile, piAuth);
  return "Migrated Pi literal API key to env reference.";
}

/**
 * @param {string} home
 * @returns {Promise<string | null>}
 */
async function migrateCursorAuth(home) {
  const dbPath = cursorStateDbPath({ home });
  const { openAIKey } = await readCursorState(dbPath);
  const cursorKey = openAIKey?.trim() ?? "";
  if (!isFireworksKey(cursorKey)) {
    return null;
  }

  const stored = await ensureKeychainSecret(cursorKey, home);
  if (!stored) {
    return "Skipped Cursor migration: the keychain holds a different key; kept the literal in Cursor settings.";
  }
  await writeGlobalConfig(home, {
    apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF,
    harnesses: (await readGlobalConfig(home)).harnesses,
  });
  return "Found literal Fireworks key in Cursor settings — stored in keychain.";
}

/**
 * @param {string} home
 */
async function shouldInstallShellHook(home) {
  const config = await readGlobalConfig(home);
  if (!isKeychainConfigRef(config.apiKey)) {
    return false;
  }
  for (const harnessId of ENV_SHELL_HARNESS_IDS) {
    if (await isHarnessEnabled(home, harnessId)) {
      return true;
    }
  }
  return false;
}

/**
 * Migrate legacy plaintext credentials into keychain refs and harness env/apiKeyHelper wiring.
 * @param {string} home
 * @param {{ installShellHook?: boolean, reportGlobalStatus?: boolean }} [options]
 * @returns {Promise<string[]>}
 */
export async function migrateLegacyCredentials(home, {
  installShellHook = true,
  reportGlobalStatus = true,
} = {}) {
  const config = await readGlobalConfig(home);
  const changes = [];

  let globalChange = null;
  try {
    globalChange = await migrateGlobalConfigLiteral(home, config.harnesses);
  } catch (error) {
    // Storage failure (e.g. keychain locked, file backend unwritable). The
    // literal in ~/.fireconnect/config.json is preserved because
    // `ensureKeychainSecret` verified-before-delete and threw first. Surface it
    // and continue with per-harness migration rather than aborting wholesale.
    const reason = error instanceof Error ? error.message : String(error);
    changes.push(`Migration aborted for global config — the literal key was kept. ${reason}`);
  }
  if (globalChange) {
    changes.push(globalChange);
  } else if (reportGlobalStatus && !changes.length) {
    if (config.apiKey === FIREWORKS_API_KEY_ENV_REF) {
      changes.push("Global config already uses {env:FIREWORKS_API_KEY}.");
    } else if (isKeychainConfigRef(config.apiKey)) {
      changes.push(`Global config already uses ${FIREWORKS_API_KEY_KEYCHAIN_REF}.`);
    }
  }

  for (const migrate of [
    migrateClaudeSettings,
    migrateCodexAuth,
    migrateOpencodeAuth,
    migratePiAuth,
    migrateCursorAuth,
  ]) {
    try {
      const change = await migrate(home);
      if (change) {
        changes.push(change);
      }
    } catch (error) {
      // A single harness migration failure (e.g. keychain locked, file backend
      // unwritable) must not abort the rest or leave a half-migrated harness.
      // `ensureKeychainSecret` already verified-before-delete, so the literal
      // is preserved; surface the failure so the user can remediate.
      const reason = error instanceof Error ? error.message : String(error);
      changes.push(`Migration aborted for one harness — the literal key was kept. ${reason}`);
    }
  }

  if (installShellHook && await shouldInstallShellHook(home)) {
    await installShellEnvHook(home);
    changes.push(`Installed shell env hook in ${resolveShellConfigPath(home)}.`);
  }

  return changes;
}
