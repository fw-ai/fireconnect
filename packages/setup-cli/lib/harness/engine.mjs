import {
  printAzureConnected,
  printHarnessRestored,
  printHarnessUnchanged,
  buildFirerouterOnFootnotes,
  printHarnessOnFootnotes,
  printHarnessOnSuccess,
} from "../cli/messages.mjs";
import { isFirerouterModel } from "../fireworks/model-id.mjs";
import { assertRequestedModelServable } from "../fireworks/model-servability.mjs";
import { detectApiKeyType } from "../keys/key-type.mjs";
import { resolveAzureBaseUrl, resolveAzureOnApiKey } from "../fireworks/azure-core.mjs";
import {
  resolveHarnessOnApiKey,
} from "../keys/harness-api-key.mjs";
import {
  firerouterByokEnvRefHeaders,
  firerouterCredentialsApplyOnGateway,
  resolveExplicitFirerouterCredential,
  resolveFirerouterAvailability,
  resolveFirerouterByokHeaders,
  resolveFirerouterPlan,
} from "../firerouter/flag.mjs";
import {
  isHarnessEnabled,
  readProviderSettings,
  setHarnessEnabled,
} from "../config/global-config.mjs";
import { reconcileShellEnvHook } from "../io/shell-env-hook.mjs";
import { disableWebsearchMcp } from "../system/websearch-mcp.mjs";
import { ensureHomeForHarness } from "./context.mjs";
import { defineHarness } from "./types.mjs";
import { buildFireconnectTelemetryHeaders } from "../telemetry/request-headers.mjs";

function resolveProfileFirerouterAvailability(profile, ctx, apiKey, keyType) {
  return resolveFirerouterAvailability({
    firerouter: profile.firerouter,
    keyType,
    workspaceApiKey: apiKey,
    home: ctx.home,
  });
}

/**
 * A HarnessProfile is the small, mostly-declarative description of a harness.
 * The engine owns the shared `on`/`off` command orchestration
 * so a new step in a flow is one edit here, not one per harness. Harness-specific
 * config-format work stays in the profile's hook functions.
 *
 * @typedef {Object} HarnessProfile
 * @property {import("./id.mjs").HarnessId} id
 * @property {string} label
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<string>} resolveKey
 *   Harness-local key (used by the registry's resolveKey and, typically, fullKey).
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<import("./types.mjs").HarnessContext>} [resolveOnContext]
 *   Resolve state-dependent defaults needed before validating `on` options.
 * @property {(ctx: import("./types.mjs").HarnessContext) => object} paths
 * @property {string} keyEnvRef
 * @property {import("../firerouter/flag.mjs").FirerouterCapability|null} [firerouter]
 *   Complete FireRouter capability; null/omitted means unsupported.
 * @property {boolean} [telemetryHeaders] Whether this harness can send static request headers.
 * @property {(ctx: import("./types.mjs").HarnessContext, paths: object) => Promise<Record<string,string>>} [readByokEnv]
 *   For `byok: "value"` harnesses: return a settingsEnv-shaped object (with
 *   ANTHROPIC_CUSTOM_HEADERS) built from BYOK keys already stored in the harness
 *   config, so a repeat `on` recovers them instead of dropping them.
 * @property {{
 *   read: (ctx: object, paths: object) => Promise<{ active: boolean, storedKey?: string, storedBaseUrl?: string, model?: string }>,
 *   enable: (args: { ctx: object, paths: object, apiKey: string, apiKeyFromFlag: boolean, baseUrl: string }) => Promise<{ model: string, baseUrl: string, apiKeyMode?: string }>,
 *   restart: (result: object) => void,
 * }} [azure] Complete Foundry capability; omitted means unsupported.
 * @property {(ctx: import("./types.mjs").HarnessContext, paths: object) => Promise<string>} [getExistingHarnessKey]
 * @property {(ctx: import("./types.mjs").HarnessContext, paths: object) => Promise<{ apiKeyRef?: string, effectiveKey: string, reusedExistingKey?: boolean }>} [resolveOnKey]
 *   Custom `on` key resolution (default: resolveHarnessOnApiKey with keyEnvRef + getExistingHarnessKey).
 * @property {(args: { ctx: object, keyType: string }) => void} [precheck]  Throw before enabling (e.g. Codex firepass).
 * @property {(args: { ctx: object, paths: object, apiKeyRef: string, effectiveKey: string, keyType: string, modelId: string, byokHeaders: Record<string,string>, telemetryHeaders: Record<string,string>, includeFirerouter: boolean, flags: object }) => Promise<{ model: string, modelsAdded?: string[], keyType: string }>} enable
 * @property {(ctx: import("./types.mjs").HarnessContext, effectiveKey: string) => Promise<void>} [envHookOn]
 * @property {(args: { ctx: object, paths: object, result: object, reusedExistingKey: boolean, keyType: string }) => void} [printConnected]
 *   Full success-output override (default: connected + restartHint).
 * @property {() => void} [restartHint]
 * @property {(args: { ctx: object, paths: object, wasEnabled: boolean }) => Promise<"restored"|"stripped"|"unchanged">} [disable]
 * @property {(ctx: object) => Promise<void>} [prepareOff]  Stop the IDE before writing (Cursor/VS Code).
 * @property {boolean} [envHookOff]  Set false to skip the shell env-hook removal on `off` (Cursor/VS Code).
 * @property {(outcome: string) => void} [restartHintOff]
 * Command overrides — when omitted, the engine's generic implementation is used
 * (except `status`, which is always harness-specific and required):
 * @property {boolean} [websearchMcp] Install Firesearch MCP on `on` when entitled.
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<void>} status
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<void>} [on]
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<void>} [off]
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<void>} [usage]
 */

/**
 * Generic `<harness> on`: resolve the key, decide the model (FireRouter default
 * or explicit/direct), build BYOK headers, write the provider config, flip the
 * enabled flag, reconcile the shell env hook when needed, and print the standard success
 * output. Azure mode delegates to the profile's own handler unchanged.
 * @param {HarnessProfile} profile
 * @param {import("./types.mjs").HarnessContext} ctx
 */
export async function engineOn(profile, ctx) {
  ensureHomeForHarness(ctx, profile.id);

  if (profile.azure) {
    const { provider, azure: azureConfig } = await readProviderSettings(ctx.home);
    if (ctx.azure || provider === "azure") {
      await engineAzureOn(profile, ctx, azureConfig);
      return;
    }
  }

  const paths = profile.paths(ctx);
  const { apiKeyRef = "", effectiveKey, reusedExistingKey = false } = await resolveOnKey(profile, ctx, paths);
  const keyType = detectApiKeyType(effectiveKey);
  const automaticFirerouter = await resolveProfileFirerouterAvailability(
    profile,
    ctx,
    effectiveKey,
    keyType,
  );
  if (profile.precheck) {
    profile.precheck({ ctx, keyType });
  }

  let modelId = ctx.main;
  let byokHeaders = {};
  let isFirerouterRequested = false;
  let preResolvedAnthropicKey;
  if (profile.firerouter) {
    const plan = resolveFirerouterPlan(ctx, { keyType });
    modelId = plan.mainModel;
    isFirerouterRequested = plan.isFirerouter;
    const settingsEnv = profile.readByokEnv ? await profile.readByokEnv(ctx, paths) : {};
    // Direct Fireworks gateway `on` only (Azure returns above). Fire Pass cannot
    // use FireRouter; assertFirerouterKeyType throws on explicit firerouter + fpk_.
    if (isFirerouterRequested && firerouterCredentialsApplyOnGateway(keyType)) {
      ({ anthropicKey: preResolvedAnthropicKey } = await resolveExplicitFirerouterCredential({
        firerouter: profile.firerouter,
        availability: automaticFirerouter,
        ctx,
        settingsEnv,
      }));
    }
    const catalogFirerouter = automaticFirerouter.include && profile.firerouter.catalogByok === true;
    if (profile.firerouter.byok === "value") {
      // Recover BYOK keys that live only in the harness's existing config
      // headers, so a repeat `on` without re-supplying them doesn't drop them.
      // VS Code alone uses catalogByok: firerouter BYOK belongs on the model
      // entry, not the provider (OpenCode/Pi/Codex attach at provider level).
      byokHeaders = await resolveFirerouterByokHeaders({
        plan,
        catalogFirerouter,
        ctx,
        settingsEnv,
        apiKey: effectiveKey,
        workspaceByokLookup: automaticFirerouter.workspaceByokLookup ?? null,
        preResolvedAnthropicKey,
      });
    } else if (profile.firerouter.byok === "envref") {
      byokHeaders = firerouterByokEnvRefHeaders(plan, { catalogFirerouter });
    }
  }

  await assertRequestedModelServable(modelId, { apiKey: effectiveKey, keyType });

  const result = await profile.enable({
    ctx,
    paths,
    apiKeyRef,
    effectiveKey,
    keyType,
    modelId,
    byokHeaders,
    telemetryHeaders: profile.telemetryHeaders
      ? buildFireconnectTelemetryHeaders(profile.id)
      : {},
    includeFirerouter: automaticFirerouter.include || isFirerouterRequested,
  });

  await setHarnessEnabled(ctx.home, profile.id, true, "fireworks");
  if (profile.envHookOn) {
    await profile.envHookOn(ctx, effectiveKey);
  }

  const modelsAdded = result.modelsAdded ?? [result.model];
  const firerouterIncluded = Boolean(
    profile.firerouter && isFirerouterModel(result.model),
  );
  const footnotes = buildFirerouterOnFootnotes({
    harnessId: profile.id,
    firerouter: profile.firerouter,
    firerouterIncluded,
    eligible: automaticFirerouter.include,
    routingPreference: ctx.routingPreference,
    firepass: keyType === "firepass",
    workspaceByokLookup: automaticFirerouter.workspaceByokLookup ?? null,
  });
  if (profile.printConnected) {
    await profile.printConnected({ ctx, paths, result, reusedExistingKey, keyType });
    printHarnessOnFootnotes(modelsAdded, footnotes, profile.restartHint, {
      primaryModel: result.model,
    });
    return;
  }
  await printHarnessOnSuccess({
    label: profile.label,
    model: result.model,
    modelsAdded,
    footnotes,
    restartHint: profile.restartHint,
  });
}

/**
 * Generic `<harness> on --azure`: the shared Foundry (Azure) orchestration —
 * resolve the key + endpoint (precedence: flag > configured > stored > env),
 * write the provider through the profile's cohesive Azure capability, flip the
 * enabled flag, and print the standard Azure success output.
 * @param {HarnessProfile} profile
 * @param {import("./types.mjs").HarnessContext} ctx
 * @param {{ baseUrl?: string, apiKey?: string }} azureConfig
 */
export async function engineAzureOn(profile, ctx, azureConfig) {
  const paths = profile.paths(ctx);
  const { active = false, storedKey = "", storedBaseUrl = "" } = await profile.azure.read(ctx, paths);

  const { apiKey, apiKeyFromFlag } = await resolveAzureOnApiKey({
    apiKey: ctx.apiKey,
    apiKeyFromFlag: ctx.apiKeyFromFlag,
    configuredApiKey: azureConfig.apiKey,
    getExistingKey: async () => (active ? storedKey : ""),
  });
  const baseUrl = resolveAzureBaseUrl(ctx, azureConfig, active ? storedBaseUrl : "");

  const result = await profile.azure.enable({ ctx, paths, apiKey, apiKeyFromFlag, baseUrl });

  await setHarnessEnabled(ctx.home, profile.id, true, "azure");
  await reconcileShellEnvHook(ctx.home);

  printAzureConnected({
    id: profile.label,
    result,
  });
  profile.azure.restart(result);
}

/**
 * `on` key resolution: the profile's own resolver when provided (Cursor/VS Code
 * read a SQLite secret), else the standard keychain/env-ref flow.
 * @param {HarnessProfile} profile
 * @param {import("./types.mjs").HarnessContext} ctx
 * @param {object} paths
 */
async function resolveOnKey(profile, ctx, paths) {
  if (profile.resolveOnKey) {
    return profile.resolveOnKey(ctx, paths);
  }
  const { apiKey, effectiveKey, reusedExistingKey } = await resolveHarnessOnApiKey({
    apiKey: ctx.apiKey,
    home: ctx.home,
    harnessEnvRef: profile.keyEnvRef,
    getExistingHarnessKey: profile.getExistingHarnessKey
      ? () => profile.getExistingHarnessKey(ctx, paths)
      : undefined,
  });
  return { apiKeyRef: apiKey, effectiveKey, reusedExistingKey };
}

/**
 * Generic `<harness> off`: back out the provider config via the profile's
 * `disable` hook (which returns an outcome), flip the enabled flag, remove the
 * shell env hook (unless the harness opts out), and print restored/unchanged.
 * `prepareOff` (stop the IDE) and `restartHintOff` are optional.
 * @param {HarnessProfile} profile
 * @param {import("./types.mjs").HarnessContext} ctx
 */
export async function engineOff(profile, ctx) {
  ensureHomeForHarness(ctx, profile.id);
  const paths = profile.paths(ctx);
  // `wasEnabled` drives restore-vs-strip in `profile.disable`. The global
  // `enabled` flag can drift from ground truth (older CLI versions, adapters
  // that didn't maintain it), so prefer the harness's real config when the
  // profile exposes `providerStatus` — otherwise a stale `false` flag would
  // make `off` skip restoring a harness that's actually routed through Fireworks.
  let wasEnabled = await isHarnessEnabled(ctx.home, profile.id);
  if (typeof profile.providerStatus === "function") {
    try {
      const provider = await profile.providerStatus(ctx);
      wasEnabled = provider === "fireworks" || provider === "azure";
    } catch {
      // Config unreadable (e.g. IDE DB locked): keep the flag-based value.
    }
  }
  if (profile.prepareOff) {
    await profile.prepareOff(ctx);
  }
  const outcome = await profile.disable({ ctx, paths, wasEnabled });
  if (profile.websearchMcp) {
    await disableWebsearchMcp(ctx.home, profile.id);
  }
  await setHarnessEnabled(ctx.home, profile.id, false);
  if (profile.envHookOff !== false) {
    await reconcileShellEnvHook(ctx.home);
  }
  if (outcome === "restored" || outcome === "stripped") {
    printHarnessRestored(profile.id);
  } else {
    printHarnessUnchanged(profile.id);
  }
  if (profile.restartHintOff) {
    profile.restartHintOff(outcome);
  }
}

function assertProfileCapabilities(profile) {
  const capability = profile.firerouter;
  if (capability != null) {
    const validByok = typeof capability === "object"
      && (
        capability.byok === "none"
        || capability.byok === "value"
        || capability.byok === "envref"
      );
    if (!validByok || typeof capability.autoCatalog !== "boolean") {
      throw new Error(
        `Harness profile ${profile.id} must define firerouter as `
          + "{ byok: \"none\"|\"value\"|\"envref\", autoCatalog: boolean, catalogByok?: boolean } or null.",
      );
    }
    if (
      Object.hasOwn(capability, "catalogByok")
      && typeof capability.catalogByok !== "boolean"
    ) {
      throw new Error(
        `Harness profile ${profile.id} firerouter.catalogByok must be a boolean when set.`,
      );
    }
  }
  if (
    profile.azure != null
    && (
      typeof profile.azure !== "object"
      || typeof profile.azure.read !== "function"
      || typeof profile.azure.enable !== "function"
      || typeof profile.azure.restart !== "function"
    )
  ) {
    throw new Error(
      `Harness profile ${profile.id} must define azure as { read, enable, restart } or omit it.`,
    );
  }
}

/**
 * Build a HarnessAdapter from a HarnessProfile.
 * @param {HarnessProfile} profile
 * @returns {import("./types.mjs").HarnessAdapter}
 */
export function defineHarnessProfile(profile) {
  assertProfileCapabilities(profile);
  return defineHarness({
    id: profile.id,
    label: profile.label,
    resolveKey: profile.resolveKey,
    firerouter: profile.firerouter ?? null,
    azure: profile.azure ?? null,
    // Engine supplies the default flow; a profile may override when needed.
    on: profile.on ?? ((ctx) => engineOn(profile, ctx)),
    off: profile.off ?? ((ctx) => engineOff(profile, ctx)),
    status: profile.status,
    ...(profile.providerStatus ? { providerStatus: profile.providerStatus } : {}),
    ...(profile.usage ? { usage: profile.usage } : {}),
    ...(profile.live ? { live: profile.live } : {}),
    ...(profile.resolveOnContext ? { resolveOnContext: profile.resolveOnContext } : {}),
  });
}
