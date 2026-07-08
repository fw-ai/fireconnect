import {
  defaultModelIds,
  detectApiKeyType,
} from "../fireconnect-core.mjs";
import {
  DEEPAGENTS_API_KEY_ENV,
  DEEPAGENTS_FIREWORKS_BASE_URL,
  DEEPAGENTS_FIREWORKS_PROVIDER_ID,
  deepagentsAuthMode,
  deepagentsCurrentModelId,
  deepagentsProviderStatus,
  disableDeepagentsFireworks,
  enableDeepagentsFireworks,
  printDeepagentsRestartHint,
  readDeepagentsTomlIfExists,
  resolveDeepagentsApiKey,
  updateDeepagentsModel,
} from "../deepagents-core.mjs";
import {
  isHarnessEnabled,
  setHarnessEnabled,
} from "../global-config.mjs";
import { resolveFireworksApiKey, resolveHarnessOnApiKey } from "../fireworks-models.mjs";
import { finishEnvHarnessOff, finishEnvHarnessOn } from "../harness-env-hook.mjs";
import { runModelListCommand } from "../model-list.mjs";
import { runDeepagentsModelSelect } from "../model-select.mjs";
import { defineHarness } from "../harness-types.mjs";
import {
  deepagentsPathsFor,
  ensureHomeForHarness,
} from "../harness-context.mjs";
import { HARNESS } from "../harness.mjs";

/**
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
async function deepagentsResolveKey(ctx) {
  const { configPath } = deepagentsPathsFor(ctx);
  const { doc } = await readDeepagentsTomlIfExists(configPath);
  if (deepagentsProviderStatus(doc) !== "fireworks") {
    return "";
  }
  return resolveDeepagentsApiKey({
    mode: deepagentsAuthMode(doc),
  });
}

/**
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
async function deepagentsApiKey(ctx) {
  return resolveFireworksApiKey({
    apiKey: ctx.apiKey,
    resolveKey: () => deepagentsResolveKey(ctx),
    home: ctx.home,
  });
}

export default defineHarness({
  id: HARNESS.DEEPAGENTS,
  label: "Deep Agents",
  resolveKey: deepagentsResolveKey,

  async on(ctx) {
    ensureHomeForHarness(ctx, HARNESS.DEEPAGENTS);
    const paths = deepagentsPathsFor(ctx);

    const { effectiveKey, reusedExistingKey } = await resolveHarnessOnApiKey({
      apiKey: ctx.apiKey,
      home: ctx.home,
      harnessEnvRef: DEEPAGENTS_API_KEY_ENV,
    });

    const keyType = detectApiKeyType(effectiveKey);
    const result = await enableDeepagentsFireworks({
      configPath: paths.configPath,
      dataDir: paths.dataDir,
      effectiveApiKey: effectiveKey,
      modelId: ctx.main,
      keyType,
    });
    await setHarnessEnabled(ctx.home, HARNESS.DEEPAGENTS, true);
    await finishEnvHarnessOn(ctx.home, { harnessId: "deepagents", expectedKey: effectiveKey });
    console.log(`Fireworks provider enabled for Deep Agents (model: ${result.model}).`);
    if (reusedExistingKey) {
      console.log("Reused api_key_env FIREWORKS_API_KEY in ~/.deepagents/config.toml.");
    } else {
      console.log("API key configured as api_key_env FIREWORKS_API_KEY.");
    }
    if (result.keyType === "firepass") {
      console.log("Fire Pass key detected: using glm-fast-latest for the default model.");
    } else {
      console.log("Browse models: fireconnect deepagents model list");
      console.log("Pick a model:  fireconnect deepagents model select");
    }
    printDeepagentsRestartHint();
  },

  async off(ctx) {
    ensureHomeForHarness(ctx, HARNESS.DEEPAGENTS);
    const paths = deepagentsPathsFor(ctx);
    const wasEnabled = await isHarnessEnabled(ctx.home, HARNESS.DEEPAGENTS);
    const outcome = await disableDeepagentsFireworks({
      configPath: paths.configPath,
      dataDir: paths.dataDir,
      wasEnabled,
    });
    await setHarnessEnabled(ctx.home, HARNESS.DEEPAGENTS, false);
    await finishEnvHarnessOff(ctx.home);
    if (outcome === "restored") {
      console.log("Fireworks provider disabled for Deep Agents; original config restored.");
    } else if (outcome === "stripped") {
      console.log("Fireworks provider disabled for Deep Agents; FireConnect routing removed from config.toml.");
    } else {
      console.log("Fireworks provider is not active for Deep Agents.");
    }
    printDeepagentsRestartHint();
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.DEEPAGENTS);
    const { configPath } = deepagentsPathsFor(ctx);
    const { doc } = await readDeepagentsTomlIfExists(configPath);
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
      defaults: { main: defaultModelIds().main },
      current: { main: model },
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Harness: ${HARNESS.DEEPAGENTS}`);
    console.log(`Provider: ${payload.provider}`);
    console.log(`Base URL: ${payload.baseUrl}`);
    console.log(`Model provider id: ${payload.modelProvider}`);
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
    ensureHomeForHarness(ctx, HARNESS.DEEPAGENTS);
    const apiKey = await deepagentsApiKey(ctx);
    await runModelListCommand({
      options: ctx,
      harness: HARNESS.DEEPAGENTS,
      apiKey,
    });
  },

  async modelReset(ctx) {
    ensureHomeForHarness(ctx, HARNESS.DEEPAGENTS);
    const { configPath } = deepagentsPathsFor(ctx);
    const { doc } = await readDeepagentsTomlIfExists(configPath);
    if (deepagentsProviderStatus(doc) !== "fireworks") {
      throw new Error(
        "model reset for deepagents requires Fireworks to be enabled; run: fireconnect deepagents on",
      );
    }

    const apiKey = await deepagentsApiKey(ctx);
    const keyType = detectApiKeyType(apiKey);
    const result = await updateDeepagentsModel({
      configPath,
      modelId: defaultModelIds(keyType).main,
    });
    console.log(`Reset Deep Agents model to default: ${result.model}`);
    printDeepagentsRestartHint();
  },

  async modelSelect(ctx) {
    ensureHomeForHarness(ctx, HARNESS.DEEPAGENTS);
    const { configPath } = deepagentsPathsFor(ctx);
    const apiKey = await deepagentsApiKey(ctx);
    await runDeepagentsModelSelect({
      options: ctx,
      configPath,
      apiKey,
    });
  },
});
