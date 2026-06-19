import claude from "./harnesses/claude.mjs";
import codex from "./harnesses/codex.mjs";
import opencode from "./harnesses/opencode.mjs";
import pi from "./harnesses/pi.mjs";
import { HARNESSES } from "./harness.mjs";

/** @typedef {import("./harness-types.mjs").HarnessAdapter} HarnessAdapter */

const REGISTRY = new Map(
  [claude, opencode, codex, pi].map((adapter) => [adapter.id, adapter]),
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
