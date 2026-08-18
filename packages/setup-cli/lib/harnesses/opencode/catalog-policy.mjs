import {
  DEFAULT_FIREWORKS_MODEL_LIMITS,
  fireworksInputModalities,
  lookupModelSpec,
} from "../../fireworks/model-specs.mjs";

/** OpenCode provider.models modalities field, omitted when text-only. */
export function opencodeModalitiesField(limits) {
  if (!limits?.vision) {
    return undefined;
  }
  return { input: fireworksInputModalities(limits) };
}

/** @param {{ contextWindow?: number, maxTokens?: number, vision?: boolean }} limits */
export function hasRichFireworksLimits(limits) {
  return limits.contextWindow !== DEFAULT_FIREWORKS_MODEL_LIMITS.contextWindow
    || limits.maxTokens !== DEFAULT_FIREWORKS_MODEL_LIMITS.maxTokens
    || limits.vision !== DEFAULT_FIREWORKS_MODEL_LIMITS.vision;
}

/**
 * When models.dev is unavailable, static-spec catalog models are assumed listed
 * there unless explicitly marked `modelsDev: false` (e.g. inkling).
 * @param {string} modelRef
 */
export function assumedModelsDevListed(modelRef) {
  const spec = lookupModelSpec(modelRef);
  if (spec?.modelsDev === false) {
    return false;
  }
  return Boolean(spec?.capabilities);
}
