import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { readJsonIfExists } from "./fireconnect-core.mjs";
import { HARNESS } from "./harness.mjs";
import { OPENCODE_ANTHROPIC_PROVIDER_ID } from "./opencode-firerouter-core.mjs";

export const CLAUDE_CREDENTIALS_FILENAME = ".credentials.json";
export const OPENCODE_AUTH_RELATIVE_PATH = ".local/share/opencode/auth.json";

/** macOS Keychain service name Claude Code stores OAuth credentials under. */
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Test-only override for the keychain credentials blob. When set to a string,
 * {@link readClaudeKeychainCredentials} parses it instead of querying the OS
 * keychain. Set to "" to simulate an empty keychain. `null` restores production
 * behavior. This avoids race conditions from concurrent tests mutating
 * `process.env`.
 * @type {string | null}
 */
let testKeychainBlob = null;

/**
 * @internal — test seam for the macOS keychain Claude credentials blob.
 * In-process tests use this setter; spawned-child tests use the
 * `FIRECONNECT_TEST_CLAUDE_KEYCHAIN` env var (read once at module load).
 * @param {string | null} blob
 */
export function _setTestClaudeKeychainBlob(blob) {
  testKeychainBlob = blob;
}

/**
 * Env-based test seam for spawned CLI subprocesses. Read once at module load
 * so child processes inherit a neutralized keychain from the test runner env.
 * Values: a JSON string to inject, "" to simulate an empty keychain, or unset
 * for production behavior.
 */
const ENV_TEST_KEYCHAIN_BLOB = process.env.FIRECONNECT_TEST_CLAUDE_KEYCHAIN ?? null;

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
 * Read the Claude Code credentials blob from the macOS login keychain.
 * Claude Code stores its OAuth token (same shape as `.credentials.json`)
 * under the generic-password service "Claude Code-credentials".
 * @returns {string} raw JSON string, or "" if not found / not on macOS.
 */
function macReadClaudeKeychainCredentials() {
  const r = spawnSync("security", ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    return "";
  }
  return (r.stdout || "").trim();
}

/**
 * Read Claude Code credentials from the OS keychain, returning a parsed
 * object (same shape as `.credentials.json`) or `null` when absent.
 * macOS is the only platform where Claude Code is known to use the keychain
 * today; Linux/Windows fall through to the credentials file.
 *
 * Tests inject a fake blob via `FIRECONNECT_TEST_CLAUDE_KEYCHAIN` so the
 * keychain path can be exercised on any OS without hitting the real keychain.
 * @returns {Record<string, unknown> | null}
 */
function readClaudeKeychainCredentials() {
  const blob = testKeychainBlob !== null ? testKeychainBlob : ENV_TEST_KEYCHAIN_BLOB;
  if (blob !== null) {
    if (!blob) {
      return null;
    }
    try {
      const parsed = JSON.parse(blob);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (process.platform !== "darwin") {
    return null;
  }
  const raw = macReadClaudeKeychainCredentials();
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
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
 * Read Claude Code's Anthropic auth. Checks the credentials file
 * (`~/.claude/.credentials.json`) first, then falls back to the macOS
 * keychain entry Claude Code writes when no credentials file is present.
 * @param {string} home
 * @returns {Promise<{ kind: AnthropicAuthKind, source: "claude-credentials" | "claude-keychain" | "" }>}
 */
export async function readClaudeAnthropicAuth(home) {
  const creds = await readJsonIfExists(claudeCredentialsPath(home));
  const kind = classifyClaudeCredentials(creds);
  if (kind === "oauth") {
    return { kind, source: "claude-credentials" };
  }
  const keychainCreds = readClaudeKeychainCredentials();
  const keychainKind = classifyClaudeCredentials(keychainCreds);
  if (keychainKind === "oauth") {
    return { kind: keychainKind, source: "claude-keychain" };
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
      return { enterpriseAuth: true, source: claude.source };
    }
    return { enterpriseAuth: false, source: "" };
  }

  if (harness === HARNESS.CLAUDE) {
    const claude = await readClaudeAnthropicAuth(home);
    if (claude.kind === "oauth") {
      return { enterpriseAuth: true, source: claude.source };
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
