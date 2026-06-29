import {
  FIREWORKS_MODEL_SPECS,
  FIREWORKS_PRICING_DOCS_URL,
  lookupModelSpec,
  resolveSpecSlug,
} from "./fireworks-model-specs.mjs";

export { FIREWORKS_PRICING_DOCS_URL };

/**
 * Standard serverless rates (USD per 1M tokens) from Fireworks docs.
 */
export const FIREWORKS_STANDARD_PRICING = Object.fromEntries(
  Object.entries(FIREWORKS_MODEL_SPECS)
    .filter(([, spec]) => spec.pricing)
    .map(([slug, spec]) => [slug, { label: spec.label, ...spec.pricing }]),
);

/**
 * @param {string} modelRef Full model/router ID or short ID.
 * @returns {{ slug: string, label: string, input: number, cachedInput: number, output: number, tier: string, source: string } | null}
 */
export function lookupFireworksPricing(modelRef) {
  const spec = lookupModelSpec(modelRef);
  if (!spec?.pricing) {
    return null;
  }

  return {
    slug: resolveSpecSlug(modelRef),
    label: spec.label,
    ...spec.pricing,
    tier: spec.pricing.tier ?? "standard",
    source: FIREWORKS_PRICING_DOCS_URL,
  };
}

function formatUsd(value) {
  const text = value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `$${text}`;
}

/** Compact in/out display for tables: "$1.40 / $4.40" */
export function formatPricingInOut(pricing) {
  if (!pricing) {
    return "—";
  }
  return `${formatUsd(pricing.input)} / ${formatUsd(pricing.output)}`;
}

/** Full standard-tier line for status output. */
export function formatPricingLine(pricing) {
  if (!pricing) {
    return null;
  }
  const tierNote = pricing.tier === "fast" ? " (fast)" : "";
  return `${formatUsd(pricing.input)} in / ${formatUsd(pricing.cachedInput)} cached in / ${formatUsd(pricing.output)} out per Mtok${tierNote}`;
}

/** Description for Claude Code custom model picker (description field only). */
export function formatPricingDescription(pricing) {
  if (!pricing) {
    return `Fireworks serverless model. Rates: ${FIREWORKS_PRICING_DOCS_URL}`;
  }
  const tierNote = pricing.tier === "fast" ? " Fast tier." : "";
  return `Fireworks serverless (${pricing.label}): ${formatUsd(pricing.input)} in / ${formatUsd(pricing.output)} out per Mtok (${formatUsd(pricing.cachedInput)} cached in).${tierNote}`;
}

export function attachPricing(modelRef) {
  const pricing = lookupFireworksPricing(modelRef);
  if (!pricing) {
    return null;
  }
  return {
    inputPerMillion: pricing.input,
    cachedInputPerMillion: pricing.cachedInput,
    outputPerMillion: pricing.output,
    tier: pricing.tier,
    label: pricing.label,
    source: pricing.source,
    display: formatPricingInOut(pricing),
  };
}

export const CLAUDE_CODE_PRICING_DISCLAIMER = (
  "Claude Code /model cost estimates use Anthropic list prices, not Fireworks. "
  + "Use fireconnect claude status or model list for Fireworks rates."
);
