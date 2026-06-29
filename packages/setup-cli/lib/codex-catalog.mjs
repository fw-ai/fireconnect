import { MODEL_API_OVERRIDES as MODEL_OVERRIDES } from "./fireworks-model-specs.mjs";
import { BUILTIN_ROUTERS } from "./fireworks-models.mjs";

export { MODEL_OVERRIDES };

export const CODEX_CONSTANT_FIELDS = {
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  prefer_websockets: true,
  support_verbosity: true,
  default_verbosity: "low",
  supports_reasoning_summaries: true,
  default_reasoning_summary: "none",
  experimental_supported_tools: [],
  base_instructions: "",
  priority: 99,
  truncation_policy: { mode: "tokens", limit: 10000 },
  minimal_client_version: "0.0.1",
  supports_search_tool: true,
  auto_compact_token_limit: null,
};

export const REASONING_DESCRIPTIONS = {
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  max: "Extra high reasoning depth for complex problems",
};

function reasoningLevel(effort) {
  return { effort, description: REASONING_DESCRIPTIONS[effort] };
}

export const MODEL_REASONING = {
  "accounts/fireworks/models/glm-5p2": {
    default: "max",
    levels: [reasoningLevel("high"), reasoningLevel("max")],
  },
  "accounts/fireworks/models/glm-5p1": {
    default: "high",
    levels: [reasoningLevel("high")],
  },
  "accounts/fireworks/models/deepseek-v4-flash": {
    default: "high",
    levels: [reasoningLevel("high"), reasoningLevel("max")],
  },
  "accounts/fireworks/models/deepseek-v4-pro": {
    default: "high",
    levels: [reasoningLevel("high"), reasoningLevel("max")],
  },
  "accounts/fireworks/models/kimi-k2p6": {
    default: "high",
    levels: [reasoningLevel("high")],
  },
  "accounts/fireworks/models/kimi-k2p7-code": {
    default: "high",
    levels: [reasoningLevel("high")],
  },
  "accounts/fireworks/models/minimax-m2p7": {
    default: "medium",
    levels: [reasoningLevel("low"), reasoningLevel("medium"), reasoningLevel("high")],
  },
  "accounts/fireworks/models/minimax-m3": {
    default: "high",
    levels: [reasoningLevel("high")],
  },
  "accounts/fireworks/models/gpt-oss-120b": {
    default: "medium",
    levels: [reasoningLevel("low"), reasoningLevel("medium"), reasoningLevel("high")],
  },
  "accounts/fireworks/models/nemotron-3-ultra-nvfp4": {
    default: "high",
    levels: [reasoningLevel("high")],
  },
  "accounts/fireworks/models/qwen3p7-plus": {
    default: "medium",
    levels: [reasoningLevel("low"), reasoningLevel("medium"), reasoningLevel("high")],
  },
};

const DEFAULT_REASONING = {
  default: "high",
  levels: [reasoningLevel("high")],
};

export const DEPRECATED_MODELS = new Set([
  "accounts/fireworks/models/kimi-k2p5",
  "accounts/fireworks/models/qwen3p6-plus",
  "accounts/fireworks/models/minimax-m2p5",
]);

export const ROUTER_BASE_MODEL = Object.fromEntries(
  BUILTIN_ROUTERS
    .filter((router) => router.baseModelId)
    .map((router) => [router.id, router.baseModelId]),
);

function routerDisplayName(routerId) {
  const router = BUILTIN_ROUTERS.find((entry) => entry.id === routerId);
  return router ? router.displayName : routerId;
}

function effectiveModelFields(model) {
  const overrides = MODEL_OVERRIDES[model.name] ?? {};
  return {
    contextLength: overrides.contextLength ?? model.contextLength ?? 0,
    supportsImageInput: overrides.supportsImageInput ?? model.supportsImageInput ?? false,
    supportsTools: overrides.supportsTools ?? model.supportsTools ?? false,
  };
}

export function buildCodexCatalogEntry(model) {
  const { contextLength, supportsImageInput, supportsTools } = effectiveModelFields(model);

  const reasoning = MODEL_REASONING[model.name] ?? DEFAULT_REASONING;
  const reasoningSummaryFormat = reasoning.levels.length > 1 ? "experimental" : "none";

  return {
    slug: model.name,
    display_name: model.displayName ?? model.name,
    description: model.description ?? "",
    ...CODEX_CONSTANT_FIELDS,
    input_modalities: supportsImageInput ? ["text", "image"] : ["text"],
    supports_parallel_tool_calls: supportsTools,
    default_reasoning_level: reasoning.default,
    supported_reasoning_levels: reasoning.levels,
    reasoning_summary_format: reasoningSummaryFormat,
    web_search_tool_type: supportsImageInput ? "text_and_image" : "text",
    supports_image_detail_original: supportsImageInput,
    context_window: contextLength,
    max_context_window: contextLength,
  };
}

export function buildCodexCatalogEntryForRouter(routerId, baseModel, displayName) {
  const entry = buildCodexCatalogEntry(baseModel);
  return {
    ...entry,
    slug: routerId,
    display_name: displayName,
  };
}

const EXCLUDED_KINDS = new Set(["EMBEDDING_MODEL", "FLUMINA_BASE_MODEL"]);

function isCodexSuitable(model) {
  if (DEPRECATED_MODELS.has(model.name)) {
    return false;
  }
  if (EXCLUDED_KINDS.has(model.kind)) {
    return false;
  }
  const { contextLength, supportsTools } = effectiveModelFields(model);
  if (!supportsTools) {
    return false;
  }
  return contextLength > 0;
}

export function buildCodexCatalog(apiModels) {
  const byName = new Map();
  for (const model of apiModels) {
    if (model?.name) {
      byName.set(model.name, model);
    }
  }

  const models = apiModels
    .filter((model) => model?.name && isCodexSuitable(model))
    .map((model) => buildCodexCatalogEntry(model));

  const routerEntries = [];
  for (const [routerId, baseModelId] of Object.entries(ROUTER_BASE_MODEL)) {
    const baseModel = byName.get(baseModelId);
    if (!baseModel) {
      continue;
    }
    routerEntries.push(
      buildCodexCatalogEntryForRouter(routerId, baseModel, routerDisplayName(routerId)),
    );
  }

  return { models: [...models, ...routerEntries] };
}

/**
 * Limit interactive picker entries to models present in the Codex metadata catalog.
 * @param {import("./fireworks-models.mjs").CatalogEntry[]} pickerCatalog
 * @param {{ models: Array<{ slug: string }> } | null} codexCatalog
 */
export function filterPickerCatalogForCodex(pickerCatalog, codexCatalog) {
  if (!pickerCatalog?.length) {
    return pickerCatalog ?? [];
  }
  if (!codexCatalog) {
    return pickerCatalog;
  }
  const slugs = new Set((codexCatalog.models ?? []).map((entry) => entry.slug));
  if (slugs.size === 0) {
    return [];
  }
  return pickerCatalog.filter((entry) => slugs.has(entry.id));
}

export function codexCatalogContainsModel(catalog, modelId) {
  if (!catalog?.models?.length || !modelId) {
    return false;
  }
  return catalog.models.some((entry) => entry.slug === modelId);
}
