import {
  printField,
  printMutedNote,
  printStructuredHarnessStatus,
} from "../../harness/status-display.mjs";
import {
  printHarnessConnected,
} from "../../cli/messages.mjs";
import { defaultMainModel } from "../../fireworks/model-id.mjs";
import {
  CODEX_API_KEY_ENV_REF,
  CODEX_AZURE_PROVIDER_ID,
  CODEX_AZURE_PROVIDER_TABLE,
  codexAuthKeyMode,
  codexCurrentModelId,
  codexProviderStatus,
  codexStoredAuthRef,
  disableCodexFireworks,
  effectiveCodexApiKey,
  enableCodexAzure,
  enableCodexFireworks,
  loadCodexCatalogBundle,
  printCodexRestartHint,
  readCodexTomlIfExists,
} from "./core.mjs";
import { DEFAULT_AZURE_MODEL, AZURE_PROVIDER_LABEL } from "../../fireworks/azure-core.mjs";
import { isFireworksKey } from "../../keys/key-type.mjs";
import { finishEnvHarnessOn } from "../../harness/env-hook.mjs";
import { defineHarnessProfile } from "../../harness/engine.mjs";
import {
  codexPathsFor,
  ensureHomeForHarness,
} from "../../harness/context.mjs";
import { codexModelExclusionReason } from "./catalog.mjs";
import { ensureChatGptStopped } from "./ide-running.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { harnessStatusKeySource } from "../../keys/api-key.mjs";
import { existsSync } from "node:fs";
import path from "node:path";

const CODEX_FIREROUTER = Object.freeze({
  byok: "envref",
  autoCatalog: true,
});

async function codexResolveKey(ctx) {
  const { configPath } = codexPathsFor(ctx);
  const { doc } = await readCodexTomlIfExists(configPath);
  if (codexProviderStatus(doc) !== "fireworks") {
    return "";
  }
  const key = effectiveCodexApiKey(codexStoredAuthRef(doc));
  return isFireworksKey(key) ? key.trim() : "";
}

export default defineHarnessProfile({
  id: HARNESS.CODEX,
  label: "Codex",
  resolveKey: codexResolveKey,
  paths: (ctx) => codexPathsFor(ctx),
  keyEnvRef: CODEX_API_KEY_ENV_REF,
  firerouter: CODEX_FIREROUTER,
  telemetryHeaders: true,
  azure: {
    read: async (_ctx, { configPath }) => {
      const { doc } = await readCodexTomlIfExists(configPath);
      const table = doc.tables[CODEX_AZURE_PROVIDER_TABLE];
      return {
        active: codexProviderStatus(doc) === "azure",
        storedKey: codexStoredAuthRef(doc),
        storedBaseUrl: typeof table?.base_url === "string" ? table.base_url : "",
      };
    },
    enable: async ({ ctx, paths, apiKey, apiKeyFromFlag, baseUrl }) => {
      await ensureChatGptStopped({ force: ctx.force });
      return enableCodexAzure({
        configPath: paths.configPath,
        dataDir: paths.dataDir,
        apiKey,
        apiKeyFromFlag,
        baseUrl,
        modelId: ctx.main,
      });
    },
    restart: () => printCodexRestartHint({
      resume: true,
      providerId: CODEX_AZURE_PROVIDER_ID,
      providerLabel: AZURE_PROVIDER_LABEL,
    }),
  },
  getExistingHarnessKey: async (_ctx, paths) => {
    const { doc } = await readCodexTomlIfExists(paths.configPath);
    // Only reuse a stored key when the gateway provider is active — an Azure
    // bearer / {env:AZURE_API_KEY} ref must never be read as the Fireworks key
    // when switching from Foundry back to the gateway.
    return codexProviderStatus(doc) === "fireworks" ? codexStoredAuthRef(doc) : "";
  },
  precheck: ({ keyType }) => {
    if (keyType === "firepass") {
      throw new Error(
        "The /responses endpoint is not supported for Fire Pass keys yet. " +
        "Use a standard Fireworks API key (fw_...).",
      );
    }
  },
  // Codex reads keys from the environment (env_key/env_http_headers).
  enable: async ({
    ctx,
    paths,
    apiKeyRef,
    effectiveKey,
    keyType,
    modelId,
    byokHeaders,
    telemetryHeaders,
    includeFirerouter,
  }) => {
    await ensureChatGptStopped({ force: ctx.force });
    const exclusionReason = codexModelExclusionReason(modelId);
    if (exclusionReason) {
      throw new Error(exclusionReason);
    }
    const { codexCatalog } = await loadCodexCatalogBundle(effectiveKey, {
      includeFirerouter,
    });
    return enableCodexFireworks({
      configPath: paths.configPath,
      dataDir: paths.dataDir,
      apiKey: apiKeyRef,
      effectiveApiKey: effectiveKey,
      baseUrl: ctx.baseUrlFromFlag ? ctx.baseUrl : "",
      modelId,
      keyType,
      catalogPath: paths.catalogPath,
      catalog: codexCatalog,
      envHttpHeaders: byokHeaders,
      telemetryHeaders,
    });
  },
  envHookOn: (ctx) => finishEnvHarnessOn(ctx.home, { harnessId: "codex" }),
  printConnected: ({ paths, result }) => {
    printHarnessConnected("Codex", { model: result.model });
    printField("Config", paths.configPath);
    printField("Endpoint", result.baseUrl);
  },
  restartHint: () => printCodexRestartHint(),

  // Stop the app before `off` rewrites config.toml/removes the catalog — it
  // caches the model list at boot. Mirrors Cursor/VS Code's `prepareOff`.
  prepareOff: (ctx) => ensureChatGptStopped({ force: ctx.force }),
  disable: async ({ paths, wasEnabled }) => disableCodexFireworks({
    configPath: paths.configPath,
    dataDir: paths.dataDir,
    catalogPath: paths.catalogPath,
    wasEnabled,
  }),
  restartHintOff: () => printCodexRestartHint({ resume: false }),
  async providerStatus(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CODEX);
    const { configPath } = codexPathsFor(ctx);
    const { doc } = await readCodexTomlIfExists(configPath);
    return codexProviderStatus(doc);
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CODEX);
    const { configPath } = codexPathsFor(ctx);
    const { doc } = await readCodexTomlIfExists(configPath);
    const provider = codexProviderStatus(doc);
    const modelProvider = typeof doc.root.model_provider === "string" ? doc.root.model_provider : "openai";
    const providerTable = doc.tables[`model_providers.${modelProvider}`] ?? {};
    const baseUrl = modelProvider === "openai" ? doc.root.openai_base_url : providerTable.base_url;
    const model = codexCurrentModelId(doc) ?? doc.root.model ?? null;
    const storedAuth = codexStoredAuthRef(doc);
    const catalogRef = doc.root.model_catalog_json;
    const catalogPath = typeof catalogRef === "string" && catalogRef
      ? (catalogRef.startsWith("~/")
        ? path.resolve(ctx.home, catalogRef.slice(2))
        : path.resolve(path.dirname(configPath), catalogRef))
      : null;
    const diagnostics = [];
    if (catalogPath && !existsSync(catalogPath)) {
      diagnostics.push("The configured model catalog is missing. Re-run fireconnect codex on to regenerate it.");
    }
    if (doc.root.profile) {
      diagnostics.push("A profile is selected in this file; its overrides are not included in this configuration-only status.");
    }
    const payload = {
      harness: HARNESS.CODEX,
      provider,
      configPath,
      configurationSource: "config-file",
      runtimeVerified: false,
      baseUrl: redactEndpoint(baseUrl),
      modelProvider,
      hasAuthToken: Boolean(effectiveCodexApiKey(storedAuth)),
      defaults: { main: provider === "azure" ? DEFAULT_AZURE_MODEL : defaultMainModel() },
      current: { main: model },
      modelCatalog: {
        set: Boolean(catalogPath),
        path: catalogPath,
        exists: Boolean(catalogPath && existsSync(catalogPath)),
      },
      diagnostics,
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.CODEX, {
      provider: payload.provider,
      keyConfigured: payload.hasAuthToken,
      authMode: codexAuthKeyMode(storedAuth),
      model: payload.current.main,
      endpoint: payload.baseUrl,
      keySource: harnessStatusKeySource(HARNESS.CODEX, provider),
    });
    printField("Config", configPath);
    printField("Model provider", modelProvider);
    printMutedNote("Configuration on disk. Running Codex tasks have not been verified.");
    for (const diagnostic of diagnostics) printMutedNote(diagnostic);
  },

});

// URLs from hand-edited configs may contain secrets even though --base-url
// rejects them. Never include URL credentials/query values in status output.
function redactEndpoint(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search ? "?[redacted]" : ""}${url.hash ? "#[redacted]" : ""}`;
  } catch {
    return "(invalid URL)";
  }
}
