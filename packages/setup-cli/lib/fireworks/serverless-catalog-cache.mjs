/** @typedef {{ slug: string, label: string, input: number, cachedInput: number, output: number, tier: string, source: string }} ServerlessPricing */

/** @typedef {{ entries: import("./models.mjs").CatalogEntry[], pricingById: Map<string, ServerlessPricing>, inputModalitiesById: Map<string, string[]>, routerBaseModelById: Map<string, string>, contextLengthById: Map<string, number>, supportsToolsById: Map<string, boolean> }} ServerlessCatalogSnapshot */

/** @type {ServerlessCatalogSnapshot | null} */
let activeSnapshot = null;

/**
 * @param {ServerlessCatalogSnapshot | null} snapshot
 */
export function setServerlessCatalogSnapshot(snapshot) {
  activeSnapshot = snapshot;
}

export function getServerlessCatalogSnapshot() {
  return activeSnapshot;
}

/**
 * @param {string} modelRef
 * @returns {ServerlessPricing | null}
 */
export function lookupCachedServerlessPricing(modelRef) {
  return activeSnapshot?.pricingById.get(modelRef) ?? null;
}

/**
 * @param {string} modelRef
 * @returns {string[] | null}
 */
export function lookupCachedInputModalities(modelRef) {
  return activeSnapshot?.inputModalitiesById.get(modelRef) ?? null;
}

/**
 * @param {string} modelRef
 * @returns {number | null}
 */
export function lookupCachedContextLength(modelRef) {
  return activeSnapshot?.contextLengthById.get(modelRef) ?? null;
}

/**
 * @param {string} modelRef
 * @returns {boolean | null}
 */
export function lookupCachedSupportsTools(modelRef) {
  const value = activeSnapshot?.supportsToolsById.get(modelRef);
  return value === undefined ? null : value;
}

/**
 * @param {string} routerId Full accounts/fireworks/routers/... id.
 * @returns {string | null}
 */
export function lookupCachedRouterBaseModel(routerId) {
  if (!activeSnapshot || !routerId) {
    return null;
  }
  const normalized = routerId.replace(/\[1m\]$/i, "");
  return activeSnapshot.routerBaseModelById.get(normalized) ?? null;
}

/**
 * @param {string} modelId Full accounts/fireworks/models|routers/... id.
 * @returns {import("./models.mjs").CatalogEntry | null}
 */
export function lookupCatalogEntryById(modelId) {
  if (!activeSnapshot || !modelId) {
    return null;
  }
  const normalized = modelId.replace(/\[1m\]$/i, "");
  return activeSnapshot.entries.find((entry) => entry.id === normalized) ?? null;
}
