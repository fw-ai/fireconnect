/** @typedef {"" | "claude" | "opencode"} HarnessArg */

export const HARNESS = Object.freeze({
  CLAUDE: "claude",
  OPENCODE: "opencode",
});

export const HARNESSES = Object.freeze(Object.values(HARNESS));

/**
 * @param {string} value
 * @returns {HarnessId}
 */
export function parseHarnessId(value) {
  if (!HARNESSES.includes(value)) {
    throw new Error(`Unknown harness: ${value}. Choose one of: ${HARNESSES.join(", ")}`);
  }
  return value;
}

/**
 * @param {string} value
 * @returns {HarnessId[]}
 */
export function parseHarnessIdList(value) {
  const ids = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new Error("At least one harness id is required");
  }
  return ids.map(parseHarnessId);
}
