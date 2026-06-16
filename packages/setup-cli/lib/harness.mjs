/** @typedef {"claude" | "opencode"} HarnessId */

export const HARNESS = Object.freeze({
  CLAUDE: "claude",
  OPENCODE: "opencode",
});

export const HARNESSES = Object.freeze(Object.values(HARNESS));

export const DEFAULT_HARNESS = HARNESS.CLAUDE;

export function parseHarness(value) {
  if (!HARNESSES.includes(value)) {
    throw new Error(`--harness must be one of: ${HARNESSES.join(", ")}, got: ${value}`);
  }
  return value;
}
