import process from "node:process";
import {
  defaultModelIds,
  detectApiKeyType,
  readJsonIfExists,
} from "../fireconnect-core.mjs";
import {
  PI_API_KEY_ENV_REF,
  PI_ANTHROPIC_API_KEY_ENV_REF,
  PI_AZURE_PROVIDER,
  enablePiFirerouter,
  disablePiFireworks,
  enablePiAzure,
  enablePiFireworks,
  piAuthKeyMode,
  piAzureCurrentModelId,
  piFirerouterAnthropicKeyRef,
  piFirerouterConfigured,
  piFirerouterCurrentModel,
  piProviderStatus,
  resolvePiApiKeyValue,
  resolvePiAzureApiKeyValue,
} from "../pi-core.mjs";
import {
  harnessModeFromConfig,
  readGlobalConfig,
  readProviderSettings,
  setHarnessEnabled,
} from "../global-config.mjs";
import {
  FIREROUTER_FIREWORKS_HEADER,
  resolveFirerouterBaseUrl,
  resolveHarnessOnAnthropicKey,
} from "../firerouter-core.mjs";
import { resolveFirerouterDefaultModel } from "../firerouter-catalog.mjs";
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
import { finishEnvHarnessOff, finishEnvHarnessOn } from "../harness-env-hook.mjs";
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

async function piRouterModeConfigured(ctx, modelsConfig) {
  const globalConfig = await readGlobalConfig(ctx.home);
  return harnessModeFromConfig(globalConfig, HARNESS.PI) === "router"
    || piFirerouterConfigured(modelsConfig);
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
    authPath: paths.authPath,
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
async function piApiKey(ctx) {
  return resolveFireworksApiKey({
    apiKey: ctx.apiKey,
    resolveKey: () => piResolveKey(ctx),
    home: ctx.home,
  });
}

async function piFirerouterOn(ctx) {
  if (ctx.main) {
    throw new Error(
      "--main/--model is not supported with Pi router mode. Choose Anthropic models inside Pi with /model. "
      + "To select a non-Anthropic model, turn off router mode first by running `fireconnect pi on`.",
    );
  }
  const paths = piPathsFor(ctx);
  const globalConfig = await readGlobalConfig(ctx.home);
  const baseUrl = resolveFirerouterBaseUrl(ctx.baseUrl, globalConfig.routerBaseUrl ?? "");
  const { apiKey, effectiveKey } = await resolveHarnessOnApiKey({
    apiKey: ctx.apiKey,
    home: ctx.home,
    harnessEnvRef: PI_API_KEY_ENV_REF,
    getExistingHarnessKey: async () => {
      const auth = await readJsonIfExists(paths.authPath);
      return piStoredApiKeyRef(auth);
    },
  });
  const {
    anthropicKey,
    anthropicKeyFromFlag,
    reusedExistingKey,
    source,
  } = await resolveHarnessOnAnthropicKey({
    anthropicKey: ctx.anthropicKey,
    anthropicKeyFromFlag: ctx.anthropicKeyFromFlag,
    home: ctx.home,
    harness: HARNESS.PI,
    harnessEnvRef: PI_ANTHROPIC_API_KEY_ENV_REF,
    getExistingHarnessKey: async () => {
      const auth = await readJsonIfExists(paths.authPath);
      return piFirerouterAnthropicKeyRef(auth);
    },
  });
  const settings = await readJsonIfExists(paths.settingsPath);
  const mainModel = piFirerouterCurrentModel(settings)
    || await resolveFirerouterDefaultModel(baseUrl);
  const result = await enablePiFirerouter({
    ...paths,
    baseUrl,
    modelId: mainModel,
    fireworksKey: effectiveKey || apiKey,
    anthropicKey,
    anthropicKeyFromFlag,
  });
  await setHarnessEnabled(ctx.home, HARNESS.PI, true, { mode: "router" });
  await finishEnvHarnessOn(ctx.home, { harnessId: "pi" });
  console.log("FireRouter enabled for Pi.");
  console.log(`  provider:      anthropic`);
  console.log(`  base URL:      ${result.baseUrl}`);
  console.log(`  active model:  ${result.model}`);
  console.log("Switch among Anthropic models in Pi without re-running fireconnect.");
  console.log("Fireworks key written into models.json (0600) — no new shell needed.");
  console.log(reusedExistingKey
    ? "Reused the Anthropic API key already configured in auth.json."
    : "Anthropic API key written into auth.json (0600).");
  if (source === "prompt") {
    console.log("Anthropic API key saved to ~/.fireconnect/config.json.");
  }
  printPiRestartHint();
}

export default defineHarness({
  id: HARNESS.PI,
  label: "Pi",
  resolveKey: piResolveKey,

  async on(ctx) {
    ensureHomeForHarness(ctx, HARNESS.PI);
    if (ctx.router) {
      await piFirerouterOn(ctx);
      return;
    }
    const { provider, azure } = await readProviderSettings(ctx.home);
    if (ctx.azure || provider === "azure") {
      await piAzureOn(ctx, azure);
      return;
    }
    const paths = piPathsFor(ctx);

    const { apiKey, reusedExistingKey, effectiveKey } = await resolveHarnessOnApiKey({
      apiKey: ctx.apiKey,
      home: ctx.home,
      harnessEnvRef: PI_API_KEY_ENV_REF,
      getExistingHarnessKey: async () => {
        const auth = await readJsonIfExists(paths.authPath);
        return piStoredApiKeyRef(auth);
      },
    });

    const keyType = detectApiKeyType(effectiveKey);
    const result = await enablePiFireworks({
      ...paths,
      apiKey,
      effectiveApiKey: effectiveKey,
      modelId: ctx.main,
      keyType,
    });
    await setHarnessEnabled(ctx.home, HARNESS.PI, true, { mode: "direct" });
    await finishEnvHarnessOn(ctx.home, { harnessId: "pi" });
    console.log(`Fireworks provider enabled for Pi (model: ${result.model}).`);
    console.log(reusedExistingKey
      ? "Reused the Fireworks key already in auth.json."
      : "API key written into auth.json (0600).");
    if (result.keyType === "firepass") {
      console.log("Fire Pass key detected: using glm-fast-latest for all aliases.");
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
    await finishEnvHarnessOff(ctx.home);
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
    const modelsConfig = await readJsonIfExists(modelsPath);
    const globalConfig = await readGlobalConfig(ctx.home);
    const routerConfigured = piFirerouterConfigured(modelsConfig);
    if (
      harnessModeFromConfig(globalConfig, HARNESS.PI) === "router"
      || routerConfigured
    ) {
      const auth = await readJsonIfExists(authPath);
      const anthropic = modelsConfig.providers?.anthropic ?? {};
      const activeProvider = settings.defaultProvider ?? null;
      const activeModel = typeof settings.defaultModel === "string"
        ? settings.defaultModel
        : null;
      const routingActive = activeProvider === "anthropic" && routerConfigured;
      const activeProviderConfig = activeProvider
        ? modelsConfig.providers?.[activeProvider]
        : undefined;
      const activeBaseUrl = typeof activeProviderConfig?.baseUrl === "string"
        ? activeProviderConfig.baseUrl
        : null;
      const payload = {
        harness: HARNESS.PI,
        provider: activeProvider,
        mode: "router",
        firerouterConfigured: routerConfigured,
        routingActive,
        baseUrl: activeBaseUrl,
        hasFireworksKey: Boolean(
          anthropic.headers?.[FIREROUTER_FIREWORKS_HEADER]
          || process.env.FIREWORKS_API_KEY,
        ),
        hasAnthropicKey: Boolean(
          piFirerouterAnthropicKeyRef(auth)
          || process.env.ANTHROPIC_API_KEY,
        ),
        current: { main: activeModel },
      };
      if (ctx.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(`Harness: ${HARNESS.PI}`);
      console.log(`FireRouter configured: ${payload.firerouterConfigured ? "yes" : "no"}`);
      console.log(`Routing active: ${payload.routingActive ? "yes" : "no"}`);
      console.log(`Active provider: ${payload.provider ?? "(unset)"}`);
      console.log(`Active model: ${payload.current.main ?? "(unset)"}`);
      console.log(`Base URL: ${payload.baseUrl ?? "(Pi provider default)"}`);
      console.log(`Fireworks API key configured: ${payload.hasFireworksKey ? "yes" : "no"}`);
      console.log(`Anthropic API key configured: ${payload.hasAnthropicKey ? "yes" : "no"}`);
      return;
    }
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
    const paths = piPathsFor(ctx);
    const modelsConfig = await readJsonIfExists(paths.modelsPath);
    if (await piRouterModeConfigured(ctx, modelsConfig)) {
      throw new Error(
        "model list does not apply in --router mode. Choose Anthropic models inside Pi with /model. "
        + "To select a non-Anthropic model, turn off router mode first by running `fireconnect pi on`.",
      );
    }
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
    const modelsConfig = await readJsonIfExists(paths.modelsPath);
    if (await piRouterModeConfigured(ctx, modelsConfig)) {
      throw new Error(
        "model reset does not apply in --router mode. Choose Anthropic models inside Pi with /model. "
        + "To select a non-Anthropic model, turn off router mode first by running `fireconnect pi on`.",
      );
    }
    if (piProviderStatus(settings) !== "fireworks") {
      throw new Error(
        "model reset for pi requires Fireworks to be enabled; run: fireconnect pi on",
      );
    }

    const auth = await readJsonIfExists(paths.authPath);
    const existingKey = piStoredApiKeyRef(auth);
    const effectiveKey = resolvePiApiKeyValue(existingKey) || (await piApiKey(ctx));
    const keyType = detectApiKeyType(effectiveKey);

    const result = await enablePiFireworks({
      ...paths,
      apiKey: PI_API_KEY_ENV_REF,
      effectiveApiKey: effectiveKey,
      modelId: defaultModelIds(keyType).main,
      keyType,
    });
    console.log(`Reset Pi model to default: ${result.model}`);
    printPiRestartHint();
  },

  async modelSelect(ctx) {
    ensureHomeForHarness(ctx, HARNESS.PI);
    const paths = piPathsFor(ctx);
    const settings = await readJsonIfExists(paths.settingsPath);
    const modelsConfig = await readJsonIfExists(paths.modelsPath);
    if (await piRouterModeConfigured(ctx, modelsConfig)) {
      throw new Error(
        "model select does not apply in --router mode. Choose Anthropic models inside Pi with /model. "
        + "To select a non-Anthropic model, turn off router mode first by running `fireconnect pi on`.",
      );
    }
    const apiKey = await piApiKey(ctx);
    await runPiModelSelect({
      options: ctx,
      ...paths,
      apiKey,
    });
  },
});
