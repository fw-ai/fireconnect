import { resolveModelDisplayMetadata } from "../../fireworks/model-display.mjs";
import {
  AUTO_INSTANT_MODEL_ID,
  FIREWORKS_MODEL_SPECS,
  isAutoModelId,
  ROUTER_SPEC_ALIASES,
} from "../../fireworks/model-specs.mjs";
import {
  autoCatalogEntry,
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
import { CLAUDE_FIREWORKS_PINNED_DEFAULTS } from "./model-profile.mjs";

// Wizard picker alternates follow each slot default (see CLAUDE_FIREWORKS_PINNED_DEFAULTS).
// minimax-latest is last in every slot — discoverable, never a default.
const MAIN_PICKER_HEAD = "kimi-latest";

const SLOT_PICKER_ALTERNATIVES = Object.freeze({
  main: ["firerouter", "auto", "glm-latest", "glm-flash-latest", "minimax-latest"],
  opus: ["kimi-latest", "deepseek-pro-latest", "firerouter", "auto", "minimax-latest"],
  sonnet: ["glm-latest", "kimi-latest", "auto", "auto-instant", "glm-flash-latest", "deepseek-flash-latest", "minimax-latest"],
  haiku: ["auto", "gpt-oss-120b", "glm-flash-latest", "qwen-plus-latest", "minimax-latest"],
  fable: ["auto", "kimi-latest", "qwen-plus-latest", "glm-latest", "minimax-latest"],
  subagent: ["auto", "gpt-oss-120b", "glm-flash-latest", "kimi-latest", "minimax-latest"],
});

export function slotPickerRecommendations(slot) {
  const head = slot === "main"
    ? MAIN_PICKER_HEAD
    : CLAUDE_FIREWORKS_PINNED_DEFAULTS[slot];
  const ordered = [];
  const seen = new Set();
  for (const slug of [head, ...(SLOT_PICKER_ALTERNATIVES[slot] ?? [])]) {
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    ordered.push(slug);
  }
  return ordered;
}

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
 * the Fireworks gateway). It's a first-class choice with no pricing/limits in
 * the FW catalog.
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
    fast: pricing?.tier === "fast",
    contextWindow: metadata.maxInputTokens ?? 128_000,
    vision: metadata.vision === true,
    tools: metadata.toolCalling !== false,
    pricing,
    router: entry.id.includes("/routers/"),
    firerouter: entry.shortId === "firerouter",
    auto: isAutoModelId(entry.shortId),
  };
}

/** Standard-key catalogs: inject synthesized `auto` rows the serverless API omits. */
function injectAutoMixCatalogRows(catalog, keyType) {
  if (keyType === "firepass") {
    return catalog;
  }
  const present = new Set(
    catalog.map((entry) => entry.shortId).filter(Boolean),
  );
  const injected = [];
  if (!present.has("auto")) {
    injected.push(autoCatalogEntry());
  }
  if (!present.has(AUTO_INSTANT_MODEL_ID)) {
    injected.push(autoCatalogEntry(AUTO_INSTANT_MODEL_ID));
  }
  return injected.length ? [...injected, ...catalog] : catalog;
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
  const withAuto = injectAutoMixCatalogRows(withRouter, keyType);
  const extras = extraModelIds
    .filter((modelId) => includeFirerouter || modelId !== "firerouter")
    .map(syntheticEntry);
  const bySlug = new Map(
    [...withAuto, ...extras]
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
  const recommendations = slotPickerRecommendations(slot);
  const rank = (model) => {
    if (model.slug === currentModel) return -300;
    if (model.slug === recommendedModel) return -200;
    if (model.slug === CLAUDE_NATIVE_MODEL_ID) {
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

function wizardVisibleSlugs({ slot, currentModel, recommendedModel }) {
  return new Set([
    currentModel,
    recommendedModel,
    CLAUDE_NATIVE_MODEL_ID,
    ...slotPickerRecommendations(slot),
  ].filter(Boolean));
}

export function suitableClaudeModelsForSlot(models, options) {
  const visible = wizardVisibleSlugs(options);
  return rankClaudeModelsForSlot(models, options).filter((model) => visible.has(model.slug));
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
    model.firerouter ? "Claude + open models" : (model.auto ? "Open-model mix" : (model.fast ? "Fast" : "Standard")),
    formatContextWindow(model.contextWindow),
    model.firerouter || model.auto ? "" : (model.vision ? "Vision" : "Text-only"),
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
