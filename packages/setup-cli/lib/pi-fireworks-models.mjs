import {
  lookupFireworksModelCost,
  lookupFireworksModelLimits,
} from "./fireworks-model-specs.mjs";

const PI_PROVIDER = "fireworks";

/** Fireworks routers FireConnect registers for Pi's /model picker. */
const PI_FIREWORKS_ROUTER_ENTRIES = [
  { id: "accounts/fireworks/routers/glm-latest", name: "GLM Latest via Fireworks" },
  { id: "accounts/fireworks/routers/glm-fast-latest", name: "GLM Fast Latest via Fireworks" },
  { id: "accounts/fireworks/routers/glm-5p2-fast", name: "GLM 5.2 Fast via Fireworks" },
  { id: "accounts/fireworks/routers/kimi-fast-latest", name: "Kimi Fast Latest via Fireworks" },
  { id: "accounts/fireworks/routers/kimi-k2p6-turbo", name: "Kimi K2.6 Turbo via Fireworks" },
  { id: "accounts/fireworks/routers/kimi-k2p7-code-fast", name: "Kimi K2.7 Code Fast via Fireworks" },
  { id: "accounts/fireworks/routers/kimi-latest", name: "Kimi Latest via Fireworks" },
];

/**
 * Model IDs Pi ships in its built-in `fireworks` catalog. Writing these into
 * `providers.fireworks.models` replaces the catalog entry and drops context,
 * pricing, and other defaults (Pi falls back to 128K / $0). Use `modelOverrides`
 * instead so Pi deep-merges with the built-in definition.
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
  "accounts/fireworks/routers/kimi-k2p6-turbo",
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
  "accounts/fireworks/routers/kimi-k2p6-turbo": {
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
  const shortId = modelId.split("/").pop() ?? modelId;
  return `${shortId} via Fireworks`;
}

function piFireworksModelOverride(entry) {
  return {
    name: entry.name,
    reasoning: entry.reasoning ?? true,
  };
}

/** Full custom model entry for routers Pi does not ship in its built-in catalog. */
export function buildPiCustomFireworksModelEntry(modelId, name, reasoning = true) {
  const limits = lookupFireworksModelLimits(modelId);
  const entry = {
    id: modelId,
    name,
    reasoning,
    input: limits.vision ? ["text", "image"] : ["text"],
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
  };
  const cost = lookupFireworksModelCost(modelId);
  if (cost) {
    entry.cost = cost;
  }
  return entry;
}

function piModelsToRegister(resolvedModel) {
  const entries = [...PI_FIREWORKS_ROUTER_ENTRIES.map((entry) => ({
    ...entry,
    reasoning: true,
  }))];
  if (resolvedModel.startsWith("accounts/")
    && !entries.some((entry) => entry.id === resolvedModel)
    && !PI_BUILTIN_FIREWORKS_MODEL_IDS.has(resolvedModel)) {
    entries.push({
      id: resolvedModel,
      name: piFireworksDisplayName(resolvedModel),
      reasoning: true,
    });
  }
  return entries;
}

export function managedPiFireworksModelIds(resolvedModel) {
  return piModelsToRegister(resolvedModel).map((entry) => entry.id);
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
  const custom = fireworksProvider?.models?.find((model) => model.id === modelId);
  if (custom) {
    return withPiModelDefaults(custom);
  }
  const builtin = PI_BUILTIN_FIREWORKS_CATALOG[modelId];
  if (!builtin) {
    return null;
  }
  return applyPiModelOverride(
    builtin,
    fireworksProvider?.modelOverrides?.[modelId],
  );
}

export function mergePiFireworksRouterModels(config, resolvedModel) {
  const next = config && typeof config === "object"
    ? structuredClone(config)
    : { providers: {} };
  next.providers ??= {};
  const fireworks = { ...(next.providers[PI_PROVIDER] ?? {}) };
  const models = [...(fireworks.models ?? [])];
  const modelOverrides = { ...(fireworks.modelOverrides ?? {}) };

  for (const entry of piModelsToRegister(resolvedModel)) {
    if (PI_BUILTIN_FIREWORKS_MODEL_IDS.has(entry.id)) {
      modelOverrides[entry.id] = {
        ...(modelOverrides[entry.id] ?? {}),
        ...piFireworksModelOverride(entry),
      };
      const index = models.findIndex((model) => model.id === entry.id);
      if (index >= 0) {
        models.splice(index, 1);
      }
      continue;
    }

    const customEntry = buildPiCustomFireworksModelEntry(
      entry.id,
      entry.name,
      entry.reasoning,
    );
    const index = models.findIndex((model) => model.id === entry.id);
    if (index >= 0) {
      models[index] = { ...models[index], ...customEntry };
    } else {
      models.push(customEntry);
    }
    delete modelOverrides[entry.id];
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
  next.providers[PI_PROVIDER] = fireworks;
  return next;
}

export { ONE_MILLION_CONTEXT, PI_FIREWORKS_ROUTER_ENTRIES };
