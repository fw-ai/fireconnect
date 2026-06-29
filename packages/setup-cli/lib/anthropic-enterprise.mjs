import path from "node:path";
import process from "node:process";
import { readJsonIfExists } from "./fireconnect-core.mjs";
import { HARNESS } from "./harness.mjs";
import { OPENCODE_ANTHROPIC_PROVIDER_ID } from "./opencode-firerouter-core.mjs";

export const CLAUDE_CREDENTIALS_FILENAME = ".credentials.json";
export const OPENCODE_AUTH_RELATIVE_PATH = ".local/share/opencode/auth.json";

/** @typedef {"none" | "api-key" | "oauth"} AnthropicAuthKind */

const OAUTH_TOKEN_KEYS = [
  "access",
  "accessToken",
  "access_token",
  "token",
  "refreshToken",
  "refresh_token",
];

/**
 * @param {unknown} value
 */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * @param {string} key
 */
export function isAnthropicShapedKey(key) {
  return typeof key === "string" && key.trim().startsWith("sk-ant-");
}

/**
 * OAuth entries must carry at least one non-empty token field.
 * @param {unknown} entry
 */
export function hasOAuthTokenMaterial(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  return OAUTH_TOKEN_KEYS.some((key) => nonEmptyString(/** @type {Record<string, unknown>} */ (entry)[key]));
}

/**
 * Classify an OpenCode auth.json `anthropic` entry.
 * @param {unknown} entry
 * @returns {AnthropicAuthKind}
 */
export function classifyOpencodeAnthropicEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return "none";
  }
  const record = /** @type {Record<string, unknown>} */ (entry);
  if (record.type === "api") {
    return isAnthropicShapedKey(record.key) ? "api-key" : "none";
  }
  if (record.type === "oauth" || hasOAuthTokenMaterial(record)) {
    return hasOAuthTokenMaterial(record) ? "oauth" : "none";
  }
  return "none";
}

/**
 * Classify Claude Code's ~/.claude/.credentials.json for Anthropic enterprise auth.
 * @param {unknown} creds
 * @returns {AnthropicAuthKind}
 */
export function classifyClaudeCredentials(creds) {
  if (!creds || typeof creds !== "object") {
    return "none";
  }
  const record = /** @type {Record<string, unknown>} */ (creds);
  const candidates = [record.claudeAiOauth, record.oauth, record.anthropic];
  for (const candidate of candidates) {
    if (hasOAuthTokenMaterial(candidate)) {
      return "oauth";
    }
  }
  return "none";
}

/**
 * @param {string} home
 */
export function claudeCredentialsPath(home) {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) {
    return path.join(configDir, CLAUDE_CREDENTIALS_FILENAME);
  }
  return path.join(home, ".claude", CLAUDE_CREDENTIALS_FILENAME);
}

/**
 * @param {string} home
 */
export function opencodeAuthPath(home) {
  return path.join(home, OPENCODE_AUTH_RELATIVE_PATH);
}

/**
 * Anthropic key already stored on the OpenCode anthropic provider block.
 * @param {object} config parsed opencode.json
 */
export function opencodeHarnessAnthropicKeyRef(config) {
  const options = config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.options ?? {};
  const fromHeader = options.headers?.["x-api-key"];
  if (typeof fromHeader === "string" && fromHeader.trim()) {
    return fromHeader.trim();
  }
  const fromApiKey = options.apiKey;
  if (typeof fromApiKey === "string" && fromApiKey.trim()) {
    return fromApiKey.trim();
  }
  return "";
}

/**
 * Inspect OpenCode's auth.json anthropic entry.
 * @param {string} home
 * @returns {Promise<{ kind: AnthropicAuthKind, apiKey: string, source: "opencode-auth" | "" }>}
 */
export async function readOpencodeAnthropicAuth(home) {
  const auth = await readJsonIfExists(opencodeAuthPath(home));
  const kind = classifyOpencodeAnthropicEntry(auth?.anthropic);
  if (kind === "api-key") {
    const key = /** @type {{ key: string }} */ (auth.anthropic).key.trim();
    return { kind, apiKey: key, source: "opencode-auth" };
  }
  if (kind === "oauth") {
    return { kind, apiKey: "", source: "opencode-auth" };
  }
  return { kind: "none", apiKey: "", source: "" };
}

/**
 * @param {string} home
 * @returns {Promise<{ kind: AnthropicAuthKind, source: "claude-credentials" | "" }>}
 */
export async function readClaudeAnthropicAuth(home) {
  const creds = await readJsonIfExists(claudeCredentialsPath(home));
  const kind = classifyClaudeCredentials(creds);
  if (kind === "oauth") {
    return { kind, source: "claude-credentials" };
  }
  return { kind: "none", source: "" };
}

/**
 * Read a literal Anthropic API key stored by OpenCode's /connect flow.
 * OAuth-only entries return "" — presence is handled separately.
 * @param {string} home
 */
export async function readOpencodeAnthropicApiKey(home) {
  const { kind, apiKey } = await readOpencodeAnthropicAuth(home);
  return kind === "api-key" ? apiKey : "";
}

/**
 * Enterprise Anthropic auth for router `on` (OAuth only).
 * OpenCode runtime auth (auth.json API key or OAuth) is handled separately.
 * OpenCode may also fall back to Claude OAuth credentials on the same machine.
 *
 * @param {string} home
 * @param {string} harness
 * @returns {Promise<{ enterpriseAuth: boolean, source: string }>}
 */
export async function resolveEnterpriseAnthropicAuth(home, harness) {
  if (!home) {
    return { enterpriseAuth: false, source: "" };
  }

  if (harness === HARNESS.OPENCODE) {
    const claude = await readClaudeAnthropicAuth(home);
    if (claude.kind === "oauth") {
      return { enterpriseAuth: true, source: "claude-credentials" };
    }
    return { enterpriseAuth: false, source: "" };
  }

  if (harness === HARNESS.CLAUDE) {
    const claude = await readClaudeAnthropicAuth(home);
    if (claude.kind === "oauth") {
      return { enterpriseAuth: true, source: "claude-credentials" };
    }
    return { enterpriseAuth: false, source: "" };
  }

  return { enterpriseAuth: false, source: "" };
}

/**
 * @param {string} home
 * @param {string} harness
 */
export async function hasEnterpriseAnthropicCredentials(home, harness) {
  const { enterpriseAuth } = await resolveEnterpriseAnthropicAuth(home, harness);
  return enterpriseAuth;
}
