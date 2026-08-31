/** @typedef {"" | "claude" | "opencode" | "codex" | "pi" | "cursor" | "vscode" | "deepseek"} HarnessArg */

export const HARNESS = Object.freeze({
  CLAUDE: "claude",
  OPENCODE: "opencode",
  CODEX: "codex",
  PI: "pi",
  CURSOR: "cursor",
  VSCODE: "vscode",
  DEEPSEEK: "deepseek",
});

export const HARNESSES = Object.freeze(Object.values(HARNESS));

/**
 * Harness name aliases → canonical harness id. The ChatGPT app shares
 * ~/.codex/config.toml + the fireworks-model-catalog.json with the Codex CLI, so
 * `chatgpt` is not a separate harness — it routes to `codex`. Kept here, next to
 * the canonical harness names, so the parser and help text share one source of
 * truth.
 */
export const HARNESS_ALIASES = Object.freeze({
  chatgpt: HARNESS.CODEX,
});

/**
 * Resolve a harness alias to its canonical harness id (or return the input
 * unchanged if it is not an alias).
 * @param {string} token
 * @returns {string}
 */
export function resolveHarnessAlias(token) {
  return HARNESS_ALIASES[token] ?? token;
}

/** Codex, OpenCode, Pi, and DeepSeek Harness — file-based configs (literal or legacy env ref). */
export const FILE_CONFIG_HARNESS_IDS = Object.freeze([
  HARNESS.CODEX,
  HARNESS.OPENCODE,
  HARNESS.PI,
  HARNESS.DEEPSEEK,
]);

export const FILE_CONFIG_HARNESS_SET = new Set(FILE_CONFIG_HARNESS_IDS);

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
