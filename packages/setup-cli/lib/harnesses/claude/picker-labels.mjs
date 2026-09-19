import { lookupModelSpec, resolveFireworksModelLabel, appendLatestRouterSuffix } from "../../fireworks/model-specs.mjs";
import {
  formatAnthropicStylePerMtok,
  FIREWORKS_PRICING_DOCS_URL,
  lookupFireworksPricing,
} from "../../fireworks/pricing.mjs";
import { autoDisplayName, prettyModelName, stripViaFireworksSuffix } from "../../fireworks/models.mjs";
import { isAutoModelId, isFirerouterModel } from "../../fireworks/model-id.mjs";

/**
 * Human-readable label for Fireworks models in Claude Code's subscription picker.
 * Prefer catalog/spec labels over raw slugs.
 * @param {string} modelId
 * @returns {string}
 */
export function fireworksModelPickerName(modelId) {
  if (isAutoModelId(modelId)) {
    return autoDisplayName(modelId);
  }
  const liveLabel = resolveFireworksModelLabel(modelId);
  if (liveLabel) {
    return stripViaFireworksSuffix(liveLabel);
  }
  const spec = lookupModelSpec(modelId);
  if (spec?.label) {
    return stripViaFireworksSuffix(appendLatestRouterSuffix(modelId, spec.label));
  }
  const pricing = lookupFireworksPricing(modelId);
  const label = pricing?.label ?? prettyModelName(modelId);
  return stripViaFireworksSuffix(appendLatestRouterSuffix(modelId, label));
}

/**
 * Claude /model subtitle: short blurb + Anthropic-style "$in/$out per Mtok" when known.
 * The row `label` carries the model name (like built-in Opus/Sonnet rows).
 */
export function fireworksModelPickerDescription(modelId) {
  if (isAutoModelId(modelId)) {
    return "Intelligent router across open models. Similar performance at lower cost.";
  }
  if (isFirerouterModel(modelId)) {
    return "Intelligent router across Claude and open models. Similar performance at lower cost.";
  }
  const pricing = lookupFireworksPricing(modelId);
  const perMtok = formatAnthropicStylePerMtok(pricing);
  if (!perMtok) {
    return `Fireworks serverless. Rates: ${FIREWORKS_PRICING_DOCS_URL}`;
  }
  const tierNote = pricing.tier === "fast" ? " · Fast tier" : "";
  return `Fireworks serverless${tierNote} · ${perMtok}`;
}

/**
 * Human-readable name + pricing blurb for a Claude Code alias slot env prefix
 * (e.g. ANTHROPIC_DEFAULT_OPUS_MODEL -> ..._NAME / ..._DESCRIPTION).
 * @param {string} modelId
 * @param {string} envPrefix
 * @returns {Record<string, string>}
 */
export function fireworksModelDisplayFields(modelId, envPrefix) {
  const description = fireworksModelPickerDescription(modelId);
  return {
    [`${envPrefix}_NAME`]: fireworksModelPickerName(modelId),
    [`${envPrefix}_DESCRIPTION`]: description,
  };
}
