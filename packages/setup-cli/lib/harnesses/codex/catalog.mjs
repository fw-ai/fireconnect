import {
  FIREROUTER_TAGLINE,
} from "../../firerouter/core.mjs";
import { MODEL_API_OVERRIDES as MODEL_OVERRIDES, lookupModelSpec, resolveFireworksModelLabel } from "../../fireworks/model-specs.mjs";
import { autoDisplayName, buildServerlessCatalogSnapshot, firerouterDisplayName, prettyModelName } from "../../fireworks/models.mjs";
import {
  AUTO_INSTANT_MODEL_ID,
  AUTO_MODEL_ID,
  FIREROUTER_ROUTER_ID,
  canonicalAutoModelId,
  fireworksModelSlug,
  isAutoModelId,
  isFirerouterModelPattern,
  isFirerouterModel,
  shortFireworksModelRef,
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

/** Standard ladder: every reasoning model offers at least these three tiers. */
const STANDARD_LEVELS = [reasoningLevel("low"), reasoningLevel("medium"), reasoningLevel("high")];
/** Ladder for models that also expose the deepest tier. */
const MAX_LEVELS = [...STANDARD_LEVELS, reasoningLevel("max")];

/*
 * Per-model reasoning tiers offered in the Codex/ChatGPT app effort picker.
 *
 * The app only renders a selectable Effort row when a model advertises more than
 * one tier, so every entry exposes the full low/medium/high ladder (the Fireworks
 * API accepts these values for reasoning models) and adds `max` only where the
 * docs confirm it (GLM 5.2, DeepSeek V4 Pro/Flash). Some models may treat the
 * lower tiers as a no-op; the tier is still selectable rather than absent.
 *
 * `default` stays `high` for every model.
 */
export const MODEL_REASONING = {
  "accounts/fireworks/models/glm-5p2": {
    default: "high",
    levels: MAX_LEVELS,
  },
  "accounts/fireworks/models/deepseek-v4-flash": {
    default: "high",
    levels: MAX_LEVELS,
  },
  "accounts/fireworks/models/deepseek-v4-pro": {
    default: "high",
    levels: MAX_LEVELS,
  },
  "accounts/fireworks/models/kimi-k2p6": {
    default: "high",
    levels: STANDARD_LEVELS,
  },
  "accounts/fireworks/models/kimi-k2p7-code": {
    default: "high",
    levels: STANDARD_LEVELS,
  },
  "accounts/fireworks/models/minimax-m2p7": {
    default: "high",
    levels: STANDARD_LEVELS,
  },
  "accounts/fireworks/models/minimax-m3": {
    default: "high",
    levels: STANDARD_LEVELS,
  },
  "accounts/fireworks/models/gpt-oss-120b": {
    default: "high",
    levels: STANDARD_LEVELS,
  },
  "accounts/fireworks/models/nemotron-3-ultra-nvfp4": {
    default: "high",
    levels: STANDARD_LEVELS,
  },
  "accounts/fireworks/models/qwen3p7-plus": {
    default: "high",
    levels: STANDARD_LEVELS,
  },
  // Kimi K3 / K3 Fast (current Kimi generation; supersedes kimi-k2p6 / kimi-k2p7-code).
  "accounts/fireworks/models/kimi-k3": {
    default: "high",
    levels: STANDARD_LEVELS,
  },
};

const DEFAULT_REASONING = {
  default: "high",
  levels: STANDARD_LEVELS,
};

/**
 * Resolve the reasoning config for a model. Tries the exact full ref, then —
 * because the live serverless catalog returns versioned slugs (e.g.
 * `deepseek-v4-flash-0731`) while {@link MODEL_REASONING} is keyed by the
 * unversioned base ref (`deepseek-v4-flash`) — strips a trailing pure-numeric
 * version suffix and retries. Falls back to {@link DEFAULT_REASONING}.
 * @param {string} modelRef full model ref, e.g. `accounts/fireworks/models/deepseek-v4-flash-0731`
 * @returns {{ default: string, levels: object[] }}
 */
function reasoningConfigFor(modelRef) {
  if (MODEL_REASONING[modelRef]) {
    return MODEL_REASONING[modelRef];
  }
  const baseRef = modelRef.replace(/-\d+$/, "");
  if (baseRef !== modelRef && MODEL_REASONING[baseRef]) {
    return MODEL_REASONING[baseRef];
  }
  return DEFAULT_REASONING;
}

export const DEPRECATED_MODELS = new Set([
  "accounts/fireworks/models/glm-5p1",
  "accounts/fireworks/routers/glm-5p1-fast",
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

  const reasoning = reasoningConfigFor(model.name);
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

/**
 * Codex catalog row for firerouter or a selected firerouter* model.
 * Shares FireRouter static metadata (context, vision, tools, tagline).
 */
export function buildCodexFirerouterCatalogEntry(modelId = FIREROUTER_ROUTER_ID) {
  const spec = lookupModelSpec(modelId);
  const stored = shortFireworksModelRef(modelId);
  const exact = isFirerouterModel(modelId);
  return {
    ...buildCodexCatalogEntry({
      name: FIREROUTER_ROUTER_ID,
      displayName: exact ? (spec?.label ?? "FireRouter") : firerouterDisplayName(stored),
      description: FIREROUTER_TAGLINE,
      contextLength: spec?.capabilities.contextWindow ?? 0,
      supportsImageInput: spec?.capabilities.vision ?? false,
      supportsTools: spec?.capabilities.toolCalling ?? true,
    }),
    // Path-shaped IDs must keep the full short ref; last-segment slug would collide.
    slug: exact ? "firerouter" : stored,
  };
}

export const AUTO_TAGLINE = "Routes each request across Fireworks open models.";
export const AUTO_INSTANT_TAGLINE =
  "Routes each request across the fastest Fireworks open models.";

/** Codex catalog row for `auto` / `auto-*`, built from that mix's spec. */
export function buildCodexAutoCatalogEntry(modelId = AUTO_MODEL_ID) {
  const spec = lookupModelSpec(modelId);
  const stored = canonicalAutoModelId(modelId) || shortFireworksModelRef(modelId);
  return {
    ...buildCodexCatalogEntry({
      name: stored,
      displayName: autoDisplayName(stored),
      description: stored === AUTO_INSTANT_MODEL_ID ? AUTO_INSTANT_TAGLINE : AUTO_TAGLINE,
      contextLength: spec?.capabilities.contextWindow ?? 0,
      supportsImageInput: spec?.capabilities.vision ?? false,
      supportsTools: spec?.capabilities.toolCalling ?? true,
    }),
    slug: stored,
  };
}

/**
 * Models the gateway serves without a serverless catalog row (`firerouter*`
 * patterns, `auto` / `auto-*`) get a spec-derived metadata row appended so Codex can
 * resolve their context window.
 */
export function ensureCodexOffCatalogEntry(catalog, modelId) {
  if (codexCatalogContainsModel(catalog, modelId)) {
    return catalog;
  }
  const entry = isFirerouterModelPattern(modelId)
    ? buildCodexFirerouterCatalogEntry(modelId)
    : (isAutoModelId(modelId) ? buildCodexAutoCatalogEntry(modelId) : null);
  if (!entry) {
    return catalog;
  }
  return {
    ...(catalog ?? {}),
    models: [...(catalog?.models ?? []), entry],
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
      models.push(buildCodexFirerouterCatalogEntry(FIREROUTER_ROUTER_ID));
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
  const stored = shortFireworksModelRef(modelId);
  const last = fireworksModelSlug(modelId);
  return catalog.models.some(
    (entry) => entry.slug === stored || fireworksModelSlug(entry.slug) === last,
  );
}
