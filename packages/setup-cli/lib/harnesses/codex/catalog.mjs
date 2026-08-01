import {
  FIREROUTER_TAGLINE,
} from "../../firerouter/core.mjs";
import { MODEL_API_OVERRIDES as MODEL_OVERRIDES, lookupModelSpec, resolveFireworksModelLabel } from "../../fireworks/model-specs.mjs";
import { buildServerlessCatalogSnapshot, prettyModelName } from "../../fireworks/models.mjs";
import {
  FIREROUTER_ROUTER_ID,
  fireworksModelSlug,
} from "../../fireworks/model-id.mjs";

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
]);

/**
 * Why MiniMax models are omitted from the Codex catalog and rejected on `codex on`.
 * Codex uses the Fireworks Responses API; its client inserts assistant messages
 * between tool_calls and tool_results. MiniMax chat templates require tool_results
 * to immediately follow tool_calls, so those sessions fail at render time.
 */
export const CODEX_MINIMAX_UNSUPPORTED_NOTE = (
  "MiniMax is not supported with Codex: Codex uses the Responses API and may place "
  + "assistant messages between tool_calls and tool_results, but MiniMax's template "
  + "requires tool_results to follow tool_calls directly. Use Claude, OpenCode, or "
  + "another Chat Completions harness for MiniMax."
);

/** @param {string} modelRef */
export function isCodexUnsupportedMiniMaxModel(modelRef) {
  const slug = fireworksModelSlug(modelRef ?? "");
  return slug === "minimax-latest" || slug.startsWith("minimax-");
}

/** @param {string} modelRef @returns {string} */
export function codexModelExclusionReason(modelRef) {
  return isCodexUnsupportedMiniMaxModel(modelRef) ? CODEX_MINIMAX_UNSUPPORTED_NOTE : "";
}

function routerDisplayName(routerId) {
  return resolveFireworksModelLabel(routerId) ?? prettyModelName(routerId);
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
    slug: fireworksModelSlug(model.name),
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
    slug: fireworksModelSlug(routerId),
    display_name: displayName,
  };
}

const EXCLUDED_KINDS = new Set(["EMBEDDING_MODEL", "FLUMINA_BASE_MODEL"]);

function isCodexSuitable(model) {
  if (DEPRECATED_MODELS.has(model.name)) {
    return false;
  }
  if (isCodexUnsupportedMiniMaxModel(model.name)) {
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
  return buildCodexCatalogFromSnapshot(buildServerlessCatalogSnapshot(apiModels), apiModels);
}

/**
 * Build the Codex metadata catalog from an already-parsed serverless snapshot.
 * The snapshot is the single source of truth for which base models and routers
 * (including synthesized `-latest` aliases) exist; this pass only layers Codex
 * presentation metadata (reasoning levels, modalities) on top.
 *
 * @param {import("../../fireworks/serverless-catalog-cache.mjs").ServerlessCatalogSnapshot} snapshot
 * @param {object[]} apiModels Raw API models, for full base-model metadata.
 */
export function buildCodexCatalogFromSnapshot(snapshot, apiModels) {
  const byName = new Map();
  for (const model of apiModels) {
    const id = model?.name ?? model?.id;
    if (id) {
      byName.set(id, model);
    }
  }

  const models = [];
  for (const entry of snapshot.entries) {
    if (entry.id === FIREROUTER_ROUTER_ID) {
      const spec = lookupModelSpec(FIREROUTER_ROUTER_ID);
      models.push(buildCodexCatalogEntry({
        name: FIREROUTER_ROUTER_ID,
        displayName: spec?.label ?? "FireRouter",
        description: FIREROUTER_TAGLINE,
        contextLength: spec?.vscode.maxInputTokens ?? 0,
        supportsImageInput: spec?.vscode.vision ?? false,
        supportsTools: spec?.vscode.toolCalling ?? true,
      }));
      continue;
    }
    if (entry.baseModelId) {
      if (isCodexUnsupportedMiniMaxModel(entry.id)
        || isCodexUnsupportedMiniMaxModel(entry.baseModelId)) {
        continue;
      }
      const baseModel = byName.get(entry.baseModelId);
      if (baseModel) {
        models.push(
          buildCodexCatalogEntryForRouter(entry.id, baseModel, routerDisplayName(entry.id)),
        );
      }
      continue;
    }

    const model = byName.get(entry.id);
    if (model && isCodexSuitable({ ...model, name: entry.id })) {
      models.push(buildCodexCatalogEntry({ ...model, name: entry.id }));
    }
  }

  return { models };
}

/**
 * Limit interactive picker entries to models present in the Codex metadata catalog.
 * @param {import("../../fireworks/models.mjs").CatalogEntry[]} pickerCatalog
 * @param {{ models: Array<{ slug: string }> } | null} codexCatalog
 */
export function filterPickerCatalogForCodex(pickerCatalog, codexCatalog) {
  if (!pickerCatalog?.length) {
    return pickerCatalog ?? [];
  }
  if (!codexCatalog) {
    return pickerCatalog;
  }
  const slugs = new Set(
    (codexCatalog.models ?? []).map((entry) => fireworksModelSlug(entry.slug)),
  );
  if (slugs.size === 0) {
    return [];
  }
  return pickerCatalog.filter((entry) => slugs.has(fireworksModelSlug(entry.id)));
}

export function codexCatalogContainsModel(catalog, modelId) {
  if (!catalog?.models?.length || !modelId) {
    return false;
  }
  const slug = fireworksModelSlug(modelId);
  return catalog.models.some((entry) => fireworksModelSlug(entry.slug) === slug);
}
