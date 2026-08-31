/**
 * Canonical pricing for Claude Code usage records.
 *
 * Both transcript reports/statusline and the demo runner call this module.
 * A rate lookup either produces a real provider rate or no cost (`null`); there
 * is deliberately no reference-price fallback.
 */

import { providerListPricing } from "../../../demo/list-pricing.mjs";
import {
  isAnthropicModelId,
  isClaudeModelAlias,
  shortFireworksModelRef,
} from "../../../fireworks/model-id.mjs";
import { lookupFireworksPricing } from "../../../fireworks/pricing.mjs";

const WEB_SEARCH_PER_1K = 10;
const US_INFERENCE_GEO_MULTIPLIER = 1.1;
const BATCH_DISCOUNT = 0.5;

function displayModel(model) {
  return shortFireworksModelRef(model);
}

function fireworksPriceFor(model) {
  const pricing = lookupFireworksPricing(model);
  if (!pricing) {
    return null;
  }
  return {
    inputPerMillion: pricing.input,
    cacheWrite5mPerMillion: 0,
    cacheWrite1hPerMillion: 0,
    cacheReadPerMillion: pricing.cachedInput,
    outputPerMillion: pricing.output,
    label: pricing.label,
    source: pricing.source,
    estimated: false,
  };
}

function anthropicPriceFor(model, usage) {
  const rate = providerListPricing({
    provider: "anthropic",
    modelId: model,
    speed: usage.speed,
  });
  // providerListPricing returns a plausible reference row for unknown ids.
  // That is useful for broad incumbent discovery, but not for measured usage:
  // only a concrete list-price match may become a dollar figure.
  if (!rate || rate.tier === "subscription" || rate.estimated) {
    return null;
  }
  return {
    inputPerMillion: rate.inputPerMillion,
    cacheWrite5mPerMillion: rate.cacheWrite5mPerMillion,
    cacheWrite1hPerMillion: rate.cacheWrite1hPerMillion,
    cacheReadPerMillion: rate.cacheReadPerMillion,
    outputPerMillion: rate.outputPerMillion,
    label: rate.label,
    source: rate.source,
    estimated: rate.estimated,
  };
}

/**
 * Rates for one call, or null when we have none.
 *
 * `providerListPricing` returns a Claude reference rate for any unknown id, so
 * it is only called after the id has been classified as Anthropic.
 */
function priceFor(model, usage) {
  const fireworksPrice = fireworksPriceFor(model);
  const price = fireworksPrice
    ?? ((isAnthropicModelId(model) || isClaudeModelAlias(model))
      ? anthropicPriceFor(model, usage)
      : null);
  if (!price) {
    return null;
  }

  return { ...price, fireworks: Boolean(fireworksPrice) };
}

function numberValue(value) {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Price one Claude Code usage record from real Fireworks serverless or
 * Anthropic list rates.
 *
 * Unknown rates preserve usage but return `cost: null`, never an estimate.
 *
 * @param {string} model
 * @param {object} usage
 */
export function computeClaudeUsageCost(model, usage = {}) {
  const price = priceFor(model, usage);
  const input = numberValue(usage.input_tokens);
  const cacheRead = numberValue(usage.cache_read_input_tokens);
  const output = numberValue(usage.output_tokens);
  const cacheCreation = usage.cache_creation && typeof usage.cache_creation === "object"
    ? usage.cache_creation
    : null;
  const cacheWrite5m = cacheCreation
    ? numberValue(cacheCreation.ephemeral_5m_input_tokens)
    : numberValue(usage.cache_creation_input_tokens);
  const cacheWrite1h = cacheCreation
    ? numberValue(cacheCreation.ephemeral_1h_input_tokens)
    : 0;
  const webSearches = numberValue(usage.server_tool_use?.web_search_requests);

  if (!price) {
    return {
      model,
      displayModel: displayModel(model),
      fireworks: false,
      priced: false,
      input,
      cacheWrite5m,
      cacheWrite1h,
      cacheRead,
      output,
      webSearches,
      cost: null,
      estimated: false,
      rates: null,
    };
  }

  let tokenCost = (
    input * price.inputPerMillion
    + cacheWrite5m * price.cacheWrite5mPerMillion
    + cacheWrite1h * price.cacheWrite1hPerMillion
    + cacheRead * price.cacheReadPerMillion
    + output * price.outputPerMillion
  ) / 1_000_000;

  if (usage.inference_geo === "us") {
    tokenCost *= US_INFERENCE_GEO_MULTIPLIER;
  }
  if (usage.service_tier === "batch") {
    tokenCost *= BATCH_DISCOUNT;
  }

  return {
    model,
    displayModel: displayModel(model),
    fireworks: price.fireworks,
    priced: true,
    input,
    cacheWrite5m,
    cacheWrite1h,
    cacheRead,
    output,
    webSearches,
    cost: tokenCost + (webSearches / 1000) * WEB_SEARCH_PER_1K,
    estimated: price.estimated,
    rates: {
      inputPerMillion: price.inputPerMillion,
      cacheWrite5mPerMillion: price.cacheWrite5mPerMillion,
      cacheWrite1hPerMillion: price.cacheWrite1hPerMillion,
      cacheReadPerMillion: price.cacheReadPerMillion,
      outputPerMillion: price.outputPerMillion,
      webSearchPer1k: WEB_SEARCH_PER_1K,
      label: price.label,
      source: price.source,
      estimated: price.estimated,
    },
  };
}
