import {
  printStructuredHarnessStatus,
} from "../../harness/status-display.mjs";
import {
  printPiRestartHint,
} from "../../cli/messages.mjs";
import process from "node:process";
import { defaultMainModel } from "../../fireworks/model-id.mjs";
import { readJsonIfExists } from "../../io/json.mjs";
import {
  PI_API_KEY_ENV_REF,
  PI_AZURE_PROVIDER,
  disablePiFireworks,
  enablePiAzure,
  enablePiFireworks,
  piAuthKeyMode,
  piAzureAuthKeyMode,
  piAzureCurrentModelId,
  piProviderStatus,
  piStoredByokHeaders,
  resolvePiApiKeyValue,
  resolvePiAzureApiKeyValue,
} from "./core.mjs";
import {
  byokEnvFromHeaders,
} from "../../firerouter/core.mjs";
import {
  loadRegisterableModels,
} from "../../fireworks/models.mjs";
import { detectApiKeyType, isFireworksKey } from "../../keys/key-type.mjs";
import { DEFAULT_AZURE_MODEL } from "../../fireworks/azure-core.mjs";
import { defineHarnessProfile } from "../../harness/engine.mjs";
import {
  ensureHomeForHarness,
  piPathsFor,
} from "../../harness/context.mjs";
import { finishEnvHarnessOn } from "../../harness/env-hook.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { harnessStatusKeySource } from "../../keys/api-key.mjs";

function piStoredApiKeyRef(auth) {
  return auth.fireworks?.key ?? "";
}

function piStoredAzureApiKeyRef(modelsConfig) {
  return modelsConfig.providers?.[PI_AZURE_PROVIDER]?.apiKey ?? "";
}

function piAzureBaseUrl(modelsConfig) {
  return modelsConfig.providers?.[PI_AZURE_PROVIDER]?.baseUrl ?? null;
}

/**
 * Harness-local Fireworks key for Pi: the key stored in auth.json
 * (resolving the $FIREWORKS_API_KEY reference). Returns "" when none.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function piResolveKey(ctx) {
  const { authPath } = piPathsFor(ctx);
  const auth = await readJsonIfExists(authPath);
  const key = resolvePiApiKeyValue(piStoredApiKeyRef(auth));
  return isFireworksKey(key) ? key.trim() : "";
}

export default defineHarnessProfile({
  id: HARNESS.PI,
  label: "Pi",
  resolveKey: piResolveKey,
  paths: (ctx) => piPathsFor(ctx),
  keyEnvRef: PI_API_KEY_ENV_REF,
  firerouter: {
    byok: "value",
    autoCatalog: true,
  },
  telemetryHeaders: true,
  readByokEnv: async (_ctx, paths) => byokEnvFromHeaders(
    piStoredByokHeaders(await readJsonIfExists(paths.modelsPath)),
  ),
  azure: {
    read: async (_ctx, paths) => {
      const settings = await readJsonIfExists(paths.settingsPath);
      const modelsConfig = await readJsonIfExists(paths.modelsPath);
      return {
        active: piProviderStatus(settings) === "azure",
        storedKey: piStoredAzureApiKeyRef(modelsConfig),
        storedBaseUrl: piAzureBaseUrl(modelsConfig) ?? "",
      };
    },
    enable: ({ ctx, paths, apiKey, apiKeyFromFlag, baseUrl }) => enablePiAzure({
      settingsPath: paths.settingsPath,
      authPath: paths.authPath,
      modelsPath: paths.modelsPath,
      dataDir: paths.dataDir,
      apiKey,
      apiKeyFromFlag,
      baseUrl,
      modelId: ctx.main,
    }),
    restart: () => printPiRestartHint(),
  },
  getExistingHarnessKey: async (_ctx, paths) => {
    const auth = await readJsonIfExists(paths.authPath);
    return piStoredApiKeyRef(auth);
  },
  enable: async ({
    paths,
    apiKeyRef,
    effectiveKey,
    keyType,
    modelId,
    byokHeaders,
    telemetryHeaders,
    includeFirerouter,
  }) => {
    // Register the preferred catalog; firerouter is workspace-BYOK-gated.
    // Fail open offline — enablePiFireworks falls back to bundled routers.
    let catalogModelIds = [];
    try {
      ({ ids: catalogModelIds } = await loadRegisterableModels({
        apiKey: effectiveKey,
        includeFirerouter,
      }));
    } catch { /* offline / catalog unavailable */ }
    return enablePiFireworks({
      ...paths,
      apiKey: apiKeyRef,
      effectiveApiKey: effectiveKey,
      modelId,
      keyType,
      byokHeaders,
      telemetryHeaders,
      catalogModelIds,
    });
  },
  envHookOn: (ctx) => finishEnvHarnessOn(ctx.home, { harnessId: "pi" }),
  restartHint: () => printPiRestartHint(),

  disable: async ({ paths }) => {
    const { changed } = await disablePiFireworks(paths);
    return changed ? "restored" : "unchanged";
  },
  restartHintOff: (outcome) => {
    if (outcome !== "unchanged") {
      printPiRestartHint();
    }
  },
  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.PI);
    const { settingsPath, authPath, modelsPath } = piPathsFor(ctx);
    const settings = await readJsonIfExists(settingsPath);
    const modelsConfig = await readJsonIfExists(modelsPath);
    const provider = piProviderStatus(settings);

    if (provider === "azure") {
      const storedAzure = piStoredAzureApiKeyRef(modelsConfig);
      const payload = {
        harness: HARNESS.PI,
        provider,
        baseUrl: piAzureBaseUrl(modelsConfig),
        hasAuthToken: Boolean(resolvePiAzureApiKeyValue(storedAzure)),
        defaults: { main: DEFAULT_AZURE_MODEL },
        current: { main: piAzureCurrentModelId(settings) },
        defaultProvider: settings.defaultProvider ?? null,
      };
      if (ctx.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printStructuredHarnessStatus(HARNESS.PI, {
        provider: payload.provider,
        keyConfigured: payload.hasAuthToken,
        authMode: piAzureAuthKeyMode(storedAzure),
        model: payload.current.main,
        endpoint: payload.baseUrl,
      });
      return;
    }

    const auth = await readJsonIfExists(authPath);
    const authKey = piStoredApiKeyRef(auth);
    const keyType = detectApiKeyType(resolvePiApiKeyValue(authKey));
    const model = typeof settings.defaultModel === "string" ? settings.defaultModel : null;
    const currentModel = provider === "fireworks" ? model : null;
    const payload = {
      harness: HARNESS.PI,
      provider,
      hasAuthToken: Boolean(authKey || process.env.FIREWORKS_API_KEY),
      apiKeyMode: piAuthKeyMode(authKey),
      defaults: { main: defaultMainModel(keyType) },
      current: { main: currentModel },
      defaultProvider: settings.defaultProvider ?? null,
      model,
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.PI, {
      provider: payload.provider,
      keyConfigured: payload.hasAuthToken,
      authMode: payload.apiKeyMode,
      model: payload.current.main,
      keySource: harnessStatusKeySource(HARNESS.PI, provider),
    });
  },

});
