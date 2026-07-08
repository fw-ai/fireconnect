import process from "node:process";
import {
  detectApiKeyType,
} from "../fireconnect-core.mjs";
import {
  isFireworksKey,
  resolveFireworksApiKey,
  resolveHarnessOnApiKey,
} from "../fireworks-models.mjs";
import {
  VSCODE_FIREWORKS_MODEL_URL,
  addVscodeModel,
  assertVscodeStopped,
  defaultModelIdFor,
  disableVscodeFireworks,
  enableVscodeFireworks,
  fireconnectRegisteredModels,
  fireworksProviderStatus,
  isFireconnectProvider,
  prettyModelName,
  readChatLanguageModels,
  readVscodeStoredKey,
  resetVscodeModels,
  warnIfVscodeRunning,
} from "../vscode-core.mjs";
import {
  FIRECONNECT_FIREROUTER_PROVIDER_NAME,
  disableFirerouterVscode,
  enableFirerouterVscode,
  readVscodeRouterFireworksKey,
  readVscodeStoredAnthropicKey,
  vscodeFirerouterProviderStatus,
} from "../vscode-firerouter-core.mjs";
import {
  FIREROUTER_FIREWORKS_HEADER,
  resolveFirerouterBaseUrl,
  resolveHarnessOnAnthropicKey,
} from "../firerouter-core.mjs";
import { runModelListCommand } from "../model-list.mjs";
import { runVscodeModelSelect } from "../model-select.mjs";
import { defineHarness } from "../harness-types.mjs";
import {
  vscodePathsFor,
  ensureHomeForHarness,
} from "../harness-context.mjs";
import { HARNESS } from "../harness.mjs";
import {
  harnessModeFromConfig,
  isHarnessEnabled,
  readGlobalConfig,
  setHarnessEnabled,
} from "../global-config.mjs";
import { linuxSafeStorageIsObfuscatedFallback } from "../vscode-safestorage.mjs";

/**
 * Harness-local Fireworks key for VS Code: the key stored (encrypted) in VS
 * Code's secret storage (state.vscdb) under the `chat.lm.secret.fw-*` id
 * referenced by the fireconnect provider. Returns "" when none is present.
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
async function vscodeResolveKey(ctx) {
  const { vscodePath, stateDbPath } = vscodePathsFor(ctx);
  return readVscodeStoredKey(vscodePath, stateDbPath);
}

/**
 * Full resolution chain (flag > env > harness-local secret storage > global).
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
async function vscodeApiKey(ctx) {
  return resolveFireworksApiKey({
    apiKey: ctx.apiKey,
    resolveKey: () => vscodeResolveKey(ctx),
    home: ctx.home,
  });
}

/**
 * Whether VS Code is currently in router mode. On-disk chatLanguageModels.json
 * is authoritative when a fireconnect provider is present (the last `on` wins even
 * if `setHarnessEnabled` did not update config); config is used only when disk
 * is inconclusive.
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 * @returns {Promise<boolean>}
 */
async function vscodeRouterModeActive(ctx) {
  const { vscodePath } = vscodePathsFor(ctx);
  const arr = await readChatLanguageModels(vscodePath);
  if (vscodeFirerouterProviderStatus(arr) === "firerouter") {
    return true;
  }
  if (fireworksProviderStatus(arr) !== "none") {
    return false;
  }
  const globalConfig = await readGlobalConfig(ctx.home);
  return harnessModeFromConfig(globalConfig, HARNESS.VSCODE) === "router";
}

/**
 * Route VS Code Chat through FireRouter (Anthropic Messages format). Layout A:
 * the Anthropic key is stored encrypted in state.vscdb (VS Code auto-sends it as
 * x-api-key in messages mode); the Fireworks key is written as a plaintext
 * literal in each model's X-FireRouter-Fireworks-Key requestHeader.
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
async function vscodeFirerouterOn(ctx) {
  if (ctx.main) {
    throw new Error(
      "--main does not apply in --router mode. fireconnect registers the Claude models "
        + "FireRouter advertises; pick one in the VS Code Chat picker.",
    );
  }
  const { vscodePath, stateDbPath, dataDir } = vscodePathsFor(ctx);
  const globalConfig = await readGlobalConfig(ctx.home);
  const baseUrl = resolveFirerouterBaseUrl(ctx.baseUrl, globalConfig.routerBaseUrl ?? "");

  // Fireworks key: flag > env/global > harness-local > keychain fallback.
  const { effectiveKey: fireworksKey } = await resolveHarnessOnApiKey({
    apiKey: ctx.apiKey,
    home: ctx.home,
    harnessEnvRef: "${FIREWORKS_API_KEY}",
    getExistingHarnessKey: async () => {
      // Router Layout A: the fw- secret row holds the Anthropic key, and the
      // Fireworks key lives only as a plaintext literal in each model's
      // requestHeaders. Prefer a Fireworks-shaped fw- secret if present (e.g.
      // mid-switch from direct mode), else fall back to the header the prior
      // `on --router` wrote — so a re-run reuses it without re-supplying the key.
      const stored = await readVscodeStoredKey(vscodePath, stateDbPath);
      if (isFireworksKey(stored)) {
        return stored;
      }
      const headerKey = await readVscodeRouterFireworksKey(vscodePath);
      return isFireworksKey(headerKey) ? headerKey : "";
    },
  });

  // Anthropic key: flag > harness-local (router-mode fw- secret) > global > env.
  const { anthropicKey, source } = await resolveHarnessOnAnthropicKey({
    anthropicKey: ctx.anthropicKey,
    anthropicKeyFromFlag: ctx.anthropicKeyFromFlag,
    home: ctx.home,
    harness: HARNESS.VSCODE,
    getExistingHarnessKey: async () => readVscodeStoredAnthropicKey(vscodePath, stateDbPath),
  });

  assertVscodeStopped({ force: ctx.force });

  const result = await enableFirerouterVscode({
    vscodePath,
    dataDir,
    stateDbPath,
    baseUrl,
    fireworksKey,
    anthropicKey,
  });
  await setHarnessEnabled(ctx.home, HARNESS.VSCODE, true, { mode: "router" });

  console.log("FireRouter enabled for VS Code Chat.");
  console.log(`  provider:      ${FIRECONNECT_FIREROUTER_PROVIDER_NAME}`);
  console.log(`  base URL:      ${result.baseUrl}`);
  console.log(`  models:        ${result.models.join(", ")}`);
  console.log("Pick one of these Anthropic models in the VS Code Chat picker.");
  console.log("Anthropic API key stored (encrypted) in VS Code's secret storage (state.vscdb).");
  if (source === "prompt") {
    console.log("Anthropic API key saved to ~/.fireconnect/config.json.");
  }
  console.warn(
    "Note: FireRouter mode writes your Fireworks API key in plaintext to chatLanguageModels.json "
      + "(in each model's requestHeaders), because VS Code's custom endpoint can only pull one "
      + "credential from secret storage. The Anthropic key stays encrypted. "
      + "Prefer `fireconnect vscode on` (direct mode) when you don't need Anthropic-format routing.",
  );
  console.log("Quit and relaunch VS Code for the Claude models to work correctly.");
}

export default defineHarness({
  id: HARNESS.VSCODE,
  label: "VS Code",
  resolveKey: vscodeResolveKey,

  async on(ctx) {
    ensureHomeForHarness(ctx, HARNESS.VSCODE);
    if (ctx.router) {
      await vscodeFirerouterOn(ctx);
      return;
    }
    const { vscodePath, stateDbPath, dataDir } = vscodePathsFor(ctx);

    const token = await vscodeApiKey(ctx);
    if (!token) {
      throw new Error(
        "No Fireworks API key found. Pass --api-key, set FIREWORKS_API_KEY, or run: fireconnect configure",
      );
    }
    const keyType = detectApiKeyType(token);

    assertVscodeStopped({ force: ctx.force });

    const result = await enableVscodeFireworks({
      vscodePath,
      dataDir,
      apiKey: token,
      modelId: ctx.main,
      keyType,
      stateDbPath,
    });
    await setHarnessEnabled(ctx.home, HARNESS.VSCODE, true, { mode: "direct" });

    console.log("Fireworks provider enabled for VS Code Chat.");
    console.log(`Model URL: ${VSCODE_FIREWORKS_MODEL_URL} (VS Code appends /v1/chat/completions)`);
    console.log(`Default model: ${result.model} (${prettyModelName(result.model)})`);
    if (linuxSafeStorageIsObfuscatedFallback()) {
      console.log(
        "API key stored in VS Code's secret storage (state.vscdb), but no Secret Service / libsecret "
          + "was detected on this Linux host, so VS Code will obfuscate (not encrypt) it. "
          + "Install gnome-keyring + secret-service (and libsecret-tools) for real encryption.",
      );
    } else {
      console.log("API key stored (encrypted) in VS Code's secret storage (state.vscdb).");
    }
    if (result.keyType === "firepass") {
      console.log("Fire Pass key detected: using glm-fast-latest (Fire Pass router).");
    }
    console.log(`Quit and relaunch VS Code for ${result.model} to work correctly, then pick it in the Chat model picker.`);
    console.log("Browse models: fireconnect vscode model list");
    console.log("Add a model:  fireconnect vscode model add <id>");
  },

  async off(ctx) {
    ensureHomeForHarness(ctx, HARNESS.VSCODE);
    const { vscodePath, stateDbPath, dataDir } = vscodePathsFor(ctx);
    const wasEnabled = await isHarnessEnabled(ctx.home, HARNESS.VSCODE);
    const routerMode = await vscodeRouterModeActive(ctx);

    assertVscodeStopped({ force: ctx.force });

    const outcome = routerMode
      ? await disableFirerouterVscode({ vscodePath, dataDir, wasEnabled, stateDbPath })
      : await disableVscodeFireworks({ vscodePath, dataDir, wasEnabled, stateDbPath });
    await setHarnessEnabled(ctx.home, HARNESS.VSCODE, false);

    if (outcome === "restored") {
      console.log("Fireworks provider disabled for VS Code Chat; original chatLanguageModels.json restored and the secret removed from state.vscdb.");
    } else if (outcome === "stripped") {
      console.log("Fireworks provider disabled for VS Code Chat; fireconnect-managed provider + secret removed.");
    } else {
      console.log("Fireworks provider is not active for VS Code Chat.");
    }
    console.log("Restart VS Code for the change to take effect.");
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.VSCODE);
    const { vscodePath, stateDbPath } = vscodePathsFor(ctx);
    const enabled = await isHarnessEnabled(ctx.home, HARNESS.VSCODE);
    const arr = await readChatLanguageModels(vscodePath);

    if (vscodeFirerouterProviderStatus(arr) === "firerouter") {
      const anthropicKey = await readVscodeStoredAnthropicKey(vscodePath, stateDbPath, arr);
      const provider = arr.find(isFireconnectProvider);
      const models = (provider?.models ?? []).map((m) => m.id);
      const fireworksKeyPresent = (provider?.models ?? []).some(
        (m) => m?.requestHeaders?.[FIREROUTER_FIREWORKS_HEADER],
      );
      const payload = {
        harness: HARNESS.VSCODE,
        enabled,
        provider: "firerouter",
        mode: "router",
        baseUrl: provider?.models?.[0]?.url ?? null,
        hasFireworksKey: Boolean(fireworksKeyPresent || process.env.FIREWORKS_API_KEY),
        hasAnthropicKey: Boolean(anthropicKey || process.env.ANTHROPIC_API_KEY),
        registeredModels: models,
      };
      if (ctx.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(`Harness: ${HARNESS.VSCODE}`);
      console.log(`Enabled: ${enabled ? "yes" : "no"}`);
      console.log("Provider: firerouter");
      console.log("Mode: FireRouter (server-side Anthropic-format routing)");
      console.log(`Base URL: ${payload.baseUrl ?? "(unset)"}`);
      console.log(`Fireworks API key configured: ${payload.hasFireworksKey ? "yes" : "no"}`);
      console.log(`Anthropic API key configured: ${payload.hasAnthropicKey ? "yes" : "no"}`);
      console.log("");
      console.log(`Registered (fireconnect) models: ${models.length ? models.join(", ") : "(none)"}`);
      return;
    }

    const provider = fireworksProviderStatus(arr);
    const registered = fireconnectRegisteredModels(arr);
    const storedKey = await readVscodeStoredKey(vscodePath, stateDbPath, arr);
    const keyType = provider === "none" ? "none" : detectApiKeyType(storedKey);

    const payload = {
      harness: HARNESS.VSCODE,
      enabled,
      provider,
      modelUrl: registered.length ? VSCODE_FIREWORKS_MODEL_URL : null,
      hasKey: Boolean(storedKey),
      keyType,
      registeredModels: registered,
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Harness: ${HARNESS.VSCODE}`);
    console.log(`Enabled: ${enabled ? "yes" : "no"}`);
    console.log(`Provider: ${provider}`);
    console.log(`Model URL: ${payload.modelUrl ?? "(unset)"}`);
    console.log(`Key present: ${payload.hasKey ? "yes" : "no"}`);
    if (linuxSafeStorageIsObfuscatedFallback()) {
      console.log("Key storage: obfuscated (no Secret Service / libsecret on Linux — install gnome-keyring + secret-service for encryption)");
    }
    if (keyType === "firepass") {
      console.log("Key type: Fire Pass");
    }
    console.log("");
    console.log(`Registered (fireconnect) models: ${registered.length ? registered.map((m) => `${m} (${prettyModelName(m)})`).join(", ") : "(none)"}`);
  },

  async modelList(ctx) {
    ensureHomeForHarness(ctx, HARNESS.VSCODE);
    if (await vscodeRouterModeActive(ctx)) {
      throw new Error("model list does not apply in --router mode; pick models in the VS Code Chat picker.");
    }
    const apiKey = await vscodeApiKey(ctx);
    await runModelListCommand({ options: ctx, harness: HARNESS.VSCODE, apiKey });
  },

  async modelSelect(ctx) {
    ensureHomeForHarness(ctx, HARNESS.VSCODE);
    if (await vscodeRouterModeActive(ctx)) {
      throw new Error("model select does not apply in --router mode; pick models in the VS Code Chat picker.");
    }
    const { vscodePath, stateDbPath } = vscodePathsFor(ctx);
    const apiKey = await vscodeApiKey(ctx);
    await runVscodeModelSelect({
      options: ctx,
      vscodePath,
      stateDbPath,
      apiKey,
    });
  },

  async modelReset(ctx) {
    ensureHomeForHarness(ctx, HARNESS.VSCODE);
    if (await vscodeRouterModeActive(ctx)) {
      throw new Error("model reset does not apply in --router mode; pick models in the VS Code Chat picker.");
    }
    const { vscodePath, stateDbPath } = vscodePathsFor(ctx);
    warnIfVscodeRunning();
    const arr = await readChatLanguageModels(vscodePath);
    if (fireworksProviderStatus(arr) === "none") {
      throw new Error("model reset for vscode requires Fireworks to be enabled; run: fireconnect vscode on");
    }
    const storedKey = await readVscodeStoredKey(vscodePath, stateDbPath, arr);
    const keyType = detectApiKeyType(storedKey);
    const model = defaultModelIdFor(keyType);
    await resetVscodeModels({ vscodePath, modelId: model });
    console.log(`Reset fireconnect-managed VS Code models to ${model} (${prettyModelName(model)}).`);
    console.log("VS Code hot-reloads the file — the change applies immediately (no restart needed).")
  },

  async modelAdd(ctx) {
    ensureHomeForHarness(ctx, HARNESS.VSCODE);
    if (await vscodeRouterModeActive(ctx)) {
      throw new Error("model add does not apply in --router mode; pick models in the VS Code Chat picker.");
    }
    if (!ctx.main) {
      throw new Error(
        "model add requires a model id. Usage: fireconnect vscode model add <id>  (e.g. deepseek-v4-flash)",
      );
    }
    const { vscodePath } = vscodePathsFor(ctx);
    warnIfVscodeRunning();
    const result = await addVscodeModel({ vscodePath, modelId: ctx.main });
    console.log(`Added ${result.model} (${prettyModelName(result.model)}) to VS Code's Fireworks provider.`);
    console.log("VS Code hot-reloads the file — the change applies immediately (no restart needed).")
  },
});
