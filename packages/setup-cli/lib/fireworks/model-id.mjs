import {
  FIREWORKS_MODEL_SPECS,
  ROUTER_SPEC_ALIASES,
  isFirerouterGatewayPattern,
  isRouterShortId,
} from "./model-specs.mjs";

export { isFirerouterGatewayPattern };

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference";
export const FIREROUTER_MODEL_ID = "firerouter";
// Reserved slot value meaning "don't pin this Claude Code slot — let it fall back
// to Claude's own (Anthropic) default model." The Fireworks gateway serves
// Anthropic models even though they aren't in the serverless catalog, so the
// writer translates this sentinel into "omit the pin" rather than a model id.
export const CLAUDE_NATIVE_MODEL_ID = "claude-default";
/** User-facing label for an unpinned Claude Code slot (native Anthropic default). */
export const CLAUDE_NATIVE_SLOT_LABEL = "Claude default";
/** CLI slot value meaning "use Claude's native Anthropic default for this slot". */
export const CLAUDE_NATIVE_SLOT_ALIAS = "native";
export const FIREROUTER_ROUTER_ID =
  "accounts/fireworks/routers/firerouter";
export const GLM_LATEST_ROUTER_ID =
  "accounts/fireworks/routers/glm-latest";
export const GLM_FAST_LATEST_ROUTER_ID =
  "accounts/fireworks/routers/glm-fast-latest";
export const KIMI_FAST_LATEST_ROUTER_ID =
  "accounts/fireworks/routers/kimi-fast-latest";
export const DEEPSEEK_FLASH_LATEST_ROUTER_ID =
  "accounts/fireworks/routers/deepseek-flash-latest";
export const DEEPSEEK_PRO_LATEST_ROUTER_ID =
  "accounts/fireworks/routers/deepseek-pro-latest";
export const DEFAULT_MAIN_MODEL = "kimi-fast-latest";
export const DEFAULT_FIREPASS_MAIN_MODEL = DEFAULT_MAIN_MODEL;

export function resolveDefaultMainModel() {
  return DEFAULT_MAIN_MODEL;
}

const FIREWORKS_ROUTER_SHORT_IDS = new Set([
  ...Object.keys(ROUTER_SPEC_ALIASES),
  "glm-latest",
  "glm-fast-latest",
  "glm-5p1-fast",
  "glm-5p2-fast",
  "kimi-fast-latest",
  "kimi-k2p6-fast",
  "kimi-k2p6-turbo",
  "kimi-latest",
  "firerouter",
]);

const KNOWN_FIREWORKS_SHORT_IDS = new Set([
  ...FIREWORKS_ROUTER_SHORT_IDS,
  ...Object.keys(FIREWORKS_MODEL_SPECS),
  ...Object.keys(ROUTER_SPEC_ALIASES),
]);
const PUBLIC_FIREWORKS_MODEL_REF_RE =
  /^accounts\/fireworks\/(?:models|routers)\/([^/]+?)(\[1m\])?$/i;

function stripContextSuffix(model) {
  return typeof model === "string"
    ? model.replace(/\[1m\]$/i, "")
    : model;
}

/**
 * Convert a public Fireworks model/router resource name to the short reference
 * accepted by the inference gateway. Existing short and non-public refs are
 * returned unchanged, and a Claude Code [1m] suffix is preserved.
 */
export function shortFireworksModelRef(model) {
  if (typeof model !== "string") {
    return model;
  }
  const match = model.match(PUBLIC_FIREWORKS_MODEL_REF_RE);
  return match ? `${match[1]}${match[2] ?? ""}` : model;
}

/** Return the suffix-free final slug from a Fireworks model reference. */
export function fireworksModelSlug(model) {
  const shortRef = shortFireworksModelRef(model);
  if (typeof shortRef !== "string") {
    return "";
  }
  const bare = stripContextSuffix(shortRef);
  return bare.split("/").at(-1) ?? bare;
}

export function isFirerouterModel(model) {
  if (typeof model !== "string") {
    return false;
  }
  const bare = stripContextSuffix(model.trim()).split("/").at(-1) ?? "";
  return bare.toLowerCase() === FIREROUTER_MODEL_ID;
}

/**
 * Whether a model reference is a real Anthropic model id (e.g. claude-sonnet-4-5).
 * Anthropic models are served on the Fireworks gateway even though they don't
 * appear in the public serverless catalog, so they're exempt from catalog
 * validation and treated as vision-capable. Bare "claude" is NOT matched — it
 * normalizes to {@link CLAUDE_NATIVE_MODEL_ID} instead.
 * @param {string} model
 * @returns {boolean}
 */
export function isAnthropicModelId(model) {
  if (typeof model !== "string") {
    return false;
  }
  const bare = stripContextSuffix(model.trim());
  if (bare === CLAUDE_NATIVE_MODEL_ID) {
    return false;
  }
  return /^claude-[a-z0-9.-]+(\[1m\])?$/i.test(bare);
}

/** Whether a user-supplied slot value is the native-default alias (`native`). */
export function isClaudeNativeSlotAlias(model) {
  if (typeof model !== "string") {
    return false;
  }
  return model.trim().toLowerCase() === CLAUDE_NATIVE_SLOT_ALIAS;
}

/** Whether a model reference is the reserved native-Claude slot value. */
export function isClaudeNativeModel(model) {
  if (typeof model !== "string") {
    return false;
  }
  return stripContextSuffix(model.trim()) === CLAUDE_NATIVE_MODEL_ID;
}

/** Native sentinel or concrete Anthropic id — served on the gateway, not the catalog. */
export function isGatewayAnthropicSlot(model) {
  return isClaudeNativeModel(model) || isAnthropicModelId(model);
}

/** Human label for a slot model id; native slots read as {@link CLAUDE_NATIVE_SLOT_LABEL}. */
export function formatClaudeSlotModelLabel(modelId) {
  return isClaudeNativeModel(modelId) ? CLAUDE_NATIVE_SLOT_LABEL : modelId;
}

/**
 * Expand a short gateway slug to a full accounts/fireworks resource id for
 * catalog/spec lookups. Stored harness config keeps short slugs as-is.
 * @param {string} model
 * @returns {string}
 */
export function fullFireworksResourceId(model) {
  const bare = stripContextSuffix(String(model ?? "").trim());
  if (!bare) {
    return bare;
  }
  if (bare.startsWith("accounts/fireworks/")) {
    return bare;
  }
  if (bare.includes("/")) {
    return bare;
  }
  if (isFirerouterModel(bare)) {
    return FIREROUTER_ROUTER_ID;
  }
  // Classify routers by the same suffix/alias heuristic spec lookups use
  // (`isRouterShortId`), not a hand-maintained list. A stale list would expand a
  // real router slug (e.g. kimi-k3-fast) to a non-existent models/ path, which
  // then fails to match its catalog row and yields duplicate Pi model entries.
  const kind = isRouterShortId(bare) ? "routers" : "models";
  return `accounts/fireworks/${kind}/${bare}`;
}

/**
 * Normalize a user-supplied model id to the short slug Fireworks accepts.
 * Full accounts/fireworks/... refs are shortened; bare slugs pass through.
 * @param {string} model
 * @returns {string}
 */
export function normalizeModelId(model) {
  if (typeof model !== "string") {
    return model;
  }
  const bare = stripContextSuffix(model.trim());
  if (!bare) {
    return bare;
  }
  if (isFirerouterModel(bare)) {
    return FIREROUTER_MODEL_ID;
  }
  if (isClaudeNativeSlotAlias(bare)) {
    return CLAUDE_NATIVE_MODEL_ID;
  }
  if (bare.startsWith("accounts/fireworks/")) {
    return shortFireworksModelRef(bare);
  }
  if (bare.includes("/")) {
    return bare;
  }
  return bare;
}

export function validateModelId(model, flag) {
  if (!model.startsWith("accounts/") && model.includes("/") && !isFirerouterGatewayPattern(model)) {
    throw new Error(
      `${flag} must be a Fireworks model ID like deepseek-v4-flash or a router ID like glm-latest`,
    );
  }
}

export function isFireworksModelId(model) {
  if (typeof model !== "string") {
    return false;
  }
  const ref = model.trim();
  return ref.startsWith("accounts/fireworks/")
    || KNOWN_FIREWORKS_SHORT_IDS.has(fireworksModelSlug(ref));
}

export function defaultMainModel(keyType = "fireworks") {
  return keyType === "firepass"
    ? DEFAULT_FIREPASS_MAIN_MODEL
    : resolveDefaultMainModel();
}
