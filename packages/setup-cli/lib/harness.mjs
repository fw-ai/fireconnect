/** @typedef {"" | "claude" | "opencode"} HarnessArg */

export const HARNESS = Object.freeze({
  CLAUDE: "claude",
  OPENCODE: "opencode",
});

export const HARNESSES = Object.freeze(Object.values(HARNESS));

/** Default harness for commands that require a single target (e.g. model select). */
export const DEFAULT_HARNESS = HARNESS.CLAUDE;

export function parseHarness(value) {
  if (!HARNESSES.includes(value)) {
    throw new Error(`--harness must be one of: ${HARNESSES.join(", ")}, got: ${value}`);
  }
  return value;
}
