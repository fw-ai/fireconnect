import { userSettingsPath } from "../harnesses/claude/core.mjs";
import { refreshFirerouterClaudeKey } from "../harnesses/claude/firerouter.mjs";
import { codexConfigPath, refreshCodexGatewayKey } from "../harnesses/codex/core.mjs";
import {
  deepseekCredentialsPath,
  deepseekSettingsPath,
  refreshDeepseekGatewayKey,
} from "../harnesses/deepseek/core.mjs";
import { opencodeConfigPath, refreshOpencodeGatewayKey } from "../harnesses/opencode/core.mjs";
import { piAuthPath, refreshPiGatewayKey } from "../harnesses/pi/core.mjs";
import {
  FIREWORKS_API_KEY_KEYCHAIN_REF,
  readGlobalConfig,
  isEnabledFireworksHarness,
  writeGlobalConfig,
} from "../config/global-config.mjs";
import { HARNESS } from "../harness/id.mjs";
import { reconcileShellEnvHook } from "../io/shell-env-hook.mjs";
import { resolveFireworksApiKeyValue, tryReadKeychainSecret } from "./api-key.mjs";
import { isEnvConfigRef, migrateLegacyGlobalApiKey } from "./config-ref.mjs";
import { refreshWebsearchMcpAuth } from "../system/websearch-mcp.mjs";

/**
 * @param {import("../config/global-config.mjs").HarnessConfigMap} harnesses
 * @param {import("../harness/id.mjs").HarnessId} harnessId
 */
function shouldSyncFireworksHarness(harnesses, harnessId) {
  return isEnabledFireworksHarness(harnesses, harnessId);
}

/**
 * Re-point every **enabled** Fireworks-routed harness config that holds the key
 * as a baked plaintext literal (or legacy env-reference) so a `login`/rotation
 * takes effect without re-running `on`.
 *
 * Codex: only `[model_providers.fireworks-ai]` auth is updated when the active
 * route is the Fireworks gateway (`refreshCodexGatewayKey`).
 *
 * `<harness> on` is the write path when enabling: it resolves the key, writes
 * the literal into the harness config, then marks the harness enabled.
 *
 * Returns user-facing notes per harness updated (or whose update failed).
 * Never throws.
 * @param {string} home
 * @param {string} fireworksKey
 * @returns {Promise<string[]>}
 */
export async function syncBakedKeysAfterStore(home, fireworksKey) {
  if (!home || !fireworksKey?.trim()) {
    return [];
  }
  const { harnesses } = await readGlobalConfig(home);
  const opencodeConfig = opencodeConfigPath(home, "");
  const codexConfig = codexConfigPath(home, "");
  const deepseekSettings = deepseekSettingsPath(home, "");
  const deepseekCredentials = deepseekCredentialsPath(home);
  const targets = [
    {
      id: HARNESS.CLAUDE,
      label: "Claude Code",
      hint: "fireconnect claude",
      refresh: () => refreshFirerouterClaudeKey({ settingsPath: userSettingsPath(home), fireworksKey }),
    },
    {
      id: HARNESS.CODEX,
      label: "Codex",
      hint: "fireconnect codex on",
      refresh: () => refreshCodexGatewayKey({ configPath: codexConfig, fireworksKey }),
    },
    {
      id: HARNESS.PI,
      label: "Pi",
      hint: "fireconnect pi on",
      refresh: () => refreshPiGatewayKey({ authPath: piAuthPath(home), fireworksKey }),
    },
    {
      id: HARNESS.OPENCODE,
      label: "OpenCode",
      hint: "fireconnect opencode on",
      refresh: () => refreshOpencodeGatewayKey({ configPath: opencodeConfig, fireworksKey }),
    },
    {
      id: HARNESS.DEEPSEEK,
      label: "DeepSeek Harness",
      hint: "fireconnect deepseek on",
      refresh: () => refreshDeepseekGatewayKey({
        settingsPath: deepseekSettings,
        credentialsPath: deepseekCredentials,
        fireworksKey,
      }),
    },
  ];
  const notes = [];
  for (const { id, label, hint, refresh } of targets) {
    if (!shouldSyncFireworksHarness(harnesses, id)) {
      continue;
    }
    try {
      if (await refresh()) {
        notes.push(`Updated ${label}'s Fireworks settings with this key — restart ${label} to pick it up.`);
      }
    } catch {
      notes.push(`Couldn't update ${label}'s Fireworks settings — re-run ${hint} to use this key there.`);
    }
  }
  try {
    if (await refreshWebsearchMcpAuth(home, fireworksKey)) {
      notes.push(
        "Updated Claude websearch MCP auth (baked Bearer token) — restart Claude Code to pick it up.",
      );
    }
  } catch {
    notes.push("Couldn't update Claude websearch MCP auth — re-run fireconnect claude on.");
  }
  return notes;
}

/**
 * Post-upgrade key reconciliation: rebake every enabled Fireworks harness
 * config to plaintext literals (including legacy env-reference auth), repair
 * a stale global `{env:FIREWORKS_API_KEY}` ref when keychain holds the secret,
 * and reconcile the shell hook (Anthropic export for Codex BYOK; no FIREWORKS
 * export — websearch MCP bakes its Bearer token).
 *
 * Key-independent harness migrations live in `system/forward-migrations.mjs`.
 * Never throws.
 * @param {string} home
 * @returns {Promise<string[]>}
 */
export async function reconcileHarnessConfigOnUpgrade(home) {
  if (!home) {
    return [];
  }
  const notes = [];
  try {
    await migrateLegacyGlobalApiKey(home);
  } catch {
    // Best-effort: upgrade finalize must not abort after the git reset.
  }
  try {
    const fromKeychain = await tryReadKeychainSecret(home);
    if (fromKeychain) {
      const config = await readGlobalConfig(home);
      if (isEnvConfigRef(config.apiKey)) {
        await writeGlobalConfig(home, { apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF });
      }
    }
  } catch {
    // Best-effort config repair — rebake may still use the keychain secret directly.
  }
  let key = "";
  try {
    key = (await tryReadKeychainSecret(home))?.trim()
      || (await resolveFireworksApiKeyValue({ home }));
  } catch {
    return notes;
  }
  if (key) {
    notes.push(...await syncBakedKeysAfterStore(home, key));
  }
  try {
    await reconcileShellEnvHook(home);
  } catch {
    // Best-effort shell reconcile — never fail upgrade over ~/.bashrc I/O.
  }
  return notes;
}
