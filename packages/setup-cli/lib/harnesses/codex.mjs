import process from "node:process";
import {
  defaultModelIds,
  detectApiKeyType,
} from "../fireconnect-core.mjs";
import {
  CODEX_API_KEY_ENV_REF,
  CODEX_FIREWORKS_BASE_URL,
  CODEX_FIREWORKS_PROVIDER_ID,
  codexCurrentModelId,
  codexLiteralAuthFromDoc,
  codexProviderStatus,
  codexStoredAuthRef,
  disableCodexFireworks,
  effectiveCodexApiKey,
  enableCodexFireworks,
  printCodexRestartHint,
  readCodexTomlIfExists,
  updateCodexModel,
} from "../codex-core.mjs";
import {
  FIREWORKS_API_KEY_ENV_REF,
  isHarnessEnabled,
  readGlobalConfig,
  resolveStoredApiKey,
  setHarnessEnabled,
} from "../global-config.mjs";
import {
  isFireworksKey,
} from "../fireworks-models.mjs";
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
    const globalKey = resolveStoredApiKey((await readGlobalConfig(ctx.home)).apiKey);
    if (globalKey && isFireworksKey(globalKey)) {
      return globalKey;
    }
  }

  return process.env.FIREWORKS_API_KEY?.trim() ?? "";
}

export default defineHarness({
  id: HARNESS.CODEX,
  label: "Codex",
  resolveKey: codexResolveKey,

  async on(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CODEX);
    const { configPath, dataDir } = codexPathsFor(ctx);

    let apiKey = ctx.apiKey;
    let apiKeyFromFlag = ctx.apiKeyFromFlag;
    let reusedExistingKey = false;
    if (!apiKey) {
      const { doc } = await readCodexTomlIfExists(configPath);
      const existingAuth = codexStoredAuthRef(doc);
      if (existingAuth) {
        apiKey = existingAuth;
        apiKeyFromFlag = existingAuth !== CODEX_API_KEY_ENV_REF;
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
      apiKey = CODEX_API_KEY_ENV_REF;
      apiKeyFromFlag = false;
    }

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
    const result = await enableCodexFireworks({
      configPath,
      dataDir,
      apiKey,
      apiKeyFromFlag,
      modelId: ctx.main,
      keyType,
    });
    await setHarnessEnabled(ctx.home, HARNESS.CODEX, true);
    console.log(`Fireworks provider enabled for Codex (model: ${result.model}).`);
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
    const { configPath, dataDir } = codexPathsFor(ctx);
    const wasEnabled = await isHarnessEnabled(ctx.home, HARNESS.CODEX);
    const outcome = await disableCodexFireworks({ configPath, dataDir, wasEnabled });
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
    const { configPath } = codexPathsFor(ctx);
    const { doc } = await readCodexTomlIfExists(configPath);
    const model = codexCurrentModelId(doc);
    const storedAuth = codexStoredAuthRef(doc);
    const payload = {
      harness: HARNESS.CODEX,
      provider: codexProviderStatus(doc),
      baseUrl: CODEX_FIREWORKS_BASE_URL,
      modelProvider: CODEX_FIREWORKS_PROVIDER_ID,
      hasAuthToken: Boolean(storedAuth || process.env.FIREWORKS_API_KEY),
      defaults: { main: defaultModelIds().main },
      current: { main: model },
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
    const { configPath } = codexPathsFor(ctx);
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
    const result = await updateCodexModel({
      configPath,
      modelId: defaultModelIds(keyType).main,
      apiKey: writeAuth || catalogKey,
      literalAuth: ctx.apiKeyFromFlag || codexLiteralAuthFromDoc(doc),
    });
    console.log(`Reset Codex model to default: ${result.model}`);
    printCodexRestartHint();
  },

  async modelSelect(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CODEX);
    const { configPath } = codexPathsFor(ctx);
    const { doc } = await readCodexTomlIfExists(configPath);
    const apiKey = await codexApiKey(ctx);
    await runCodexModelSelect({
      options: ctx,
      configPath,
      apiKey,
      literalAuth: codexLiteralAuthFromDoc(doc),
    });
  },
});
