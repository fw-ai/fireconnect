import { resolveModelDisplayMetadata } from "../../fireworks/model-display.mjs";
import { FIREWORKS_MODEL_SPECS, ROUTER_SPEC_ALIASES } from "../../fireworks/model-specs.mjs";
import {
  catalogWithAutomaticFirerouter,
  FIREPASS_FALLBACK_ROUTERS,
  loadServerlessCatalog,
  preferLatestAliases,
  prettyModelName,
  stripViaFireworksSuffix,
} from "../../fireworks/models.mjs";
import {
  CLAUDE_NATIVE_MODEL_ID,
  CLAUDE_NATIVE_SLOT_LABEL,
  fullFireworksResourceId,
  isClaudeNativeModel,
} from "../../fireworks/model-id.mjs";
import { attachPricing } from "../../fireworks/pricing.mjs";

const SLOT_RECOMMENDATIONS = Object.freeze({
  main: ["kimi-fast-latest", "firerouter", "glm-fast-latest", "glm-latest"],
  opus: ["glm-fast-latest", "glm-latest", "deepseek-v4-pro", "firerouter"],
  sonnet: ["glm-fast-latest", "kimi-fast-latest", "glm-latest", "deepseek-flash-latest"],
  haiku: ["deepseek-flash-latest", "kimi-fast-latest", "gpt-oss-120b", "minimax-latest"],
  fable: ["kimi-fast-latest", "kimi-latest", "qwen-plus-latest", "minimax-latest"],
  subagent: ["deepseek-flash-latest", "kimi-fast-latest", "gpt-oss-120b", "glm-fast-latest"],
});

const STATIC_MODEL_SLUGS = [
  ...Object.keys(ROUTER_SPEC_ALIASES),
  ...Object.keys(FIREWORKS_MODEL_SPECS),
];

function syntheticEntry(modelId) {
  const id = fullFireworksResourceId(modelId);
  const shortId = id.split("/").at(-1) ?? modelId;
  return {
    id,
    shortId,
    displayName: prettyModelName(shortId),
    kind: "serverless",
  };
}

/**
 * The "Claude default" slot choice. Selecting it means "don't pin
 * this slot — use Claude's own default Anthropic model for the role" (served via
 * the Fireworks gateway). Keep it out of the Fireworks-only fast/non-fast tiers;
 * it's a first-class choice with no pricing/limits in the FW catalog.
 */
function claudeNativePickerEntry() {
  const id = fullFireworksResourceId(CLAUDE_NATIVE_MODEL_ID);
  return {
    id,
    slug: CLAUDE_NATIVE_MODEL_ID,
    label: CLAUDE_NATIVE_SLOT_LABEL,
    fast: false,
    contextWindow: 1_000_000,
    vision: true,
    tools: true,
    router: false,
    firerouter: false,
    pricing: undefined,
  };
}

function offlineCatalog(keyType) {
  if (keyType === "firepass") {
    return FIREPASS_FALLBACK_ROUTERS;
  }
  return STATIC_MODEL_SLUGS.map(syntheticEntry);
}

function enrichEntry(entry) {
  const metadata = resolveModelDisplayMetadata(entry.id);
  const pricing = attachPricing(entry.id);
  return {
    id: entry.id,
    slug: entry.shortId,
    label: stripViaFireworksSuffix(entry.displayName || prettyModelName(entry.shortId)),
    fast: pricing?.tier === "fast" || /(?:-fast|-turbo|-flash)(?:-|$)/i.test(entry.shortId),
    contextWindow: metadata.maxInputTokens ?? 128_000,
    vision: metadata.vision === true,
    tools: metadata.toolCalling !== false,
    pricing,
    router: entry.id.includes("/routers/"),
    firerouter: entry.shortId === "firerouter",
  };
}

export async function loadClaudeModelPickerCatalog({
  apiKey,
  keyType,
  includeFirerouter,
  extraModelIds = [],
  loadCatalog = loadServerlessCatalog,
}) {
  let catalog;
  try {
    ({ catalog } = await loadCatalog({ apiKey, keyType }));
  } catch {
    catalog = offlineCatalog(keyType);
  }
  const withRouter = catalogWithAutomaticFirerouter(
    preferLatestAliases(catalog),
    keyType,
    { includeFirerouter },
  );
  const extras = extraModelIds
    .filter((modelId) => includeFirerouter || modelId !== "firerouter")
    .map(syntheticEntry);
  const bySlug = new Map(
    [...withRouter, ...extras]
      .map(enrichEntry)
      .filter((model) => model.tools)
      .map((model) => [model.slug, model]),
  );
  // Native-Claude slot: fw_ keys only (Fire Pass skips the setup entirely).
  if (keyType !== "firepass") {
    bySlug.set(CLAUDE_NATIVE_MODEL_ID, claudeNativePickerEntry());
  }
  return [...bySlug.values()];
}

export function rankClaudeModelsForSlot(models, {
  slot,
  currentModel,
  recommendedModel,
}) {
  const recommendations = SLOT_RECOMMENDATIONS[slot] ?? [];
  const rank = (model) => {
    if (model.slug === currentModel) return -300;
    if (model.slug === recommendedModel) return -200;
    if (model.slug === CLAUDE_NATIVE_MODEL_ID) {
      // Always keep "Claude default" in the visible top slice — in non-fast mode
      // too, where the slot's recommendation is a Fireworks alias and the native
      // entry would otherwise rank off the end of the list.
      return isClaudeNativeModel(currentModel) || isClaudeNativeModel(recommendedModel)
        ? -250
        : -150;
    }
    const recommendedIndex = recommendations.indexOf(model.slug);
    if (recommendedIndex !== -1) return -100 + recommendedIndex;
    return 0;
  };
  return [...models].sort((left, right) => (
    rank(left) - rank(right)
    || left.slug.localeCompare(right.slug)
  ));
}

export function suitableClaudeModelsForSlot(models, options, limit = 5) {
  return rankClaudeModelsForSlot(models, options).slice(0, limit);
}

export function formatContextWindow(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1_000)}K`;
}

export function modelPickerBadges(model, {
  currentModel,
  recommendedModel,
}) {
  return [
    model.slug === currentModel ? "Current" : "",
    model.slug === recommendedModel ? "Recommended" : "",
    isClaudeNativeModel(model.slug) ? CLAUDE_NATIVE_SLOT_LABEL : "",
    model.firerouter ? "Automatic routing" : (model.fast ? "Fast" : "Standard"),
    formatContextWindow(model.contextWindow),
    model.firerouter ? "" : (model.vision ? "Vision" : "Text-only"),
    model.pricing?.display ?? "",
  ].filter(Boolean);
}

export function filterClaudeModelPicker(models, term) {
  const query = term.trim().toLowerCase();
  if (!query) return models;
  return models.filter((model) => (
    model.slug.toLowerCase().includes(query)
    || model.label.toLowerCase().includes(query)
  ));
}
