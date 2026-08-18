import {
  printStructuredHarnessStatus,
} from "../../harness/status-display.mjs";
import {
  printHarnessConnected,
} from "../../cli/messages.mjs";
import process from "node:process";
import { defaultMainModel } from "../../fireworks/model-id.mjs";
import {
  CODEX_API_KEY_ENV_REF,
  CODEX_AZURE_PROVIDER_ID,
  CODEX_AZURE_PROVIDER_TABLE,
  CODEX_FIREWORKS_BASE_URL,
  CODEX_FIREWORKS_PROVIDER_ID,
  codexAuthKeyMode,
  codexCurrentModelId,
  codexProviderStatus,
  codexStoredAuthRef,
  disableCodexFireworks,
  effectiveCodexApiKey,
  enableCodexAzure,
  enableCodexFireworks,
  loadCodexCatalogBundle,
  printCodexRestartHint,
  readCodexTomlIfExists,
} from "./core.mjs";
import { DEFAULT_AZURE_MODEL } from "../../fireworks/azure-core.mjs";
import { isFireworksKey } from "../../keys/key-type.mjs";
import { finishEnvHarnessOn } from "../../harness/env-hook.mjs";
import { defineHarnessProfile } from "../../harness/engine.mjs";
import {
  codexPathsFor,
  ensureHomeForHarness,
} from "../../harness/context.mjs";
import { codexModelExclusionReason } from "./catalog.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { harnessStatusKeySource } from "../../keys/api-key.mjs";
import { existsSync } from "node:fs";

const CODEX_FIREROUTER = Object.freeze({
  byok: "envref",
  autoCatalog: true,
});

async function codexResolveKey(ctx) {
  const { configPath } = codexPathsFor(ctx);
  const { doc } = await readCodexTomlIfExists(configPath);
  if (codexProviderStatus(doc) !== "fireworks") {
    return "";
  }
  const key = effectiveCodexApiKey(codexStoredAuthRef(doc));
  return isFireworksKey(key) ? key.trim() : "";
}

export default defineHarnessProfile({
  id: HARNESS.CODEX,
  label: "Codex",
  resolveKey: codexResolveKey,
  paths: (ctx) => codexPathsFor(ctx),
  keyEnvRef: CODEX_API_KEY_ENV_REF,
  firerouter: CODEX_FIREROUTER,
  telemetryHeaders: true,
  azure: {
    read: async (_ctx, { configPath }) => {
      const { doc } = await readCodexTomlIfExists(configPath);
      const table = doc.tables[CODEX_AZURE_PROVIDER_TABLE];
      return {
        active: codexProviderStatus(doc) === "azure",
        storedKey: codexStoredAuthRef(doc),
        storedBaseUrl: typeof table?.base_url === "string" ? table.base_url : "",
      };
    },
    enable: ({ ctx, paths, apiKey, apiKeyFromFlag, baseUrl }) => enableCodexAzure({
      configPath: paths.configPath,
      dataDir: paths.dataDir,
      apiKey,
      apiKeyFromFlag,
      baseUrl,
      modelId: ctx.main,
    }),
    restart: () => printCodexRestartHint(),
  },
  getExistingHarnessKey: async (_ctx, paths) => {
    const { doc } = await readCodexTomlIfExists(paths.configPath);
    // Only reuse a stored key when the gateway provider is active — an Azure
    // bearer / {env:AZURE_API_KEY} ref must never be read as the Fireworks key
    // when switching from Foundry back to the gateway.
    return codexProviderStatus(doc) === "fireworks" ? codexStoredAuthRef(doc) : "";
  },
  precheck: ({ keyType }) => {
    if (keyType === "firepass") {
      throw new Error(
        "The /responses endpoint is not supported for Fire Pass keys yet. " +
        "Use a standard Fireworks API key (fw_...).",
      );
    }
  },
  // Codex reads keys from the environment (env_key/env_http_headers).
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
    const exclusionReason = codexModelExclusionReason(modelId);
    if (exclusionReason) {
      throw new Error(exclusionReason);
    }
    const { codexCatalog } = await loadCodexCatalogBundle(effectiveKey, {
      includeFirerouter,
    });
    return enableCodexFireworks({
      configPath: paths.configPath,
      dataDir: paths.dataDir,
      apiKey: apiKeyRef,
      effectiveApiKey: effectiveKey,
      modelId,
      keyType,
      catalogPath: paths.catalogPath,
      catalog: codexCatalog,
      envHttpHeaders: byokHeaders,
      telemetryHeaders,
    });
  },
  envHookOn: (ctx) => finishEnvHarnessOn(ctx.home, { harnessId: "codex" }),
  printConnected: ({ result }) => {
    printHarnessConnected("Codex", { model: result.model });
  },
  restartHint: () => printCodexRestartHint(),

  disable: async ({ paths, wasEnabled }) => disableCodexFireworks({
    configPath: paths.configPath,
    dataDir: paths.dataDir,
    catalogPath: paths.catalogPath,
    wasEnabled,
  }),
  restartHintOff: () => printCodexRestartHint(),
  async providerStatus(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CODEX);
    const { configPath } = codexPathsFor(ctx);
    const { doc } = await readCodexTomlIfExists(configPath);
    return codexProviderStatus(doc);
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CODEX);
    const { configPath, catalogPath } = codexPathsFor(ctx);
    const { doc } = await readCodexTomlIfExists(configPath);
    const provider = codexProviderStatus(doc);

    if (provider === "azure") {
      const azureTable = doc.tables[CODEX_AZURE_PROVIDER_TABLE] ?? {};
      const storedAuth = codexStoredAuthRef(doc);
      const payload = {
        harness: HARNESS.CODEX,
        provider,
        baseUrl: typeof azureTable.base_url === "string" ? azureTable.base_url : null,
        modelProvider: CODEX_AZURE_PROVIDER_ID,
        hasAuthToken: Boolean(effectiveCodexApiKey(storedAuth)),
        defaults: { main: DEFAULT_AZURE_MODEL },
        current: { main: codexCurrentModelId(doc) },
      };
      if (ctx.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printStructuredHarnessStatus(HARNESS.CODEX, {
        provider: payload.provider,
        keyConfigured: payload.hasAuthToken,
        authMode: codexAuthKeyMode(storedAuth),
        model: payload.current.main,
        endpoint: payload.baseUrl,
      });
      return;
    }

    const model = codexCurrentModelId(doc);
    const storedAuth = codexStoredAuthRef(doc);
    const payload = {
      harness: HARNESS.CODEX,
      provider,
      baseUrl: CODEX_FIREWORKS_BASE_URL,
      modelProvider: CODEX_FIREWORKS_PROVIDER_ID,
      hasAuthToken: Boolean(storedAuth || process.env.FIREWORKS_API_KEY),
      defaults: { main: defaultMainModel() },
      current: { main: model },
      modelCatalog: {
        set: Boolean(doc.root.model_catalog_json),
        path: catalogPath,
        exists: existsSync(catalogPath),
      },
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.CODEX, {
      provider: payload.provider,
      keyConfigured: payload.hasAuthToken,
      authMode: codexAuthKeyMode(storedAuth),
      model: payload.current.main,
      keySource: harnessStatusKeySource(HARNESS.CODEX, provider),
    });
  },

});
