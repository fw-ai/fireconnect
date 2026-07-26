import { readFileSync } from "node:fs";
import process from "node:process";

/**
 * Whether this process runs somewhere a locally-opened browser can't reach
 * the user: an SSH session, or WSL (an opener exists but the user's browser
 * lives on the Windows side). Sign-in flows use this to skip the opener and
 * print the URL directly instead of pretending a browser opened.
 *
 * WSL 1 and 2 both stamp "microsoft" into /proc/version — the conventional
 * detection (same signal VS Code and others use).
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, readProcVersion?: () => string }} [options]  test seams
 */
export function isRemoteContext({
  env = process.env,
  platform = process.platform,
  readProcVersion = defaultReadProcVersion,
} = {}) {
  if (env.SSH_CONNECTION?.trim() || env.SSH_TTY?.trim() || env.SSH_CLIENT?.trim()) {
    return true;
  }
  return platform === "linux" && readProcVersion().toLowerCase().includes("microsoft");
}

function defaultReadProcVersion() {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return "";
  }
}
