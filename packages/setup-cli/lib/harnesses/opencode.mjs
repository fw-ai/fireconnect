import process from "node:process";
import {
  defaultModelIds,
  detectApiKeyType,
  readJsonIfExists,
} from "../fireconnect-core.mjs";
import {
  OPENCODE_API_KEY_ENV_REF,
  OPENCODE_FIREWORKS_PROVIDER_ID,
  disableOpencodeFireworks,
  enableOpencodeFireworks,
  opencodeCurrentModelId,
  opencodeProviderStatus,
} from "../opencode-core.mjs";
import {
  FIREWORKS_API_KEY_ENV_REF,
  readGlobalConfig,
  isHarnessEnabled,
  setHarnessEnabled,
} from "../global-config.mjs";
import {
  effectiveOpencodeApiKey,
  isFireworksKey,
  resolveFireworksApiKey,
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

export default defineHarness({
  id: HARNESS.OPENCODE,
  label: "OpenCode",
  resolveKey: opencodeResolveKey,

  async on(ctx) {
    ensureHomeForHarness(ctx, HARNESS.OPENCODE);
    const { configPath, dataDir } = opencodePathsFor(ctx);

    let apiKey = ctx.apiKey;
    let apiKeyFromFlag = ctx.apiKeyFromFlag;
    let reusedExistingKey = false;
    if (!apiKey) {
      const config = await readJsonIfExists(configPath);
      const existingKey = opencodeStoredApiKeyRef(config);
      if (existingKey) {
        apiKey = existingKey;
        apiKeyFromFlag = true;
        reusedExistingKey = true;
      }
    }

    if (!apiKey && ctx.home) {
      const globalConfig = await readGlobalConfig(ctx.home);
      const storedKey = globalConfig.apiKey;
      // A literal key in global config is written into opencode.json; an env
      // reference is left to the {env:FIREWORKS_API_KEY} default below.
      if (storedKey && storedKey !== FIREWORKS_API_KEY_ENV_REF) {
        apiKey = storedKey;
        apiKeyFromFlag = true;
      }
    }

    // Final fallback: FIREWORKS_API_KEY in the environment. Write it as an env
    // reference so the secret stays out of opencode.json.
    if (!apiKey && process.env.FIREWORKS_API_KEY) {
      apiKey = OPENCODE_API_KEY_ENV_REF;
      apiKeyFromFlag = false;
    }

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
    await setHarnessEnabled(ctx.home, HARNESS.OPENCODE, true);
    console.log(`Fireworks provider enabled for OpenCode (model: ${result.model}).`);
    if (reusedExistingKey) {
      console.log("Reused the API key already configured in opencode.json.");
    } else if (result.apiKeyMode === "env-reference") {
      console.log("API key written as {env:FIREWORKS_API_KEY} — keep FIREWORKS_API_KEY set in your shell.");
    } else {
      console.log("API key written into opencode.json (passed via --api-key).");
    }
    if (result.keyType === "firepass") {
      console.log("Fire Pass key detected: using kimi-k2p7-code-fast for all aliases.");
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
    await disableOpencodeFireworks({ configPath, dataDir, wasEnabled });
    await setHarnessEnabled(ctx.home, HARNESS.OPENCODE, false);
    console.log("Fireworks provider disabled for OpenCode; original config restored.");
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.OPENCODE);
    const { configPath } = opencodePathsFor(ctx);
    const config = await readJsonIfExists(configPath);
    const fireworksAi = config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID] ?? null;
    const model = opencodeCurrentModelId(config);
    const payload = {
      harness: HARNESS.OPENCODE,
      provider: opencodeProviderStatus(config),
      baseUrl: fireworksAi?.options?.baseURL ?? null,
      hasAuthToken: Boolean(opencodeStoredApiKeyRef(config) || process.env.FIREWORKS_API_KEY),
      defaults: { main: defaultModelIds().main },
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
    const apiKey = await opencodeApiKey(ctx);
    await runOpencodeModelSelect({
      options: ctx,
      configPath,
      dataDir,
      apiKey,
    });
  },
});
