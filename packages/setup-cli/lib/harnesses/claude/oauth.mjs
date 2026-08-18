import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { writeJson } from "../../io/json.mjs";

export const CLAUDE_CREDENTIALS_FILENAME = ".credentials.json";
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

const OAUTH_TOKEN_KEYS = [
  "access",
  "accessToken",
  "access_token",
  "token",
  "refreshToken",
  "refresh_token",
];

function hasOAuthTokenMaterial(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  return OAUTH_TOKEN_KEYS.some((key) => (
    typeof entry[key] === "string" && entry[key].trim().length > 0
  ));
}

export function hasClaudeOAuthTokenMaterial(credentials) {
  if (!credentials || typeof credentials !== "object") {
    return false;
  }
  return [
    credentials.claudeAiOauth,
    credentials.oauth,
    credentials.anthropic,
  ].some(hasOAuthTokenMaterial);
}

export function claudeCredentialsPath(home, settingsPath = "") {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) {
    return path.join(configDir, CLAUDE_CREDENTIALS_FILENAME);
  }
  if (settingsPath) {
    return path.join(path.dirname(settingsPath), CLAUDE_CREDENTIALS_FILENAME);
  }
  return path.join(home, ".claude", CLAUDE_CREDENTIALS_FILENAME);
}

async function readCredentialsFile(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${filePath} is not valid JSON`);
    }
    throw error;
  }
}

function readClaudeKeychainCredentials() {
  const testBlob = process.env.FIRECONNECT_TEST_CLAUDE_KEYCHAIN;
  if (testBlob !== undefined) {
    if (!testBlob) {
      return null;
    }
    try {
      const parsed = JSON.parse(testBlob);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  const result = spawnSync(
    "security",
    ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read Claude Code OAuth credentials. On macOS, Claude Code often stores login
 * tokens only in the Keychain (`Claude Code-credentials`) — there may be no
 * `~/.claude/.credentials.json` on disk. Linux/Windows use the file when present.
 *
 * @param {{
 *   home: string,
 *   settingsPath?: string,
 *   platform?: NodeJS.Platform,
 *   readKeychainCredentials?: typeof readClaudeKeychainCredentials,
 * }} args
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function readClaudeOAuthCredentials({
  home,
  settingsPath = "",
  platform = process.platform,
  readKeychainCredentials = readClaudeKeychainCredentials,
}) {
  const credentials = await readCredentialsFile(
    claudeCredentialsPath(home, settingsPath),
  );
  if (hasClaudeOAuthTokenMaterial(credentials)) {
    return credentials;
  }
  if (platform !== "darwin") {
    return null;
  }
  const keychain = readKeychainCredentials();
  return hasClaudeOAuthTokenMaterial(keychain) ? keychain : null;
}

export async function hasClaudeOAuthCredentials({
  home,
  settingsPath = "",
  platform = process.platform,
  readKeychainCredentials = readClaudeKeychainCredentials,
}) {
  return (await readClaudeOAuthCredentials({
    home,
    settingsPath,
    platform,
    readKeychainCredentials,
  })) != null;
}

/**
 * Copy Claude Code OAuth credentials into an isolated CLAUDE_CONFIG_DIR so a
 * headless `claude -p` child can authenticate without reading ~/.claude.
 *
 * @param {{ configDir: string, credentials: Record<string, unknown> }} args
 */
export async function writeClaudeOAuthCredentialsToDir({ configDir, credentials }) {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeJson(path.join(configDir, CLAUDE_CREDENTIALS_FILENAME), credentials, { mode: 0o600 });
}
