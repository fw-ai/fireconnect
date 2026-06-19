import process from "node:process";
import {
  defaultModelIds,
  detectApiKeyType,
  readJsonIfExists,
} from "../fireconnect-core.mjs";
import {
  PI_API_KEY_ENV_REF,
  disablePiFireworks,
  enablePiFireworks,
  piAuthKeyMode,
  piProviderStatus,
  resolvePiApiKeyValue,
} from "../pi-core.mjs";
import {
  FIREWORKS_API_KEY_ENV_REF,
  readGlobalConfig,
  setHarnessEnabled,
} from "../global-config.mjs";
import { isFireworksKey, resolveFireworksApiKey } from "../fireworks-models.mjs";
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
    const paths = piPathsFor(ctx);

    let apiKey = ctx.apiKey;
    let apiKeyFromFlag = ctx.apiKeyFromFlag;
    let reusedExistingKey = false;
    if (!apiKey) {
      const auth = await readJsonIfExists(paths.authPath);
      const existingKey = piStoredApiKeyRef(auth);
      if (existingKey) {
        apiKey = existingKey;
        apiKeyFromFlag = true;
        reusedExistingKey = true;
      }
    }

    if (!apiKey && ctx.home) {
      const globalConfig = await readGlobalConfig(ctx.home);
      const storedKey = globalConfig.apiKey;
      if (storedKey && storedKey !== FIREWORKS_API_KEY_ENV_REF) {
        apiKey = storedKey;
        apiKeyFromFlag = true;
      }
    }

    if (!apiKey && process.env.FIREWORKS_API_KEY) {
      apiKey = PI_API_KEY_ENV_REF;
      apiKeyFromFlag = false;
    }

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
    const { settingsPath, authPath } = piPathsFor(ctx);
    const settings = await readJsonIfExists(settingsPath);
    const auth = await readJsonIfExists(authPath);
    const authKey = piStoredApiKeyRef(auth);
    const keyType = detectApiKeyType(resolvePiApiKeyValue(authKey));
    const model = typeof settings.defaultModel === "string" ? settings.defaultModel : null;
    const currentModel = model?.startsWith("accounts/fireworks/") ? model : null;
    const payload = {
      harness: HARNESS.PI,
      provider: piProviderStatus(settings),
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
