/** Shared representation and aggregation for nullable usage costs. */

/** Cost cell for a call whose model has no rate we can look up. */
export const UNPRICED_TEXT = "n/a";

/**
 * Add two costs where either may be unknown.
 *
 * A total containing an unpriceable call is itself unknown. Null therefore
 * wins; treating it as zero would silently understate the total.
 *
 * @param {number | null} a
 * @param {number | null} b
 * @returns {number | null}
 */
export function addCost(a, b) {
  return a == null || b == null ? null : a + b;
}

/** @param {Array<number | null>} costs @returns {number | null} */
export function sumCosts(costs) {
  return costs.reduce(addCost, 0);
}

/** New zero-valued usage totals. */
export function emptyUsage() {
  return {
    input: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    webSearches: 0,
    cost: 0,
  };
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function costOrZero(value) {
  return value === undefined ? 0 : value;
}

/**
 * Add the numeric usage fields shared by calls, model tallies, and reports.
 * Metadata on either operand is intentionally ignored.
 */
export function addUsage(a, b) {
  return {
    input: numberOrZero(a?.input) + numberOrZero(b?.input),
    cacheWrite5m: numberOrZero(a?.cacheWrite5m) + numberOrZero(b?.cacheWrite5m),
    cacheWrite1h: numberOrZero(a?.cacheWrite1h) + numberOrZero(b?.cacheWrite1h),
    cacheRead: numberOrZero(a?.cacheRead) + numberOrZero(b?.cacheRead),
    output: numberOrZero(a?.output) + numberOrZero(b?.output),
    webSearches: numberOrZero(a?.webSearches) + numberOrZero(b?.webSearches),
    cost: addCost(costOrZero(a?.cost), costOrZero(b?.cost)),
  };
}

/** @param {object[]} items */
export function sumUsage(items) {
  return items.reduce(addUsage, emptyUsage());
}
