/**
 * Shared cost / cache formatting for the live meter and session/agent pickers.
 * Matches the meter’s cost columns and cache-hit share (PR #230).
 */

/**
 * A single call's cost, at 4 decimals.
 *
 * A cheap GLM call really is worth $0.0018, so rounding to cents would erase the
 * row entirely. Only per-call figures want this precision — see
 * `formatLiveCostTotal` for anything summed.
 *
 * @param {number} cost
 * @returns {string}
 */
export function formatLiveCost(cost) {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.0000";
  if (cost < 0.0001) return `$${cost.toExponential(1)}`;
  return `$${cost.toFixed(4)}`;
}

/**
 * A summed cost, at 2 decimals — the precision you'd actually quote.
 *
 * Nobody reads the fourth decimal of a $116.9562 session; the extra digits just
 * make a column of totals harder to scan. But a real charge must not round to
 * nothing, so anything under half a cent reads `<$0.01` instead of `$0.00` —
 * a subagent that cost $0.0072 did cost something.
 *
 * @param {number} cost
 * @returns {string}
 */
export function formatLiveCostTotal(cost) {
  const n = Number(cost);
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.005) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/**
 * Cache-hit ratio of prompt tokens, or null when there is no prompt.
 *
 * @param {{
 *   input?: number,
 *   cacheRead?: number,
 *   cacheWrite?: number,
 *   cacheWrite5m?: number,
 *   cacheWrite1h?: number,
 * }} totals
 * @returns {number | null}
 */
export function usageCacheHitRatio(totals = {}) {
  const input = Number(totals.input) || 0;
  const cacheRead = Number(totals.cacheRead) || 0;
  const cacheWrite = Number.isFinite(Number(totals.cacheWrite))
    ? Number(totals.cacheWrite)
    : (Number(totals.cacheWrite5m) || 0) + (Number(totals.cacheWrite1h) || 0);
  const prompt = input + cacheRead + cacheWrite;
  if (prompt <= 0) return null;
  return cacheRead / prompt;
}

/**
 * Round a cache-hit ratio to whole percent WITHOUT inventing 0% or 100%.
 *
 * `Math.round` alone reports a false perfect hit: a turn with 81 fresh tokens
 * against 21.7M cached is 99.85%, which rounds to "100%" and claims nothing was
 * billed at the full prompt rate — while those fresh tokens plus 31.9k cache
 * writes were charged. The reverse end lies the same way, printing "0%" for a
 * cache that did return tokens.
 *
 * So 100% is reserved for `cacheRead === prompt` and 0% for `cacheRead === 0`;
 * everything strictly between clamps to 1..99. The rounding error is at most one
 * percentage point, but the claim "perfectly cached" is qualitatively different
 * from "almost perfectly cached" when the number exists to explain a bill.
 *
 * @param {number} ratio 0..1
 * @returns {number} whole percent, 0..100
 */
export function roundCachePct(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  if (ratio >= 1) return 100;
  return Math.min(99, Math.max(1, Math.round(ratio * 100)));
}

/**
 * Cache-hit share as a display string (e.g. `90%`, or `—` when unknown).
 *
 * @param {{
 *   input?: number,
 *   cacheRead?: number,
 *   cacheWrite?: number,
 *   cacheWrite5m?: number,
 *   cacheWrite1h?: number,
 * }} totals
 */
export function formatUsageCachePct(totals = {}) {
  const ratio = usageCacheHitRatio(totals);
  if (ratio == null) return "—";
  return `${roundCachePct(ratio)}%`;
}
