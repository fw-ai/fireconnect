import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { FIREROUTER_BASE_URL } from "../firerouter-core.mjs";
import {
  DEFAULT_DATA_DIR,
} from "../fireconnect-core.mjs";
import {
  OPENCODE_DATA_RELATIVE_DIR,
} from "../opencode-core.mjs";
import {
  CODEX_CATALOG_RELATIVE_PATH,
  CODEX_DATA_RELATIVE_DIR,
  codexConfigPath,
  snapshotReferencesFireworksCatalog,
} from "../codex-core.mjs";
import {
  PI_DATA_RELATIVE_DIR,
} from "../pi-core.mjs";
import {
  discoverHarnessesForUninstall,
  globalConfigPath,
} from "../global-config.mjs";
import { getHarness } from "../harness-registry.mjs";
import { HARNESS } from "../harness.mjs";
import { runConfigureCommand } from "./configure.mjs";
import { readLocalVersion } from "../version.mjs";

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
  --api-key <key>           Fireworks API key. Passing to on also saves ~/.fireconnect/config.json.
  --router                  Route through FireRouter (${FIREROUTER_BASE_URL}).
  --anthropic-api-key <key> Optional Anthropic API key for frontier models (--router). Alias: --anthropic-key.
  --base-url <url>          Anthropic-compatible URL (direct) or FireRouter URL (--router).
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
  --api-key <key>           Fireworks API key. Passing to on also saves ~/.fireconnect/config.json.
  --router                  Retarget OpenCode's Anthropic provider at FireRouter (${FIREROUTER_BASE_URL}).
  --anthropic-api-key <key> Optional Anthropic API key for frontier models (--router). Alias: --anthropic-key.
  --main, --model <id>      Default model (on).
  --search <query>          Filter models (model list, model select).
  --json                    Machine-readable output (model list, status).
  --home <path>             Override HOME for config resolution.
  --config-path <path>      Explicit opencode.json path.
  --data-dir <path>         Override backup/state directory.`,
    codex: `Usage:
  ${CLI_NAME} codex [command] [options]

Manage Fireworks routing for OpenAI Codex CLI. Bare "${CLI_NAME} codex" runs on.

Commands:
  on              Route Codex through Fireworks (default).
  off             Restore your previous config.
  status          Show the provider, auth, and model.
  model list      Browse callable Fireworks serverless models.
  model select    Interactively pick the default model.
  model reset     Reset the model to the default.
  help            Show this help.

Options:
  --api-key <key>           Fireworks API key (validates setup; on also saves global config).
  --main, --model <id>      Default model (on).
  --search <query>          Filter models (model list, model select).
  --json                    Machine-readable output (model list, status).
  --home <path>             Override HOME for config resolution.
  --config-path <path>      Explicit ~/.codex/config.toml path.
  --data-dir <path>         Override backup/state directory.`,
    pi: `Usage:
  ${CLI_NAME} pi [command] [options]

Manage Fireworks routing for Pi. Bare "${CLI_NAME} pi" runs on.

Commands:
  on              Route Pi through Fireworks (default).
  off             Restore your previous settings and auth.
  status          Show the provider, auth, and model.
  model list      Browse callable Fireworks serverless models.
  model select    Interactively pick the default model.
  model reset     Reset the model to the default.
  help            Show this help.

Options:
  --api-key <key>           Fireworks API key. Passing to on also saves ~/.fireconnect/config.json.
  --main, --model <id>      Default model (on).
  --search <query>          Filter models (model list, model select).
  --json                    Machine-readable output (model list, status).
  --home <path>             Override HOME for settings resolution.
  --settings-path <path>    Explicit Pi settings.json path.
  --data-dir <path>         Override backup/state directory.`,
    cursor: `Usage:
  ${CLI_NAME} cursor [command] [options]

Manage Fireworks routing for the Cursor IDE. Bare "${CLI_NAME} cursor" runs on.

Cursor stores AI settings in a SQLite DB (state.vscdb), so writes require
Cursor to be quit first (Cmd-Q / File > Quit) — otherwise Cursor's in-memory
state overwrites them. status and model list are read-only and work any time.

Commands:
  on              Route Cursor through Fireworks (default).
  off             Restore your previous Cursor AI settings.
  status          Show the provider, auth, modes, and per-mode model.
  model list      Browse callable Fireworks serverless models.
  model add <id>  Register a model in Cursor's picker without changing the active mode.
  model select    Interactively pick a model for a Cursor mode.
  model reset     Reset fireconnect-managed model selections to default.
  help            Show this help.

Options:
  --api-key <key>           Fireworks API key. Defaults to FIREWORKS_API_KEY.
  --main, --model <id>      Model id (on, model add).
  --mode <mode>             Cursor mode for model select (composer, cmd-k, ...).
  --search <query>          Filter models (model list, model select).
  --json                    Machine-readable output (model list, status).
  --home <path>             Override HOME for state.vscdb resolution.
  --db-path <path>          Explicit Cursor state.vscdb path.
  --force                   Write even if Cursor is running, without asking you to quit it first.`,
    vscode: `Usage:
  ${CLI_NAME} vscode [command] [options]

Manage Fireworks routing for VS Code Chat (custom language models).

VS Code Chat reads custom OpenAI-compatible providers from
chatLanguageModels.json; their API keys live (encrypted) in VS Code's secret
storage (state.vscdb), which is where fireconnect stores the Fireworks key.
on/off write state.vscdb, so quit VS Code first (they hard-error otherwise);
restart VS Code for the change to take effect. model add/select/reset only edit
chatLanguageModels.json, which VS Code hot-reloads. status and model list are
read-only and work any time.

Commands:
  on              Add the Fireworks provider to VS Code Chat (default).
  off             Restore your previous chatLanguageModels.json + remove the key.
  status          Show the provider, auth, and registered models.
  model list      Browse callable Fireworks serverless models.
  model add <id>  Register a model in the Fireworks provider.
  model select    Interactively pick a model to add.
  model reset     Reset fireconnect-managed models to the default.
  help            Show this help.

Options:
  --api-key <key>           Fireworks API key. Defaults to FIREWORKS_API_KEY.
  --main, --model <id>      Model id (on, model add).
  --search <query>          Filter models (model list, model select).
  --json                    Machine-readable output (model list, status).
  --home <path>             Override HOME for chatLanguageModels.json resolution.
  --vscode-path <path>      Explicit chatLanguageModels.json path.
  --force                   Write even if VS Code is running (not recommended).`,
    configure: `Usage:
  ${CLI_NAME} configure [options]

Register which harnesses you use and store API key preferences.

Options:
  --harnesses <ids>         Comma-separated harness ids (e.g. claude,opencode,codex,pi,cursor).
  --api-key <key>           Fireworks API key (stored in ~/.fireconnect/config.json).
  --anthropic-api-key <key> Anthropic API key for FireRouter (optional).
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

  console.log(`FireConnect — use Fireworks models in Claude Code, OpenCode, Codex, Pi, Cursor, and VS Code.

Usage:
  ${CLI_NAME} <command> [options]
  ${CLI_NAME} <harness> [on|off|status|model select|model add|model reset] [options]
  ${CLI_NAME} --version

Global commands:
  configure   Register harnesses and API key preferences.
  upgrade     Pull the latest FireConnect from GitHub.
  uninstall   Remove FireConnect from this machine.
  help        Show help.

Options:
  --version, -V   Print the installed CLI version (--json for machine-readable output).

Harnesses:
  claude      Claude Code (${CLI_NAME} claude on|off|...)
  opencode    OpenCode (${CLI_NAME} opencode on|off|...)
  codex       OpenAI Codex CLI (${CLI_NAME} codex on|off|...)
  pi          Pi (${CLI_NAME} pi on|off|...)
  cursor      Cursor IDE (${CLI_NAME} cursor on|off|...)
  vscode      VS Code Chat (${CLI_NAME} vscode on|off|...)

Examples:
  # Global
  ${CLI_NAME} configure
  ${CLI_NAME} --version
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

  # Codex
  ${CLI_NAME} codex on
  ${CLI_NAME} codex model list
  ${CLI_NAME} codex model select

  # Pi
  ${CLI_NAME} pi on
  ${CLI_NAME} pi on --main glm-5p1
  ${CLI_NAME} pi model select

  # Cursor (quit Cursor before on/off/model select/model add)
  ${CLI_NAME} cursor on --api-key fw_...
  ${CLI_NAME} cursor status
  ${CLI_NAME} cursor model list --search glm
  ${CLI_NAME} cursor model add deepseek-v4-flash
  ${CLI_NAME} cursor model select --mode composer

  # VS Code Chat (changes apply live; quit VS Code only to avoid concurrent-edit clobber)
  ${CLI_NAME} vscode on --api-key fw_...
  ${CLI_NAME} vscode status
  ${CLI_NAME} vscode model list --search glm
  ${CLI_NAME} vscode model add deepseek-v4-flash
  ${CLI_NAME} vscode model select

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

/**
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
export function runVersionCommand(ctx) {
  const version = readLocalVersion();
  if (!version) {
    throw new Error("Unable to determine FireConnect version.");
  }

  if (ctx.json) {
    console.log(JSON.stringify({ version }, null, 2));
    return;
  }

  console.log(`v${version}`);
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
      // Uninstall is a destructive, user-initiated operation. Force writes
      // past the "is the IDE running?" guard so uninstall completes even if
      // Cursor is open — otherwise the backup files get deleted below while
      // Fireworks settings remain in state.vscdb, making `off` unrecoverable.
      force: true,
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

  const codexOffFailed = offErrors.some((error) => error.harnessId === HARNESS.CODEX);
  let removeCatalog = !codexOffFailed;
  if (removeCatalog) {
    try {
      const raw = await readFile(codexConfigPath(home), "utf8");
      if (snapshotReferencesFireworksCatalog(raw)) {
        removeCatalog = false;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  const pathsToRemove = [
    path.join(home, DEFAULT_DATA_DIR),
    path.join(home, OPENCODE_DATA_RELATIVE_DIR),
    path.join(home, CODEX_DATA_RELATIVE_DIR),
    ...(removeCatalog ? [path.join(home, CODEX_CATALOG_RELATIVE_PATH)] : []),
    path.join(home, PI_DATA_RELATIVE_DIR),
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
    console.log("FireConnect has been uninstalled. Restart any running harnesses (Claude Code, OpenCode, Codex, Pi) to fully apply.");
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

  if (command === "version") {
    runVersionCommand(ctx);
    return;
  }

  if (command === "uninstall") {
    await runUninstallCommand(ctx);
    return;
  }

  throw new Error(`Unknown global command: ${command}`);
}
