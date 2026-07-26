import {
  printStructuredHarnessStatus,
} from "../../harness/status-display.mjs";
import {
  printDeepagentsRestartHint,
} from "../../cli/messages.mjs";
import { defaultMainModel } from "../../fireworks/model-id.mjs";
import {
  DEEPAGENTS_API_KEY_ENV,
  DEEPAGENTS_AZURE_PROVIDER_ID,
  DEEPAGENTS_FIREWORKS_BASE_URL,
  DEEPAGENTS_FIREWORKS_PROVIDER_ID,
  deepagentsAuthMode,
  deepagentsAzureAuthKeyMode,
  deepagentsAzureBaseUrl,
  deepagentsAzureStoredAuthRef,
  deepagentsCurrentModelId,
  deepagentsFireworksStoredAuthRef,
  deepagentsProviderStatus,
  disableDeepagentsFireworks,
  enableDeepagentsAzure,
  enableDeepagentsFireworks,
  readDeepagentsTomlIfExists,
  resolveDeepagentsApiKey,
} from "./core.mjs";
import {
  DEFAULT_AZURE_MODEL,
  effectiveAzureApiKey,
} from "../../fireworks/azure-core.mjs";
import { harnessFullKey } from "../../keys/harness-api-key.mjs";
import { finishEnvHarnessOn } from "../../harness/env-hook.mjs";
import { defineHarnessProfile } from "../../harness/engine.mjs";
import {
  deepagentsPathsFor,
  ensureHomeForHarness,
} from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { harnessStatusKeySource } from "../../keys/api-key.mjs";

/**
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function deepagentsResolveKey(ctx) {
  const { configPath } = deepagentsPathsFor(ctx);
  const { doc } = await readDeepagentsTomlIfExists(configPath);
  if (deepagentsProviderStatus(doc) !== "fireworks") {
    return "";
  }
  return resolveDeepagentsApiKey({
    mode: deepagentsAuthMode(doc),
    routingApiKey: deepagentsFireworksStoredAuthRef(doc),
  });
}

async function deepagentsApiKey(ctx) {
  return harnessFullKey(ctx, deepagentsResolveKey);
}

export default defineHarnessProfile({
  id: HARNESS.DEEPAGENTS,
  label: "Deep Agents",
  resolveKey: deepagentsResolveKey,
  paths: (ctx) => deepagentsPathsFor(ctx),
  keyEnvRef: DEEPAGENTS_API_KEY_ENV,
  // Deep Agents supports the gateway model but cannot forward local BYOK
  // headers. Workspace BYOK can therefore expose it automatically.
  firerouter: {
    byok: "none",
    autoCatalog: true,
  },
  azure: {
    read: async (_ctx, { configPath }) => {
      const { doc } = await readDeepagentsTomlIfExists(configPath);
      return {
        active: deepagentsProviderStatus(doc) === "azure",
        storedKey: deepagentsAzureStoredAuthRef(doc),
        storedBaseUrl: deepagentsAzureBaseUrl(doc) ?? "",
      };
    },
    enable: ({ ctx, paths, apiKey, apiKeyFromFlag, baseUrl }) => enableDeepagentsAzure({
      configPath: paths.configPath,
      dataDir: paths.dataDir,
      apiKey,
      apiKeyFromFlag,
      baseUrl,
      modelId: ctx.main,
    }),
    restart: () => printDeepagentsRestartHint(),
  },
  enable: ({ paths, effectiveKey, keyType, modelId }) => enableDeepagentsFireworks({
    configPath: paths.configPath,
    dataDir: paths.dataDir,
    effectiveApiKey: effectiveKey,
    modelId,
    keyType,
  }),
  envHookOn: (ctx, effectiveKey) => finishEnvHarnessOn(ctx.home, {
    harnessId: "deepagents",
    expectedKey: effectiveKey,
  }),
  restartHint: () => printDeepagentsRestartHint(),
  disable: ({ paths, wasEnabled }) => disableDeepagentsFireworks({
    configPath: paths.configPath,
    dataDir: paths.dataDir,
    wasEnabled,
  }),
  restartHintOff: () => printDeepagentsRestartHint(),
  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.DEEPAGENTS);
    const { configPath } = deepagentsPathsFor(ctx);
    const { doc } = await readDeepagentsTomlIfExists(configPath);

    if (deepagentsProviderStatus(doc) === "azure") {
      const storedAuth = deepagentsAzureStoredAuthRef(doc);
      const payload = {
        harness: HARNESS.DEEPAGENTS,
        provider: "azure",
        baseUrl: deepagentsAzureBaseUrl(doc),
        modelProvider: DEEPAGENTS_AZURE_PROVIDER_ID,
        hasAuthToken: Boolean(effectiveAzureApiKey(storedAuth)),
        defaults: { main: DEFAULT_AZURE_MODEL },
        current: { main: deepagentsCurrentModelId(doc) },
      };
      if (ctx.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printStructuredHarnessStatus(HARNESS.DEEPAGENTS, {
        provider: payload.provider,
        keyConfigured: payload.hasAuthToken,
        authMode: deepagentsAzureAuthKeyMode(storedAuth),
        model: payload.current.main,
        endpoint: payload.baseUrl,
      });
      return;
    }

    const model = deepagentsCurrentModelId(doc);
    const apiKeyMode = deepagentsAuthMode(doc);
    const resolvedKey = await deepagentsApiKey(ctx);
    const payload = {
      harness: HARNESS.DEEPAGENTS,
      provider: deepagentsProviderStatus(doc),
      baseUrl: DEEPAGENTS_FIREWORKS_BASE_URL,
      modelProvider: DEEPAGENTS_FIREWORKS_PROVIDER_ID,
      hasAuthToken: Boolean(resolvedKey),
      apiKeyMode,
      defaults: { main: defaultMainModel() },
      current: { main: model },
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.DEEPAGENTS, {
      provider: payload.provider,
      keyConfigured: payload.hasAuthToken,
      authMode: payload.apiKeyMode,
      model: payload.current.main,
      keySource: harnessStatusKeySource(HARNESS.DEEPAGENTS, payload.provider),
    });
  },
});
