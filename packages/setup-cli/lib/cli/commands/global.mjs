import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_DATA_DIR,
} from "../../harnesses/claude/core.mjs";
import {
  OPENCODE_DATA_RELATIVE_DIR,
} from "../../harnesses/opencode/core.mjs";
import {
  CODEX_CATALOG_RELATIVE_PATH,
  CODEX_DATA_RELATIVE_DIR,
  codexConfigPath,
  snapshotReferencesFireworksCatalog,
} from "../../harnesses/codex/core.mjs";
import {
  DEEPAGENTS_DATA_RELATIVE_DIR,
} from "../../harnesses/deepagents/core.mjs";
import {
  PI_DATA_RELATIVE_DIR,
} from "../../harnesses/pi/core.mjs";
import {
  discoverHarnessesForUninstall,
  globalConfigPath,
} from "../../config/global-config.mjs";
import { getHarness } from "../../harness/registry.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { runConfigureCommand } from "./configure.mjs";
import { runGlobalModelListCommand } from "./model.mjs";
import { printReleaseNotesAfterUpgrade } from "../../system/release-notes.mjs";
import { readLocalVersion } from "../../system/version.mjs";
import { removeShellEnvHook } from "../../io/shell-env-hook.mjs";
import { runClaudeUpgradePreflight } from "../../system/upgrade.mjs";
import { finalizeInstallOrUpgrade } from "../../system/finalize-install.mjs";
import { deleteSecret } from "../../keys/secret-store.mjs";
import { demoHelpText } from "../../demo/help.mjs";
import { info, printBanner, success } from "../../ui/index.mjs";
import { colorizeHelp } from "../../ui.mjs";
import { ROUTING_PREFERENCE_LEVEL_NAMES } from "../../firerouter/core.mjs";
import {
  supportsAnthropicApiKeyFlag,
  supportsRoutingPreference,
} from "../../firerouter/flag.mjs";
import { CURSOR_FIREWORKS_ONLY_NOTE } from "../../harnesses/cursor/core.mjs";

const CLI_NAME = "fireconnect";

const ROUTING_PREF = `${ROUTING_PREFERENCE_LEVEL_NAMES} (or 1-5)`;

function helpLines(...lines) {
  return lines.join("\n");
}

function cmdBlock(title, entries) {
  const body = entries.map(([name, desc]) => `  ${name.padEnd(14)}${desc}`).join("\n");
  return `${title}:\n${body}`;
}

function optBlock(title, entries) {
  const body = entries.map(([flag, desc]) => `  ${flag.padEnd(26)}${desc}`).join("\n");
  return `${title}:\n${body}`;
}

const OPT_HOME = ["--home <path>", "Override HOME for config resolution."];
const OPT_DATA_DIR = ["--data-dir <path>", "Override backup/state directory."];

/**
 * Options for `<harness> on`. FireRouter flags are derived from the harness's
 * own firerouter profile using the same predicates `harness.mjs` validates
 * with, so help can never advertise a flag the runtime rejects.
 */
function standardOnOpts({ azure = true, firerouter = null, modelNote = "" } = {}) {
  const opts = [
    ["--api-key <key>", "Fireworks API key (on also saves config when set)."],
  ];
  if (azure) {
    opts.push(
      ["--azure", "Route through Microsoft Foundry endpoint."],
      ["--base-url <url>", "Microsoft Foundry endpoint (with --azure)."],
    );
  }
  opts.push(["--model <id>", `Model to use${modelNote ? ` (${modelNote})` : ""}.`]);
  if (supportsRoutingPreference(firerouter)) {
    opts.push(["--routing-preference <p>", `FireRouter tradeoff: ${ROUTING_PREF}.`]);
  }
  if (supportsAnthropicApiKeyFlag(firerouter)) {
    opts.push(["--anthropic-api-key <key>", "Anthropic BYOK key for firerouter."]);
  }
  return opts;
}

function claudeHelp() {
  return helpLines(
    `Usage: ${CLI_NAME} claude [command] [options]`,
    "",
    "Route Claude Code through Fireworks. Bare `fireconnect claude` runs on.",
    "",
    cmdBlock("Commands", [
      ["on", "Enable Fireworks routing (default)."],
      ["off", "Restore your previous Claude Code settings."],
      ["status", "Show provider, auth, and model mapping."],
      ["usage", "Estimate cost from a Claude Code session log."],
      ["help", "Show this help."],
    ]),
    "",
    optBlock("Options for on", [
      ["--api-key <key>", "Fireworks API key (also saves ~/.fireconnect/config.json)."],
      ["--base-url <url>", "Anthropic-compatible gateway URL override."],
      ["--model <id>", "Primary/default model."],
      ["--opus <id>", "Model for the opus alias."],
      ["--sonnet <id>", "Model for the sonnet alias."],
      ["--haiku <id>", "Model for the haiku alias."],
      ["--fable <id>", "Model for the fable alias."],
      ["--subagent <id>", "Model for subagents."],
      ["--interactive", "Open the model mapping wizard, including after setup."],
      ["--non-interactive", "Skip first-run model onboarding; use saved preferences or defaults."],
      ["--routing-preference <p>", `FireRouter tradeoff (${ROUTING_PREF}); needs a firerouter slot.`],
      ["--anthropic-api-key <key>", "Anthropic BYOK key for firerouter slots."],
    ]),
    "",
    optBlock("Options for usage", [
      ["--session <id|path>", "Session id prefix or path to a .jsonl log."],
      ["--last-n <N>", "Usage for the latest N parent sessions."],
      ["--plain", "Plain text summary (no interactive TUI styling)."],
      ["-v, --verbose", "Request-level usage rows and rate details."],
    ]),
    "",
    optBlock("Options for status, usage", [
      ["--json", "Machine-readable JSON output."],
    ]),
    "",
    optBlock("Options for all commands", [
      OPT_HOME,
      ["--settings-path <path>", "Explicit Claude Code settings file."],
      OPT_DATA_DIR,
    ]),
  );
}

function configHarnessHelp(id, label, { configPath, configPathNote = "", codexNote = "" } = {}) {
  const onOpts = standardOnOpts({
    firerouter: getHarness(id).firerouter,
    modelNote: id === "deepagents" ? "use firerouter for FireRouter" : id === "codex" ? "use firerouter for FireRouter" : "",
  });
  const allOpts = [
    OPT_HOME,
    [configPath, configPathNote || "Explicit config file path."],
    OPT_DATA_DIR,
  ].filter((row) => row[0]);

  return helpLines(
    `Usage: ${CLI_NAME} ${id} [command] [options]`,
    "",
    `Route ${label} through Fireworks. Bare \`${CLI_NAME} ${id}\` runs on.`,
    codexNote ? `\n${codexNote}` : "",
    "",
    cmdBlock("Commands", [
      ["on", "Enable Fireworks routing (default)."],
      ["off", "Restore your previous config."],
      ["status", "Show provider, auth, and model."],
      ["help", "Show this help."],
    ]),
    "",
    optBlock("Options for on", onOpts),
    "",
    optBlock("Options for status", [
      ["--json", "Machine-readable JSON output."],
    ]),
    "",
    optBlock("Options for all commands", allOpts),
  );
}

function ideHarnessHelp(id, label, { pathFlag, pathDesc, note }) {
  const onOpts = standardOnOpts({ firerouter: getHarness(id).firerouter });
  onOpts.push(["--force", `Write while ${label} is running (not recommended).`]);

  return helpLines(
    `Usage: ${CLI_NAME} ${id} [command] [options]`,
    "",
    `Route ${label} through Fireworks. Bare \`${CLI_NAME} ${id}\` runs on.`,
    "",
    note,
    "",
    cmdBlock("Commands", [
      ["on", "Enable Fireworks routing (default)."],
      ["off", "Restore your previous settings."],
      ["status", "Show provider, auth, and models."],
      ["help", "Show this help."],
    ]),
    "",
    optBlock("Options for on", onOpts),
    "",
    optBlock("Options for status", [
      ["--json", "Machine-readable JSON output."],
    ]),
    "",
    optBlock("Options for all commands", [
      OPT_HOME,
      [pathFlag, pathDesc],
    ]),
  );
}

export function mainCommandsHelp() {
  return helpLines(
    "FireConnect — use Fireworks models in AI coding tools.",
    "",
    cmdBlock("Get started", [
      ["login", "Sign in to Fireworks."],
      ["claude on", "Route Claude Code through Fireworks."],
    ]),
    "",
    cmdBlock("Harnesses", [
      ["claude", "Claude Code"],
      ["opencode", "OpenCode"],
      ["codex", "Codex CLI"],
      ["pi", "Pi"],
      ["cursor", "Cursor IDE"],
      ["vscode", "VS Code Chat"],
      ["deepagents", "Deep Agents (dcode)"],
    ]),
    "",
    cmdBlock("Per harness", [
      ["<harness> on", "Enable Fireworks routing (default)."],
      ["<harness> off", "Restore previous settings."],
      ["<harness> status", "Show provider, auth, and models."],
    ]),
    "",
    cmdBlock("Other", [
      ["status", "Sign-in state and key storage."],
      ["configure", "Provider and Anthropic key."],
      ["upgrade", "Update FireConnect."],
      ["help", "Full command reference."],
      ["help <harness>", "All options for one harness."],
    ]),
  );
}

export function printHelp(topic = "") {
  if (topic === "quick") {
    console.log(colorizeHelp(mainCommandsHelp()));
    return;
  }

  const harnessHelp = {
    claude: claudeHelp(),
    opencode: configHarnessHelp("opencode", "OpenCode", {
      configPath: "--config-path <path>",
      configPathNote: "Explicit opencode.json path.",
    }),
    codex: configHarnessHelp("codex", "Codex CLI", {
      configPath: "--config-path <path>",
      configPathNote: "Explicit ~/.codex/config.toml path.",
      codexNote: "Firerouter BYOK reads ANTHROPIC_API_KEY from your shell. "
        + "Pass --anthropic-api-key with codex on (or configure), then source your shell config.",
    }),
    pi: helpLines(
      configHarnessHelp("pi", "Pi", {
        configPath: "--settings-path <path>",
        configPathNote: "Explicit Pi settings.json path.",
      }),
      "",
      "  --config-path <path>      Alias for --settings-path.",
    ),
    cursor: ideHarnessHelp("cursor", "Cursor", {
      pathFlag: "--db-path <path>",
      pathDesc: "Explicit Cursor state.vscdb path.",
      note: "Quit Cursor before on/off (Cmd-Q). status is read-only. "
        + `${CURSOR_FIREWORKS_ONLY_NOTE}`,
    }),
    vscode: ideHarnessHelp("vscode", "VS Code Chat", {
      pathFlag: "--vscode-path <path>",
      pathDesc: "Explicit chatLanguageModels.json path.",
      note: "If VS Code is running, on/off wait for you to quit and press Enter. Restart after. status is read-only.",
    }),
    deepagents: configHarnessHelp("deepagents", "Deep Agents (dcode)", {
      configPath: "--config-path <path>",
      configPathNote: "Explicit ~/.deepagents/config.toml path.",
    }),
    login: helpLines(
      `Usage: ${CLI_NAME} login [options]`,
      "",
      "Sign in to Fireworks and store an API key in the OS keychain.",
      "",
      optBlock("Options", [
        ["--account <id>", "Enterprise SSO account id."],
        ["--with-token", "Read API key from stdin (CI/non-interactive)."],
        ["--paste", "Skip chooser and paste a key."],
        ["--api-key <key>", "Sign in with this key directly."],
        ["--force", "Skip the replace-key confirmation when already signed in (key rotation)."],
        OPT_HOME,
      ]),
    ),
    logout: helpLines(
      `Usage: ${CLI_NAME} logout [options]`,
      "",
      "Clear stored Fireworks credentials (does not unset FIREWORKS_API_KEY in your shell).",
      "",
      optBlock("Options", [
        ["--revoke", "Revoke this machine's key without prompting."],
      ]),
    ),
    status: helpLines(
      `Usage: ${CLI_NAME} status [options]`,
      "",
      "Show sign-in state (validated live), machine environment, key storage, and per-harness key sources. Exits non-zero when signed out.",
      "",
      optBlock("Options", [
        ["--json", "Machine-readable JSON output."],
        OPT_HOME,
      ]),
    ),
    configure: helpLines(
      `Usage: ${CLI_NAME} configure [options]`,
      "",
      "Set default provider and Anthropic key for firerouter. Use `fireconnect login` for your Fireworks key.",
      "",
      optBlock("Options", [
        ["--provider <name>", "fireworks (default) or azure."],
        ["--base-url <url>", "Foundry URL (with --provider azure)."],
        ["--api-key <key>", "Foundry endpoint key (azure only)."],
        ["--anthropic-api-key <key>", "Anthropic key for firerouter."],
        OPT_HOME,
      ]),
    ),
    demo: demoHelpText(CLI_NAME),
    uninstall: helpLines(
      `Usage: ${CLI_NAME} uninstall`,
      "",
      "Disable all harnesses and remove FireConnect (~/.fireconnect/, CLI launcher).",
    ),
    upgrade: helpLines(
      `Usage: ${CLI_NAME} upgrade`,
      "",
      "Update FireConnect (curl/git install only).",
    ),
  };

  if (topic && harnessHelp[topic]) {
    console.log(colorizeHelp(harnessHelp[topic]));
    return;
  }

  console.log(colorizeHelp(helpLines(
    "FireConnect — use Fireworks models in AI coding tools.",
    "",
    `Usage: ${CLI_NAME} [<harness> [command]] [options]`,
    "",
    cmdBlock("Harnesses", [
      ["claude", "Claude Code"],
      ["opencode", "OpenCode"],
      ["codex", "Codex CLI"],
      ["pi", "Pi"],
      ["cursor", "Cursor IDE"],
      ["vscode", "VS Code Chat"],
      ["deepagents", "Deep Agents (dcode)"],
    ]),
    "",
    cmdBlock("Harness commands", [
      ["on", "Route the harness through Fireworks (default when omitted)."],
      ["off", "Restore previous provider settings."],
      ["status", "Show provider, auth, and models."],
      ["usage", "Claude-only: session usage report."],
      ["help", "Show harness-specific options."],
    ]),
    "",
    cmdBlock("Global commands", [
      ["login", "Sign in to Fireworks."],
      ["logout", "Clear stored credentials."],
      ["status", "Show sign-in state, machine environment, and key storage."],
      ["model list", "Browse serverless models."],
      ["configure", "Set provider and Anthropic key."],
      ["demo", "Race your provider vs Fireworks on a prompt."],
      ["upgrade", "Update FireConnect."],
      ["uninstall", "Remove FireConnect."],
      ["help", "Show help (`help <topic>` or `<harness> help`)."],
    ]),
    "",
    optBlock("Global options", [
      ["--version, -V", "Print CLI version (--json for machine-readable)."],
      ["--search <q>", "Filter model list."],
      ["--json", "Machine-readable model list output."],
    ]),
    "",
    `Run \`${CLI_NAME} <harness> help\` for every option on that harness.`,
  )));
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
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
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

/**
 * Shared post-bootstrap finalize used by `fireconnect upgrade` and
 * `install.sh` (via hidden `finalize-install`). See finalize-install.mjs.
 *
 * @param {string} home
 * @param {string} installDir
 */
async function finalizeUpgradeKeyStorage(home, installDir) {
  await finalizeInstallOrUpgrade({ home, installDir });
}

/**
 * Hidden easter-egg entry point — not listed in help. Use for local preview;
 * install.sh uses bin/fireconnect-banner.mjs directly.
 */
export function runBannerCommand() {
  printBanner({ version: readLocalVersion() || undefined });
}

/**
 * Hidden install.sh entry point — not listed in help. Same body as upgrade
 * finalize (deps, key-storage probe, harness + websearch MCP rebake).
 *
 * @param {{ home?: string }} [ctx]
 */
export async function runFinalizeInstallCommand(ctx = {}) {
  const home = ctx.home || process.env.HOME || "";
  const installDir = home ? path.join(home, ".fireconnect/cli") : "";
  await finalizeInstallOrUpgrade({ home, installDir });
}

/**
 * Dependencies are injectable so the fetch/compare/preflight/reset ordering can
 * be tested without a network or a real installation.
 *
 * @param {{
 *   home?: string,
 *   execFile?: typeof execFileSync,
 *   exists?: typeof existsSync,
 *   readVersion?: typeof readInstalledVersion,
 *   finalize?: typeof finalizeUpgradeKeyStorage,
 *   printNotes?: typeof printReleaseNotesAfterUpgrade,
 *   preflight?: typeof runClaudeUpgradePreflight,
 *   getClaudeAdapter?: () => { off: (ctx: object) => Promise<void> },
 *   input?: NodeJS.ReadStream | { isTTY?: boolean },
 *   printBannerFn?: typeof printBanner,
 *   infoFn?: typeof info,
 *   successFn?: typeof success,
 *   log?: (...args: unknown[]) => void,
 * }} [dependencies]
 */
export async function runUpgradeCommand({
  home = process.env.HOME ?? "",
  execFile = execFileSync,
  exists = existsSync,
  readVersion = readInstalledVersion,
  finalize = finalizeUpgradeKeyStorage,
  printNotes = printReleaseNotesAfterUpgrade,
  preflight = runClaudeUpgradePreflight,
  getClaudeAdapter = () => getHarness(HARNESS.CLAUDE),
  input = process.stdin,
  printBannerFn = printBanner,
  infoFn = info,
  successFn = success,
  log = console.log,
} = {}) {
  if (!home) {
    throw new Error("HOME is not set; upgrade requires HOME to be set.");
  }
  const installDir = path.join(home, ".fireconnect/cli");

  printBannerFn();

  if (!exists(path.join(installDir, ".git"))) {
    infoFn("Nothing to upgrade: FireConnect was not installed via the curl installer.");
    infoFn("Re-run the installer to get the latest version:");
    infoFn("  curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh | bash");
    await finalize(home, installDir);
    return;
  }

  const before = await readVersion(installDir);
  if (before) {
    infoFn(`Current version: v${before}`);
  }

  let beforeHash = "";
  try {
    beforeHash = execFile("git", ["-C", installDir, "rev-parse", "HEAD"], { stdio: "pipe", encoding: "utf8" }).trim();
  } catch { /* non-fatal */ }

  infoFn("Checking for updates...");
  let targetHash = "";
  try {
    execFile("git", ["-C", installDir, "fetch", "--depth=1", "origin", "main", "--quiet"], { stdio: "pipe" });
    targetHash = execFile("git", ["-C", installDir, "rev-parse", "FETCH_HEAD"], {
      stdio: "pipe",
      encoding: "utf8",
    }).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim() ?? error.message;
    throw new Error(`Upgrade failed: ${detail}`);
  }

  if (!targetHash) {
    throw new Error("Upgrade failed: unable to determine the fetched revision.");
  }

  if (beforeHash && beforeHash === targetHash) {
    infoFn(`Already up to date${before ? ` (v${before})` : ""}.`);
    await printNotes({
      home,
      fromVersion: "",
      toVersion: before,
      installDir,
    });
    await finalize(home, installDir);
    return;
  }

  // The registry was loaded from the currently running revision. Capture that
  // adapter before reset so restoration cannot switch to newly fetched code.
  // Claude-off preflight only applies when upgrading from FireConnect < 0.9.0.
  const oldClaudeAdapter = getClaudeAdapter();
  const claudePreflight = await preflight({
    home,
    adapter: oldClaudeAdapter,
    input,
    installedVersion: before,
  });
  if (!claudePreflight.proceed) {
    infoFn("Upgrade cancelled.");
    return;
  }

  try {
    execFile("git", ["-C", installDir, "reset", "--hard", targetHash], { stdio: "pipe" });
  } catch (error) {
    const detail = error.stderr?.toString().trim() ?? error.message;
    throw new Error(`Upgrade failed: ${detail}`);
  }

  const afterHash = targetHash;
  const after = await readVersion(installDir);

  // Reinstall runtime dependencies after the pull — a new release may have
  // added/changed deps (e.g. cross-keychain). Without this, upgraded installs
  // can hit "OS keychain is unavailable" if the dep was missing. Skip the npm
  // resolution when the lockfile is unchanged between commits (code-only
  // releases), to avoid ~300-800ms of overhead on every upgrade.
  const lockfileRel = "packages/setup-cli/package-lock.json";
  let depsChanged = true;
  if (beforeHash && afterHash) {
    try {
      execFile("git", ["-C", installDir, "diff", "--quiet", beforeHash, afterHash, "--", lockfileRel], { stdio: "ignore" });
      depsChanged = false; // exit 0 => no diff
    } catch {
      depsChanged = true; // non-zero => diff (or git error) => install
    }
  }

  const setupDir = path.join(installDir, "packages/setup-cli");
  if (depsChanged && exists(setupDir)) {
    // npm is npm.cmd on Windows; execFileSync without shell:true doesn't resolve
    // .cmd shims, so pick the right binary name per platform.
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    try {
      execFile(npmBin, ["install", "--omit=dev", "--no-fund", "--no-audit"], {
        cwd: setupDir,
        stdio: "inherit",
      });
    } catch (error) {
      throw new Error(`Upgrade failed: could not install dependencies (${error.message}). Re-run the installer.`);
    }
  }

  if (!claudePreflight.restored) {
    if (before && after && before !== after) {
      successFn(`Upgraded v${before} → v${after}.`);
    } else {
      successFn(`FireConnect upgraded successfully${after ? ` (v${after})` : ""}.`);
    }
  }

  await printNotes({
    home,
    fromVersion: before,
    toVersion: after,
    installDir,
  });
  await finalize(home, installDir);

  if (claudePreflight.restored) {
    log("Upgrade complete. Your original Claude Code settings were restored.");
    log(`To reconnect with FireConnect v${after || before || "unknown"}:\n  fireconnect claude on`);
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
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
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

  await removeShellEnvHook(home).catch(() => {});
  await deleteSecret(home);

  const pathsToRemove = [
    path.join(home, DEFAULT_DATA_DIR),
    path.join(home, OPENCODE_DATA_RELATIVE_DIR),
    path.join(home, CODEX_DATA_RELATIVE_DIR),
    ...(removeCatalog ? [path.join(home, CODEX_CATALOG_RELATIVE_PATH)] : []),
    path.join(home, PI_DATA_RELATIVE_DIR),
    path.join(home, DEEPAGENTS_DATA_RELATIVE_DIR),
    globalConfigPath(home),
    path.join(home, ".fireconnect/cli"),
    path.join(home, ".local/bin/fireconnect"),
    // Final sweep: remove the whole ~/.fireconnect dir last so nothing is left
    // behind (update-check.json, update-check.lock, key-storage.json, plaintext
    // .api-key fallback). Listed after the CLI binary so a failure removing the
    // dir doesn't skip binary removal. (gh fw-ai/fireconnect#12)
    path.join(home, ".fireconnect"),
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
    console.log("FireConnect has been uninstalled. Restart any running harnesses (Claude Code, OpenCode, Codex, Pi, Cursor, VS Code, Deep Agents) to fully apply.");
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

  if (command === "launcher") {
    const { runLauncherCommand } = await import("./launcher.mjs");
    await runLauncherCommand(ctx);
    return;
  }

  if (command === "login" || command === "logout") {
    const { runLoginCommand, runLogoutCommand } = await import("./login.mjs");
    await (command === "login" ? runLoginCommand(ctx) : runLogoutCommand(ctx));
    return;
  }

  if (command === "status") {
    const { runStatusCommand } = await import("./status.mjs");
    await runStatusCommand(ctx);
    return;
  }

  if (command === "model" && parsed.modelSubcommand === "list") {
    await runGlobalModelListCommand(ctx);
    return;
  }

  if (command === "configure") {
    await runConfigureCommand(ctx);
    return;
  }

  if (command === "key") {
    const { runKeyCommand } = await import("./key.mjs");
    await runKeyCommand(ctx, parsed.keySubcommand);
    return;
  }

  if (command === "upgrade") {
    await runUpgradeCommand();
    return;
  }

  if (command === "banner") {
    runBannerCommand();
    return;
  }

  if (command === "finalize-install") {
    await runFinalizeInstallCommand(ctx);
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
