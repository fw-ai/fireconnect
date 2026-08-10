import {
  appendLatestRouterSuffix,
  fireworksInputModalities,
  lookupFireworksModelCost,
  lookupFireworksModelLimits,
  lookupModelSpec,
  resolveFireworksModelLabel,
} from "../../fireworks/model-specs.mjs";
import {
  isFirerouterGatewayPattern,
  isFirerouterModel,
  normalizeModelId,
  shortFireworksModelRef,
  fullFireworksResourceId,
} from "../../fireworks/model-id.mjs";
import { prettyModelName } from "../../fireworks/models.mjs";
import { mergeFireconnectTelemetryHeaders } from "../../telemetry/request-headers.mjs";

const PI_PROVIDER = "fireworks";

/** Fireworks router IDs FireConnect registers for Pi's /model picker. */
const PI_FIREWORKS_ROUTER_IDS = [
  "accounts/fireworks/routers/glm-latest",
  "accounts/fireworks/routers/glm-fast-latest",
  "accounts/fireworks/routers/glm-5p2-fast",
  "accounts/fireworks/routers/kimi-fast-latest",
  "accounts/fireworks/routers/kimi-k2p7-code-fast",
  "accounts/fireworks/routers/kimi-latest",
];

/**
 * Canonical model IDs Pi ships in its built-in `fireworks` catalog. Pi keys
 * those definitions by canonical ID, so FireConnect cannot rely on them after
 * writing short IDs. Complete short-ID rows are built from the metadata below.
 * @see https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/providers/fireworks.models.ts
 */
export const PI_BUILTIN_FIREWORKS_MODEL_IDS = new Set([
  "accounts/fireworks/models/deepseek-v4-flash",
  "accounts/fireworks/models/deepseek-v4-pro",
  "accounts/fireworks/models/glm-5p1",
  "accounts/fireworks/models/glm-5p2",
  "accounts/fireworks/models/gpt-oss-120b",
  "accounts/fireworks/models/gpt-oss-20b",
  "accounts/fireworks/models/kimi-k2p6",
  "accounts/fireworks/models/kimi-k2p7-code",
  "accounts/fireworks/models/minimax-m2p7",
  "accounts/fireworks/models/minimax-m3",
  "accounts/fireworks/models/qwen3p7-plus",
  "accounts/fireworks/routers/glm-5p1-fast",
  "accounts/fireworks/routers/glm-5p2-fast",
  "accounts/fireworks/routers/kimi-k2p6-fast",
  "accounts/fireworks/routers/kimi-k2p7-code-fast",
]);

/**
 * Pi built-in fireworks catalog fields FireConnect tests merge against.
 * Values mirror pi-mono `fireworks.models.ts` (contextWindow / cost / input).
 */
export const PI_BUILTIN_FIREWORKS_CATALOG = {
  "accounts/fireworks/models/deepseek-v4-flash": {
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    reasoning: true,
    input: ["text"],
    cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
  },
  "accounts/fireworks/models/deepseek-v4-pro": {
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    reasoning: true,
    input: ["text"],
    cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
  },
  "accounts/fireworks/models/glm-5p1": {
    contextWindow: 202_800,
    maxTokens: 131_072,
    reasoning: true,
    input: ["text"],
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  },
  "accounts/fireworks/models/glm-5p2": {
    contextWindow: 1_048_575,
    maxTokens: 131_072,
    reasoning: true,
    input: ["text"],
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  },
  "accounts/fireworks/models/gpt-oss-120b": {
    contextWindow: 131_072,
    maxTokens: 32_768,
    reasoning: true,
    input: ["text"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
  },
  "accounts/fireworks/models/gpt-oss-20b": {
    contextWindow: 131_072,
    maxTokens: 32_768,
    reasoning: true,
    input: ["text"],
    cost: { input: 0.07, output: 0.3, cacheRead: 0.035, cacheWrite: 0 },
  },
  "accounts/fireworks/models/kimi-k2p6": {
    contextWindow: 262_000,
    maxTokens: 262_000,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
  },
  "accounts/fireworks/models/kimi-k2p7-code": {
    contextWindow: 262_000,
    maxTokens: 262_000,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
  },
  "accounts/fireworks/models/minimax-m2p7": {
    contextWindow: 196_608,
    maxTokens: 196_608,
    reasoning: true,
    input: ["text"],
    cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  },
  "accounts/fireworks/models/minimax-m3": {
    contextWindow: 512_000,
    maxTokens: 512_000,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  },
  "accounts/fireworks/models/qwen3p7-plus": {
    contextWindow: 262_144,
    maxTokens: 65_536,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.4, output: 1.6, cacheRead: 0.08, cacheWrite: 0 },
  },
  "accounts/fireworks/routers/glm-5p1-fast": {
    contextWindow: 202_800,
    maxTokens: 131_072,
    reasoning: true,
    input: ["text"],
    cost: { input: 2.8, output: 8.8, cacheRead: 0.52, cacheWrite: 0 },
  },
  "accounts/fireworks/routers/glm-5p2-fast": {
    contextWindow: 1_048_575,
    maxTokens: 131_072,
    reasoning: true,
    input: ["text"],
    cost: { input: 2.1, output: 6.6, cacheRead: 0.21, cacheWrite: 0 },
  },
  "accounts/fireworks/routers/kimi-k2p6-fast": {
    contextWindow: 262_000,
    maxTokens: 262_000,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 8, cacheRead: 0.3, cacheWrite: 0 },
  },
  "accounts/fireworks/routers/kimi-k2p7-code-fast": {
    contextWindow: 262_000,
    maxTokens: 262_000,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
  },
};

const ONE_MILLION_CONTEXT = 1_000_000;
const PI_DEFAULT_CONTEXT_WINDOW = 128_000;
const PI_DEFAULT_MAX_TOKENS = 16_384;
const PI_DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function withPiModelDefaults(model) {
  return {
    reasoning: false,
    input: ["text"],
    contextWindow: PI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: PI_DEFAULT_MAX_TOKENS,
    cost: PI_DEFAULT_COST,
    ...model,
    cost: model.cost ?? PI_DEFAULT_COST,
  };
}

function piFireworksDisplayName(modelId) {
  if (isFirerouterModel(modelId)) {
    return "FireRouter";
  }
  const liveLabel = resolveFireworksModelLabel(modelId);
  if (liveLabel) {
    return liveLabel;
  }
  const spec = lookupModelSpec(modelId);
  if (spec?.label) {
    return appendLatestRouterSuffix(modelId, spec.label);
  }
  return prettyModelName(modelId);
}

function piFireworksRouterEntries() {
  return PI_FIREWORKS_ROUTER_IDS.map((id) => ({
    id,
    name: piFireworksDisplayName(id),
  }));
}

/** Full custom model entry using the short ID stored in Pi config. */
export function buildPiCustomFireworksModelEntry(modelId, name, reasoning = true) {
  const limits = lookupFireworksModelLimits(modelId);
  const entry = {
    id: shortFireworksModelRef(modelId),
    name,
    reasoning,
    input: fireworksInputModalities(limits),
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
  };
  const cost = lookupFireworksModelCost(modelId);
  if (cost) {
    entry.cost = cost;
  }
  return entry;
}

/** Complete short-ID entry, retaining Pi's richer built-in metadata when known. */
function buildPiStoredFireworksModelEntry(modelId, name, reasoning = true) {
  const canonicalId = fullFireworksResourceId(modelId);
  const builtin = PI_BUILTIN_FIREWORKS_CATALOG[canonicalId];
  if (!builtin) {
    return buildPiCustomFireworksModelEntry(modelId, name, reasoning);
  }
  return {
    id: shortFireworksModelRef(canonicalId),
    name,
    ...structuredClone(builtin),
    reasoning,
  };
}

function piModelsToRegister(resolvedModel, catalogModelIds = []) {
  // FireRouter routes server-side, so register only the selected firerouter* model.
  if (isFirerouterGatewayPattern(resolvedModel)) {
    return [{ id: resolvedModel, name: piFireworksDisplayName(resolvedModel), reasoning: true }];
  }
  // The caller already reduced the catalog to latest aliases or the newest
  // concrete family version. Offline, fall back to the bundled router set.
  const catalog = catalogModelIds.filter((id) => typeof id === "string" && id.startsWith("accounts/"));
  const entries = catalog.length
    ? catalog.map((id) => ({ id, name: piFireworksDisplayName(id), reasoning: true }))
    : piFireworksRouterEntries().map((entry) => ({ ...entry, reasoning: true }));
  // Always include the active model. Even Pi built-ins need a complete custom
  // row because settings.defaultModel is stored as a short ID.
  if (resolvedModel.startsWith("accounts/")
    && !entries.some(
      (entry) => shortFireworksModelRef(entry.id) === shortFireworksModelRef(resolvedModel),
    )) {
    entries.push({
      id: resolvedModel,
      name: piFireworksDisplayName(resolvedModel),
      reasoning: true,
    });
  }
  return entries;
}

export function managedPiFireworksModelIds(resolvedModel, catalogModelIds = []) {
  return piModelsToRegister(resolvedModel, catalogModelIds)
    .map((entry) => shortFireworksModelRef(entry.id));
}

function applyPiModelOverride(base, override) {
  if (!override) {
    return { ...base };
  }
  const merged = { ...base, ...override };
  if (base.cost && override.cost) {
    merged.cost = { ...base.cost, ...override.cost };
  }
  return merged;
}

/**
 * Resolve the effective Pi fireworks model after applying models.json wiring.
 * Mirrors Pi's merge rules: a `models` entry replaces the built-in catalog row;
 * `modelOverrides` deep-merge onto the built-in catalog row.
 * @param {object | undefined} fireworksProvider
 * @param {string} modelId
 */
export function resolvePiEffectiveFireworksModel(fireworksProvider, modelId) {
  const storedId = shortFireworksModelRef(modelId);
  const custom = fireworksProvider?.models?.find(
    (model) => shortFireworksModelRef(model.id) === storedId,
  );
  if (custom) {
    return withPiModelDefaults(custom);
  }
  const canonicalId = fullFireworksResourceId(modelId);
  const builtin = PI_BUILTIN_FIREWORKS_CATALOG[canonicalId];
  if (!builtin) {
    return null;
  }
  const overrides = fireworksProvider?.modelOverrides ?? {};
  return applyPiModelOverride(
    builtin,
    overrides[modelId] ?? overrides[storedId] ?? overrides[canonicalId],
  );
}

export function mergePiFireworksRouterModels(config, resolvedModel, managedHeaders = {}, catalogModelIds = [], previousManagedIds = []) {
  const next = config && typeof config === "object"
    ? structuredClone(config)
    : { providers: {} };
  next.providers ??= {};
  const fireworks = { ...(next.providers[PI_PROVIDER] ?? {}) };
  let models = [...(fireworks.models ?? [])];
  const modelOverrides = { ...(fireworks.modelOverrides ?? {}) };

  // When rebuilding from a fresh catalog (or switching to firerouter), drop the
  // ids FireConnect registered last time so the live config matches the current
  // catalog exactly — no accumulation. User-added entries are left untouched.
  // Offline (empty catalog, direct mode) we skip this and merge, so a transient
  // catalog fetch failure doesn't wipe the picker.
  const rebuilding = isFirerouterGatewayPattern(resolvedModel)
    || catalogModelIds.some((id) => typeof id === "string" && id.startsWith("accounts/"));
  if (rebuilding && previousManagedIds.length) {
    const prior = new Set(previousManagedIds.map(shortFireworksModelRef));
    models = models.filter(
      (model) => !prior.has(shortFireworksModelRef(model.id)),
    );
    for (const id of Object.keys(modelOverrides)) {
      if (prior.has(shortFireworksModelRef(id))) {
        delete modelOverrides[id];
      }
    }
  }

  for (const entry of piModelsToRegister(resolvedModel, catalogModelIds)) {
    const storedId = shortFireworksModelRef(entry.id);
    const customEntry = buildPiStoredFireworksModelEntry(
      entry.id,
      entry.name,
      entry.reasoning,
    );
    const existing = models.find(
      (model) => shortFireworksModelRef(model.id) === storedId,
    );
    models = models.filter(
      (model) => shortFireworksModelRef(model.id) !== storedId,
    );
    models.push({ ...(existing ?? {}), ...customEntry });
    for (const id of Object.keys(modelOverrides)) {
      if (shortFireworksModelRef(id) === storedId) {
        delete modelOverrides[id];
      }
    }
  }

  if (models.length) {
    fireworks.models = models;
  } else {
    delete fireworks.models;
  }
  if (Object.keys(modelOverrides).length) {
    fireworks.modelOverrides = modelOverrides;
  } else {
    delete fireworks.modelOverrides;
  }
  fireworks.compat = {
    ...(fireworks.compat ?? {}),
    sendSessionAffinityHeaders: true,
  };
  // FireRouter BYOK header (x-anthropic-api-key). Drop any stale one first so
  // switching firerouter → a direct model clears it; x-openai-api-key is dropped
  // too, to clean up configs written before OpenAI BYOK was removed.
  const byokHeaderNames = ["x-anthropic-api-key", "x-openai-api-key"];
  const headersWithoutByok = Object.fromEntries(
    Object.entries(fireworks.headers ?? {}).filter(
      ([name]) => !byokHeaderNames.includes(name.toLowerCase()),
    ),
  );
  const headers = mergeFireconnectTelemetryHeaders(
    headersWithoutByok,
    managedHeaders,
  );
  if (Object.keys(headers).length) {
    fireworks.headers = headers;
  } else {
    delete fireworks.headers;
  }
  next.providers[PI_PROVIDER] = fireworks;
  return next;
}

export { ONE_MILLION_CONTEXT, PI_FIREWORKS_ROUTER_IDS, piFireworksRouterEntries };
