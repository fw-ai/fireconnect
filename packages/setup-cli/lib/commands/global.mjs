import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_DATA_DIR,
} from "../fireconnect-core.mjs";
import {
  OPENCODE_DATA_RELATIVE_DIR,
} from "../opencode-core.mjs";
import {
  discoverHarnessesForUninstall,
  globalConfigPath,
} from "../global-config.mjs";
import { getHarness } from "../harness-registry.mjs";
import { runConfigureCommand } from "./configure.mjs";

const CLI_NAME = "fireconnect";

export function printHelp(topic = "") {
  const harnessHelp = {
    claude: `Usage:
  ${CLI_NAME} claude [command] [options]

Manage Fireworks routing for Claude Code. Bare "${CLI_NAME} claude" runs on.

Commands:
  on              Route Claude Code through Fireworks (default).
  off             Restore your previous provider.
  status          Show the provider, auth, and model mapping.
  model list      Browse callable Fireworks serverless models.
  model select    Interactively pick a model for a slot.
  model reset     Reset model aliases to the defaults.
  help            Show this help.

Options:
  --api-key <key>           Fireworks API key. Defaults to FIREWORKS_API_KEY.
  --base-url <url>          Anthropic-compatible URL.
  --main, --model <id>      Main model (on).
  --opus <id>               Model for the opus alias (on).
  --sonnet <id>             Model for the sonnet alias (on).
  --haiku <id>              Model for the haiku alias (on).
  --subagent <id>           Model for subagents (on).
  --slot <alias>            For model select: main, opus, sonnet, haiku, subagent.
  --search <query>          Filter models (model list, model select).
  --json                    Machine-readable output (model list, status).
  --home <path>             Override HOME for settings resolution.
  --settings-path <path>    Explicit Claude Code settings file.
  --data-dir <path>         Override backup/state directory.`,
    opencode: `Usage:
  ${CLI_NAME} opencode [command] [options]

Manage Fireworks routing for OpenCode. Bare "${CLI_NAME} opencode" runs on.

Commands:
  on              Route OpenCode through Fireworks (default).
  off             Restore your previous config.
  status          Show the provider, auth, and model.
  model list      Browse callable Fireworks serverless models.
  model select    Interactively pick the default model.
  model reset     Reset the model to the default.
  help            Show this help.

Options:
  --api-key <key>           Fireworks API key. Defaults to FIREWORKS_API_KEY.
  --main, --model <id>      Default model (on).
  --search <query>          Filter models (model list, model select).
  --json                    Machine-readable output (model list, status).
  --home <path>             Override HOME for config resolution.
  --config-path <path>      Explicit opencode.json path.
  --data-dir <path>         Override backup/state directory.`,
    configure: `Usage:
  ${CLI_NAME} configure [options]

Register which harnesses you use and store API key preferences.

Options:
  --harnesses <ids>         Comma-separated harness ids (e.g. claude,opencode).
  --api-key <key>           Fireworks API key.
  --api-key-mode <mode>     env or literal.
  --home <path>             Override HOME.`,
    uninstall: `Usage:
  ${CLI_NAME} uninstall

Disable and restore all configured harnesses, then remove FireConnect
(~/.fireconnect/, CLI launcher).`,
    upgrade: `Usage:
  ${CLI_NAME} upgrade

Pull the latest FireConnect from GitHub and update in place.
Only works when installed via the curl installer (requires git).`,
  };

  if (topic && harnessHelp[topic]) {
    console.log(harnessHelp[topic]);
    return;
  }

  console.log(`FireConnect — use Fireworks models in Claude Code and OpenCode.

Usage:
  ${CLI_NAME} <command> [options]
  ${CLI_NAME} <harness> [on|off|status|model select|model reset] [options]

Global commands:
  configure   Register harnesses and API key preferences.
  upgrade     Pull the latest FireConnect from GitHub.
  uninstall   Remove FireConnect from this machine.
  help        Show help.

Harnesses:
  claude      Claude Code (${CLI_NAME} claude on|off|...)
  opencode    OpenCode (${CLI_NAME} opencode on|off|...)

Examples:
  # Global
  ${CLI_NAME} configure
  ${CLI_NAME} uninstall

  # Claude Code
  ${CLI_NAME} claude on --api-key fw_...
  ${CLI_NAME} claude status
  ${CLI_NAME} claude model list --search glm
  ${CLI_NAME} claude model select --slot sonnet
  ${CLI_NAME} claude model reset

  # OpenCode
  ${CLI_NAME} opencode on
  ${CLI_NAME} opencode model list
  ${CLI_NAME} opencode model select

Run "${CLI_NAME} help <topic>" or "${CLI_NAME} <harness> help" for details.
`);
}

async function readInstalledVersion(installDir) {
  try {
    const raw = await readFile(path.join(installDir, "packages/setup-cli/package.json"), "utf8");
    return JSON.parse(raw).version ?? "";
  } catch {
    return "";
  }
}

export async function runUpgradeCommand() {
  const home = process.env.HOME ?? "";
  if (!home) {
    throw new Error("HOME is not set; upgrade requires HOME to be set.");
  }
  const installDir = path.join(home, ".fireconnect/cli");

  if (!existsSync(path.join(installDir, ".git"))) {
    console.log("Nothing to upgrade: FireConnect was not installed via the curl installer.");
    console.log("Re-run the installer to get the latest version:");
    console.log("  curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh | bash");
    return;
  }

  const before = await readInstalledVersion(installDir);
  if (before) {
    console.log(`Current version: v${before}`);
  }

  let beforeHash = "";
  try {
    beforeHash = execFileSync("git", ["-C", installDir, "rev-parse", "HEAD"], { stdio: "pipe", encoding: "utf8" }).trim();
  } catch { /* non-fatal */ }

  console.log("Checking for updates...");
  try {
    execFileSync("git", ["-C", installDir, "fetch", "--depth=1", "origin", "main", "--quiet"], { stdio: "pipe" });
    execFileSync("git", ["-C", installDir, "reset", "--hard", "origin/main"], { stdio: "pipe" });
  } catch (error) {
    const detail = error.stderr?.toString().trim() ?? error.message;
    throw new Error(`Upgrade failed: ${detail}`);
  }

  let afterHash = "";
  try {
    afterHash = execFileSync("git", ["-C", installDir, "rev-parse", "HEAD"], { stdio: "pipe", encoding: "utf8" }).trim();
  } catch { /* non-fatal */ }

  const after = await readInstalledVersion(installDir);
  const alreadyUpToDate = Boolean(beforeHash && afterHash && beforeHash === afterHash);

  if (alreadyUpToDate) {
    console.log(`Already up to date${after ? ` (v${after})` : ""}.`);
  } else if (before && after && before !== after) {
    console.log(`Upgraded v${before} → v${after}.`);
  } else {
    console.log(`FireConnect upgraded successfully${after ? ` (v${after})` : ""}.`);
  }
}

async function removePath(pathToRemove) {
  try {
    await rm(pathToRemove, { recursive: true, force: true });
    return null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    return { path: pathToRemove, message: error.message };
  }
}

/**
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
export async function runUninstallCommand(ctx) {
  const home = process.env.HOME ?? "";
  if (!home) {
    throw new Error("HOME is not set; uninstall requires HOME to be set.");
  }
  if (ctx.home && ctx.home !== home) {
    throw new Error("uninstall does not support --home");
  }
  if (ctx.settingsPath || ctx.configPath || ctx.dataDir) {
    throw new Error("uninstall does not support path overrides");
  }

  const harnessIds = await discoverHarnessesForUninstall(home);

  const offErrors = [];
  for (const harnessId of harnessIds) {
    const adapter = getHarness(harnessId);
    const offCtx = {
      ...ctx,
      home,
      settingsPath: "",
      configPath: "",
      dataDir: "",
    };
    try {
      await adapter.off(offCtx);
    } catch (error) {
      offErrors.push({ harnessId, label: adapter.label, message: error.message });
      // Print restart hint even when off() fails — the harness config may be
      // partially applied and the user needs to know to restart.
      console.error(`Warning: failed to restore ${harnessId}: ${error.message}`);
      console.error(`Restart ${adapter.label} manually to clear any Fireworks settings.`);
    }
  }

  const pathsToRemove = [
    path.join(home, DEFAULT_DATA_DIR),
    path.join(home, OPENCODE_DATA_RELATIVE_DIR),
    globalConfigPath(home),
    path.join(home, ".fireconnect/cli"),
    path.join(home, ".local/bin/fireconnect"),
  ];

  const removalFailures = [];
  for (const pathToRemove of pathsToRemove) {
    const failure = await removePath(pathToRemove);
    if (failure) {
      removalFailures.push(failure);
    }
  }

  const hasErrors = offErrors.length > 0 || removalFailures.length > 0;
  if (!hasErrors) {
    console.log("FireConnect has been uninstalled. Restart any running harnesses (Claude Code, OpenCode) to fully apply.");
  } else {
    if (removalFailures.length > 0) {
      console.error("FireConnect uninstall completed with file removal errors:");
      for (const { path: failedPath, message } of removalFailures) {
        console.error(`  ${failedPath}: ${message}`);
      }
    } else {
      console.log("FireConnect files removed. Restart any running harnesses to fully apply.");
    }
    process.exitCode = 1;
  }
}

/**
 * @param {import("../parse-args.mjs").parseCli extends Function ? ReturnType<import("../parse-args.mjs").parseCli> : never} parsed
 */
export async function runGlobalCommand(parsed) {
  const { command, ctx } = parsed;

  if (command === "help") {
    printHelp(parsed.helpTopic ?? "");
    return;
  }

  if (command === "configure") {
    await runConfigureCommand(ctx);
    return;
  }

  if (command === "upgrade") {
    await runUpgradeCommand();
    return;
  }

  if (command === "uninstall") {
    await runUninstallCommand(ctx);
    return;
  }

  throw new Error(`Unknown global command: ${command}`);
}
