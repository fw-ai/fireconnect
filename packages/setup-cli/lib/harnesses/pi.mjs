import process from "node:process";
import {
  defaultModelIds,
  detectApiKeyType,
  readJsonIfExists,
} from "../fireconnect-core.mjs";
import {
  PI_API_KEY_ENV_REF,
  PI_AZURE_PROVIDER,
  disablePiFireworks,
  enablePiAzure,
  enablePiFireworks,
  piAuthKeyMode,
  piAzureCurrentModelId,
  piProviderStatus,
  resolvePiApiKeyValue,
  resolvePiAzureApiKeyValue,
} from "../pi-core.mjs";
import {
  readProviderSettings,
  setHarnessEnabled,
} from "../global-config.mjs";
import {
  isFireworksKey,
  resolveFireworksApiKey,
  resolveHarnessOnApiKey,
} from "../fireworks-models.mjs";
import {
  AZURE_PROVIDER_LABEL,
  DEFAULT_AZURE_MODEL,
  resolveAzureOnApiKey,
} from "../azure-core.mjs";
import { runModelListCommand } from "../model-list.mjs";
import { runPiModelSelect } from "../model-select.mjs";
import { printPiRestartHint } from "../pi-hints.mjs";
import { defineHarness } from "../harness-types.mjs";
import {
  ensureHomeForHarness,
  piPathsFor,
} from "../harness-context.mjs";
import { HARNESS } from "../harness.mjs";

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
 * Route Pi through Fireworks on Microsoft Foundry. The endpoint and key come
 * from `fireconnect configure` (global config) unless overridden by
 * `--base-url` / `--api-key`.
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 * @param {{ baseUrl: string, apiKey: string }} configured
 */
async function piAzureOn(ctx, configured) {
  const paths = piPathsFor(ctx);
  const modelsConfig = await readJsonIfExists(paths.modelsPath);

  const { apiKey, apiKeyFromFlag, reusedExistingKey } = await resolveAzureOnApiKey({
    apiKey: ctx.apiKey,
    apiKeyFromFlag: ctx.apiKeyFromFlag,
    configuredApiKey: configured.apiKey,
    getExistingKey: async () => piStoredAzureApiKeyRef(modelsConfig),
  });

  // Endpoint precedence: explicit --base-url > configured global endpoint > the
  // endpoint already stored from a previous `on --azure`.
  const storedBaseUrl = piAzureBaseUrl(modelsConfig) ?? "";
  const baseUrl = ctx.baseUrlFromFlag ? ctx.baseUrl : (configured.baseUrl || storedBaseUrl);
  const result = await enablePiAzure({
    settingsPath: paths.settingsPath,
    modelsPath: paths.modelsPath,
    dataDir: paths.dataDir,
    apiKey,
    apiKeyFromFlag,
    baseUrl,
    modelId: ctx.main,
  });
  await setHarnessEnabled(ctx.home, HARNESS.PI, true);
  console.log(`${AZURE_PROVIDER_LABEL} enabled for Pi (model: ${result.model}).`);
  console.log(`Endpoint: ${result.baseUrl}`);
  if (reusedExistingKey) {
    console.log("Reused the Azure API key already configured in models.json.");
  } else if (result.apiKeyMode === "env-reference") {
    console.log("API key written as $AZURE_API_KEY — keep AZURE_API_KEY set in your shell.");
  } else {
    console.log("API key written into models.json (passed via --api-key).");
  }
  printPiRestartHint();
}

/**
 * Harness-local Fireworks key for Pi: the key stored in auth.json
 * (resolving the $FIREWORKS_API_KEY reference). Returns "" when none.
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
async function piResolveKey(ctx) {
  const { authPath } = piPathsFor(ctx);
  const auth = await readJsonIfExists(authPath);
  const key = resolvePiApiKeyValue(piStoredApiKeyRef(auth));
  return isFireworksKey(key) ? key.trim() : "";
}

/**
 * Full resolution chain for Pi (flag > harness-local > global > env).
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
function piApiKey(ctx) {
  return resolveFireworksApiKey({
    apiKey: ctx.apiKey,
    resolveKey: () => piResolveKey(ctx),
    home: ctx.home,
  });
}

export default defineHarness({
  id: HARNESS.PI,
  label: "Pi",
  resolveKey: piResolveKey,

  async on(ctx) {
    ensureHomeForHarness(ctx, HARNESS.PI);
    const { provider, azure } = await readProviderSettings(ctx.home);
    if (ctx.azure || provider === "azure") {
      await piAzureOn(ctx, azure);
      return;
    }
    const paths = piPathsFor(ctx);

    const { apiKey, apiKeyFromFlag, reusedExistingKey } = await resolveHarnessOnApiKey({
      apiKey: ctx.apiKey,
      home: ctx.home,
      harnessEnvRef: PI_API_KEY_ENV_REF,
      getExistingHarnessKey: async () => {
        const auth = await readJsonIfExists(paths.authPath);
        return piStoredApiKeyRef(auth);
      },
    });

    const effectiveApiKey = apiKey === PI_API_KEY_ENV_REF
      ? (process.env.FIREWORKS_API_KEY ?? "")
      : apiKey;
    const keyType = detectApiKeyType(effectiveApiKey);
    const result = await enablePiFireworks({
      ...paths,
      apiKey,
      apiKeyFromFlag,
      modelId: ctx.main,
      keyType,
    });
    await setHarnessEnabled(ctx.home, HARNESS.PI, true);
    console.log(`Fireworks provider enabled for Pi (model: ${result.model}).`);
    if (reusedExistingKey) {
      console.log("Reused the API key already configured in auth.json.");
    } else if (result.apiKeyMode === "env-reference") {
      console.log("API key written as $FIREWORKS_API_KEY — keep FIREWORKS_API_KEY set in your shell.");
    } else {
      console.log("API key written into auth.json (passed via --api-key).");
    }
    if (result.keyType === "firepass") {
      console.log("Fire Pass key detected: using glm-latest for all aliases.");
    } else {
      console.log("Browse models: fireconnect pi model list");
      console.log("Pick a model:  fireconnect pi model select");
    }
    printPiRestartHint();
  },

  async off(ctx) {
    ensureHomeForHarness(ctx, HARNESS.PI);
    const paths = piPathsFor(ctx);
    const { changed } = await disablePiFireworks(paths);
    await setHarnessEnabled(ctx.home, HARNESS.PI, false);
    if (changed) {
      console.log("Fireworks provider disabled for Pi; original settings and auth restored.");
      printPiRestartHint();
    } else {
      console.log("FireConnect is not enabled for Pi; no changes made.");
    }
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.PI);
    const { settingsPath, authPath, modelsPath } = piPathsFor(ctx);
    const settings = await readJsonIfExists(settingsPath);
    const provider = piProviderStatus(settings);

    if (provider === "azure") {
      const modelsConfig = await readJsonIfExists(modelsPath);
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
      console.log(`Harness: ${HARNESS.PI}`);
      console.log(`Provider: azure (${AZURE_PROVIDER_LABEL})`);
      console.log(`Default provider: ${payload.defaultProvider ?? "(unset)"}`);
      console.log(`Base URL: ${payload.baseUrl ?? "(unset)"}`);
      console.log(`API key configured: ${payload.hasAuthToken ? "yes" : "no"}`);
      console.log("");
      console.log("Default mapping:");
      console.log(`  main -> ${payload.defaults.main}`);
      console.log("");
      console.log("Current mapping:");
      console.log(`  main -> ${payload.current.main ?? "(unset)"}`);
      return;
    }

    const auth = await readJsonIfExists(authPath);
    const authKey = piStoredApiKeyRef(auth);
    const keyType = detectApiKeyType(resolvePiApiKeyValue(authKey));
    const model = typeof settings.defaultModel === "string" ? settings.defaultModel : null;
    const currentModel = model?.startsWith("accounts/fireworks/") ? model : null;
    const payload = {
      harness: HARNESS.PI,
      provider,
      hasAuthToken: Boolean(authKey || process.env.FIREWORKS_API_KEY),
      apiKeyMode: piAuthKeyMode(authKey),
      defaults: { main: defaultModelIds(keyType).main },
      current: { main: currentModel },
      defaultProvider: settings.defaultProvider ?? null,
      model,
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Harness: ${HARNESS.PI}`);
    console.log(`Provider: ${payload.provider}`);
    console.log(`Default provider: ${payload.defaultProvider ?? "(unset)"}`);
    console.log(`API key configured: ${payload.hasAuthToken ? "yes" : "no"}`);
    console.log(`API key mode: ${payload.apiKeyMode}`);
    console.log("");
    console.log("Default mapping:");
    console.log(`  main -> ${payload.defaults.main}`);
    console.log("");
    console.log("Current mapping:");
    console.log(`  main -> ${payload.current.main ?? "(unset)"}`);
  },

  async modelList(ctx) {
    ensureHomeForHarness(ctx, HARNESS.PI);
    const apiKey = await piApiKey(ctx);
    await runModelListCommand({
      options: ctx,
      harness: HARNESS.PI,
      apiKey,
    });
  },

  async modelReset(ctx) {
    ensureHomeForHarness(ctx, HARNESS.PI);
    const paths = piPathsFor(ctx);
    const settings = await readJsonIfExists(paths.settingsPath);
    if (piProviderStatus(settings) !== "fireworks") {
      throw new Error(
        "model reset for pi requires Fireworks to be enabled; run: fireconnect pi on",
      );
    }

    const auth = await readJsonIfExists(paths.authPath);
    const existingKey = piStoredApiKeyRef(auth);
    const effectiveKey = resolvePiApiKeyValue(existingKey);
    const keyType = detectApiKeyType(effectiveKey);

    const result = await enablePiFireworks({
      ...paths,
      apiKey: existingKey,
      apiKeyFromFlag: Boolean(existingKey),
      modelId: defaultModelIds(keyType).main,
      keyType,
    });
    console.log(`Reset Pi model to default: ${result.model}`);
    printPiRestartHint();
  },

  async modelSelect(ctx) {
    ensureHomeForHarness(ctx, HARNESS.PI);
    const paths = piPathsFor(ctx);
    const apiKey = await piApiKey(ctx);
    await runPiModelSelect({
      options: ctx,
      ...paths,
      apiKey,
    });
  },
});
