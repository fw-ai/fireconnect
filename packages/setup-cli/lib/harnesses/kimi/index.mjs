import {
  printStructuredHarnessStatus,
} from "../../harness/status-display.mjs";
import {
  printKimiRestartHint,
} from "../../cli/messages.mjs";
import { defaultMainModel } from "../../fireworks/model-id.mjs";
import {
  KIMI_API_KEY_ENV,
  KIMI_AZURE_PROVIDER_ID,
  KIMI_FIREWORKS_BASE_URL,
  KIMI_FIREWORKS_PROVIDER_ID,
  disableKimiFireworks,
  enableKimiAzure,
  enableKimiFireworks,
  kimiAuthMode,
  kimiAzureBaseUrl,
  kimiAzureStoredKey,
  kimiCurrentModelId,
  kimiFireworksStoredKey,
  kimiProviderStatus,
  readKimiTomlIfExists,
} from "./core.mjs";
import { DEFAULT_AZURE_MODEL } from "../../fireworks/azure-core.mjs";
import { harnessFullKey } from "../../keys/harness-api-key.mjs";
import { finishEnvHarnessOn } from "../../harness/env-hook.mjs";
import { defineHarnessProfile } from "../../harness/engine.mjs";
import {
  ensureHomeForHarness,
  kimiPathsFor,
} from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { harnessStatusKeySource } from "../../keys/api-key.mjs";

async function kimiResolveKey(ctx) {
  const { configPath } = kimiPathsFor(ctx);
  const { doc } = await readKimiTomlIfExists(configPath);
  if (kimiProviderStatus(doc) !== "fireworks") {
    return "";
  }
  return kimiFireworksStoredKey(doc);
}

async function kimiApiKey(ctx) {
  return harnessFullKey(ctx, kimiResolveKey);
}

export default defineHarnessProfile({
  id: HARNESS.KIMI,
  label: "Kimi Code",
  resolveKey: kimiResolveKey,
  paths: (ctx) => kimiPathsFor(ctx),
  keyEnvRef: KIMI_API_KEY_ENV,
  firerouter: {
    byok: "none",
    autoCatalog: true,
  },
  azure: {
    read: async (_ctx, { configPath }) => {
      const { doc } = await readKimiTomlIfExists(configPath);
      return {
        active: kimiProviderStatus(doc) === "azure",
        storedKey: kimiAzureStoredKey(doc),
        storedBaseUrl: kimiAzureBaseUrl(doc) ?? "",
      };
    },
    enable: ({ ctx, paths, apiKey, baseUrl }) => enableKimiAzure({
      configPath: paths.configPath,
      dataDir: paths.dataDir,
      apiKey,
      baseUrl,
      modelId: ctx.main,
    }),
    restart: () => printKimiRestartHint(),
  },
  enable: ({ paths, effectiveKey, keyType, modelId }) => enableKimiFireworks({
    configPath: paths.configPath,
    dataDir: paths.dataDir,
    effectiveApiKey: effectiveKey,
    modelId,
    keyType,
  }),
  envHookOn: (ctx, effectiveKey) => finishEnvHarnessOn(ctx.home, {
    harnessId: "kimi",
    expectedKey: effectiveKey,
  }),
  restartHint: () => printKimiRestartHint(),
  disable: ({ paths, wasEnabled }) => disableKimiFireworks({
    configPath: paths.configPath,
    dataDir: paths.dataDir,
    wasEnabled,
  }),
  restartHintOff: () => printKimiRestartHint(),
  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.KIMI);
    const { configPath } = kimiPathsFor(ctx);
    const { doc } = await readKimiTomlIfExists(configPath);

    if (kimiProviderStatus(doc) === "azure") {
      const storedKey = kimiAzureStoredKey(doc);
      const payload = {
        harness: HARNESS.KIMI,
        provider: "azure",
        baseUrl: kimiAzureBaseUrl(doc),
        modelProvider: KIMI_AZURE_PROVIDER_ID,
        hasAuthToken: Boolean(storedKey),
        defaults: { main: DEFAULT_AZURE_MODEL },
        current: { main: kimiCurrentModelId(doc) },
      };
      if (ctx.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printStructuredHarnessStatus(HARNESS.KIMI, {
        provider: payload.provider,
        keyConfigured: payload.hasAuthToken,
        authMode: storedKey ? "literal" : "missing",
        model: payload.current.main,
        endpoint: payload.baseUrl,
      });
      return;
    }

    const model = kimiCurrentModelId(doc);
    const apiKeyMode = kimiAuthMode(doc);
    const resolvedKey = await kimiApiKey(ctx);
    const payload = {
      harness: HARNESS.KIMI,
      provider: kimiProviderStatus(doc),
      baseUrl: KIMI_FIREWORKS_BASE_URL,
      modelProvider: KIMI_FIREWORKS_PROVIDER_ID,
      hasAuthToken: Boolean(resolvedKey),
      apiKeyMode,
      defaults: { main: defaultMainModel() },
      current: { main: model },
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.KIMI, {
      provider: payload.provider,
      keyConfigured: payload.hasAuthToken,
      authMode: payload.apiKeyMode,
      model: payload.current.main,
      keySource: harnessStatusKeySource(HARNESS.KIMI, payload.provider),
    });
  },
});
