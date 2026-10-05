/**
 * Shared cost / cache formatting for the live meter, pickers, and reports.
 *
 * Moved from `lib/harnesses/claude/usage/format.mjs` when the Pi usage surfaces
 * needed the same figures; the Claude module re-exports this one so every
 * surface keeps quoting identical numbers. Matches the meter's cost columns and
 * cache-hit share (PR #230).
 */

export {
  formatUsageCachePct,
  formatUsageCost,
  roundCachePct,
  usageCacheHitRatio,
  usageCostDigits,
} from "../../../usage/format.mjs";
