/**
 * Shared representation and aggregation for nullable usage costs.
 *
 * Moved from `lib/harnesses/claude/usage/cost.mjs` when the Pi usage surfaces
 * needed the same arithmetic; the Claude module re-exports this one so its
 * importers (and the usage folder's structure tests) are unchanged.
 */

export {
  addCost,
  addUsage,
  emptyUsage,
  rowHasUsage,
  sumCosts,
  sumUsage,
  UNPRICED_TEXT,
} from "../../../usage/cost.mjs";
