import {
  isFirerouterModel,
  isFirerouterModelPattern,
  firerouterNamesAnthropicModel,
  firerouterRequiresAnthropicKey,
  firerouterRequiresOpenaiKey,
} from "../fireworks/model-id.mjs";
import {
  ANTHROPIC_BYOK_HEADER,
  OPENAI_BYOK_HEADER,
  ROUTING_PREFERENCE_HEADER,
  firerouterByokHeaders,
  normalizeRoutingPreference,
  resolveAnthropicKey,
  resolveFirerouterByokKeys,
  resolveOpenaiKey,
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
 * FireRouter (`--model firerouter` or a Claude slot). Never throws for
 * harnesses that cannot forward a key (`byok: "none"`): the key is resolved
 * best-effort (flag/global/env/settings, no prompt) and the `on` proceeds
 * without BYOK headers, so FireRouter keeps routing the Fireworks mix instead
 * of failing the connect.
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
    // No forwarding path on this harness: resolve best-effort (flag, stored
    // global, env, settings) with no prompt, then proceed without BYOK headers.
    return {
      anthropicKey: await resolveAnthropicKey({
        apiKey: ctx.anthropicKeyFromFlag ? ctx.anthropicKey : "",
        settingsEnv,
        home: ctx.home,
      }),
    };
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
 * Whether a harness accepts `--openai-api-key` on `on`. Mirrors the Anthropic
 * flag: value harnesses embed the key in config headers, envref harnesses
 * (Codex) persist it and export OPENAI_API_KEY via the shell hook, and Claude
 * Code carries it in ANTHROPIC_CUSTOM_HEADERS next to the Fireworks key.
 * @param {{ byok?: "value"|"envref"|"none", nativeAnthropicKey?: boolean }|null|undefined} firerouter
 * @returns {boolean}
 */
export function supportsOpenaiApiKeyFlag(firerouter) {
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
 *   Whether the selection uses an Anthropic credential (bare firerouter or a
 *   Claude/Opus model in the path). Pure-Fireworks selections need none.
 * @property {boolean} requiresOpenaiKey
 *   Whether the selection routes to an OpenAI model in the path
 *   (firerouter/gpt-...). Bare firerouter needs none; a configured OpenAI key
 *   still rides along opportunistically.
 * @property {boolean} namesAnthropicModel
 *   Whether the path names a Claude/Opus model. Harnesses that cannot forward
 *   an Anthropic key refuse only these; bare firerouter falls back to a GPT model
 *   or open models without one.
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
    return {
      mainModel: "",
      isFirerouter: false,
      requiresAnthropicKey: false,
      requiresOpenaiKey: false,
      namesAnthropicModel: false,
    };
  }
  assertFirerouterKeyType(requested, keyType);
  return {
    mainModel: requested,
    isFirerouter: isFirerouterModelPattern(requested),
    requiresAnthropicKey: firerouterRequiresAnthropicKey(requested),
    requiresOpenaiKey: firerouterRequiresOpenaiKey(requested),
    namesAnthropicModel: firerouterNamesAnthropicModel(requested),
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
 * VS Code). Resolves at most one key per provider family (Anthropic, OpenAI)
 * from flag/env/settings — prompting once for an Anthropic key when the
 * selection needs one and none is available — then maps present keys to the
 * wire headers. A key rides along only where the selection can route to its
 * provider: Anthropic on Anthropic-requiring selections (`firerouter`,
 * `firerouter/opus`), OpenAI on bare `firerouter` or GPT-member selections
 * (`firerouter/gpt-...`). A missing key stays absent instead of failing the
 * `on`. Returns `{}` when the plan isn't routing through FireRouter.
 * `settingsEnv` surfaces keys a harness already stores.
 *
 * Also carries the `x-routing-preference` header when `ctx.routingPreference`
 * is set, so `--routing-preference` keeps tuning FireRouter under the model path.
 *
 * @param {{
 *   plan: FirerouterPlan,
 *   ctx: { anthropicKey?: string, anthropicKeyFromFlag?: boolean, openaiKey?: string, openaiKeyFromFlag?: boolean, home?: string, routingPreference?: number|string|null },
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
  // Anthropic BYOK is only attached when the selection routes to an Anthropic
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
  // OpenAI keys are never prompted for and never required: attach when
  // configured and routable (bare firerouter, whose mix can serve GPT
  // primaries, or a GPT member in the path). Pinned non-GPT compounds stay
  // clean even with a key configured.
  if (plan.requiresOpenaiKey || isFirerouterModel(plan.mainModel)) {
    const openaiKey = await resolveOpenaiKey({
      apiKey: ctx.openaiKeyFromFlag ? ctx.openaiKey : "",
      settingsEnv,
      home: ctx.home,
    });
    Object.assign(headers, firerouterByokHeaders({ openaiKey }));
  }
  const preference = normalizeRoutingPreference(ctx.routingPreference);
  if (preference !== null) {
    headers[ROUTING_PREFERENCE_HEADER] = String(preference);
  }
  return headers;
}

/**
 * Env-reference BYOK headers for Codex, which forwards provider keys by
 * env-var NAME (`env_http_headers`) rather than value. Each env ref is
 * attached only when the selection needs it AND a key is actually behind it
 * (`anthropicKey` on Anthropic-requiring selections, `openaiKey` on bare
 * firerouter or a GPT member) — a ref with no key behind it would send an
 * empty header upstream, so it stays absent. Otherwise `{}`. Pure — reads
 * only the plan plus the resolved keys.
 * @param {FirerouterPlan} plan
 * @returns {Record<string, string>}
 */
export function firerouterByokEnvRefHeaders(
  plan,
  { catalogFirerouter = false, anthropicKey = "", openaiKey = "" } = {},
) {
  if (!plan.isFirerouter && !catalogFirerouter) {
    return {};
  }
  /** @type {Record<string, string>} */
  const headers = {};
  // Pure-Fireworks firerouter paths need no Anthropic key, even when the
  // catalog entry is registered (catalogFirerouter).
  if (plan.requiresAnthropicKey && anthropicKey?.trim()) {
    headers[ANTHROPIC_BYOK_HEADER] = "ANTHROPIC_API_KEY";
  }
  if (openaiKey?.trim() && (plan.requiresOpenaiKey || isFirerouterModel(plan.mainModel))) {
    headers[OPENAI_BYOK_HEADER] = "OPENAI_API_KEY";
  }
  return headers;
}
