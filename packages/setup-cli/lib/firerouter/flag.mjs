import {
  isFirerouterModelPattern,
  firerouterRequiresAnthropicKey,
} from "../fireworks/model-id.mjs";
import {
  ANTHROPIC_BYOK_HEADER,
  ROUTING_PREFERENCE_HEADER,
  firerouterByokHeaders,
  normalizeRoutingPreference,
  resolveFirerouterByokKeys,
} from "./core.mjs";

export const FIREROUTER_WORKSPACE_BYOK_REQUIRED_MESSAGE =
  "Ask the Fireworks team to enable FireRouter for your account.";

export const FIREROUTER_ENV_BYOK_REQUIRED_MESSAGE =
  "FireRouter needs an Anthropic key in your environment. Export ANTHROPIC_API_KEY, "
  + "or pass --anthropic-api-key with codex on.";

export const FIREROUTER_BYOK_REQUIRED_MESSAGE =
  "FireRouter needs your Anthropic API key. "
  + "Set ANTHROPIC_API_KEY, pass --anthropic-api-key <sk-ant-...>, "
  + "or ask the Fireworks team to enable FireRouter for your account."

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
 * Resolve or prompt for Anthropic credentials when the user explicitly selects
 * FireRouter (`--model firerouter` or a Claude slot). Harnesses that cannot
 * forward a key (`byok: "none"`) throw.
 *
 * @param {{
 *   firerouter?: { byok?: "value"|"envref"|"none" }|null,
 *   ctx?: { anthropicKey?: string, anthropicKeyFromFlag?: boolean, home?: string },
 *   settingsEnv?: Record<string, string>,
 *   allowPromptSkip?: boolean,
 * }} input
 */
export async function resolveExplicitFirerouterCredential({
  firerouter = null,
  ctx = {},
  settingsEnv = {},
  allowPromptSkip = true,
} = {}) {
  if (!firerouter) {
    return { anthropicKey: "" };
  }
  if (firerouter.byok === "none") {
    throw new Error(firerouterCredentialsRequiredMessage(firerouter));
  }
  return resolveFirerouterByokKeys({
    anthropicFlag: ctx.anthropicKeyFromFlag ? ctx.anthropicKey : "",
    settingsEnv,
    home: ctx.home,
    explicit: true,
    allowPromptSkip,
  });
}

/**
 * Whether a harness accepts `--routing-preference` on `on`. Matches the
 * validation in harness.mjs (custom-header BYOK harnesses only).
 * @param {{ byok?: "value"|"envref"|"none" }|null|undefined} firerouter
 * @returns {boolean}
 */
export function supportsRoutingPreference(firerouter) {
  return firerouter?.byok === "value" || firerouter?.routingPreference === true;
}

/**
 * Whether a harness accepts `--anthropic-api-key` on `on`.
 * Value harnesses embed the key in config headers; envref harnesses (Codex)
 * persist it and export ANTHROPIC_API_KEY via the shell hook. Claude Code
 * (`nativeAnthropicKey`) accepts it for native auth even though FireRouter
 * itself needs no BYOK there.
 * @param {{ byok?: "value"|"envref"|"none", nativeAnthropicKey?: boolean }|null|undefined} firerouter
 * @returns {boolean}
 */
export function supportsAnthropicApiKeyFlag(firerouter) {
  return firerouter?.byok === "value"
    || firerouter?.byok === "envref"
    || firerouter?.nativeAnthropicKey === true;
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
 * @param {{
 *   plan: FirerouterPlan,
 *   ctx: { anthropicKey?: string, anthropicKeyFromFlag?: boolean, home?: string, routingPreference?: number|string|null },
 *   settingsEnv?: Record<string, string>,
 *   preResolvedAnthropicKey?: string,
 * }} args
 * @returns {Promise<Record<string, string>>}
 */
export async function resolveFirerouterByokHeaders({
  plan,
  catalogFirerouter = false,
  ctx,
  settingsEnv = {},
  preResolvedAnthropicKey,
}) {
  if (!plan.isFirerouter && !catalogFirerouter) {
    return {};
  }
  /** @type {Record<string, string>} */
  const headers = {};
  // Anthropic BYOK is only needed when the selection routes to an Anthropic
  // model. Pure-Fireworks firerouter paths (e.g. firerouter/kimi-k3 on VS Code,
  // where catalogFirerouter is true) must not prompt for or attach a key.
  if (plan.requiresAnthropicKey) {
    const anthropicKey = preResolvedAnthropicKey !== undefined
      ? preResolvedAnthropicKey
      : (await resolveFirerouterByokKeys({
        anthropicFlag: ctx.anthropicKeyFromFlag ? ctx.anthropicKey : "",
        settingsEnv,
        home: ctx.home,
        explicit: true,
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
  // Pure-Fireworks firerouter paths need no Anthropic key, even when the
  // catalog entry is registered (catalogFirerouter).
  if (!plan.requiresAnthropicKey) {
    return {};
  }
  return {
    [ANTHROPIC_BYOK_HEADER]: "ANTHROPIC_API_KEY",
  };
}
