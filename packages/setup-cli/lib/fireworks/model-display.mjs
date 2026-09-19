import {
  DEFAULT_FIREWORKS_MODEL_LIMITS,
  DEFAULT_MODEL_CAPABILITIES,
  lookupModelSpec,
  resolveFireworksCatalog,
  resolveFireworksModelLabel,
} from "./model-specs.mjs";
import {
  fullFireworksResourceId,
  isAutoModelId,
  isFirerouterModelPattern,
} from "./model-id.mjs";
import { lookupCatalogEntryById } from "./serverless-catalog-cache.mjs";
import { autoDisplayName, firerouterDisplayName, prettyModelName } from "./models.mjs";

/** Default metadata for CLI pickers and VS Code rows when a model has no static spec. */
export const DEFAULT_MODEL_DISPLAY_METADATA = {
  vision: false,
  toolCalling: true,
};

/** Resolve a catalog display name, preferring live metadata. */
export function resolveManagedDisplayName(modelId) {
  if (isFirerouterModelPattern(modelId)) {
    return firerouterDisplayName(modelId);
  }
  if (isAutoModelId(modelId)) {
    return autoDisplayName(modelId);
  }
  return lookupCatalogEntryById(fullFireworksResourceId(modelId))?.displayName
    ?? resolveFireworksModelLabel(modelId)
    ?? prettyModelName(modelId);
}

/**
 * Map a Fireworks model ref to the display metadata shape used by VS Code
 * chatLanguageModels.json, model pickers, and catalog listings.
 * @param {string} modelRef
 * @returns {{
 *   maxInputTokens?: number,
 *   maxOutputTokens?: number,
 *   vision: boolean,
 *   toolCalling: boolean,
 * }}
 */
export function resolveModelDisplayMetadata(modelRef) {
  const spec = lookupModelSpec(modelRef);
  const catalog = resolveFireworksCatalog(modelRef);
  const { cache, limits, toolCalling } = catalog;
  const capabilities = spec?.capabilities;

  if (!capabilities && !cache.contextLength && !cache.inputModalities && cache.supportsTools === null) {
    return { ...DEFAULT_MODEL_DISPLAY_METADATA };
  }

  const base = capabilities
    ? {
      maxInputTokens: capabilities.contextWindow ?? DEFAULT_FIREWORKS_MODEL_LIMITS.contextWindow,
      maxOutputTokens: capabilities.maxOutputTokens ?? DEFAULT_FIREWORKS_MODEL_LIMITS.maxTokens,
      vision: capabilities.vision ?? false,
      toolCalling: capabilities.toolCalling ?? DEFAULT_MODEL_CAPABILITIES.toolCalling,
    }
    : {
      maxInputTokens: limits.contextWindow,
      maxOutputTokens: limits.maxTokens,
      vision: limits.vision,
      toolCalling: toolCalling ?? DEFAULT_MODEL_CAPABILITIES.toolCalling,
    };

  if (!cache.inputModalities && !cache.contextLength && cache.supportsTools === null) {
    return base;
  }

  return {
    ...base,
    ...(cache.contextLength
      ? { maxInputTokens: cache.contextLength, maxOutputTokens: base.maxOutputTokens ?? DEFAULT_FIREWORKS_MODEL_LIMITS.maxTokens }
      : {}),
    ...(cache.inputModalities ? { vision: cache.inputModalities.includes("image") } : {}),
    ...(cache.supportsTools === null ? {} : { toolCalling: cache.supportsTools }),
  };
}
