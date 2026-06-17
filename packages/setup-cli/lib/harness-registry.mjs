import claude from "./harnesses/claude.mjs";
import opencode from "./harnesses/opencode.mjs";
import { HARNESSES } from "./harness.mjs";

/** @typedef {import("./harness-types.mjs").HarnessAdapter} HarnessAdapter */

const REGISTRY = new Map(
  [claude, opencode].map((adapter) => [adapter.id, adapter]),
);

/**
 * @param {string} id
 * @returns {HarnessAdapter}
 */
export function getHarness(id) {
  const adapter = REGISTRY.get(id);
  if (!adapter) {
    throw new Error(`Unknown harness: ${id}. Choose one of: ${HARNESSES.join(", ")}`);
  }
  return adapter;
}

/**
 * @returns {HarnessAdapter[]}
 */
export function listHarnesses() {
  return [...REGISTRY.values()];
}
