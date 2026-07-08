import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to the FireConnect CLI entrypoint for apiKeyHelper / shell hooks.
 * Follows symlinks so an npm-global launcher pointing at `fireconnect.mjs` is
 * recognized as a Node entrypoint (apiKeyHelper must invoke `node … key export`
 * when `node` is not on the subprocess PATH — e.g. Claude Code's apiKeyHelper).
 * @param {string} [home]
 */
export function resolveFireconnectCliPath(home = process.env.HOME ?? "") {
  const launcher = home ? path.join(home, ".local/bin/fireconnect") : "";
  if (launcher && existsSync(launcher)) {
    return realpath(launcher);
  }

  const argvPath = process.argv[1];
  if (argvPath && existsSync(argvPath)) {
    return realpath(path.resolve(argvPath));
  }

  return fileURLToPath(new URL("../bin/fireconnect.mjs", import.meta.url));
}

/**
 * Shell command that prints the Fireworks API key to stdout.
 * apiKeyHelper subprocesses (e.g. Claude Code) often run with a minimal
 * environment — no HOME and no FIREWORKS_API_KEY — so embed `--home`.
 * @param {string} [home]
 */
export function fireconnectKeyExportCommand(home = process.env.HOME ?? "") {
  const cliPath = resolveFireconnectCliPath(home);
  const homeFlag = home ? ` --home ${shellQuote(home)}` : "";
  const storedFlag = " --stored-only";
  if (cliPath.endsWith(".mjs")) {
    return `${process.execPath} ${shellQuote(cliPath)}${homeFlag} key export${storedFlag}`;
  }
  return `${shellQuote(cliPath)}${homeFlag} key export${storedFlag}`;
}

/**
 * Shell command that runs the Claude Desktop SessionStart guard hook.
 * Resolves next to the `fireconnect` CLI entrypoint (same install), not the
 * npm-global launcher, since the guard is a plain Node script, not a bin.
 */
export function fireconnectDesktopGuardCommand() {
  const guardPath = fileURLToPath(new URL("../bin/fireconnect-desktop-guard.mjs", import.meta.url));
  return `${process.execPath} ${shellQuote(guardPath)}`;
}

/** @param {string} p */
function realpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * @param {string} value
 */
export function shellQuote(value) {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
