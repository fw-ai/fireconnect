import {
  printHarnessConnected,
  printNote,
  printRestartHint,
} from "../../cli/messages.mjs";
import { printStructuredHarnessStatus } from "../../harness/status-display.mjs";
import { detectApiKeyType, isFireworksKey } from "../../keys/key-type.mjs";
import { defineHarnessProfile } from "../../harness/engine.mjs";
import { ensureHomeForHarness, copilotCliPathsFor as copilotCliPathsForShared } from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { isHarnessEnabled } from "../../config/global-config.mjs";
import { harnessStatusKeySource } from "../../keys/api-key.mjs";
import { loadRegisterableModels } from "../../fireworks/models.mjs";
import {
  isAutoModelId,
  isFirerouterModelPattern,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import {
  COPILOT_FIREWORKS_BASE_URL,
  copilotModelIds,
  describeCopilotModels,
  resolveCopilotModelId,
} from "../copilot-shared.mjs";
import {
  copilotCliSelectionId,
  copilotProvidersPath,
  copilotSettingsPath,
  deselectCopilotCliModel,
  disableCopilotCli,
  enableCopilotCli,
  readCopilotCliState,
  selectCopilotCliModel,
} from "./config.mjs";

/**
 * GitHub Copilot **CLI** harness (`@github/copilot`, the `copilot` command).
 *
 * Separate from `copilot-app` because the two products share no config: this
 * one reads `~/.copilot/providers.json` and never looks at the desktop app's
 * data.db. See ./config.mjs for the format and the snapshot/restore rules.
 */


async function copilotCliResolveKey(ctx) {
  const { providersPath } = copilotCliPathsForShared(ctx);
  const { apiKey } = await readCopilotCliState(providersPath);
  // Only reuse a key that is actually Fireworks-shaped — a stale or hand-
  // edited entry is not a credential, it just 401s.
  return isFireworksKey(apiKey) ? apiKey.trim() : "";
}

export default defineHarnessProfile({
  id: HARNESS.COPILOT_CLI,
  label: "Copilot CLI",
  resolveKey: copilotCliResolveKey,
  keyEnvRef: "${FIREWORKS_API_KEY}",
  getExistingHarnessKey: copilotCliResolveKey,
  paths: (ctx) => copilotCliPathsForShared(ctx),
  // providers.json carries no per-request header map, so a local Anthropic
  // BYOK key can't be forwarded — same constraint as the desktop app.
  firerouter: {
    byok: "none",
    autoCatalog: true,
  },
  telemetryHeaders: true,
  enable: async ({ ctx, paths, effectiveKey, keyType, modelId, telemetryHeaders = {}, includeFirerouter = false }) => {
    const { ids: extraModels, available: catalogAvailable } = await loadRegisterableModels({
      apiKey: effectiveKey,
      includeFirerouter,
    });
    const resolvedModel = shortFireworksModelRef(resolveCopilotModelId(modelId?.trim(), keyType));
    const existing = await readCopilotCliState(paths.providersPath, paths.settingsPath);
    const initialized = await isHarnessEnabled(ctx.home, HARNESS.COPILOT_CLI);
    const catalogModels = copilotModelIds(extraModels);
    let toRegister;
    if (modelId) {
      toRegister = [...new Set([...existing.models, resolvedModel])];
    } else if (!initialized) {
      toRegister = copilotModelIds([resolvedModel, ...extraModels]);
    } else if (catalogAvailable) {
      const served = new Set(catalogModels);
      toRegister = existing.models.filter((id) => (
        isAutoModelId(id)
        || isFirerouterModelPattern(id)
        || served.has(id)
      ));
    } else {
      toRegister = existing.models;
    }

    await enableCopilotCli({
      providersPath: paths.providersPath,
      dataDir: paths.dataDir,
      apiKey: effectiveKey,
      models: describeCopilotModels(toRegister),
      extraHeaders: telemetryHeaders,
    });
    // A BYOK provider has no default model, so without a selection the CLI
    // refuses to start ("No supported model available").
    await selectCopilotCliModel({
      settingsPath: paths.settingsPath,
      dataDir: paths.dataDir,
      selectionId: copilotCliSelectionId(resolvedModel),
    });

    return {
      model: resolvedModel,
      modelsAdded: toRegister,
      keyType,
      selectionId: copilotCliSelectionId(resolvedModel),
    };
  },
  printConnected: ({ result }) => {
    printHarnessConnected("Copilot CLI", { model: result.model });
    printNote(
      `Selected as \`${result.selectionId}\` — the CLI addresses BYOK models by their `
        + "provider-qualified id. Switch with `copilot --model fireworks/<id>` or `/model`.",
    );
  },
  restartHint: () => printRestartHint("Start a new `copilot` session to pick up the change."),

  // A plain config file: no shell env hook, and no app to quit.
  envHookOff: false,
  disable: async ({ paths }) => {
    const providers = await disableCopilotCli({
      providersPath: paths.providersPath,
      dataDir: paths.dataDir,
    });
    const selection = await deselectCopilotCliModel({
      settingsPath: paths.settingsPath,
      dataDir: paths.dataDir,
    });
    return providers === "none" && selection === "none" ? "none" : "restored";
  },

  async providerStatus(ctx) {
    ensureHomeForHarness(ctx, HARNESS.COPILOT_CLI);
    const { providersPath } = copilotCliPathsForShared(ctx);
    return (await readCopilotCliState(providersPath)).configured ? "fireworks" : "none";
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.COPILOT_CLI);
    const paths = copilotCliPathsForShared(ctx);
    const enabled = await isHarnessEnabled(ctx.home, HARNESS.COPILOT_CLI);
    const state = await readCopilotCliState(paths.providersPath, paths.settingsPath);
    const provider = state.configured ? "fireworks" : "none";

    const payload = {
      harness: HARNESS.COPILOT_CLI,
      enabled,
      provider,
      baseUrl: state.configured ? COPILOT_FIREWORKS_BASE_URL : null,
      providersPath: paths.providersPath,
      hasKey: Boolean(state.apiKey),
      keyType: provider === "none" ? "none" : detectApiKeyType(state.apiKey),
      selectedModel: state.selectedModel,
      registeredModels: state.models,
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.COPILOT_CLI, {
      provider: payload.provider,
      keyConfigured: payload.hasKey,
      authMode: "literal",
      model: payload.selectedModel,
      registeredModels: payload.registeredModels,
      endpoint: payload.baseUrl,
      keySource: harnessStatusKeySource(HARNESS.COPILOT_CLI, payload.provider, { whenFireworks: false }),
    });
  },
});
