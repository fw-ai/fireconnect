import {
  lookupCachedContextLength,
  lookupCachedInputModalities,
  lookupCachedRouterBaseModel,
  lookupCachedServerlessPricing,
  lookupCachedSupportsTools,
  lookupCatalogEntryById,
} from "./serverless-catalog-cache.mjs";

/** @see https://docs.fireworks.ai/serverless/pricing */
export const FIREWORKS_PRICING_DOCS_URL = "https://docs.fireworks.ai/serverless/pricing";

/** Standard serverless model metadata keyed by short ID. Limits align with models.dev / pi-mono. */
export const FIREWORKS_MODEL_SPECS = {
  "deepseek-v4-pro": {
    label: "DeepSeek V4 Pro",
    pricing: { input: 1.32, cachedInput: 0.044, output: 3.96 },
    capabilities: { contextWindow: 1_000_000, maxOutputTokens: 384_000, vision: false, toolCalling: true },
  },
  "deepseek-v4-pro-0813": {
    label: "DeepSeek V4 Pro (0813)",
    pricing: { input: 1.32, cachedInput: 0.044, output: 3.96 },
    capabilities: { contextWindow: 1_000_000, maxOutputTokens: 384_000, vision: false, toolCalling: true },
  },
  "deepseek-v4-flash": {
    label: "DeepSeek V4 Flash",
    pricing: { input: 0.22, cachedInput: 0.007, output: 0.66 },
    capabilities: { contextWindow: 1_000_000, maxOutputTokens: 384_000, vision: false, toolCalling: true },
  },
  "deepseek-v4-flash-0731": {
    label: "DeepSeek V4 Flash (0731)",
    pricing: { input: 0.22, cachedInput: 0.007, output: 0.66 },
    capabilities: { contextWindow: 1_000_000, maxOutputTokens: 384_000, vision: false, toolCalling: true },
  },
  "glm-5p3": {
    label: "GLM 5.3",
    pricing: { input: 1.40, cachedInput: 0.26, output: 4.40 },
    capabilities: { contextWindow: 1_048_576, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "glm-5p3-flash": {
    label: "GLM 5.3 Flash",
    pricing: { input: 0.15, cachedInput: 0.03, output: 0.50 },
    capabilities: { contextWindow: 1_048_576, maxOutputTokens: 131_072, vision: true, toolCalling: true },
    api: { contextLength: 1_048_576, supportsImageInput: true },
  },
  "glm-5p3-flash-us": {
    label: "GLM 5.3 Flash (US)",
    pricing: { input: 0.225, cachedInput: 0.045, output: 0.75 },
    capabilities: { contextWindow: 1_048_576, maxOutputTokens: 131_072, vision: true, toolCalling: true },
    api: { contextLength: 1_048_576, supportsImageInput: true },
  },
  "glm-5p2": {
    label: "GLM 5.2",
    pricing: { input: 1.40, cachedInput: 0.14, output: 4.40 },
    capabilities: { contextWindow: 1_048_575, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "glm-5p1": {
    label: "GLM 5.1",
    pricing: { input: 1.40, cachedInput: 0.26, output: 4.40 },
    capabilities: { contextWindow: 202_800, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "glm-5p1-fast": {
    label: "GLM 5.1 Fast",
    pricing: { input: 2.80, cachedInput: 0.52, output: 8.80, tier: "fast" },
    capabilities: { contextWindow: 202_800, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "glm-5p2-fast": {
    label: "GLM 5.2 Fast",
    pricing: { input: 2.10, cachedInput: 0.21, output: 6.60, tier: "fast" },
    capabilities: { contextWindow: 1_048_575, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "glm-5p2-fast-us": {
    label: "GLM 5.2 Fast (US)",
    pricing: { input: 2.10, cachedInput: 0.21, output: 6.60, tier: "fast" },
    capabilities: { contextWindow: 1_048_575, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "kimi-k3": {
    label: "Kimi K3",
    pricing: { input: 3.00, cachedInput: 0.30, output: 15.00 },
    capabilities: { contextWindow: 1_040_000, maxOutputTokens: 131_072, vision: true, toolCalling: true },
  },
  "kimi-k3-us": {
    label: "Kimi K3 (US)",
    pricing: { input: 3.30, cachedInput: 0.33, output: 16.50 },
    capabilities: { contextWindow: 1_040_000, maxOutputTokens: 131_072, vision: true, toolCalling: true },
  },
  "kimi-k3-fast": {
    label: "Kimi K3 Fast",
    pricing: { input: 4.50, cachedInput: 0.45, output: 22.50, tier: "fast" },
    capabilities: { contextWindow: 1_040_000, maxOutputTokens: 131_072, vision: true, toolCalling: true },
  },
  "kimi-k2p7-code": {
    label: "Kimi K2.7 Code",
    pricing: { input: 0.95, cachedInput: 0.19, output: 4.00 },
    capabilities: { contextWindow: 262_000, maxOutputTokens: 262_000, vision: true, toolCalling: true },
  },
  "kimi-k2p6": {
    label: "Kimi K2.6",
    pricing: { input: 0.95, cachedInput: 0.16, output: 4.00 },
    capabilities: { contextWindow: 262_000, maxOutputTokens: 262_000, vision: true, toolCalling: true },
  },
  "kimi-k2p6-fast": {
    label: "Kimi K2.6 Fast",
    pricing: { input: 2.00, cachedInput: 0.30, output: 8.00, tier: "fast" },
    capabilities: { contextWindow: 262_000, maxOutputTokens: 262_000, vision: true, toolCalling: true },
  },
  "kimi-k2p6-turbo": {
    label: "Kimi K2.6 Turbo",
    pricing: { input: 2.00, cachedInput: 0.30, output: 8.00, tier: "fast" },
    capabilities: { contextWindow: 262_000, maxOutputTokens: 262_000, vision: true, toolCalling: true },
  },
  "kimi-k2p5": {
    label: "Kimi K2.5",
    pricing: { input: 0.60, cachedInput: 0.10, output: 3.00 },
    capabilities: { contextWindow: 262_144, maxOutputTokens: 32_768, vision: true, toolCalling: true },
  },
  "minimax-m2p5": {
    label: "MiniMax 2.5",
    pricing: { input: 0.30, cachedInput: 0.03, output: 1.20 },
    capabilities: { contextWindow: 196_608, maxOutputTokens: 24_576, vision: false, toolCalling: true },
  },
  "minimax-m2p7": {
    label: "MiniMax 2.7",
    pricing: { input: 0.30, cachedInput: 0.06, output: 1.20 },
    capabilities: { contextWindow: 196_608, maxOutputTokens: 196_608, vision: false, toolCalling: true },
  },
  "minimax-m3": {
    label: "MiniMax M3",
    pricing: { input: 0.30, cachedInput: 0.06, output: 1.20 },
    capabilities: { contextWindow: 512_000, maxOutputTokens: 512_000, vision: true, toolCalling: true },
  },
  "qwen3p7-plus": {
    label: "Qwen 3.7 Plus",
    pricing: { input: 0.40, cachedInput: 0.08, output: 1.60 },
    capabilities: { contextWindow: 262_144, maxOutputTokens: 65_536, vision: true, toolCalling: true },
    api: { contextLength: 262_144, supportsImageInput: true },
  },
  "qwen3p6-plus": {
    label: "Qwen 3.6 Plus",
    pricing: { input: 0.50, cachedInput: 0.10, output: 3.00 },
    capabilities: { contextWindow: 262_144, maxOutputTokens: 32_768, vision: true, toolCalling: true },
  },
  "gpt-oss-120b": {
    label: "GPT-OSS 120B",
    pricing: { input: 0.15, cachedInput: 0.015, output: 0.60 },
    capabilities: { contextWindow: 131_072, maxOutputTokens: 32_768, vision: false, toolCalling: true },
  },
  "gpt-oss-20b": {
    label: "GPT-OSS 20B",
    pricing: { input: 0.07, cachedInput: 0.035, output: 0.30 },
    capabilities: { contextWindow: 131_072, maxOutputTokens: 32_768, vision: false, toolCalling: false },
  },
  inkling: {
    label: "Inkling",
    pricing: { input: 1.00, cachedInput: 0.17, output: 4.05 },
    capabilities: { contextWindow: 1_048_576, maxOutputTokens: 131_072, vision: true, toolCalling: true },
    api: { contextLength: 1_048_576, supportsImageInput: true },
    modelsDev: false,
  },
  "nemotron-3-ultra-nvfp4": {
    label: "NVIDIA Nemotron 3 Ultra NVFP4",
    capabilities: { contextWindow: 262_144, maxOutputTokens: 32_768, vision: false, toolCalling: true },
  },
  firerouter: {
    label: "FireRouter",
    capabilities: {
      contextWindow: 1_048_575,
      maxOutputTokens: 131_072,
      vision: true,
      toolCalling: true,
    },
  },
  auto: {
    label: "Auto",
    capabilities: {
      contextWindow: 1_048_575,
      maxOutputTokens: 131_072,
      vision: true,
      toolCalling: true,
    },
  },
};

/**
 * Bare gateway slug for the default auto mix. Variants (`auto-instant`) share
 * the same no-resource-path rule: the gateway serves them under the slug, not
 * `accounts/fireworks/...`.
 */
export const AUTO_MODEL_ID = "auto";

/** Latency-first auto mix (`--model auto-instant`). */
export const AUTO_INSTANT_MODEL_ID = "auto-instant";

/**
 * Auto mixes to synthesize in `model list`. Acceptance is wider ({@link
 * canonicalAutoModelId} matches any `auto-*`); this list only controls which
 * names get a discoverable row when the serverless API omits them.
 */
export const KNOWN_AUTO_MODEL_IDS = [AUTO_MODEL_ID, AUTO_INSTANT_MODEL_ID];

/** Cursor's built-in picker — not a Fireworks auto mix. */
const NON_GATEWAY_AUTO_IDS = new Set(["auto-smart"]);

/**
 * Canonical short slug for an auto mix (`auto`, `auto-instant`). Empty when
 * the ref is not an auto mix.
 *
 * Matched on the whole ref, never per path segment: a slash means the ref names
 * something else that merely contains an auto-shaped part (a custom
 * `accounts/auto-corp/...` resource, a `firerouter/auto-instant` selection), and
 * collapsing it to a bare mix slug would send the gateway the wrong model.
 * @param {string} model
 * @returns {string}
 */
export function canonicalAutoModelId(model) {
  if (typeof model !== "string") {
    return "";
  }
  const slug = model.replace(/\[1m\]$/i, "").trim().toLowerCase();
  if (!slug || slug.includes("/") || NON_GATEWAY_AUTO_IDS.has(slug)) {
    return "";
  }
  return slug === AUTO_MODEL_ID || slug.startsWith(`${AUTO_MODEL_ID}-`) ? slug : "";
}

/**
 * Whether a model reference is the `auto` mix or an `auto-*` variant
 * (`auto-instant`). Unrelated to `firerouter*`: these route open models only
 * and never need an Anthropic credential. Cursor-native `auto-smart` is not
 * matched.
 * @param {string} model
 * @returns {boolean}
 */
export function isAutoModelId(model) {
  return canonicalAutoModelId(model) !== "";
}

/** True when any path segment matches the `firerouter*` prefix. */
export function isFirerouterModelPattern(model) {
  if (typeof model !== "string") {
    return false;
  }
  return model.replace(/\[1m\]$/i, "")
    .trim()
    .toLowerCase()
    .split("/")
    .some((part) => part.startsWith("firerouter"));
}

export const ROUTER_SPEC_ALIASES = {
  "deepseek-flash-latest": "deepseek-v4-flash-0731",
  "deepseek-pro-latest": "deepseek-v4-pro-0813",
  "glm-latest": "glm-5p3",
  "glm-fast-latest": "glm-5p2-fast",
  "glm-flash-latest": "glm-5p3-flash",
  "glm-5p2-fast-us": "glm-5p2",
  "glm-5p3-flash-us": "glm-5p3-flash",
  "kimi-latest": "kimi-k3",
  "kimi-fast-latest": "kimi-k3-fast",
  "kimi-k3-us": "kimi-k3",
  "minimax-latest": "minimax-m3",
  "qwen-plus-latest": "qwen3p7-plus",
};

const GLM_LATEST_BASE_CANDIDATES = ["glm-5p3", "glm-5p2"];
const GLM_FAST_LATEST_BASE_CANDIDATES = ["glm-5p3-fast", "glm-5p2-fast"];
const GLM_FLASH_LATEST_BASE_CANDIDATES = ["glm-5p3-flash"];
const DEEPSEEK_FLASH_LATEST_BASE_CANDIDATES = ["deepseek-v4-flash-0731", "deepseek-v4-flash"];
const DEEPSEEK_PRO_LATEST_BASE_CANDIDATES = ["deepseek-v4-pro-0813", "deepseek-v4-pro"];
const KIMI_LATEST_BASE_CANDIDATES = ["kimi-k3", "kimi-k2p8-code", "kimi-k2p7-code"];
const MINIMAX_LATEST_BASE_CANDIDATES = ["minimax-m3", "minimax-m2p7", "minimax-m2p5"];
const QWEN_PLUS_LATEST_BASE_CANDIDATES = ["qwen3p7-plus", "qwen3p6-plus"];

function resolveFirstCatalogCandidate(catalogCheck, candidates) {
  for (const slug of candidates) {
    if (catalogCheck(slug)) {
      return slug;
    }
  }
  return null;
}

function makeCatalogModelChecker(entryIds = null, { includeRouters = false } = {}) {
  if (entryIds) {
    return (slug) => entryIds.has(`accounts/fireworks/models/${slug}`)
      || (includeRouters && entryIds.has(`accounts/fireworks/routers/${slug}`));
  }
  return (slug) => Boolean(
    lookupCatalogEntryById(`accounts/fireworks/models/${slug}`)
    || (includeRouters && lookupCatalogEntryById(`accounts/fireworks/routers/${slug}`)),
  );
}

function resolveKimiLatestBaseSlug(catalogCheck) {
  return resolveFirstCatalogCandidate(catalogCheck, KIMI_LATEST_BASE_CANDIDATES);
}

/**
 * Resolve the target slug for a `-latest` router alias, preferring live catalog
 * models over static offline fallbacks.
 * @param {string} alias
 * @param {Set<string>} [entryIds] Optional catalog entry ids while building a snapshot.
 * @returns {string | null}
 */
export function resolveRouterSpecAliasTarget(alias, entryIds = null) {
  const catalogCheck = makeCatalogModelChecker(entryIds);
  if (alias === "kimi-latest") {
    return resolveKimiLatestBaseSlug(catalogCheck) ?? ROUTER_SPEC_ALIASES[alias] ?? null;
  }
  if (alias === "kimi-fast-latest") {
    if (makeCatalogModelChecker(entryIds, { includeRouters: true })("kimi-k3-fast")) {
      return "kimi-k3-fast";
    }
    const base = resolveKimiLatestBaseSlug(catalogCheck);
    if (base) {
      return fastSpecSlugForBase(base, alias);
    }
    return ROUTER_SPEC_ALIASES[alias] ?? null;
  }
  if (alias === "glm-latest") {
    return resolveFirstCatalogCandidate(catalogCheck, GLM_LATEST_BASE_CANDIDATES)
      ?? ROUTER_SPEC_ALIASES[alias]
      ?? null;
  }
  if (alias === "glm-fast-latest") {
    return resolveFirstCatalogCandidate(
      makeCatalogModelChecker(entryIds, { includeRouters: true }),
      GLM_FAST_LATEST_BASE_CANDIDATES,
    )
      ?? ROUTER_SPEC_ALIASES[alias]
      ?? null;
  }
  if (alias === "glm-flash-latest") {
    return resolveFirstCatalogCandidate(catalogCheck, GLM_FLASH_LATEST_BASE_CANDIDATES)
      ?? ROUTER_SPEC_ALIASES[alias]
      ?? null;
  }
  if (alias === "minimax-latest") {
    return resolveFirstCatalogCandidate(catalogCheck, MINIMAX_LATEST_BASE_CANDIDATES)
      ?? ROUTER_SPEC_ALIASES[alias]
      ?? null;
  }
  if (alias === "qwen-plus-latest") {
    return resolveFirstCatalogCandidate(catalogCheck, QWEN_PLUS_LATEST_BASE_CANDIDATES)
      ?? ROUTER_SPEC_ALIASES[alias]
      ?? null;
  }
  if (alias === "deepseek-flash-latest") {
    return resolveFirstCatalogCandidate(catalogCheck, DEEPSEEK_FLASH_LATEST_BASE_CANDIDATES)
      ?? ROUTER_SPEC_ALIASES[alias]
      ?? null;
  }
  if (alias === "deepseek-pro-latest") {
    return resolveFirstCatalogCandidate(catalogCheck, DEEPSEEK_PRO_LATEST_BASE_CANDIDATES)
      ?? ROUTER_SPEC_ALIASES[alias]
      ?? null;
  }
  return ROUTER_SPEC_ALIASES[alias] ?? null;
}

/** Router IDs that share pricing/base-model metadata for a target slug. */
export function routerIdsForTargetSlug(targetSlug) {
  const ids = [`accounts/fireworks/routers/${targetSlug}`];
  for (const alias of Object.keys(ROUTER_SPEC_ALIASES)) {
    if (resolveRouterSpecAliasTarget(alias) === targetSlug) {
      ids.push(`accounts/fireworks/routers/${alias}`);
    }
  }
  return [...new Set(ids)];
}

export const DEFAULT_MODEL_CAPABILITIES = {
  vision: false,
  toolCalling: true,
};

export function specShortIdFromModelRef(modelRef) {
  if (!modelRef) {
    return "";
  }
  const stripped = modelRef.replace(/\[1m\]$/i, "");
  return stripped.split("/").at(-1) ?? stripped;
}

/** @param {string} modelRef */
export function routerCatalogIdCandidates(modelRef) {
  const stripped = String(modelRef ?? "").replace(/\[1m\]$/i, "");
  const shortId = specShortIdFromModelRef(modelRef);
  /** @type {string[]} */
  const candidates = [];
  if (stripped.includes("/routers/")) {
    candidates.push(stripped);
  }
  if (shortId) {
    candidates.push(`accounts/fireworks/routers/${shortId}`);
  }
  return [...new Set(candidates)];
}

/** Live base model for a router alias from the warmed serverless catalog, if known. */
export function resolveLiveRouterBaseModelId(modelRef) {
  for (const routerId of routerCatalogIdCandidates(modelRef)) {
    const baseModelId = lookupCachedRouterBaseModel(routerId);
    if (baseModelId) {
      return baseModelId;
    }
  }
  return null;
}

function stripViaFireworksSuffix(label) {
  return String(label).replace(/ via Fireworks$/i, "");
}

function appendFastTierLabel(label) {
  const trimmed = stripViaFireworksSuffix(label);
  return / fast$/i.test(trimmed) ? trimmed : `${trimmed} Fast`;
}

/** True when the ref is a stable `-latest` router alias (incl. `-fast-latest`). */
export function isLatestRouterAlias(modelRef) {
  return specShortIdFromModelRef(modelRef).endsWith("-latest");
}

export function appendLatestRouterSuffix(modelRef, label) {
  if (!isLatestRouterAlias(modelRef)) {
    return label;
  }
  const trimmed = String(label).trim();
  return / \(Latest\)$/i.test(trimmed) ? trimmed : `${trimmed} (Latest)`;
}

/**
 * Human-readable label for a router entry from its resolved base model name.
 * Used while building the catalog before the serverless cache is active.
 * @param {string} routerId
 * @param {string} baseDisplayName
 * @param {{ pricingTier?: string }} [options]
 * @returns {string}
 */
export function resolveRouterEntryDisplayName(routerId, baseDisplayName, { pricingTier } = {}) {
  const shortId = specShortIdFromModelRef(routerId);
  const label = stripViaFireworksSuffix(baseDisplayName);
  if (shortId.endsWith("-turbo")) {
    return appendLatestRouterSuffix(routerId, label);
  }
  const needsFastTier = shortId.endsWith("-fast-latest")
    || shortId.endsWith("-fast")
    || pricingTier === "fast";
  const withTier = needsFastTier ? appendFastTierLabel(label) : label;
  return appendLatestRouterSuffix(routerId, withTier);
}

function fastSpecSlugForBase(baseSlug, routerShortId) {
  if (FIREWORKS_MODEL_SPECS[routerShortId]) {
    return routerShortId;
  }
  if (!routerShortId.endsWith("-fast-latest") && !routerShortId.endsWith("-fast")) {
    return baseSlug;
  }
  return baseSlug.endsWith("-fast") ? baseSlug : `${baseSlug}-fast`;
}

export function resolveSpecSlug(modelRef) {
  const shortId = specShortIdFromModelRef(modelRef);
  if (FIREWORKS_MODEL_SPECS[shortId]) {
    return shortId;
  }
  const folded = String(shortId).toLowerCase().replace(/(\d)\.(\d)/g, "$1p$2");
  if (folded !== shortId && FIREWORKS_MODEL_SPECS[folded]) {
    return folded;
  }
  const baseModelId = resolveLiveRouterBaseModelId(modelRef);
  if (baseModelId) {
    return fastSpecSlugForBase(specShortIdFromModelRef(baseModelId), shortId);
  }
  const aliasTarget = resolveRouterSpecAliasTarget(shortId);
  if (aliasTarget) {
    return fastSpecSlugForBase(aliasTarget, shortId);
  }
  return shortId;
}

/** True when a model ref resolves through Fireworks specs, router aliases, or catalog. */
export function isFireworksRoutedModelRef(modelRef) {
  if (typeof modelRef !== "string" || !modelRef.trim()) {
    return false;
  }
  const ref = modelRef.trim();
  if (ref.startsWith("accounts/fireworks/")) {
    return true;
  }
  const shortId = specShortIdFromModelRef(ref);
  if (isFirerouterModelPattern(ref) || isAutoModelId(ref)) {
    return true;
  }
  if (ROUTER_SPEC_ALIASES[shortId]) {
    return true;
  }
  return Boolean(lookupModelSpec(ref) || resolveLiveRouterBaseModelId(ref));
}

/**
 * Human-readable label from the live catalog base model when available.
 * @param {string} modelRef
 * @returns {string | null}
 */
export function resolveFireworksModelLabel(modelRef) {
  const shortId = specShortIdFromModelRef(modelRef);
  const routerSpec = FIREWORKS_MODEL_SPECS[shortId];
  if ((shortId.endsWith("-turbo") || shortId.endsWith("-us")) && routerSpec?.label) {
    return routerSpec.label;
  }
  const baseModelId = resolveLiveRouterBaseModelId(modelRef);
  if (!baseModelId) {
    const aliasTarget = resolveRouterSpecAliasTarget(shortId);
    if (!aliasTarget) {
      return null;
    }
    const aliasSpec = FIREWORKS_MODEL_SPECS[aliasTarget];
    if (!aliasSpec?.label) {
      return null;
    }
    return resolveRouterEntryDisplayName(
      routerCatalogIdCandidates(modelRef)[0] ?? `accounts/fireworks/routers/${shortId}`,
      aliasSpec.label,
    );
  }

  const baseEntry = lookupCatalogEntryById(baseModelId);
  const label = baseEntry?.displayName
    ?? FIREWORKS_MODEL_SPECS[specShortIdFromModelRef(baseModelId)]?.label
    ?? null;
  if (!label) {
    return null;
  }

  const routerPricing = routerCatalogIdCandidates(modelRef)
    .map((routerId) => lookupCachedServerlessPricing(routerId))
    .find(Boolean);
  return resolveRouterEntryDisplayName(
    routerCatalogIdCandidates(modelRef)[0] ?? `accounts/fireworks/routers/${shortId}`,
    label,
    { pricingTier: routerPricing?.tier },
  );
}

export function lookupModelSpec(modelRef) {
  if (isFirerouterModelPattern(modelRef)) {
    return FIREWORKS_MODEL_SPECS.firerouter;
  }
  if (isAutoModelId(modelRef)) {
    return FIREWORKS_MODEL_SPECS.auto;
  }
  const slug = resolveSpecSlug(modelRef);
  const shortId = specShortIdFromModelRef(modelRef);
  const staticAlias = ROUTER_SPEC_ALIASES[shortId];
  const aliasSpec = staticAlias ? FIREWORKS_MODEL_SPECS[staticAlias] ?? null : null;
  const direct = FIREWORKS_MODEL_SPECS[slug];

  if (direct) {
    if (direct.pricing || !aliasSpec?.pricing) {
      return direct;
    }
    return { ...direct, pricing: aliasSpec.pricing };
  }
  return aliasSpec;
}

/**
 * Whether a bare short slug is a router (not a model). Suffix-based so new
 * `*-fast` / `*-latest` / `*-turbo` router slugs are classified correctly
 * without needing a hand-maintained list — `fullFireworksResourceId` relies on
 * this to pick `routers/` vs `models/`, so a stale list would mis-expand a
 * real router id to a non-existent `accounts/fireworks/models/...` path.
 * @param {string} shortId
 * @returns {boolean}
 */
export function isRouterShortId(shortId) {
  if (typeof shortId !== "string") {
    return false;
  }
  return shortId.startsWith("firerouter")
    || Boolean(ROUTER_SPEC_ALIASES[shortId])
    || shortId.endsWith("-latest")
    || shortId.endsWith("-fast")
    || shortId.endsWith("-turbo");
}

function canonicalResourceIdForCache(modelRef) {
  const stripped = String(modelRef ?? "").replace(/\[1m\]$/i, "").trim();
  if (!stripped) {
    return "";
  }
  if (stripped.startsWith("accounts/fireworks/")) {
    return stripped;
  }
  if (stripped.includes("/")) {
    return "";
  }
  const shortId = specShortIdFromModelRef(modelRef);
  if (isRouterShortId(shortId)) {
    return `accounts/fireworks/routers/${shortId}`;
  }
  return `accounts/fireworks/models/${shortId}`;
}

/** True when pricing lookups must resolve to fast-tier cache or static rates. */
export function requiresFastTierPricing(modelRef) {
  const shortId = specShortIdFromModelRef(modelRef);
  return shortId.endsWith("-fast-latest")
    || shortId.endsWith("-fast")
    || shortId.endsWith("-fast-us")
    || shortId.endsWith("-turbo");
}

/** True when cached pricing tier matches what a model/router ref expects. */
export function pricingMatchesModelRefTier(modelRef, pricing) {
  if (!pricing) {
    return false;
  }
  if (pricing.tier === "priority") {
    return false;
  }
  const wantsFast = requiresFastTierPricing(modelRef);
  return wantsFast ? pricing.tier === "fast" : pricing.tier !== "fast";
}

/** Usable live cache pricing for a ref; tier must match the ref's expectations. */
export function isUsableCachedServerlessPricing(modelRef, pricing) {
  if (!pricing || (pricing.input <= 0 && pricing.output <= 0)) {
    return false;
  }
  return pricingMatchesModelRefTier(modelRef, pricing);
}

/** Canonical cache keys for a model/router ref (short slug, full id, resolved spec). */
export function catalogCacheCandidates(modelRef) {
  const candidates = [modelRef];
  const canonical = canonicalResourceIdForCache(modelRef);
  if (canonical && canonical !== modelRef) {
    candidates.push(canonical);
  }
  for (const routerId of routerCatalogIdCandidates(modelRef)) {
    candidates.push(routerId);
  }
  const shortId = specShortIdFromModelRef(modelRef);
  const aliasSlug = resolveRouterSpecAliasTarget(shortId);
  if (aliasSlug && !FIREWORKS_MODEL_SPECS[shortId]) {
    candidates.push(`accounts/fireworks/models/${aliasSlug}`);
    candidates.push(`accounts/fireworks/routers/${aliasSlug}`);
  }
  const resolvedSlug = resolveSpecSlug(modelRef);
  candidates.push(`accounts/fireworks/models/${resolvedSlug}`);
  candidates.push(`accounts/fireworks/routers/${resolvedSlug}`);
  return [...new Set(candidates)];
}

function firstCachedContextLength(modelRef) {
  for (const candidate of catalogCacheCandidates(modelRef)) {
    const value = lookupCachedContextLength(candidate);
    if (value) {
      return value;
    }
  }
  return null;
}

function firstCachedInputModalities(modelRef) {
  for (const candidate of catalogCacheCandidates(modelRef)) {
    const value = lookupCachedInputModalities(candidate);
    if (value) {
      return value;
    }
  }
  return null;
}

function firstCachedSupportsTools(modelRef) {
  for (const candidate of catalogCacheCandidates(modelRef)) {
    const value = lookupCachedSupportsTools(candidate);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function firstCachedServerlessPricing(modelRef) {
  for (const candidate of catalogCacheCandidates(modelRef)) {
    const value = lookupCachedServerlessPricing(candidate);
    if (isUsableCachedServerlessPricing(modelRef, value)) {
      return value;
    }
  }
  return null;
}

export const DEFAULT_FIREWORKS_MODEL_LIMITS = {
  contextWindow: 128_000,
  maxTokens: 16_384,
  vision: false,
};

/** @param {{ vision?: boolean }} limits */
export function fireworksInputModalities(limits) {
  return limits?.vision ? ["text", "image"] : ["text"];
}

/** Harness-neutral context and modality limits for a Fireworks model or router. */
function resolveFireworksCatalogLimits(modelRef, {
  cachedContextLength,
  cachedModalities,
  specCapabilities,
}) {
  if (!specCapabilities && !cachedContextLength && !cachedModalities) {
    return { ...DEFAULT_FIREWORKS_MODEL_LIMITS };
  }
  return {
    contextWindow: cachedContextLength ?? specCapabilities?.contextWindow ?? DEFAULT_FIREWORKS_MODEL_LIMITS.contextWindow,
    maxTokens: specCapabilities?.maxOutputTokens ?? DEFAULT_FIREWORKS_MODEL_LIMITS.maxTokens,
    vision: cachedModalities
      ? cachedModalities.includes("image")
      : (specCapabilities?.vision ?? DEFAULT_FIREWORKS_MODEL_LIMITS.vision),
  };
}

/** Per-million-token cost block for Pi models.json `cost` fields. */
function resolveFireworksCatalogCost(modelRef, specPricing) {
  const pricing = firstCachedServerlessPricing(modelRef) ?? specPricing;
  if (!pricing) {
    return null;
  }
  return {
    input: pricing.input,
    output: pricing.output,
    cacheRead: pricing.cachedInput ?? 0,
    cacheWrite: 0,
  };
}

/**
 * Per-million-token cost block for Pi models.json `cost` fields.
 * Fire Pass is a subscription: it has no per-model pricing, so `firepass`
 * returns null and the harness omits the cost block.
 */
export function lookupFireworksModelCost(modelRef, { firepass = false } = {}) {
  if (firepass) {
    return null;
  }
  const pricing = firstCachedServerlessPricing(modelRef)
    ?? lookupModelSpec(modelRef)?.pricing;
  if (!pricing) {
    return null;
  }
  return {
    input: pricing.input,
    output: pricing.output,
    cacheRead: pricing.cachedInput ?? 0,
    cacheWrite: 0,
  };
}

/**
 * Canonical Fireworks catalog snapshot for a model/router ref.
 * Static specs and the warmed serverless cache are merged once here.
 * @param {string} modelRef
 * @returns {{
 *   limits: { contextWindow: number, maxTokens: number, vision: boolean },
 *   cost: { input: number, output: number, cacheRead: number, cacheWrite: number } | null,
 *   input: string[],
 *   toolCalling: boolean | null,
 *   cache: {
 *     contextLength: number | null,
 *     inputModalities: string[] | null,
 *     supportsTools: boolean | null,
 *   },
 * }}
 */
export function resolveFireworksCatalog(modelRef) {
  const spec = lookupModelSpec(modelRef);
  const cachedContextLength = firstCachedContextLength(modelRef);
  const cachedModalities = firstCachedInputModalities(modelRef);
  const cachedSupportsTools = firstCachedSupportsTools(modelRef);
  const limits = resolveFireworksCatalogLimits(modelRef, {
    cachedContextLength,
    cachedModalities,
    specCapabilities: spec?.capabilities,
  });
  return {
    limits,
    cost: resolveFireworksCatalogCost(modelRef, spec?.pricing),
    input: fireworksInputModalities(limits),
    toolCalling: cachedSupportsTools ?? spec?.capabilities?.toolCalling ?? null,
    cache: {
      contextLength: cachedContextLength,
      inputModalities: cachedModalities,
      supportsTools: cachedSupportsTools,
    },
  };
}

/** @param {string} modelRef */
export function lookupFireworksModelLimits(modelRef) {
  return resolveFireworksCatalog(modelRef).limits;
}

export const MODEL_API_OVERRIDES = Object.fromEntries(
  Object.entries(FIREWORKS_MODEL_SPECS)
    .filter(([, spec]) => spec.api)
    .map(([slug, spec]) => [`accounts/fireworks/models/${slug}`, spec.api]),
);
