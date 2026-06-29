import {
  detectApiKeyType,
} from "../fireconnect-core.mjs";
import {
  isFireworksKey,
  resolveFireworksApiKey,
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
  prettyModelName,
  readChatLanguageModels,
  readVscodeStoredKey,
  resetVscodeModels,
  warnIfVscodeRunning,
} from "../vscode-core.mjs";
import { runModelListCommand } from "../model-list.mjs";
import { runVscodeModelSelect } from "../model-select.mjs";
import { defineHarness } from "../harness-types.mjs";
import {
  vscodePathsFor,
  ensureHomeForHarness,
} from "../harness-context.mjs";
import { HARNESS } from "../harness.mjs";
import { isHarnessEnabled, setHarnessEnabled } from "../global-config.mjs";

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

export default defineHarness({
  id: HARNESS.VSCODE,
  label: "VS Code",
  resolveKey: vscodeResolveKey,

  async on(ctx) {
    ensureHomeForHarness(ctx, HARNESS.VSCODE);
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
    await setHarnessEnabled(ctx.home, HARNESS.VSCODE, true);

    console.log("Fireworks provider enabled for VS Code Chat.");
    console.log(`Model URL: ${VSCODE_FIREWORKS_MODEL_URL} (VS Code appends /v1/chat/completions)`);
    console.log(`Default model: ${result.model} (${prettyModelName(result.model)})`);
    console.log("API key stored (encrypted) in VS Code's secret storage (state.vscdb).");
    if (result.keyType === "firepass") {
      console.log("Fire Pass key detected: using glm-latest (Fire Pass router).");
    }
    console.log("Start (or restart) VS Code, then pick the Fireworks model in the Chat model picker.");
    console.log("Browse models: fireconnect vscode model list");
    console.log("Add a model:  fireconnect vscode model add <id>");
  },

  async off(ctx) {
    ensureHomeForHarness(ctx, HARNESS.VSCODE);
    const { vscodePath, stateDbPath, dataDir } = vscodePathsFor(ctx);
    const wasEnabled = await isHarnessEnabled(ctx.home, HARNESS.VSCODE);

    assertVscodeStopped({ force: ctx.force });

    const outcome = await disableVscodeFireworks({
      vscodePath,
      dataDir,
      wasEnabled,
      stateDbPath,
    });
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
    if (keyType === "firepass") {
      console.log("Key type: Fire Pass");
    }
    console.log("");
    console.log(`Registered (fireconnect) models: ${registered.length ? registered.map((m) => `${m} (${prettyModelName(m)})`).join(", ") : "(none)"}`);
  },

  async modelList(ctx) {
    ensureHomeForHarness(ctx, HARNESS.VSCODE);
    const apiKey = await vscodeApiKey(ctx);
    await runModelListCommand({ options: ctx, harness: HARNESS.VSCODE, apiKey });
  },

  async modelSelect(ctx) {
    ensureHomeForHarness(ctx, HARNESS.VSCODE);
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
