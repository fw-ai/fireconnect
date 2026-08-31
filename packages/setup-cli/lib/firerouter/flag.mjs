import process from "node:process";

import {
  isFirerouterModelPattern,
  firerouterRequiresAnthropicKey,
} from "../fireworks/model-id.mjs";
import {
  isAccountFeatureFlagEnabled,
} from "../config/feature-flags.mjs";
import {
  ANTHROPIC_BYOK_HEADER,
  ROUTING_PREFERENCE_HEADER,
  firerouterByokHeaders,
  isAnthropicShapedKey,
  normalizeRoutingPreference,
  resolveAnthropicKey,
  resolveFirerouterByokKeys,
} from "./core.mjs";
import { verifyFireworksApiKey } from "../keys/verify-api-key.mjs";

/**
 * Account feature flag indicating workspace-level BYOK is provisioned
 * server-side (control-plane `EnableWorkspaceByok`). When set, the gateway
 * supplies the provider (e.g. Anthropic) key for FireRouter pass-through, so
 * `firerouter` reaches frontier models with NO user-supplied Anthropic key —
 * and FireConnect must not prompt for one.
 *
 * (FireRouter access itself is generally available; only this BYOK provisioning
 * is still account-specific.)
 */
export const ENABLE_WORKSPACE_BYOK_FLAG_ID = "enable-workspace-byok";

export const FIREROUTER_WORKSPACE_BYOK_REQUIRED_MESSAGE =
  "Ask the Fireworks team to enable FireRouter for your account.";

export const FIREROUTER_ENV_BYOK_REQUIRED_MESSAGE =
  "FireRouter needs an Anthropic key in your environment. Export ANTHROPIC_API_KEY, "
  + "pass --anthropic-api-key with codex on, "
  + "or ask the Fireworks team about workspace BYOK.";

export const FIREROUTER_BYOK_REQUIRED_MESSAGE =
  "FireRouter needs your Anthropic API key (or workspace BYOK). "
  + "Set ANTHROPIC_API_KEY, pass --anthropic-api-key <sk-ant-...>, "
  + "or ask the Fireworks team about workspace BYOK.";

/** Lookup result used before a workspace-BYOK probe has run. */
export const WORKSPACE_BYOK_UNRESOLVED = Object.freeze({
  enabled: false,
  unavailable: false,
  reason: "",
});

/**
 * Whether FireRouter credentials are available for an explicit `--model firerouter`
 * selection. When workspace BYOK cannot be verified (offline/control-plane error),
 * allow the request so a transient lookup failure does not block enablement.
 * @param {{
 *   include?: boolean,
 *   workspaceByokLookup?: import("../config/feature-flags.mjs").FeatureFlagLookupResult|null,
 * }} availability
 * @returns {boolean}
 */
export function firerouterCredentialsSatisfied(availability) {
  if (availability.include) {
    return true;
  }
  return availability.workspaceByokLookup?.unavailable === true;
}

/**
 * Resolve the error message for a missing FireRouter credential requirement.
 * @param {{ byok?: "value"|"envref"|"none" }|null|undefined} firerouter
 * @returns {string}
 */
export function firerouterCredentialsRequiredMessage(firerouter) {
  if (firerouter?.byok === "none") {
    return FIREROUTER_WORKSPACE_BYOK_REQUIRED_MESSAGE;
  }
  if (firerouter?.byok === "envref") {
    return FIREROUTER_ENV_BYOK_REQUIRED_MESSAGE;
  }
  return FIREROUTER_BYOK_REQUIRED_MESSAGE;
}

/**
 * Throw when `<harness> on --model firerouter` is requested on a harness that
 * cannot forward a local Anthropic key (`byok: "none"`) and workspace BYOK is
 * not provisioned.
 *
 * @param {{
 *   availability?: {
 *     include?: boolean,
 *     workspaceByokLookup?: import("../config/feature-flags.mjs").FeatureFlagLookupResult|null,
 *   },
 * }} input
 */
export function assertFirerouterWorkspaceByok({
  availability = { include: false },
  firerouter = { byok: "none" },
} = {}) {
  if (firerouterCredentialsSatisfied(availability)) {
    return;
  }
  throw new Error(firerouterCredentialsRequiredMessage(firerouter));
}

/**
 * Resolve or prompt for Anthropic credentials when the user explicitly selects
 * FireRouter (`--model firerouter` or a Claude slot). Workspace-only harnesses
 * throw when workspace BYOK is missing.
 *
 * @param {{
 *   firerouter?: { byok?: "value"|"envref"|"none" }|null,
 *   availability?: {
 *     include?: boolean,
 *     workspaceByokLookup?: import("../config/feature-flags.mjs").FeatureFlagLookupResult|null,
 *   },
 *   ctx?: { anthropicKey?: string, anthropicKeyFromFlag?: boolean, home?: string },
 *   settingsEnv?: Record<string, string>,
 *   allowPromptSkip?: boolean,
 * }} input
 */
export async function resolveExplicitFirerouterCredential({
  firerouter = null,
  availability = { include: false },
  ctx = {},
  settingsEnv = {},
  allowPromptSkip = true,
} = {}) {
  if (!firerouter) {
    return { anthropicKey: "" };
  }
  const workspaceByokLookup = availability.workspaceByokLookup ?? WORKSPACE_BYOK_UNRESOLVED;
  if (firerouter.byok === "none") {
    assertFirerouterWorkspaceByok({ availability, firerouter });
    return { anthropicKey: "" };
  }
  return resolveFirerouterByokKeys({
    anthropicFlag: ctx.anthropicKeyFromFlag ? ctx.anthropicKey : "",
    settingsEnv,
    home: ctx.home,
    explicit: true,
    allowPromptSkip,
    resolveWorkspaceByok: () => Promise.resolve(workspaceByokLookup),
  });
}

/**
 * Whether a harness accepts `--routing-preference` on `on`. Matches the
 * validation in harness.mjs (custom-header BYOK harnesses only).
 * @param {{ byok?: "value"|"envref"|"none" }|null|undefined} firerouter
 * @returns {boolean}
 */
export function supportsRoutingPreference(firerouter) {
  return firerouter?.byok === "value";
}

/**
 * Whether a harness accepts `--anthropic-api-key` on `on` for FireRouter BYOK.
 * Value harnesses embed the key in config headers; envref harnesses (Codex)
 * persist it and export ANTHROPIC_API_KEY via the shell hook.
 * @param {{ byok?: "value"|"envref"|"none" }|null|undefined} firerouter
 * @returns {boolean}
 */
export function supportsAnthropicApiKeyFlag(firerouter) {
  return firerouter?.byok === "value" || firerouter?.byok === "envref";
}

/**
 * Whether FireRouter should be auto-visible for a harness. Workspace BYOK works
 * for every supported harness; a local Anthropic env key only counts when the
 * harness can forward a value or env reference.
 */
export function shouldAutoIncludeFirerouter({
  autoFirerouter = false,
  byok = "none",
  keyType = "",
  workspaceByok = false,
  anthropicApiKey = "",
} = {}) {
  if (!autoFirerouter || keyType === "firepass") {
    return false;
  }
  if (workspaceByok) {
    return true;
  }
  return (byok === "value" || byok === "envref")
    && isAnthropicShapedKey(anthropicApiKey);
}

/**
 * Resolve the complete automatic-visibility decision once. Local Anthropic
 * credentials (flag/global/env) avoid a control-plane lookup; workspace BYOK
 * is consulted only when local BYOK is unavailable.
 *
 * @typedef {{
 *   byok: "value"|"envref"|"none",
 *   autoCatalog: boolean,
 * }} FirerouterCapability
 *
 * @param {{
 *   firerouter?: FirerouterCapability|null,
 *   keyType?: string,
 *   workspaceApiKey?: string,
 *   home?: string,
 * }} input
 * @param {{
 *   resolveAnthropic?: typeof resolveAnthropicKey,
 *   resolveWorkspace?: typeof resolveWorkspaceByok,
 * }} [seams]
 */
export async function resolveFirerouterAvailability({
  firerouter = null,
  keyType = "",
  workspaceApiKey = "",
  home = "",
} = {}, {
  resolveAnthropic = resolveAnthropicKey,
  resolveWorkspace = resolveWorkspaceByokStatus,
} = {}) {
  if (!firerouter) {
    return { include: false, workspaceByok: false };
  }
  const { autoCatalog, byok } = firerouter;
  const anthropicApiKey = byok === "none"
    ? ""
    : await resolveAnthropic({ home });
  const options = {
    autoFirerouter: autoCatalog,
    byok,
    keyType,
    anthropicApiKey,
  };
  if (shouldAutoIncludeFirerouter(options)) {
    return { include: true, workspaceByok: false };
  }
  if (!autoCatalog || keyType === "firepass") {
    return { include: false, workspaceByok: false };
  }
  const rawLookup = await resolveWorkspace(workspaceApiKey);
  const workspaceByokLookup = typeof rawLookup === "boolean"
    ? { enabled: rawLookup, unavailable: false, reason: "" }
    : rawLookup;
  const workspaceByok = workspaceByokLookup.enabled;
  return {
    include: shouldAutoIncludeFirerouter({ ...options, workspaceByok }),
    workspaceByok,
    workspaceByokLookup,
  };
}

/**
 * Resolve workspace BYOK without collapsing disabled and unavailable states.
 * @param {string} apiKey
 * @param {{ verifyKey?: typeof verifyFireworksApiKey, lookupFlag?: typeof isAccountFeatureFlagEnabled }} [seams]
 * @returns {Promise<import("../config/feature-flags.mjs").FeatureFlagLookupResult>}
 */
export async function resolveWorkspaceByokStatus(
  apiKey,
  {
    verifyKey = verifyFireworksApiKey,
    lookupFlag = isAccountFeatureFlagEnabled,
  } = {},
) {
  const key = (apiKey ?? "").trim();
  if (!key) {
    return { enabled: false, unavailable: false, reason: "" };
  }
  try {
    const verified = await verifyKey(key);
    if (!verified.ok) {
      return {
        enabled: false,
        unavailable: true,
        reason: verified.reason || "API key verification failed",
      };
    }
    const acct = verified.ok ? verified.accountId?.trim() ?? "" : "";
    if (!acct) {
      return {
        enabled: false,
        unavailable: true,
        reason: "API key verification returned no account ID",
      };
    }
    const apiBaseUrl = process.env.FIRECONNECT_GATEWAY_URL?.trim() ?? "";
    return await lookupFlag(
      acct,
      key,
      ENABLE_WORKSPACE_BYOK_FLAG_ID,
      apiBaseUrl ? { apiBaseUrl } : undefined,
    );
  } catch (error) {
    return {
      enabled: false,
      unavailable: true,
      reason: error instanceof Error ? error.message : "workspace BYOK lookup failed",
    };
  }
}

/** Backward-compatible boolean view for callers that need only enabled/disabled. */
export async function resolveWorkspaceByok(apiKey, seams) {
  return (await resolveWorkspaceByokStatus(apiKey, seams)).enabled;
}

/**
 * @typedef {Object} FirerouterPlan
 * @property {string}  mainModel     Model id to write to the harness's main slot
 *                                   ("" = keep the harness's normal Fireworks default).
 * @property {boolean} isFirerouter  Whether `mainModel` routes through FireRouter.
 * @property {boolean} requiresAnthropicKey
 *   Whether the selection needs an Anthropic credential (bare firerouter or a
 *   Claude/Opus model in the path). Pure-Fireworks selections need none.
 */

/**
 * Resolve the routing plan from the requested model. FireRouter is a regular
 * gateway model now (generally available — no account entitlement lookup):
 * `--model firerouter` selects it; anything else keeps the harness's normal
 * default. FireConnect never auto-selects firerouter. The only guard is that
 * Fire Pass keys can't use it (`assertFirerouterKeyType`).
 *
 * @param {{ main?: string }} ctx
 * @param {{ keyType?: string }} [options]
 * @returns {FirerouterPlan}
 */
export function resolveFirerouterPlan(ctx, { keyType = "" } = {}) {
  const requested = ctx.main?.trim() ?? "";
  if (!requested) {
    return { mainModel: "", isFirerouter: false, requiresAnthropicKey: false };
  }
  assertFirerouterKeyType(requested, keyType);
  return {
    mainModel: requested,
    isFirerouter: isFirerouterModelPattern(requested),
    requiresAnthropicKey: firerouterRequiresAnthropicKey(requested),
  };
}

/** FireRouter is only offered for standard Fireworks keys, not Fire Pass. */
export const FIREROUTER_FIREPASS_UNSUPPORTED_MESSAGE =
  "FireRouter is not available for Fire Pass keys (fpk_...). Use a standard Fireworks API key (fw_...).";

/**
 * Throw when a FireRouter selection is requested with a Fire Pass key. Call after
 * the effective model + key type are known, before enabling.
 * @param {string} model
 * @param {string} keyType
 */
export function assertFirerouterKeyType(model, keyType) {
  if (isFirerouterModelPattern(model) && keyType === "firepass") {
    throw new Error(FIREROUTER_FIREPASS_UNSUPPORTED_MESSAGE);
  }
}

/**
 * Whether explicit FireRouter credential resolution runs on the shared engine's
 * direct Fireworks gateway `on` path. Azure mode returns before this; only
 * standard fw_ keys qualify (Fire Pass cannot use FireRouter).
 * @param {string} keyType
 * @returns {boolean}
 */
export function firerouterCredentialsApplyOnGateway(keyType) {
  return keyType === "fireworks";
}

/**
 * Value-based BYOK headers for custom-header harnesses (Claude/OpenCode/Pi/
 * VS Code). Resolves at most one provider key (Anthropic or OpenAI) from
 * flag/env/settings — prompting once for an Anthropic key when none is
 * available — then maps it to the wire headers. Returns `{}` when the plan
 * isn't routing through FireRouter. `settingsEnv` surfaces keys a harness
 * already stores.
 *
 * Also carries the `x-routing-preference` header when `ctx.routingPreference`
 * is set, so `--routing-preference` keeps tuning FireRouter under the model path.
 *
 * When neither key is supplied, workspace BYOK (`enable-workspace-byok`) is
 * checked before prompting: if the workspace provisions the provider key
 * server-side, firerouter works with no user key, so we never prompt.
 *
 * @param {{
 *   plan: FirerouterPlan,
 *   ctx: { anthropicKey?: string, anthropicKeyFromFlag?: boolean, home?: string, routingPreference?: number|string|null },
 *   settingsEnv?: Record<string, string>,
 *   apiKey?: string,
 *   workspaceByokLookup?: import("../config/feature-flags.mjs").FeatureFlagLookupResult|null,
 *   preResolvedAnthropicKey?: string,
 * }} args
 * @returns {Promise<Record<string, string>>}
 */
export async function resolveFirerouterByokHeaders({
  plan,
  catalogFirerouter = false,
  ctx,
  settingsEnv = {},
  apiKey = "",
  workspaceByokLookup = null,
  preResolvedAnthropicKey,
}) {
  if (!plan.isFirerouter && !catalogFirerouter) {
    return {};
  }
  /** @type {Record<string, string>} */
  const headers = {};
  // Attach the Anthropic BYOK key only for Anthropic-requiring selections.
  if (plan.requiresAnthropicKey || catalogFirerouter) {
    const anthropicKey = preResolvedAnthropicKey !== undefined
      ? preResolvedAnthropicKey
      : (await resolveFirerouterByokKeys({
        anthropicFlag: ctx.anthropicKeyFromFlag ? ctx.anthropicKey : "",
        settingsEnv,
        home: ctx.home,
        explicit: true,
        resolveWorkspaceByok: () => (
          workspaceByokLookup === null
            ? resolveWorkspaceByokStatus(apiKey)
            : Promise.resolve(workspaceByokLookup)
        ),
      })).anthropicKey;
    Object.assign(headers, firerouterByokHeaders({ anthropicKey }));
  }
  const preference = normalizeRoutingPreference(ctx.routingPreference);
  if (preference !== null) {
    headers[ROUTING_PREFERENCE_HEADER] = String(preference);
  }
  return headers;
}

/**
 * Env-reference BYOK header for Codex, which forwards the provider key by
 * env-var NAME (`env_http_headers`) rather than value. Returns the Anthropic env
 * ref when the selection needs an Anthropic credential (bare firerouter, or a
 * Claude/Opus member in the slash path); otherwise `{}`. The routing-preference
 * header is handled separately by the value-mode builder. Pure — reads only the plan.
 * @param {FirerouterPlan} plan
 * @returns {Record<string, string>}
 */
export function firerouterByokEnvRefHeaders(plan, { catalogFirerouter = false } = {}) {
  if (!plan.isFirerouter && !catalogFirerouter) {
    return {};
  }
  if (!plan.requiresAnthropicKey && !catalogFirerouter) {
    return {};
  }
  return {
    [ANTHROPIC_BYOK_HEADER]: "ANTHROPIC_API_KEY",
  };
}
