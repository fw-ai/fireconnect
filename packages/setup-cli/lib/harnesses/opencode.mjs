import process from "node:process";
import {
  defaultModelIds,
  detectApiKeyType,
  readJsonIfExists,
} from "../fireconnect-core.mjs";
import {
  OPENCODE_API_KEY_ENV_REF,
  OPENCODE_AZURE_PROVIDER_ID,
  OPENCODE_FIREWORKS_PROVIDER_ID,
  disableOpencodeFireworks,
  enableOpencodeAzure,
  enableOpencodeFireworks,
  opencodeCurrentModelId,
  opencodeProviderStatus,
} from "../opencode-core.mjs";
import {
  ANTHROPIC_API_KEY_ENV_REF,
  harnessModeFromConfig,
  isHarnessEnabled,
  readGlobalConfig,
  setHarnessEnabled,
} from "../global-config.mjs";
import {
  FIREROUTER_FIREWORKS_HEADER,
  resolveFirerouterBaseUrl,
  resolveHarnessOnAnthropicKey,
} from "../firerouter-core.mjs";
import {
  FIREWORKS_KEY_ENV_REF,
  FIREROUTER_ANTHROPIC_PROVIDER_NAME,
  OPENCODE_ANTHROPIC_PROVIDER_ID,
  disableFirerouterOpencode,
  enableFirerouterOpencode,
  firerouterCurrentModel,
  firerouterDataDir,
  firerouterProviderStatus,
  resolveFirerouterDefaultModel,
} from "../opencode-firerouter-core.mjs";
import { opencodeHarnessAnthropicKeyRef } from "../anthropic-enterprise.mjs";
import {
  AZURE_PROVIDER_LABEL,
  DEFAULT_AZURE_MODEL,
  effectiveAzureApiKey,
  resolveAzureOnApiKey,
} from "../azure-core.mjs";
import {
  effectiveOpencodeApiKey,
  isFireworksKey,
  resolveFireworksApiKey,
  resolveHarnessOnApiKey,
} from "../fireworks-models.mjs";
import { runModelListCommand } from "../model-list.mjs";
import { runOpencodeModelSelect } from "../model-select.mjs";
import { defineHarness } from "../harness-types.mjs";
import {
  ensureHomeForHarness,
  opencodePathsFor,
} from "../harness-context.mjs";
import { HARNESS } from "../harness.mjs";

function opencodeStoredApiKeyRef(config) {
  return config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]?.options?.apiKey
    ?? config.provider?.fireworks?.options?.apiKey
    ?? "";
}

function opencodeFirerouterStoredFireworksKeyRef(config) {
  return config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.options?.headers?.[FIREROUTER_FIREWORKS_HEADER]
    ?? "";
}

/**
 * Harness-local Fireworks key for OpenCode: the key stored in opencode.json
 * (resolving the {env:FIREWORKS_API_KEY} reference). Returns "" when none.
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
async function opencodeResolveKey(ctx) {
  const { configPath } = opencodePathsFor(ctx);
  const config = await readJsonIfExists(configPath);
  const key = effectiveOpencodeApiKey(opencodeStoredApiKeyRef(config));
  return isFireworksKey(key) ? key.trim() : "";
}

/**
 * Full resolution chain for OpenCode (flag > harness-local > global > env).
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
function opencodeApiKey(ctx) {
  return resolveFireworksApiKey({
    apiKey: ctx.apiKey,
    resolveKey: () => opencodeResolveKey(ctx),
    home: ctx.home,
  });
}

function opencodeAzureStoredApiKeyRef(config) {
  return config.provider?.[OPENCODE_AZURE_PROVIDER_ID]?.options?.apiKey ?? "";
}

function opencodeAzureStoredBaseUrl(config) {
  return config.provider?.[OPENCODE_AZURE_PROVIDER_ID]?.options?.baseURL ?? "";
}

/**
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 * @param {{ baseUrl: string, apiKey: string }} configured
 */
async function opencodeAzureOn(ctx, configured) {
  const { configPath, dataDir } = opencodePathsFor(ctx);
  const config = await readJsonIfExists(configPath);
  const azureActive = opencodeProviderStatus(config) === "azure";
  const { apiKey, apiKeyFromFlag, reusedExistingKey } = await resolveAzureOnApiKey({
    apiKey: ctx.apiKey,
    apiKeyFromFlag: ctx.apiKeyFromFlag,
    configuredApiKey: configured.apiKey,
    getExistingKey: async () => (azureActive ? opencodeAzureStoredApiKeyRef(config) : ""),
  });
  const storedBaseUrl = azureActive ? opencodeAzureStoredBaseUrl(config) : "";
  const baseUrl = ctx.baseUrlFromFlag ? ctx.baseUrl : (configured.baseUrl || storedBaseUrl);
  const result = await enableOpencodeAzure({
    configPath,
    dataDir,
    apiKey,
    apiKeyFromFlag,
    baseUrl,
    modelId: ctx.main,
  });
  await setHarnessEnabled(ctx.home, HARNESS.OPENCODE, true, { mode: "direct" });
  console.log(`${AZURE_PROVIDER_LABEL} enabled for OpenCode (model: ${result.model}).`);
  console.log(`Endpoint: ${result.baseUrl}`);
  if (reusedExistingKey) {
    console.log("Reused the Azure API key already configured in opencode.json.");
  } else if (result.apiKeyMode === "env-reference") {
    console.log("API key written as {env:AZURE_API_KEY} — keep AZURE_API_KEY set in your shell.");
  } else {
    console.log("API key written into opencode.json (passed via --api-key).");
  }
  console.log("Restart OpenCode for full effect.");
}

/**
 * Resolve the Fireworks and Anthropic keys for FireRouter mode, then retarget
 * OpenCode's Anthropic provider at FireRouter. Mirrors the resolution order
 * used by the direct path: flag > harness-local > global > env.
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
async function _firerouterOn(ctx) {
  const { configPath } = opencodePathsFor(ctx);
  const frDataDir = firerouterDataDir(ctx.home, ctx.dataDir);
  const globalConfig = ctx.home ? await readGlobalConfig(ctx.home) : null;
  const baseUrl = resolveFirerouterBaseUrl(ctx.baseUrl, globalConfig?.routerBaseUrl ?? "");

  const { apiKey: storedFireworksKey, apiKeyFromFlag: fireworksKeyFromFlag } = await resolveHarnessOnApiKey({
    apiKey: ctx.apiKey,
    home: ctx.home,
    harnessEnvRef: FIREWORKS_KEY_ENV_REF,
    getExistingHarnessKey: async () => {
      const config = await readJsonIfExists(configPath);
      return opencodeFirerouterStoredFireworksKeyRef(config) || opencodeStoredApiKeyRef(config);
    },
  });
  const fireworksKey = effectiveOpencodeApiKey(storedFireworksKey);

  const { anthropicKey, anthropicKeyFromFlag, enterpriseAuth, runtimeAuth, source } = await resolveHarnessOnAnthropicKey({
    anthropicKey: ctx.anthropicKey,
    anthropicKeyFromFlag: ctx.anthropicKeyFromFlag,
    home: ctx.home,
    harness: HARNESS.OPENCODE,
    harnessEnvRef: ANTHROPIC_API_KEY_ENV_REF,
    getExistingHarnessKey: async () => {
      const config = await readJsonIfExists(configPath);
      return opencodeHarnessAnthropicKeyRef(config);
    },
  });

  // Default model: explicit --main wins; otherwise, only when the active model
  // doesn't already target the Anthropic provider, derive it from FireRouter's
  // advertised config (env override > well-known fetch > bundled fallback) so the
  // retargeting takes effect without hardcoding a model id here.
  let mainModel = ctx.main;
  if (!mainModel) {
    const current = (await readJsonIfExists(configPath)).model;
    const isAnthropicModel = typeof current === "string"
      && current.startsWith(`${OPENCODE_ANTHROPIC_PROVIDER_ID}/`);
    if (!isAnthropicModel) {
      mainModel = await resolveFirerouterDefaultModel(baseUrl);
    }
  }

  const result = await enableFirerouterOpencode({
    configPath,
    dataDir: frDataDir,
    baseUrl,
    mainModel,
    fireworksKey,
    fireworksKeyFromFlag,
    anthropicKey,
    anthropicKeyFromFlag,
  });

  await setHarnessEnabled(ctx.home, HARNESS.OPENCODE, true, { mode: "router" });
  console.log("FireRouter enabled for OpenCode.");
  console.log(`  provider:      ${FIREROUTER_ANTHROPIC_PROVIDER_NAME}`);
  console.log(`  base URL:      ${result.baseUrl}`);
  console.log(`  active model:  ${result.model}`);
  console.log("Switch among anthropic/<model> in OpenCode without re-running fireconnect.");
  if (result.fireworksKeyMode === "env-reference") {
    console.log("Fireworks key written as {env:FIREWORKS_API_KEY} — keep FIREWORKS_API_KEY set in your shell.");
  } else if (result.fireworksKeyMode === "literal") {
    console.log("Fireworks key written into opencode.json (passed via --api-key).");
  }
  if (result.anthropicKeyMode === "env-reference") {
    console.log("Anthropic key written as {env:ANTHROPIC_API_KEY} — keep ANTHROPIC_API_KEY set in your shell.");
  } else if (result.anthropicKeyMode === "literal") {
    console.log("Anthropic key written into opencode.json.");
  }
  if (enterpriseAuth) {
    console.log("Using existing Anthropic enterprise credentials (no separate API key written).");
  } else if (runtimeAuth) {
    console.log("Using OpenCode Anthropic auth (auth.json); no API key written to opencode.json.");
  }
  if (source === "prompt") {
    console.log("Anthropic API key saved to ~/.fireconnect/config.json.");
  }
  console.log("Restart OpenCode for full effect.");
}

export default defineHarness({
  id: HARNESS.OPENCODE,
  label: "OpenCode",
  resolveKey: opencodeResolveKey,

  async on(ctx) {
    ensureHomeForHarness(ctx, HARNESS.OPENCODE);
    const globalConfig = await readGlobalConfig(ctx.home);
    const provider = ctx.provider || globalConfig.provider;

    if (ctx.router) {
      await _firerouterOn(ctx);
      return;
    }

    if (ctx.azure || provider === "azure") {
      await opencodeAzureOn(ctx, globalConfig.azure);
      return;
    }

    const { configPath, dataDir } = opencodePathsFor(ctx);

    const { apiKey, apiKeyFromFlag, reusedExistingKey } = await resolveHarnessOnApiKey({
      apiKey: ctx.apiKey,
      home: ctx.home,
      harnessEnvRef: OPENCODE_API_KEY_ENV_REF,
      getExistingHarnessKey: async () => {
        const config = await readJsonIfExists(configPath);
        return opencodeStoredApiKeyRef(config);
      },
    });

    const effectiveApiKey = apiKey === OPENCODE_API_KEY_ENV_REF
      ? (process.env.FIREWORKS_API_KEY ?? "")
      : apiKey;
    const keyType = detectApiKeyType(effectiveApiKey);
    const result = await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey,
      apiKeyFromFlag,
      modelId: ctx.main,
      keyType,
    });
    await setHarnessEnabled(ctx.home, HARNESS.OPENCODE, true, { mode: "direct" });
    console.log(`Fireworks provider enabled for OpenCode (model: ${result.model}).`);
    if (reusedExistingKey) {
      console.log("Reused the API key already configured in opencode.json.");
    } else if (result.apiKeyMode === "env-reference") {
      console.log("API key written as {env:FIREWORKS_API_KEY} — keep FIREWORKS_API_KEY set in your shell.");
    } else {
      console.log("API key written into opencode.json (passed via --api-key).");
    }
    if (result.keyType === "firepass") {
      console.log("Fire Pass key detected: using glm-latest for all aliases.");
    } else {
      console.log("Browse models: fireconnect opencode model list");
      console.log("Pick a model:  fireconnect opencode model select");
    }
    console.log("Restart OpenCode for full effect.");
  },

  async off(ctx) {
    ensureHomeForHarness(ctx, HARNESS.OPENCODE);
    const { configPath, dataDir } = opencodePathsFor(ctx);
    const wasEnabled = await isHarnessEnabled(ctx.home, HARNESS.OPENCODE);
    const config = await readJsonIfExists(configPath);
    const globalConfig = await readGlobalConfig(ctx.home);
    const routerMode = harnessModeFromConfig(globalConfig, HARNESS.OPENCODE) === "router"
      || firerouterProviderStatus(config) === "firerouter";

    if (routerMode) {
      const frDataDir = firerouterDataDir(ctx.home, ctx.dataDir);
      await disableFirerouterOpencode({ configPath, dataDir: frDataDir, wasEnabled });
      await setHarnessEnabled(ctx.home, HARNESS.OPENCODE, false);
      console.log("FireRouter disabled for OpenCode; original config restored.");
      return;
    }

    await disableOpencodeFireworks({ configPath, dataDir, wasEnabled });
    await setHarnessEnabled(ctx.home, HARNESS.OPENCODE, false);
    console.log("Fireworks provider disabled for OpenCode; original config restored.");
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.OPENCODE);
    const { configPath } = opencodePathsFor(ctx);
    const config = await readJsonIfExists(configPath);
    const globalConfig = await readGlobalConfig(ctx.home);

    // Trust the recorded mode, not config sniffing — a config can briefly carry
    // both modes' wiring while switching, and the last `on` is the truth.
    if (harnessModeFromConfig(globalConfig, HARNESS.OPENCODE) === "router") {
      const options = config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.options ?? {};
      const headers = options.headers ?? {};
      const payload = {
        harness: HARNESS.OPENCODE,
        provider: "firerouter",
        mode: "router",
        baseUrl: options.baseURL ?? null,
        hasFireworksKey: Boolean(headers[FIREROUTER_FIREWORKS_HEADER] || process.env.FIREWORKS_API_KEY),
        hasAnthropicKey: Boolean(headers["x-api-key"] || process.env.ANTHROPIC_API_KEY),
        current: { main: firerouterCurrentModel(config) },
      };

      if (ctx.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(`Harness: ${HARNESS.OPENCODE}`);
      console.log(`Provider: firerouter`);
      console.log("Mode: FireRouter (server-side routing)");
      console.log(`Base URL: ${payload.baseUrl ?? "(unset)"}`);
      console.log(`Fireworks API key configured:  ${payload.hasFireworksKey ? "yes" : "no"}`);
      console.log(`Anthropic API key configured:  ${payload.hasAnthropicKey ? "yes" : "no"}`);
      console.log("");
      console.log("Current model: (pick any anthropic/<model> in OpenCode)");
      console.log(`  ${payload.current.main ?? "(unset)"}`);
      return;
    }

    const fireworksAi = config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID] ?? null;
    const azure = config.provider?.[OPENCODE_AZURE_PROVIDER_ID] ?? null;
    const model = opencodeCurrentModelId(config);
    const provider = opencodeProviderStatus(config);
    const storedRef = provider === "azure" ? opencodeAzureStoredApiKeyRef(config) : opencodeStoredApiKeyRef(config);
    const effectiveKey = provider === "azure"
      ? effectiveAzureApiKey(storedRef)
      : (effectiveOpencodeApiKey(storedRef) || process.env.FIREWORKS_API_KEY || "");
    const keyType = detectApiKeyType(effectiveKey);
    const payload = {
      harness: HARNESS.OPENCODE,
      provider,
      baseUrl: provider === "azure" ? (azure?.options?.baseURL ?? null) : (fireworksAi?.options?.baseURL ?? null),
      hasAuthToken: provider === "azure"
        ? Boolean(effectiveAzureApiKey(storedRef))
        : Boolean(storedRef || process.env.FIREWORKS_API_KEY),
      defaults: provider === "azure" ? { main: DEFAULT_AZURE_MODEL } : defaultModelIds(keyType),
      current: { main: model },
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Harness: ${HARNESS.OPENCODE}`);
    console.log(`Provider: ${payload.provider}`);
    console.log(`Base URL: ${payload.baseUrl ?? "(unset)"}`);
    console.log(`API key configured: ${payload.hasAuthToken ? "yes" : "no"}`);
    console.log("");
    console.log("Default mapping:");
    console.log(`  main -> ${payload.defaults.main}`);
    console.log("");
    console.log("Current mapping:");
    console.log(`  main -> ${payload.current.main ?? "(unset)"}`);
  },

  async modelList(ctx) {
    ensureHomeForHarness(ctx, HARNESS.OPENCODE);
    const apiKey = await opencodeApiKey(ctx);
    await runModelListCommand({
      options: ctx,
      harness: HARNESS.OPENCODE,
      apiKey,
    });
  },

  async modelReset(ctx) {
    ensureHomeForHarness(ctx, HARNESS.OPENCODE);
    const { configPath, dataDir } = opencodePathsFor(ctx);
    const config = await readJsonIfExists(configPath);
    if (firerouterProviderStatus(config) === "firerouter") {
      throw new Error("model reset does not apply in --router mode; pick models in OpenCode.");
    }
    if (opencodeProviderStatus(config) !== "fireworks") {
      throw new Error(
        "model reset for opencode requires Fireworks to be enabled; run: fireconnect opencode on",
      );
    }

    const existingKey = opencodeStoredApiKeyRef(config);
    const effectiveKey = existingKey === OPENCODE_API_KEY_ENV_REF
      ? (process.env.FIREWORKS_API_KEY ?? "")
      : existingKey;
    const keyType = detectApiKeyType(effectiveKey);

    const result = await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: existingKey,
      apiKeyFromFlag: Boolean(existingKey),
      modelId: defaultModelIds(keyType).main,
      keyType,
    });
    console.log(`Reset OpenCode model to default: ${result.model}`);
    console.log("Restart OpenCode for full effect.");
  },

  async modelSelect(ctx) {
    ensureHomeForHarness(ctx, HARNESS.OPENCODE);
    const { configPath, dataDir } = opencodePathsFor(ctx);
    if (firerouterProviderStatus(await readJsonIfExists(configPath)) === "firerouter") {
      throw new Error("model select does not apply in --router mode; pick models in OpenCode.");
    }
    const apiKey = await opencodeApiKey(ctx);
    await runOpencodeModelSelect({
      options: ctx,
      configPath,
      dataDir,
      apiKey,
    });
  },
});
