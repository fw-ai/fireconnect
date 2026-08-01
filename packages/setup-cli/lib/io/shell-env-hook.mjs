import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  fireconnectAnthropicKeyExportCommand,
  fireconnectKeyExportCommand,
} from "../cli/path.mjs";
import {
  ANTHROPIC_API_KEY_ENV_REF,
  readGlobalConfig,
  resolveStoredAnthropicApiKey,
} from "../config/global-config.mjs";
import { isAnthropicShapedKey } from "../firerouter/core.mjs";
import { shouldInstallShellEnvHook } from "../keys/api-key.mjs";
import { needsFireworksShellExport } from "./shell-fireworks-consumers.mjs";

export const SHELL_HOOK_BEGIN = "# >>> fireconnect >>>";
export const SHELL_HOOK_END = "# <<< fireconnect <<<";

/**
 * @param {string} [home]
 */
export function resolveShellConfigPath(home = process.env.HOME ?? "") {
  if (!home) {
    throw new Error("HOME is required to resolve shell config path");
  }
  if (process.env.ZSH_VERSION || (process.env.SHELL ?? "").includes("zsh")) {
    return path.join(home, ".zshrc");
  }
  if (process.env.BASH_VERSION || (process.env.SHELL ?? "").includes("bash")) {
    if (process.platform === "darwin") {
      return path.join(home, ".bash_profile");
    }
    return path.join(home, ".bashrc");
  }
  return path.join(home, ".zshrc");
}

/**
 * @param {string} home
 */
export function shellHookBlock(home, {
  includeFireworks = true,
  includeAnthropic = false,
} = {}) {
  const lines = [SHELL_HOOK_BEGIN];
  if (includeFireworks) {
    const exportCmd = fireconnectKeyExportCommand(home);
    // Capture the key from `fireconnect key export`. If the command fails or
    // returns nothing (e.g. node not on PATH in a non-interactive sandbox, or no
    // key stored), print a one-time hint to stderr — but only in interactive
    // shells (`[ -t 2 ]`) so CI and other non-interactive contexts stay quiet.
    // `2>/dev/null` keeps normal "no key yet" noise out of the way.
    lines.push(
      `export FIREWORKS_API_KEY="$(${exportCmd} 2>/dev/null)"`,
      `if [ -z "\${FIREWORKS_API_KEY:-}" ] && [ -t 2 ]; then`,
      `  echo 'fireconnect: FIREWORKS_API_KEY is empty — run \`fireconnect status\` to check your key storage.' >&2`,
      "fi",
    );
  }
  if (includeAnthropic) {
    const exportCmd = fireconnectAnthropicKeyExportCommand(home);
    lines.push(`export ANTHROPIC_API_KEY="$(${exportCmd} 2>/dev/null)"`);
  }
  lines.push(SHELL_HOOK_END, "");
  return lines.join("\n");
}

/**
 * @param {string} raw
 */
export function stripShellHookBlock(raw) {
  const begin = raw.indexOf(SHELL_HOOK_BEGIN);
  if (begin === -1) {
    return raw;
  }
  const end = raw.indexOf(SHELL_HOOK_END, begin);
  if (end === -1) {
    return raw;
  }
  const after = end + SHELL_HOOK_END.length;
  let next = raw.slice(0, begin) + raw.slice(after);
  next = next.replace(/\n{3,}/g, "\n\n");
  return next.replace(/\n+$/, "\n");
}

/**
 * @param {string} home
 */
export async function readShellConfig(home) {
  const filePath = resolveShellConfigPath(home);
  try {
    return { filePath, raw: await readFile(filePath, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { filePath, raw: "" };
    }
    throw error;
  }
}

/**
 * @param {string} home
 */
export async function installShellEnvHook(home, options = {}) {
  const { filePath, raw } = await readShellConfig(home);
  const block = shellHookBlock(home, options);
  const without = stripShellHookBlock(raw);
  const separator = without && !without.endsWith("\n") ? "\n" : "";
  const next = `${without}${separator}${without ? "\n" : ""}${block}`;
  await writeFile(filePath, next, "utf8");
  return filePath;
}

/**
 * @param {string} home
 */
export async function removeShellEnvHook(home) {
  const { filePath, raw } = await readShellConfig(home);
  if (!raw.includes(SHELL_HOOK_BEGIN)) {
    return false;
  }
  const next = stripShellHookBlock(raw);
  if (next.trim()) {
    await writeFile(filePath, next, "utf8");
  } else {
    await writeFile(filePath, "", "utf8");
  }
  return true;
}

/**
 * Reconcile the singleton shell block from all managed consumers. Harness and
 * websearch callers never edit the block from partial local knowledge.
 * @param {string} home
 */
export async function reconcileShellEnvHook(home) {
  const config = await readGlobalConfig(home);
  // Claude websearch MCP and harness configs bake literals; no current consumer
  // needs FIREWORKS_API_KEY in the shell. Codex may still need ANTHROPIC export.
  const includeFireworks = await needsFireworksShellExport(
    home,
    config.harnesses,
    shouldInstallShellEnvHook(config.apiKey),
  );
  const storedAnthropicKey = resolveStoredAnthropicApiKey(config.anthropicApiKey);
  const includeAnthropic = config.harnesses.codex?.enabled === true
    && config.harnesses.codex?.provider !== "azure"
    && config.anthropicApiKey !== ANTHROPIC_API_KEY_ENV_REF
    && isAnthropicShapedKey(storedAnthropicKey);
  if (!includeFireworks && !includeAnthropic) {
    await removeShellEnvHook(home);
    return null;
  }
  return installShellEnvHook(home, { includeFireworks, includeAnthropic });
}
