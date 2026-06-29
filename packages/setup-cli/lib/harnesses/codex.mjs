import process from "node:process";
import { existsSync } from "node:fs";
import {
  defaultModelIds,
  detectApiKeyType,
} from "../fireconnect-core.mjs";
import {
  CODEX_API_KEY_ENV_REF,
  CODEX_AZURE_API_KEY_ENV_REF,
  CODEX_AZURE_PROVIDER_ID,
  CODEX_AZURE_PROVIDER_TABLE,
  CODEX_FIREWORKS_BASE_URL,
  CODEX_FIREWORKS_PROVIDER_ID,
  codexCurrentModelId,
  codexLiteralAuthFromDoc,
  codexProviderStatus,
  codexStoredAuthRef,
  disableCodexFireworks,
  effectiveCodexApiKey,
  enableCodexAzure,
  enableCodexFireworks,
  loadCodexCatalogBundle,
  printCodexRestartHint,
  readCodexTomlIfExists,
  updateCodexModel,
} from "../codex-core.mjs";
import {
  AZURE_PROVIDER_LABEL,
  DEFAULT_AZURE_MODEL,
  resolveAzureOnApiKey,
} from "../azure-core.mjs";
import {
  isHarnessEnabled,
  readProviderSettings,
  setHarnessEnabled,
} from "../global-config.mjs";
import { isFireworksKey, resolveHarnessOnApiKey } from "../fireworks-models.mjs";
import { runModelListCommand } from "../model-list.mjs";
import { runCodexModelSelect } from "../model-select.mjs";
import { defineHarness } from "../harness-types.mjs";
import {
  codexPathsFor,
  ensureHomeForHarness,
} from "../harness-context.mjs";
import { HARNESS } from "../harness.mjs";

/**
 * Harness-local Fireworks key for Codex: bearer token or env_key reference in
 * ~/.codex/config.toml. Returns "" when none.
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
async function codexResolveKey(ctx) {
  const { configPath } = codexPathsFor(ctx);
  const { doc } = await readCodexTomlIfExists(configPath);
  if (codexProviderStatus(doc) !== "fireworks") {
    return "";
  }
  const key = effectiveCodexApiKey(codexStoredAuthRef(doc));
  return isFireworksKey(key) ? key.trim() : "";
}

/**
 * Full resolution chain for Codex model commands (flag > harness-local > global > env).
 * Unlike `resolveFireworksApiKey`, harness-local auth in config.toml wins over env so
 * `codex on --api-key` keeps working after FIREWORKS_API_KEY is set elsewhere.
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
async function codexApiKey(ctx) {
  if (ctx.apiKey?.trim()) {
    return ctx.apiKey.trim();
  }

  const harnessKey = await codexResolveKey(ctx);
  if (harnessKey) {
    return harnessKey;
  }

  if (ctx.home) {
    const { readGlobalConfig, resolveStoredApiKey } = await import("../global-config.mjs");
    const globalKey = resolveStoredApiKey((await readGlobalConfig(ctx.home)).apiKey);
    if (globalKey && isFireworksKey(globalKey)) {
      return globalKey;
    }
  }

  return process.env.FIREWORKS_API_KEY?.trim() ?? "";
}

/**
 * Route Codex through Fireworks on Microsoft Foundry. The endpoint and key come
 * from `fireconnect configure` (global config) unless overridden by
 * `--base-url` / `--api-key`.
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 * @param {{ baseUrl: string, apiKey: string }} configured
 */
async function codexAzureOn(ctx, configured) {
  const { configPath, dataDir } = codexPathsFor(ctx);
  const { doc } = await readCodexTomlIfExists(configPath);
  const azureActive = codexProviderStatus(doc) === "azure";

  const { apiKey, apiKeyFromFlag, reusedExistingKey } = await resolveAzureOnApiKey({
    apiKey: ctx.apiKey,
    apiKeyFromFlag: ctx.apiKeyFromFlag,
    configuredApiKey: configured.apiKey,
    getExistingKey: async () => (azureActive ? codexStoredAuthRef(doc) : ""),
  });

  // Endpoint precedence: explicit --base-url > configured global endpoint > the
  // endpoint already stored from a previous `on --azure`.
  const storedBaseUrl = azureActive && typeof doc.tables[CODEX_AZURE_PROVIDER_TABLE]?.base_url === "string"
    ? doc.tables[CODEX_AZURE_PROVIDER_TABLE].base_url
    : "";
  const baseUrl = ctx.baseUrlFromFlag ? ctx.baseUrl : (configured.baseUrl || storedBaseUrl);
  const result = await enableCodexAzure({
    configPath,
    dataDir,
    apiKey,
    apiKeyFromFlag,
    baseUrl,
    modelId: ctx.main,
  });
  await setHarnessEnabled(ctx.home, HARNESS.CODEX, true);
  console.log(`${AZURE_PROVIDER_LABEL} enabled for Codex (model: ${result.model}).`);
  console.log(`Endpoint: ${result.baseUrl}`);
  if (reusedExistingKey) {
    console.log("Reused the Azure API key already configured in ~/.codex/config.toml.");
  } else if (result.apiKeyMode === "env-reference") {
    console.log("API key written as env_key AZURE_API_KEY — keep AZURE_API_KEY set in your shell.");
  } else {
    console.log("API key written into ~/.codex/config.toml (passed via --api-key).");
  }
  printCodexRestartHint();
}

export default defineHarness({
  id: HARNESS.CODEX,
  label: "Codex",
  resolveKey: codexResolveKey,

  async on(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CODEX);
    const { provider, azure } = await readProviderSettings(ctx.home);
    if (ctx.azure || provider === "azure") {
      await codexAzureOn(ctx, azure);
      return;
    }
    const { configPath, dataDir, catalogPath } = codexPathsFor(ctx);

    const { apiKey, apiKeyFromFlag, reusedExistingKey } = await resolveHarnessOnApiKey({
      apiKey: ctx.apiKey,
      home: ctx.home,
      harnessEnvRef: CODEX_API_KEY_ENV_REF,
      getExistingHarnessKey: async () => {
        const { doc } = await readCodexTomlIfExists(configPath);
        // Only reuse a stored key when the gateway provider is active — an
        // Azure bearer / {env:AZURE_API_KEY} ref must never be read as the
        // Fireworks key when switching from Foundry back to the gateway.
        return codexProviderStatus(doc) === "fireworks" ? codexStoredAuthRef(doc) : "";
      },
    });

    const effectiveApiKey = apiKey === CODEX_API_KEY_ENV_REF
      ? (process.env.FIREWORKS_API_KEY ?? "")
      : apiKey;
    const keyType = detectApiKeyType(effectiveApiKey);
    if (keyType === "firepass") {
      throw new Error(
        "The /responses endpoint is not supported for Fire Pass keys yet. " +
        "Use a standard Fireworks API key (fw_...).",
      );
    }
    const { codexCatalog } = await loadCodexCatalogBundle(effectiveApiKey);
    const result = await enableCodexFireworks({
      configPath,
      dataDir,
      apiKey,
      apiKeyFromFlag,
      modelId: ctx.main,
      keyType,
      catalogPath,
      catalog: codexCatalog,
    });
    await setHarnessEnabled(ctx.home, HARNESS.CODEX, true);
    console.log(`Fireworks provider enabled for Codex (model: ${result.model}).`);
    if (result.catalogWritten) {
      console.log("Model catalog written to ~/.codex/fireworks-model-catalog.json.");
    }
    if (reusedExistingKey) {
      console.log("Reused the API key already configured in ~/.codex/config.toml.");
    } else if (result.apiKeyMode === "env-reference") {
      console.log("API key written as env_key FIREWORKS_API_KEY — keep FIREWORKS_API_KEY set in your shell.");
    } else {
      console.log("API key written into ~/.codex/config.toml (passed via --api-key).");
    }
    if (result.keyType === "firepass") {
      console.log("Fire Pass key detected: using kimi-k2p7-code-fast for the default model.");
    } else {
      console.log("Browse models: fireconnect codex model list");
      console.log("Pick a model:  fireconnect codex model select");
    }
    printCodexRestartHint();
  },

  async off(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CODEX);
    const { configPath, dataDir, catalogPath } = codexPathsFor(ctx);
    const wasEnabled = await isHarnessEnabled(ctx.home, HARNESS.CODEX);
    const outcome = await disableCodexFireworks({ configPath, dataDir, catalogPath, wasEnabled });
    await setHarnessEnabled(ctx.home, HARNESS.CODEX, false);
    if (outcome === "restored") {
      console.log("Fireworks provider disabled for Codex; original config restored.");
    } else if (outcome === "stripped") {
      console.log("Fireworks provider disabled for Codex; FireConnect routing removed from config.toml.");
    } else {
      console.log("Fireworks provider is not active for Codex.");
    }
    printCodexRestartHint();
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
      console.log(`Harness: ${HARNESS.CODEX}`);
      console.log(`Provider: azure (${AZURE_PROVIDER_LABEL})`);
      console.log(`Base URL: ${payload.baseUrl ?? "(unset)"}`);
      console.log(`Model provider id: ${payload.modelProvider}`);
      console.log(`API key configured: ${payload.hasAuthToken ? "yes" : "no"}`);
      console.log("");
      console.log("Default mapping:");
      console.log(`  main -> ${payload.defaults.main}`);
      console.log("");
      console.log("Current mapping:");
      console.log(`  main -> ${payload.current.main ?? "(unset)"}`);
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
      defaults: { main: defaultModelIds().main },
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

    console.log(`Harness: ${HARNESS.CODEX}`);
    console.log(`Provider: ${payload.provider}`);
    console.log(`Base URL: ${payload.baseUrl}`);
    console.log(`Model provider id: ${payload.modelProvider}`);
    console.log(`API key configured: ${payload.hasAuthToken ? "yes" : "no"}`);
    console.log(`Model catalog: ${payload.modelCatalog.set ? "set" : "not set"} (${payload.modelCatalog.exists ? "file present" : "file missing"})`);
    console.log("");
    console.log("Default mapping:");
    console.log(`  main -> ${payload.defaults.main}`);
    console.log("");
    console.log("Current mapping:");
    console.log(`  main -> ${payload.current.main ?? "(unset)"}`);
  },

  async modelList(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CODEX);
    const apiKey = await codexApiKey(ctx);
    await runModelListCommand({
      options: ctx,
      harness: HARNESS.CODEX,
      apiKey,
    });
  },

  async modelReset(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CODEX);
    const { configPath, catalogPath } = codexPathsFor(ctx);
    const { doc } = await readCodexTomlIfExists(configPath);
    if (codexProviderStatus(doc) !== "fireworks") {
      throw new Error(
        "model reset for codex requires Fireworks to be enabled; run: fireconnect codex on",
      );
    }

    const storedAuth = codexStoredAuthRef(doc);
    const catalogKey = await codexApiKey(ctx);
    const keyType = detectApiKeyType(catalogKey || effectiveCodexApiKey(storedAuth));
    const writeAuth = ctx.apiKeyFromFlag ? ctx.apiKey : storedAuth;
    const { codexCatalog } = await loadCodexCatalogBundle(catalogKey || effectiveCodexApiKey(storedAuth));
    const result = await updateCodexModel({
      configPath,
      modelId: defaultModelIds(keyType).main,
      apiKey: writeAuth || catalogKey,
      literalAuth: ctx.apiKeyFromFlag || codexLiteralAuthFromDoc(doc),
      catalogPath,
      catalog: codexCatalog,
    });
    console.log(`Reset Codex model to default: ${result.model}`);
    printCodexRestartHint();
  },

  async modelSelect(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CODEX);
    const { configPath, catalogPath } = codexPathsFor(ctx);
    const { doc } = await readCodexTomlIfExists(configPath);
    const apiKey = await codexApiKey(ctx);
    const { pickerCatalog, codexCatalog } = await loadCodexCatalogBundle(apiKey);
    await runCodexModelSelect({
      options: { ...ctx, catalogPath, catalog: codexCatalog, pickerCatalog },
      configPath,
      apiKey,
      literalAuth: codexLiteralAuthFromDoc(doc),
    });
  },
});
