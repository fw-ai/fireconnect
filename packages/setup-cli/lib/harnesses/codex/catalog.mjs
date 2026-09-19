import {
  FIREROUTER_TAGLINE,
} from "../../firerouter/core.mjs";
import {
  MODEL_API_OVERRIDES as MODEL_OVERRIDES,
  DEFAULT_FIREWORKS_MODEL_LIMITS,
  DEFAULT_MODEL_CAPABILITIES,
  lookupModelSpec,
  resolveFireworksModelLabel,
} from "../../fireworks/model-specs.mjs";
import { reasoningConfigFor } from "../../fireworks/reasoning.mjs";
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
import { rowSupportsImageInput } from "../../fireworks/vision.mjs";
import { planCatalogRefresh } from "../../harness/catalog-refresh.mjs";

export { MODEL_OVERRIDES };

export const CODEX_CONSTANT_FIELDS = {
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  // Fireworks gateway serves /v1/responses over HTTP SSE only — it has no
  // websocket upgrade — so Codex must not try websockets first. With true,
  // Codex desktop attempts wss, retries ("Reconnecting 5/5"), then fails the
  // turn with "stream disconnected before completion: stream closed before
  // response.completed".
  prefer_websockets: false,
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
};

// Auto-compact at 80% of the window, not Codex's 90% default for an unset
// limit: the compaction RPC resends the full history plus instructions/tool
// schemas (~130k tokens of overhead on 1M-token sessions), so at 90% it
// already exceeds the gateway limit and the session can never compact again.
// 80% also passes through Codex's 90% clamp on explicit limits unclamped.
export const CODEX_AUTO_COMPACT_FRACTION = 0.8;

/**
 * Explicit auto-compact threshold for one catalog row. Never 0, which Codex
 * reads as "disable auto-compaction" — unknown windows get null instead.
 * @param {number} contextLength
 * @returns {number | null}
 */
export function codexAutoCompactTokenLimit(contextLength) {
  if (!Number.isFinite(contextLength) || contextLength <= 0) {
    return null;
  }
  return Math.floor(contextLength * CODEX_AUTO_COMPACT_FRACTION);
}

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

/** First usable context window: 0 means "unknown", so fall through to the next source. */
function firstUsableContextLength(...values) {
  return values.find((value) => Number.isFinite(value) && value > 0)
    ?? DEFAULT_FIREWORKS_MODEL_LIMITS.contextWindow;
}

function effectiveModelFields(model) {
  const overrides = MODEL_OVERRIDES[model.name] ?? {};
  return {
    contextLength: firstUsableContextLength(
      overrides.contextLength,
      model.contextLength,
      model.context_length,
    ),
    supportsImageInput: overrides.supportsImageInput
      ?? rowSupportsImageInput(model),
    supportsTools: overrides.supportsTools
      ?? model.supportsTools
      ?? model.supports_tools
      ?? DEFAULT_MODEL_CAPABILITIES.toolCalling,
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
    auto_compact_token_limit: codexAutoCompactTokenLimit(contextLength),
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

/** Whether a catalog row has a usable context window. */
export function codexRowHasUsableContext(row) {
  return (row?.context_window ?? row?.max_context_window ?? 0) > 0;
}

function findSnapshotEntry(snapshot, modelId) {
  if (!modelId) {
    return null;
  }
  if (modelId.startsWith("accounts/fireworks/")) {
    return (snapshot?.entries ?? []).find((entry) => entry?.id === modelId) ?? null;
  }
  return (snapshot?.entries ?? []).find((entry) => entry?.shortId === modelId) ?? null;
}

function codexRowMatchesModelId(row, modelId) {
  return codexCatalogContainsModel({ models: [row] }, modelId);
}

/** Remove rows no longer present in the serverless catalog. */
export function pruneCodexCatalogRows(models = [], snapshot = null) {
  return models.filter((row) => {
    const slug = typeof row?.slug === "string" ? row.slug : "";
    if (!slug || isCodexUnsupportedMiniMaxModel(slug)) {
      return false;
    }
    return isFirerouterModelPattern(slug)
      || isAutoModelId(slug)
      || Boolean(findSnapshotEntry(snapshot, slug));
  });
}

/**
 * Re-`on` refresh of a managed catalog, per the shared catalog-refresh policy:
 * prune delisted rows, append rows newly served by serverless, and re-render
 * kept rows from the fresh catalog (display names / context windows drift).
 * The catalog file is fireconnect-owned, so the picker tracks the live catalog
 * instead of going stale until the next fresh setup or upgrade.
 * Kept rows keep their position; only their metadata is replaced.
 */
export function refreshCodexCatalogRows(models = [], snapshot = null, freshModels = []) {
  const freshBySlug = new Map();
  for (const row of freshModels) {
    const slug = typeof row?.slug === "string" ? row.slug : "";
    if (slug && !freshBySlug.has(slug)) {
      freshBySlug.set(slug, row);
    }
  }
  const plan = planCatalogRefresh({
    currentIds: models.map((row) => (typeof row?.slug === "string" ? row.slug : "")),
    freshIds: [...freshBySlug.keys()],
    keepUnserved: (slug) => (
      !isCodexUnsupportedMiniMaxModel(slug)
      && (isFirerouterModelPattern(slug)
        || isAutoModelId(slug)
        || Boolean(findSnapshotEntry(snapshot, slug)))
    ),
  });
  const keptSet = new Set(plan.kept);
  const emitted = new Set();
  return [
    ...models
      .filter((row) => {
        const slug = typeof row?.slug === "string" ? row.slug : "";
        if (!keptSet.has(slug) || emitted.has(slug)) {
          return false;
        }
        emitted.add(slug);
        return true;
      })
      .map((row) => freshBySlug.get(row.slug) ?? row),
    ...plan.added.map((slug) => freshBySlug.get(slug)).filter(Boolean),
  ];
}

/** Add the selected model without changing existing rows. */
export function addCodexSelectedModel(models, catalog, modelId) {
  if (models.some((row) => codexRowMatchesModelId(row, modelId))) {
    return models;
  }
  let entry;
  if (isFirerouterModelPattern(modelId)) {
    entry = buildCodexFirerouterCatalogEntry(modelId);
  } else if (isAutoModelId(modelId)) {
    entry = buildCodexAutoCatalogEntry(modelId);
  } else {
    entry = catalog?.models?.find((row) => codexRowMatchesModelId(row, modelId));
  }
  return entry ? [...models, entry] : models;
}

const EXCLUDED_KINDS = new Set(["EMBEDDING_MODEL", "FLUMINA_BASE_MODEL"]);

function isCodexSuitable(model) {
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

function snapshotModelMetadata(snapshot, modelId) {
  const entry = snapshot.entries.find((candidate) => candidate.id === modelId);
  if (!entry) {
    return null;
  }
  const inputModalities = snapshot.inputModalitiesById.get(modelId) ?? [];
  return {
    name: modelId,
    displayName: entry.displayName,
    contextLength: snapshot.contextLengthById.get(modelId) ?? 0,
    supportsImageInput: rowSupportsImageInput({ inputModalities }),
    supportsTools: snapshot.supportsToolsById.get(modelId) ?? DEFAULT_MODEL_CAPABILITIES.toolCalling,
  };
}

/** Build Codex metadata from the serverless snapshot. */
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
    // The registerable set synthesizes the `auto` mix (see
    // catalogWithAutomaticAuto); it has no serverless row to borrow metadata
    // from, so it gets its static-spec row like an explicit `--model auto`.
    if (isAutoModelId(entry.id) || isAutoModelId(entry.shortId)) {
      models.push(buildCodexAutoCatalogEntry(
        canonicalAutoModelId(entry.shortId) || canonicalAutoModelId(entry.id) || AUTO_MODEL_ID,
      ));
      continue;
    }
    if (entry.id === FIREROUTER_ROUTER_ID) {
      models.push(buildCodexFirerouterCatalogEntry(FIREROUTER_ROUTER_ID));
      continue;
    }
    if (entry.baseModelId) {
      if (isCodexUnsupportedMiniMaxModel(entry.id)
        || isCodexUnsupportedMiniMaxModel(entry.baseModelId)) {
        continue;
      }
      const baseModel = byName.get(entry.baseModelId)
        ?? snapshotModelMetadata(snapshot, entry.baseModelId);
      if (baseModel) {
        // Flat API rows are keyed `id`, not `name`; stamp the resource id on so
        // the catalog entry builder (reasoningConfigFor etc.) sees a model ref.
        models.push(
          buildCodexCatalogEntryForRouter(entry.id, { ...baseModel, name: entry.baseModelId }, routerDisplayName(entry.id)),
        );
      }
      continue;
    }

    const model = byName.get(entry.id) ?? snapshotModelMetadata(snapshot, entry.id);
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
  return catalog.models.some(
    (entry) => shortFireworksModelRef(entry.slug) === stored,
  );
}
