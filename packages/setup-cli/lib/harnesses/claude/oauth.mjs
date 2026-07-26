import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { readJsonIfExists } from "../../io/json.mjs";

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

export async function hasClaudeOAuthCredentials({
  home,
  settingsPath = "",
  platform = process.platform,
  readKeychainCredentials = readClaudeKeychainCredentials,
}) {
  const credentials = await readJsonIfExists(
    claudeCredentialsPath(home, settingsPath),
  );
  if (hasClaudeOAuthTokenMaterial(credentials)) {
    return true;
  }
  if (platform !== "darwin") {
    return false;
  }
  return hasClaudeOAuthTokenMaterial(readKeychainCredentials());
}
