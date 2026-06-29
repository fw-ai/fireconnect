import {
  detectApiKeyType,
} from "../fireconnect-core.mjs";
import {
  isFireworksKey,
  resolveFireworksApiKey,
} from "../fireworks-models.mjs";
import {
  CURSOR_FIREWORKS_BASE_URL,
  CURSOR_MODES,
  CURSOR_DEFAULT_MODE,
  ensureCursorStopped,
  addCursorUserModel,
  cursorCurrentModelId,
  cursorProviderStatus,
  defaultModelIdFor,
  disableCursorFireworks,
  enableCursorFireworks,
  existingModes,
  fireconnectRegisteredModels,
  prettyModelName,
  readCursorState,
  resetCursorModelConfig,
} from "../cursor-core.mjs";
import { runModelListCommand } from "../model-list.mjs";
import { runCursorModelSelect } from "../model-select.mjs";
import { defineHarness } from "../harness-types.mjs";
import {
  cursorPathsFor,
  ensureHomeForHarness,
} from "../harness-context.mjs";
import { HARNESS } from "../harness.mjs";
import { isHarnessEnabled, setHarnessEnabled } from "../global-config.mjs";

/**
 * Harness-local Fireworks key for Cursor: the OpenAI key cell in state.vscdb.
 * Returns "" when none is present.
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
async function cursorResolveKey(ctx) {
  const { dbPath } = cursorPathsFor(ctx);
  const { openAIKey } = await readCursorState(dbPath);
  return isFireworksKey(openAIKey) ? openAIKey.trim() : "";
}

/**
 * Full resolution chain (flag > env > harness-local > global).
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
async function cursorApiKey(ctx) {
  return resolveFireworksApiKey({
    apiKey: ctx.apiKey,
    resolveKey: () => cursorResolveKey(ctx),
    home: ctx.home,
  });
}

export default defineHarness({
  id: HARNESS.CURSOR,
  label: "Cursor",
  resolveKey: cursorResolveKey,

  async on(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CURSOR);
    const { dbPath, dataDir } = cursorPathsFor(ctx);

    const token = await cursorApiKey(ctx);
    if (!token) {
      throw new Error(
        "No Fireworks API key found. Pass --api-key, set FIREWORKS_API_KEY, or run: fireconnect configure",
      );
    }
    const keyType = detectApiKeyType(token);

    await ensureCursorStopped({ force: ctx.force });

    const result = await enableCursorFireworks({
      dbPath,
      dataDir,
      apiKey: token,
      modelId: ctx.main,
      keyType,
    });
    await setHarnessEnabled(ctx.home, HARNESS.CURSOR, true);

    const { blob } = await readCursorState(dbPath);
    const modesSet = existingModes(blob);
    console.log("Fireworks provider enabled for Cursor.");
    console.log(`Base URL: ${CURSOR_FIREWORKS_BASE_URL}`);
    console.log(`Default model: ${result.model} (${prettyModelName(result.model)})`);
    console.log(`Applied to ${modesSet.length} mode${modesSet.length === 1 ? "" : "s"}: ${modesSet.join(", ")}`);
    if (result.keyType === "firepass") {
      console.log("Fire Pass key detected: using glm-latest (Fire Pass router).");
    }
    console.log("Quit & reopen Cursor for the change to take effect.");
    console.log("Browse models: fireconnect cursor model list");
    console.log("Pick a model:  fireconnect cursor model select");
  },

  async off(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CURSOR);
    const { dbPath, dataDir } = cursorPathsFor(ctx);
    const wasEnabled = await isHarnessEnabled(ctx.home, HARNESS.CURSOR);

    await ensureCursorStopped({ force: ctx.force });

    const outcome = await disableCursorFireworks({ dbPath, dataDir, wasEnabled });
    await setHarnessEnabled(ctx.home, HARNESS.CURSOR, false);

    if (outcome === "restored") {
      console.log("Fireworks provider disabled for Cursor; original settings restored.");
    } else if (outcome === "stripped") {
      console.log("Fireworks provider disabled for Cursor; fireconnect-managed settings removed.");
    } else {
      console.log("Fireworks provider is not active for Cursor.");
    }
    console.log("Quit & reopen Cursor for full effect.");
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CURSOR);
    const { dbPath } = cursorPathsFor(ctx);
    const enabled = await isHarnessEnabled(ctx.home, HARNESS.CURSOR);
    const { blob, openAIKey } = await readCursorState(dbPath);
    const provider = cursorProviderStatus(blob, openAIKey);
    const keyType = provider === "none" ? "none" : detectApiKeyType(openAIKey);
    const baseUrl = blob.openAIBaseUrl ?? null;
    const registered = fireconnectRegisteredModels(blob);

    const payload = {
      harness: HARNESS.CURSOR,
      enabled,
      provider,
      baseUrl,
      useOpenAIKey: Boolean(blob.useOpenAIKey),
      hasKey: Boolean(openAIKey),
      keyType,
      registeredModels: registered,
      defaultMode: CURSOR_DEFAULT_MODE,
      modes: CURSOR_MODES.reduce((acc, mode) => {
        acc[mode] = cursorCurrentModelId(blob, mode) || null;
        return acc;
      }, {}),
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Harness: ${HARNESS.CURSOR}`);
    console.log(`Enabled: ${enabled ? "yes" : "no"}`);
    console.log(`Provider: ${provider}`);
    console.log(`Base URL: ${baseUrl ?? "(unset)"}`);
    console.log(`Use OpenAI key: ${payload.useOpenAIKey ? "yes" : "no"}`);
    console.log(`Key present: ${payload.hasKey ? "yes" : "no"}`);
    if (keyType === "firepass") {
      console.log("Key type: Fire Pass");
    }
    console.log("");
    console.log(`Registered (fireconnect) models: ${registered.length ? registered.map((m) => `${m} (${prettyModelName(m)})`).join(", ") : "(none)"}`);
    console.log("");
    console.log("Cursor modes (pass one to --mode):");
    for (const mode of CURSOR_MODES) {
      const id = payload.modes[mode] ?? "";
      const tag = mode === CURSOR_DEFAULT_MODE ? " (default)" : "";
      console.log(`  ${mode.padEnd(20)}${tag} -> ${id || "(unset)"}${id && id !== "default" ? `  (${prettyModelName(id)})` : ""}`);
    }
  },

  async modelList(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CURSOR);
    const apiKey = await cursorApiKey(ctx);
    await runModelListCommand({ options: ctx, harness: HARNESS.CURSOR, apiKey });
  },

  async modelSelect(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CURSOR);
    const { dbPath } = cursorPathsFor(ctx);
    const apiKey = await cursorApiKey(ctx);
    await runCursorModelSelect({ options: ctx, dbPath, apiKey });
  },

  async modelReset(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CURSOR);
    const { dbPath } = cursorPathsFor(ctx);
    const { blob, openAIKey } = await readCursorState(dbPath);
    if (cursorProviderStatus(blob, openAIKey) === "none") {
      throw new Error(
        "model reset for cursor requires Fireworks to be enabled; run: fireconnect cursor on",
      );
    }
    const keyType = detectApiKeyType(openAIKey);
    const model = defaultModelIdFor(keyType);
    await ensureCursorStopped({ force: ctx.force });
    await resetCursorModelConfig({ dbPath, modelId: model });
    console.log(`Reset fireconnect-managed Cursor model selections to ${model} (${prettyModelName(model)}).`);
    console.log("Quit & reopen Cursor for the change to take effect.");
  },

  async modelAdd(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CURSOR);
    if (!ctx.main) {
      throw new Error(
        "model add requires a model id. Usage: fireconnect cursor model add <id>  (e.g. deepseek-v4-flash)",
      );
    }
    const { dbPath } = cursorPathsFor(ctx);
    // Fail fast: if Fireworks isn't enabled, the command can't do anything —
    // don't make the user quit Cursor only to then hit this error (mirrors
    // modelReset). addCursorUserModel re-checks authoritatively before writing.
    const { blob, openAIKey } = await readCursorState(dbPath);
    if (cursorProviderStatus(blob, openAIKey) === "none") {
      throw new Error("model add for cursor requires Fireworks to be enabled; run: fireconnect cursor on");
    }
    await ensureCursorStopped({ force: ctx.force });
    const result = await addCursorUserModel({ dbPath, modelId: ctx.main });
    console.log(`Added ${result.model} (${prettyModelName(result.model)}) to Cursor's model list.`);
    console.log("Pick it in Cursor's model picker to use it for a mode.");
    console.log("Quit & reopen Cursor for the change to take effect.");
  },
});
