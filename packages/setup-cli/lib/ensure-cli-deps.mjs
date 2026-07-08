import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to packages/setup-cli (where package.json and node_modules live).
 * @returns {string}
 */
export function resolveSetupCliDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * @param {string} [setupDir]
 * @returns {boolean}
 */
export function crossKeychainInstalled(setupDir = resolveSetupCliDir()) {
  return existsSync(path.join(setupDir, "node_modules", "cross-keychain", "package.json"));
}

/**
 * Install runtime dependencies when cross-keychain is missing — e.g. after
 * `npm install -g ./packages/setup-cli` from a checkout without a prior
 * `npm install` in packages/setup-cli, or a broken partial install.
 *
 * @param {string} [setupDir]
 * @returns {boolean} true when cross-keychain is present after this call
 */
export function ensureCliDependencies(setupDir = resolveSetupCliDir()) {
  if (crossKeychainInstalled(setupDir)) {
    return true;
  }
  if (!existsSync(path.join(setupDir, "package.json"))) {
    return false;
  }

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    execFileSync(
      npm,
      ["install", "--omit=dev", "--no-fund", "--no-audit"],
      { cwd: setupDir, stdio: "pipe", encoding: "utf8" },
    );
  } catch {
    return false;
  }

  return crossKeychainInstalled(setupDir);
}
