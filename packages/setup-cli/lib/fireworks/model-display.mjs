import {
  DEFAULT_MODEL_CAPABILITIES,
  lookupModelSpec,
  resolveFireworksCatalog,
} from "./model-specs.mjs";

/** Default metadata for CLI pickers and VS Code rows when a model has no static spec. */
export const DEFAULT_MODEL_DISPLAY_METADATA = {
  vision: false,
  toolCalling: true,
};

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
      maxInputTokens: capabilities.contextWindow,
      maxOutputTokens: capabilities.maxOutputTokens,
      vision: capabilities.vision,
      toolCalling: capabilities.toolCalling,
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
      ? { maxInputTokens: cache.contextLength, maxOutputTokens: base.maxOutputTokens ?? 16_384 }
      : {}),
    ...(cache.inputModalities ? { vision: cache.inputModalities.includes("image") } : {}),
    ...(cache.supportsTools === null ? {} : { toolCalling: cache.supportsTools }),
  };
}
