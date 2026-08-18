import {
  printStructuredHarnessStatus,
} from "../../harness/status-display.mjs";
import {
  printDeepseekRestartHint,
} from "../../cli/messages.mjs";
import { defaultMainModel } from "../../fireworks/model-id.mjs";
import {
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_FIREWORKS_BASE_URL,
  DEEPSEEK_FIREWORKS_PROVIDER_ID,
  deepseekAuthMode,
  deepseekCurrentModelId,
  deepseekProviderStatus,
  disableDeepseekFireworks,
  enableDeepseekFireworks,
  readDeepseekCredentialsIfExists,
  readDeepseekSettingsIfExists,
  resolveDeepseekApiKey,
} from "./core.mjs";
import { harnessFullKey } from "../../keys/harness-api-key.mjs";
import { finishEnvHarnessOn } from "../../harness/env-hook.mjs";
import { defineHarnessProfile } from "../../harness/engine.mjs";
import {
  deepseekPathsFor,
  ensureHomeForHarness,
} from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { harnessStatusKeySource } from "../../keys/api-key.mjs";

/**
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function deepseekResolveKey(ctx) {
  const { settingsPath, credentialsPath } = deepseekPathsFor(ctx);
  const { settings } = await readDeepseekSettingsIfExists(settingsPath);
  if (deepseekProviderStatus(settings) !== "fireworks") {
    return "";
  }
  const { credentials } = await readDeepseekCredentialsIfExists(credentialsPath);
  return resolveDeepseekApiKey({
    mode: deepseekAuthMode(settings, credentials),
    credentials,
  });
}

export default defineHarnessProfile({
  id: HARNESS.DEEPSEEK,
  label: "DeepSeek Harness",
  resolveKey: deepseekResolveKey,
  paths: (ctx) => deepseekPathsFor(ctx),
  keyEnvRef: DEEPSEEK_API_KEY_ENV,
  // Custom providers cannot forward local BYOK headers; workspace BYOK can
  // still auto-enable FireRouter.
  firerouter: {
    byok: "none",
    autoCatalog: true,
  },
  getExistingHarnessKey: async (_ctx, paths) => {
    const { settings } = await readDeepseekSettingsIfExists(paths.settingsPath);
    if (deepseekProviderStatus(settings) !== "fireworks") {
      return "";
    }
    const { credentials } = await readDeepseekCredentialsIfExists(paths.credentialsPath);
    return credentials[DEEPSEEK_API_KEY_ENV] ?? "";
  },
  enable: ({ paths, effectiveKey, keyType, modelId }) => enableDeepseekFireworks({
    settingsPath: paths.settingsPath,
    credentialsPath: paths.credentialsPath,
    dataDir: paths.dataDir,
    effectiveApiKey: effectiveKey,
    modelId,
    keyType,
  }),
  envHookOn: (ctx, effectiveKey) => finishEnvHarnessOn(ctx.home, {
    harnessId: "deepseek",
    expectedKey: effectiveKey,
  }),
  restartHint: () => printDeepseekRestartHint(),
  disable: ({ paths, wasEnabled }) => disableDeepseekFireworks({
    settingsPath: paths.settingsPath,
    credentialsPath: paths.credentialsPath,
    dataDir: paths.dataDir,
    wasEnabled,
  }),
  restartHintOff: (outcome) => {
    if (outcome !== "unchanged") {
      printDeepseekRestartHint();
    }
  },
  async providerStatus(ctx) {
    ensureHomeForHarness(ctx, HARNESS.DEEPSEEK);
    const { settingsPath } = deepseekPathsFor(ctx);
    const { settings } = await readDeepseekSettingsIfExists(settingsPath);
    return deepseekProviderStatus(settings);
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.DEEPSEEK);
    const { settingsPath, credentialsPath } = deepseekPathsFor(ctx);
    const [{ settings }, { credentials }] = await Promise.all([
      readDeepseekSettingsIfExists(settingsPath),
      readDeepseekCredentialsIfExists(credentialsPath),
    ]);

    const provider = deepseekProviderStatus(settings);
    const apiKeyMode = deepseekAuthMode(settings, credentials);
    const model = deepseekCurrentModelId(settings);
    const resolvedKey = await harnessFullKey(ctx, async () => (
      provider === "fireworks"
        ? resolveDeepseekApiKey({ mode: apiKeyMode, credentials })
        : ""
    ));
    const payload = {
      harness: HARNESS.DEEPSEEK,
      provider,
      baseUrl: DEEPSEEK_FIREWORKS_BASE_URL,
      modelProvider: DEEPSEEK_FIREWORKS_PROVIDER_ID,
      hasAuthToken: Boolean(resolvedKey),
      apiKeyMode,
      defaults: { main: defaultMainModel() },
      current: { main: model },
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.DEEPSEEK, {
      provider: payload.provider,
      keyConfigured: payload.hasAuthToken,
      authMode: payload.apiKeyMode,
      model: payload.current.main,
      keySource: harnessStatusKeySource(HARNESS.DEEPSEEK, payload.provider),
    });
  },
});
