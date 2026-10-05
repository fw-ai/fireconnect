/**
 * Install/remove the FireConnect Pi footer usage bar extension.
 *
 * `fireconnect pi on` writes a stub directory into Pi's user extensions dir
 * (`~/.pi/agent/extensions/fireconnect-usage/`): a CommonJS `index.js` whose
 * factory dynamically imports the real implementation from the CLI install,
 * with the implementation's absolute URL baked in — the same self-location
 * pattern as the Claude status line helper (a stale absolute path from an
 * old install location is refreshed on re-`on`, rather than silently
 * breaking).
 *
 * A `fireconnect.json` marker claims the directory. Anything else in that
 * path is the user's own extension and is never touched (the Claude status
 * line's "never replace the user's own" rule, applied to a directory).
 */

import { rm, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveSetupCliDir } from "../../../system/ensure-cli-deps.mjs";

export const PI_EXTENSION_DIR_NAME = "fireconnect-usage";
const MARKER_FILE = "fireconnect.json";

/**
 * @param {string} home
 * @param {string} [settingsPath] explicit settings.json path (the extensions
 *   dir sits next to it, mirroring Pi's agent-dir layout)
 */
export function piExtensionsDir(home, settingsPath = "") {
  const agentDir = settingsPath
    ? path.dirname(path.resolve(settingsPath))
    : path.join(home, ".pi", "agent");
  return path.join(agentDir, "extensions");
}

/** @param {string} home @param {string} [settingsPath] */
export function piUsageExtensionDir(home, settingsPath = "") {
  return path.join(piExtensionsDir(home, settingsPath), PI_EXTENSION_DIR_NAME);
}

/** Absolute path to the implementation inside the CLI install. */
export function piUsageExtensionImplPath(cliDir = resolveSetupCliDir()) {
  return path.join(cliDir, "lib", "harnesses", "pi", "extension", "main.mjs");
}

async function fileExists(filePath) {
  try {
    const st = await stat(filePath);
    return st.isFile();
  } catch {
    return false;
  }
}

async function dirExists(dirPath) {
  try {
    const st = await stat(dirPath);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * The CommonJS stub pi loads. Its factory dynamically imports the real
 * implementation from the CLI install, so the pricing engine and the bar
 * renderer are the exact same code every other FireConnect surface uses —
 * and a `fireconnect` upgrade re-`on` refreshes them in place.
 *
 * @param {string} implUrl
 */
export function piUsageExtensionStubSource(implUrl) {
  return [
    "/**",
    " * FireConnect usage bar for Pi — managed by `fireconnect pi on`.",
    " * Do not edit: re-run `fireconnect pi` to refresh it, `fireconnect pi off`",
    " * to remove it. The real implementation lives in the FireConnect CLI",
    " * install and is loaded below.",
    " */",
    `const implUrl = ${JSON.stringify(implUrl)};`,
    "",
    "module.exports = async function fireconnectUsageExtension(pi) {",
    "  const impl = await import(implUrl);",
    "  return impl.default(pi);",
    "};",
    "",
  ].join("\n");
}

/**
 * Install (or refresh) the managed extension stub.
 *
 * - a user-owned directory (no marker) is left alone
 * - a stale marker (impl no longer at the baked path) is refreshed
 *
 * @param {{ home: string, settingsPath?: string, cliDir?: string }} opts
 * @returns {Promise<{ installed: boolean, reason?: "user", dir: string }>}
 */
export async function installPiUsageExtension({ home, settingsPath = "", cliDir } = {}) {
  const dir = piUsageExtensionDir(home, settingsPath);
  if (await dirExists(dir)) {
    const markerPath = path.join(dir, MARKER_FILE);
    if (!await fileExists(markerPath)) {
      return { installed: false, reason: "user", dir };
    }
  }

  const implUrl = pathToFileURL(piUsageExtensionImplPath(cliDir)).href;
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "index.js"),
    piUsageExtensionStubSource(implUrl),
  );
  await writeFile(
    path.join(dir, MARKER_FILE),
    `${JSON.stringify({ managedBy: "fireconnect", impl: implUrl, installedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return { installed: true, dir };
}

/**
 * Remove the managed extension stub — only when the marker claims the
 * directory (a user's own extension of the same name is never touched).
 *
 * @param {{ home: string, settingsPath?: string }} opts
 * @returns {Promise<{ removed: boolean, dir: string }>}
 */
export async function removePiUsageExtension({ home, settingsPath = "" } = {}) {
  const dir = piUsageExtensionDir(home, settingsPath);
  const markerPath = path.join(dir, MARKER_FILE);
  if (!await fileExists(markerPath)) {
    return { removed: false, dir };
  }
  await rm(dir, { recursive: true, force: true });
  return { removed: true, dir };
}

/**
 * Whether the managed extension stub is currently installed.
 * @param {{ home: string, settingsPath?: string }} opts
 */
export async function piUsageExtensionInstalled({ home, settingsPath = "" } = {}) {
  const dir = piUsageExtensionDir(home, settingsPath);
  return fileExists(path.join(dir, MARKER_FILE));
}
