/**
 * Unified model catalog for `fireconnect demo` — any two models can race.
 *
 * Includes Fireworks serverless models, FireRouter, and Claude Code Anthropic
 * subscription slots (opus / sonnet / haiku / fable). Anthropic slots require
 * `fireconnect claude` (same routing check as status).
 */

import { defaultClaudeModelMapping } from "../harnesses/claude/model-profile.mjs";
import { stripClaudeCodeContextSuffix } from "../harnesses/claude/code-context.mjs";
import {
  FIREROUTER_ROUTER_ID,
  isClaudeNativeModel,
  isFirerouterModel,
  shortFireworksModelRef,
} from "../fireworks/model-id.mjs";
import {
  FIREWORKS_MODEL_SPECS,
  ROUTER_SPEC_ALIASES,
  catalogCacheCandidates,
  isUsableCachedServerlessPricing,
  resolveFireworksModelLabel,
} from "../fireworks/model-specs.mjs";
import {
  getServerlessCatalogSnapshot,
  lookupCachedServerlessPricing,
  lookupCatalogEntryById,
} from "../fireworks/serverless-catalog-cache.mjs";
import { lookupFireworksPricing } from "../fireworks/pricing.mjs";
import {
  firerouterCatalogEntry,
  preferLatestAliases,
} from "../fireworks/models.mjs";
import { prettyClaudeLabel, providerListPricing } from "./incumbent-detect.mjs";

/** Claude Code subscription aliases — routed through Fireworks when fireconnected. */
export const ANTHROPIC_SLOT_IDS = Object.freeze(["opus", "sonnet", "haiku", "fable"]);

const ANTHROPIC_SLOT_LABELS = Object.freeze({
  opus: "Claude Opus",
  sonnet: "Claude Sonnet",
  haiku: "Claude Haiku",
  fable: "Claude Fable",
});

const DEFAULT_LEFT_MODEL = "opus";
const DEFAULT_RIGHT_MODEL = "glm-fast-latest";

/** @type {string[] | null} */
let demoPickerFireworksIds = null;

function isDemoLatestRouterShortId(shortId) {
  return shortId.endsWith("-fast-latest")
    || (shortId.endsWith("-latest") && !shortId.endsWith("-fast-latest"));
}

/** @param {string} shortId */
function demoPickerSortKey(shortId) {
  if (shortId === "firerouter") {
    return "0";
  }
  if (shortId.endsWith("-fast-latest")) {
    return `1:${shortId.slice(0, -"-fast-latest".length)}:0:${shortId}`;
  }
  if (shortId.endsWith("-latest")) {
    return `1:${shortId.slice(0, -"-latest".length)}:1:${shortId}`;
  }
  return `2:${shortId}`;
}

/** Offline fallback when the serverless catalog has not been warmed yet. */
function staticDemoFireworksPickerIds() {
  const latestAliases = Object.keys(ROUTER_SPEC_ALIASES)
    .filter(isDemoLatestRouterShortId)
    .sort((left, right) => demoPickerSortKey(left).localeCompare(demoPickerSortKey(right)));
  return ["firerouter", ...latestAliases];
}

/**
 * Derive demo picker ids from a serverless catalog snapshot (same source as
 * `fireconnect model list`). Keeps FireRouter and `*-latest` / `*-fast-latest`
 * routers only — pinned family versions like glm-5p1 are dropped by
 * `preferLatestAliases` when stable aliases exist.
 * @param {import("../fireworks/models.mjs").CatalogEntry[]} entries
 * @returns {string[]}
 */
export function demoFireworksPickerIdsFromCatalog(entries) {
  const withFirerouter = [
    firerouterCatalogEntry(),
    ...entries.filter((entry) => entry.shortId !== "firerouter"),
  ];
  const trimmed = preferLatestAliases(withFirerouter);
  const ids = trimmed
    .map((entry) => entry.shortId)
    .filter((shortId) => shortId === "firerouter" || isDemoLatestRouterShortId(shortId));
  return [...new Set(ids)].sort((left, right) => (
    demoPickerSortKey(left).localeCompare(demoPickerSortKey(right))
  ));
}

/** Refresh picker ids from the warmed serverless catalog snapshot, if any. */
export function refreshDemoPickerFromServerlessCatalog() {
  const entries = getServerlessCatalogSnapshot()?.entries ?? [];
  demoPickerFireworksIds = entries.length > 0
    ? demoFireworksPickerIdsFromCatalog(entries)
    : null;
}

/** @returns {string[]} */
export function demoFireworksPickerIds() {
  return demoPickerFireworksIds ?? staticDemoFireworksPickerIds();
}

/** @param {string} id */
function demoFireworksKind(id) {
  return id === "firerouter" || isFirerouterModel(id) ? "firerouter" : "fireworks";
}

/**
 * @typedef {"anthropic" | "fireworks" | "firerouter"} DemoModelKind
 * @typedef {{ id: string, label: string, kind: DemoModelKind }} DemoModelEntry
 */

/** @returns {DemoModelEntry[]} */
export function demoModelCatalog() {
  /** @type {DemoModelEntry[]} */
  const out = [];
  for (const id of ANTHROPIC_SLOT_IDS) {
    out.push({ id, label: ANTHROPIC_SLOT_LABELS[id], kind: "anthropic" });
  }
  const seen = new Set(out.map((e) => e.id));
  for (const id of demoFireworksPickerIds()) {
    if (seen.has(id)) continue;
    out.push({
      id,
      label: demoModelLabel(id),
      kind: demoFireworksKind(id),
    });
    seen.add(id);
  }
  return out;
}

/** @param {string} id */
export function isAnthropicSlotModel(id) {
  return ANTHROPIC_SLOT_IDS.includes(String(id).trim().toLowerCase());
}

/** @param {string} id */
export function isDemoCatalogModel(id) {
  return demoModelCatalog().some((e) => e.id === id);
}

/** @param {string} id */
export function demoModelLabel(id) {
  const bare = String(id).trim();
  if (isAnthropicSlotModel(bare)) {
    return ANTHROPIC_SLOT_LABELS[bare] ?? prettyClaudeLabel(bare);
  }
  const catalogEntry = lookupCatalogEntryById(bare)
    ?? lookupCatalogEntryById(`accounts/fireworks/routers/${bare}`);
  if (catalogEntry?.displayName) {
    return catalogEntry.displayName;
  }
  const resolved = resolveFireworksModelLabel(bare);
  if (resolved) {
    return resolved;
  }
  if (bare === "firerouter") {
    return FIREWORKS_MODEL_SPECS.firerouter?.label ?? "FireRouter";
  }
  return FIREWORKS_MODEL_SPECS[bare]?.label ?? bare;
}

function hasLiveCachedPricing(modelRef) {
  for (const candidate of catalogCacheCandidates(modelRef)) {
    const cached = lookupCachedServerlessPricing(candidate);
    if (isUsableCachedServerlessPricing(modelRef, cached)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {NonNullable<ReturnType<typeof lookupFireworksPricing>>} pricing
 * @param {{ label: string, pricingRef: string, forceEstimated?: boolean }} opts
 */
function toDemoRateShape(pricing, { label, pricingRef, forceEstimated = false }) {
  const live = hasLiveCachedPricing(pricingRef);
  const estimated = forceEstimated || !live;
  return {
    inputPerMillion: pricing.input,
    outputPerMillion: pricing.output,
    cachedInputPerMillion: pricing.cachedInput,
    tier: pricing.tier ?? "standard",
    source: pricing.source,
    label,
    ...(estimated ? { estimated: true } : {}),
  };
}

/**
 * Rate table shape used by measurement / TUI.
 * @param {string} id
 * @returns {{ inputPerMillion: number, outputPerMillion: number, cachedInputPerMillion: number, tier: string, source: string, label: string, estimated?: boolean } | null}
 */
export function demoModelRates(id, keyType = "fireworks", slotMapping = null) {
  if (isAnthropicSlotModel(id)) {
    const defaults = defaultClaudeModelMapping(keyType);
    const mapped = slotMapping?.[id];
    const backendId = mapped
      ? shortFireworksModelRef(stripClaudeCodeContextSuffix(String(mapped).trim()))
      : defaults[id];
    if (isClaudeNativeModel(backendId)) {
      const list = providerListPricing({ provider: "anthropic", modelId: id });
      return {
        inputPerMillion: list.inputPerMillion,
        outputPerMillion: list.outputPerMillion,
        cachedInputPerMillion: list.cachedInputPerMillion,
        tier: list.tier,
        source: list.source,
        // Parallel to the Fireworks branch's "Claude Opus (via DeepSeek V4 Pro)".
        // Using list.label here renders "Claude Sonnet (Claude Sonnet)", since the
        // Anthropic rate table labels the slot with the same name.
        label: `${demoModelLabel(id)} (via Anthropic)`,
        ...(list.estimated ? { estimated: true } : {}),
      };
    }
    const p = backendId ? lookupFireworksPricing(backendId) : null;
    if (!p) {
      return null;
    }
    return toDemoRateShape(p, {
      label: `${demoModelLabel(id)} (via ${p.label})`,
      pricingRef: backendId,
    });
  }
  if (id === "firerouter" || isFirerouterModel(id)) {
    const p = lookupFireworksPricing(id)
      ?? lookupFireworksPricing(FIREROUTER_ROUTER_ID);
    if (p) {
      return toDemoRateShape(p, {
        label: p.label,
        pricingRef: id,
      });
    }
    const fallback = lookupFireworksPricing("glm-5p2-fast");
    if (!fallback) {
      return null;
    }
    return toDemoRateShape(fallback, {
      label: `${demoModelLabel(id)} (estimate)`,
      pricingRef: "glm-5p2-fast",
      forceEstimated: true,
    });
  }
  const p = lookupFireworksPricing(id);
  if (!p) {
    return null;
  }
  return toDemoRateShape(p, {
    label: p.label,
    pricingRef: id,
  });
}

export function defaultLeftModel() {
  return DEFAULT_LEFT_MODEL;
}

export function defaultRightModel() {
  return DEFAULT_RIGHT_MODEL;
}

/** Side display label: "Fireworks · GLM 5.2 Fast" or "Anthropic · Claude Opus". */
export function demoSideDisplayLabel(id) {
  if (isAnthropicSlotModel(id)) {
    return `Anthropic · ${demoModelLabel(id)}`;
  }
  if (isFirerouterModel(id) || id === "firerouter") {
    return `Fireworks · ${demoModelLabel(id)}`;
  }
  return `Fireworks · ${demoModelLabel(id)}`;
}
