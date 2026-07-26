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
    pricing: { input: 1.74, cachedInput: 0.145, output: 3.48 },
    vscode: { maxInputTokens: 1_000_000, maxOutputTokens: 384_000, vision: false, toolCalling: true },
  },
  "deepseek-v4-flash": {
    label: "DeepSeek V4 Flash",
    pricing: { input: 0.14, cachedInput: 0.028, output: 0.28 },
    vscode: { maxInputTokens: 1_000_000, maxOutputTokens: 384_000, vision: false, toolCalling: true },
  },
  "glm-5p2": {
    label: "GLM 5.2",
    pricing: { input: 1.40, cachedInput: 0.14, output: 4.40 },
    vscode: { maxInputTokens: 1_048_575, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "glm-5p1": {
    label: "GLM 5.1",
    pricing: { input: 1.40, cachedInput: 0.26, output: 4.40 },
    vscode: { maxInputTokens: 202_800, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "glm-5p1-fast": {
    label: "GLM 5.1 Fast",
    pricing: { input: 2.80, cachedInput: 0.52, output: 8.80, tier: "fast" },
    vscode: { maxInputTokens: 202_800, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "glm-5p2-fast": {
    label: "GLM 5.2 Fast",
    pricing: { input: 2.10, cachedInput: 0.21, output: 6.60, tier: "fast" },
    vscode: { maxInputTokens: 1_048_575, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "kimi-k3": {
    label: "Kimi K3",
    vscode: { maxInputTokens: 262_000, maxOutputTokens: 262_000, vision: true, toolCalling: true },
  },
  "kimi-k3-fast": {
    label: "Kimi K3 Fast",
    vscode: { maxInputTokens: 262_000, maxOutputTokens: 262_000, vision: true, toolCalling: true },
  },
  "kimi-k2p7-code": {
    label: "Kimi K2.7 Code",
    pricing: { input: 0.95, cachedInput: 0.19, output: 4.00 },
    vscode: { maxInputTokens: 262_000, maxOutputTokens: 262_000, vision: true, toolCalling: true },
  },
  "kimi-k2p7-code-fast": {
    label: "Kimi K2.7 Code Fast",
    pricing: { input: 1.90, cachedInput: 0.38, output: 8.00, tier: "fast" },
    vscode: { maxInputTokens: 262_000, maxOutputTokens: 262_000, vision: true, toolCalling: true },
  },
  "kimi-k2p6": {
    label: "Kimi K2.6",
    pricing: { input: 0.95, cachedInput: 0.16, output: 4.00 },
    vscode: { maxInputTokens: 262_000, maxOutputTokens: 262_000, vision: true, toolCalling: true },
  },
  "kimi-k2p6-fast": {
    label: "Kimi K2.6 Fast",
    pricing: { input: 2.00, cachedInput: 0.30, output: 8.00, tier: "fast" },
    vscode: { maxInputTokens: 262_000, maxOutputTokens: 262_000, vision: true, toolCalling: true },
  },
  "kimi-k2p6-turbo": {
    label: "Kimi K2.6 Turbo",
    pricing: { input: 2.00, cachedInput: 0.30, output: 8.00, tier: "fast" },
    vscode: { maxInputTokens: 262_000, maxOutputTokens: 262_000, vision: true, toolCalling: true },
  },
  "kimi-k2p5": {
    label: "Kimi K2.5",
    pricing: { input: 0.60, cachedInput: 0.10, output: 3.00 },
    vscode: { maxInputTokens: 262_144, maxOutputTokens: 32_768, vision: true, toolCalling: true },
  },
  "minimax-m2p5": {
    label: "MiniMax 2.5",
    pricing: { input: 0.30, cachedInput: 0.03, output: 1.20 },
    vscode: { maxInputTokens: 196_608, maxOutputTokens: 24_576, vision: false, toolCalling: true },
  },
  "minimax-m2p7": {
    label: "MiniMax 2.7",
    pricing: { input: 0.30, cachedInput: 0.06, output: 1.20 },
    vscode: { maxInputTokens: 196_608, maxOutputTokens: 196_608, vision: false, toolCalling: true },
  },
  "minimax-m3": {
    label: "MiniMax M3",
    pricing: { input: 0.30, cachedInput: 0.06, output: 1.20 },
    vscode: { maxInputTokens: 512_000, maxOutputTokens: 512_000, vision: true, toolCalling: true },
  },
  "qwen3p7-plus": {
    label: "Qwen 3.7 Plus",
    pricing: { input: 0.40, cachedInput: 0.08, output: 1.60 },
    vscode: { maxInputTokens: 262_144, maxOutputTokens: 65_536, vision: true, toolCalling: true },
    api: { contextLength: 262_144, supportsImageInput: true },
  },
  "qwen3p6-plus": {
    label: "Qwen 3.6 Plus",
    pricing: { input: 0.50, cachedInput: 0.10, output: 3.00 },
    vscode: { maxInputTokens: 262_144, maxOutputTokens: 32_768, vision: true, toolCalling: true },
  },
  "gpt-oss-120b": {
    label: "GPT-OSS 120B",
    pricing: { input: 0.15, cachedInput: 0.015, output: 0.60 },
    vscode: { maxInputTokens: 131_072, maxOutputTokens: 32_768, vision: false, toolCalling: true },
  },
  "gpt-oss-20b": {
    label: "GPT-OSS 20B",
    pricing: { input: 0.07, cachedInput: 0.035, output: 0.30 },
    vscode: { maxInputTokens: 131_072, maxOutputTokens: 32_768, vision: false, toolCalling: false },
  },
  "nemotron-3-ultra-nvfp4": {
    label: "NVIDIA Nemotron 3 Ultra NVFP4",
    vscode: { maxInputTokens: 262_144, maxOutputTokens: 32_768, vision: false, toolCalling: true },
  },
  firerouter: {
    label: "FireRouter",
    vscode: {
      maxInputTokens: 1_048_575,
      maxOutputTokens: 131_072,
      vision: true,
      toolCalling: true,
    },
  },
};

export const ROUTER_SPEC_ALIASES = {
  "glm-latest": "glm-5p2",
  "glm-fast-latest": "glm-5p2-fast",
  "kimi-latest": "kimi-k2p7-code",
  "kimi-fast-latest": "kimi-k2p7-code-fast",
  "minimax-latest": "minimax-m3",
  "qwen-plus-latest": "qwen3p7-plus",
};

const KIMI_LATEST_BASE_CANDIDATES = ["kimi-k3", "kimi-k2p8-code", "kimi-k2p7-code"];

function makeCatalogModelChecker(entryIds = null) {
  if (entryIds) {
    return (slug) => entryIds.has(`accounts/fireworks/models/${slug}`);
  }
  return (slug) => Boolean(lookupCatalogEntryById(`accounts/fireworks/models/${slug}`));
}

function resolveKimiLatestBaseSlug(catalogCheck) {
  for (const slug of KIMI_LATEST_BASE_CANDIDATES) {
    if (catalogCheck(slug)) {
      return slug;
    }
  }
  return null;
}

/** True when Kimi K3 is listed in the warmed serverless catalog. */
export function isKimiK3ServerlessAvailable() {
  const catalogCheck = makeCatalogModelChecker();
  return catalogCheck("kimi-k3") || catalogCheck("kimi-k3-fast");
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
    if (catalogCheck("kimi-k3-fast")) {
      return "kimi-k3-fast";
    }
    const base = resolveKimiLatestBaseSlug(catalogCheck);
    if (base) {
      return fastSpecSlugForBase(base, alias);
    }
    return ROUTER_SPEC_ALIASES[alias] ?? null;
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

export const DEFAULT_VSCODE_MODEL_METADATA = {
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
  const baseModelId = resolveLiveRouterBaseModelId(modelRef);
  if (baseModelId) {
    const baseSlug = specShortIdFromModelRef(baseModelId);
    return fastSpecSlugForBase(baseSlug, shortId);
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
  if (shortId === "firerouter") {
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
  const baseModelId = resolveLiveRouterBaseModelId(modelRef);
  if (!baseModelId) {
    return null;
  }

  const baseEntry = lookupCatalogEntryById(baseModelId);
  let label = baseEntry?.displayName
    ? stripViaFireworksSuffix(baseEntry.displayName)
    : FIREWORKS_MODEL_SPECS[specShortIdFromModelRef(baseModelId)]?.label ?? null;
  if (!label) {
    return null;
  }

  const routerPricing = routerCatalogIdCandidates(modelRef)
    .map((routerId) => lookupCachedServerlessPricing(routerId))
    .find(Boolean);
  const needsFastTier = shortId.endsWith("-fast-latest")
    || shortId.endsWith("-fast")
    || routerPricing?.tier === "fast";
  const withTier = needsFastTier ? appendFastTierLabel(label) : label;
  return appendLatestRouterSuffix(modelRef, withTier);
}

export function lookupModelSpec(modelRef) {
  const slug = resolveSpecSlug(modelRef);
  const shortId = specShortIdFromModelRef(modelRef);
  const staticAlias = ROUTER_SPEC_ALIASES[shortId];
  const aliasSpec = staticAlias ? FIREWORKS_MODEL_SPECS[staticAlias] ?? null : null;
  const direct = FIREWORKS_MODEL_SPECS[slug];

  if (direct) {
    // Catalog-resolved slugs like kimi-k3-fast ship metadata before pricing lands.
    // Borrow documented rates from the static -latest alias target when needed.
    if (direct.pricing || !aliasSpec?.pricing) {
      return direct;
    }
    return { ...direct, pricing: aliasSpec.pricing };
  }
  return aliasSpec;
}

function isRouterShortId(shortId) {
  return shortId === "firerouter"
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
    || shortId.endsWith("-turbo");
}

/** Usable live cache pricing for a ref; fast routers reject standard-tier rates. */
export function isUsableCachedServerlessPricing(modelRef, pricing) {
  if (!pricing || (pricing.input <= 0 && pricing.output <= 0)) {
    return false;
  }
  if (requiresFastTierPricing(modelRef) && pricing.tier !== "fast") {
    return false;
  }
  return true;
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
  if (aliasSlug) {
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

export function lookupVscodeModelMetadata(modelRef) {
  const spec = lookupModelSpec(modelRef);
  const cachedModalities = firstCachedInputModalities(modelRef);
  const cachedContextLength = firstCachedContextLength(modelRef);
  const cachedSupportsTools = firstCachedSupportsTools(modelRef);
  const base = spec?.vscode ?? DEFAULT_VSCODE_MODEL_METADATA;

  if (!cachedModalities && !cachedContextLength && cachedSupportsTools === null) {
    return base;
  }

  return {
    ...base,
    ...(cachedContextLength
      ? { maxInputTokens: cachedContextLength, maxOutputTokens: base.maxOutputTokens ?? 16_384 }
      : {}),
    ...(cachedModalities ? { vision: cachedModalities.includes("image") } : {}),
    ...(cachedSupportsTools === null ? {} : { toolCalling: cachedSupportsTools }),
  };
}

export const DEFAULT_FIREWORKS_MODEL_LIMITS = {
  contextWindow: 128_000,
  maxTokens: 16_384,
  vision: false,
};

/** Harness-neutral context and modality limits for a Fireworks model or router. */
export function lookupFireworksModelLimits(modelRef) {
  const cachedContextLength = firstCachedContextLength(modelRef);
  const cachedModalities = firstCachedInputModalities(modelRef);
  const limits = lookupModelSpec(modelRef)?.vscode;
  if (!limits && !cachedContextLength && !cachedModalities) {
    return DEFAULT_FIREWORKS_MODEL_LIMITS;
  }
  return {
    contextWindow: cachedContextLength ?? limits?.maxInputTokens ?? DEFAULT_FIREWORKS_MODEL_LIMITS.contextWindow,
    maxTokens: limits?.maxOutputTokens ?? DEFAULT_FIREWORKS_MODEL_LIMITS.maxTokens,
    vision: cachedModalities
      ? cachedModalities.includes("image")
      : (limits?.vision ?? DEFAULT_FIREWORKS_MODEL_LIMITS.vision),
  };
}

/** Per-million-token cost block for Pi models.json `cost` fields. */
export function lookupFireworksModelCost(modelRef) {
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

export const MODEL_API_OVERRIDES = Object.fromEntries(
  Object.entries(FIREWORKS_MODEL_SPECS)
    .filter(([, spec]) => spec.api)
    .map(([slug, spec]) => [`accounts/fireworks/models/${slug}`, spec.api]),
);
