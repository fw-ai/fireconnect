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
  DEEPSEEK_DATA_RELATIVE_DIR,
} from "../../harnesses/deepseek/core.mjs";
import {
  PI_DATA_RELATIVE_DIR,
} from "../../harnesses/pi/core.mjs";
import {
  CURSOR_DATA_RELATIVE_DIR,
  CURSOR_FIREWORKS_ONLY_NOTE,
} from "../../harnesses/cursor/core.mjs";
import {
  VSCODE_DATA_RELATIVE_DIR,
} from "../../harnesses/vscode/core.mjs";
import { globalConfigPath } from "../../config/global-config.mjs";
import { isHarnessRouted } from "../../harness/engine.mjs";
import { getHarness, listHarnesses } from "../../harness/registry.mjs";
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
import { accent, check as checkGlyph, red, symbols } from "../../ui/style.mjs";

/**
 * Per-harness FireConnect data dir (`~/.fireconnect/<id>`), holding the
 * snapshot/backup `off` needs to restore. Deleting a harness's dir only after
 * its `off` succeeds keeps restore recoverable if a later step fails.
 * @type {Record<string, string>}
 */
const HARNESS_DATA_DIR = {
  [HARNESS.CLAUDE]: DEFAULT_DATA_DIR,
  [HARNESS.OPENCODE]: OPENCODE_DATA_RELATIVE_DIR,
  [HARNESS.CODEX]: CODEX_DATA_RELATIVE_DIR,
  [HARNESS.PI]: PI_DATA_RELATIVE_DIR,
  [HARNESS.DEEPSEEK]: DEEPSEEK_DATA_RELATIVE_DIR,
  [HARNESS.CURSOR]: CURSOR_DATA_RELATIVE_DIR,
  [HARNESS.VSCODE]: VSCODE_DATA_RELATIVE_DIR,
};

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
      ["usage", "Pick session → live meter (Tab for the agents pane); snapshot with --json / --last-n."],
      ["live", "tmux split: Claude Code left, live usage meter right (exit Claude to close)."],
      ["demo", "Race two models on a prompt (requires claude on)."],
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
      ["--session <id|path>", "Start on one session; Esc still opens the session list."],
      ["--days <N>", "Lookback for the session list, 1-365 (default 3)."],
      ["--last-n <N>", "Snapshot of the latest N parent sessions."],
      ["--plain", "Plain text summary (no interactive TUI styling)."],
      ["-v, --verbose", "Request-level usage rows and rate details."],
    ]),
    "",
    optBlock("Options for status, usage", [
      ["--json", "Machine-readable JSON output."],
    ]),
    "",
    `Run \`${CLI_NAME} help demo\` for demo-specific options.`,
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
    azure: Boolean(getHarness(id).azure),
    firerouter: getHarness(id).firerouter,
    modelNote: id === "deepseek" ? "use firerouter for FireRouter" : id === "codex" ? "use firerouter for FireRouter" : "",
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
      ["claude", "Route Claude Code through Fireworks."],
    ]),
    "",
    cmdBlock("Harnesses", [
      ["claude", "Claude Code"],
      ["opencode", "OpenCode"],
      ["codex", "Codex CLI"],
      ["pi", "Pi"],
      ["cursor", "Cursor IDE"],
      ["vscode", "VS Code Chat"],
      ["deepseek", "DeepSeek Harness (dsh)"],
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
      note: "If VS Code is running, on/off wait for you to quit (press Enter or auto-detect). Restart after. status is read-only.",
    }),
    deepseek: configHarnessHelp("deepseek", "DeepSeek Harness (dsh)", {
      configPath: "--config-path <path>",
      configPathNote: "Explicit ~/.dsh/settings.yaml path.",
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
    demo: demoHelpText(CLI_NAME, { deprecatedTopLevel: true }),
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
      ["deepseek", "DeepSeek Harness (dsh)"],
    ]),
    "",
    cmdBlock("Harness commands", [
      ["on", "Route the harness through Fireworks (default when omitted)."],
      ["off", "Restore previous provider settings."],
      ["status", "Show provider, auth, and models."],
      ["usage", "Claude-only: session usage report."],
      ["live", "Claude-only: tmux split with live usage meter."],
      ["demo", "Claude-only: race two models on a prompt."],
      ["help", "Show harness-specific options."],
    ]),
    "",
    cmdBlock("Global commands", [
      ["login", "Sign in to Fireworks."],
      ["logout", "Clear stored credentials."],
      ["status", "Show sign-in state, machine environment, and key storage."],
      ["model list", "Browse serverless models."],
      ["configure", "Set provider and Anthropic key."],
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
    log(`To reconnect with FireConnect v${after || before || "unknown"}:\n  fireconnect claude`);
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
 * Which harnesses uninstall must restore: the ones that are actually on, and
 * nothing else. A harness FireConnect never turned on has nothing to restore, so
 * listing it would only add "wasn't connected" noise to the checklist and run a
 * no-op `off`.
 *
 * "On" is decided by `isHarnessRouted` — the same check `<harness> off` uses to
 * pick restore-vs-strip. It reads the harness's own config via `providerStatus`
 * rather than trusting FireConnect's `enabled` flag, so a harness whose flag has
 * drifted is still classified by what is actually in its config. That matters in
 * both directions: a stale `true` must not put a harness that was never routed
 * on the checklist, and a stale or missing `false` must not skip one that is
 * routed — skipping it leaves its provider settings in place while the cleanup
 * below deletes its backup, which is unrecoverable (a Cursor left pointed at the
 * Fireworks base URL with its built-in models hidden and no snapshot left).
 *
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 * @param {string} home
 * @returns {Promise<string[]>} harnesses that are on, in registry order
 */
async function discoverHarnessesToRestore(ctx, home) {
  const ids = [];
  for (const adapter of listHarnesses()) {
    const on = await isHarnessRouted(adapter, {
      ...ctx,
      home,
      settingsPath: "",
      configPath: "",
      dataDir: "",
    });
    if (on) {
      ids.push(adapter.id);
    }
  }
  return ids;
}

/**
 * Restore one harness's pre-FireConnect config. Interactive uninstall calls
 * this per harness (without `force`) so Cursor/VS Code get the interactive
 * "quit the IDE" wait via their own `prepareOff`; non-interactive uninstall
 * passes `force: true` to skip the wait (CI/scripts). Errors are collected,
 * not thrown, so one harness failing doesn't abort the rest.
 *
 * `quiet` silences the harness's own restored/unchanged + restart-hint lines
 * (see `engineOff`) so the interactive checklist is the only narration; the
 * outcome is still returned so the checklist can say what actually happened.
 *
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 * @param {string} home
 * @param {string} harnessId
 * @param {boolean} force
 * @param {{ quiet?: boolean }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   outcome?: "restored" | "stripped" | "none",
 *   error?: { harnessId: string, label: string, message: string },
 * }>}
 */
async function restoreHarness(ctx, home, harnessId, force, { quiet = false } = {}) {
  const adapter = getHarness(harnessId);
  const offCtx = {
    ...ctx,
    home,
    settingsPath: "",
    configPath: "",
    dataDir: "",
    force,
    quiet,
  };
  try {
    const outcome = await adapter.off(offCtx);
    return { ok: true, outcome };
  } catch (error) {
    return {
      ok: false,
      error: { harnessId, label: adapter.label, message: error.message },
    };
  }
}

/**
 * Shared tail: remove the shell env hook, stored secret, and the remaining
 * top-level FireConnect files (config, CLI launcher, launcher symlink, the
 * final `~/.fireconnect` sweep). Per-harness data dirs are deleted earlier in
 * the interactive path; in the non-interactive path they're included here.
 *
 * @param {string} home
 * @param {boolean} removeCatalog
 * @param {{
 *   skipPerHarnessDirs?: Set<string>,
 *   reportStep?: (label: string) => Promise<void> | void,
 * }} [opts]  `skipPerHarnessDirs`: harness dirs already removed by the
 *   interactive path (the non-interactive path removes all). Interactive runs
 *   only reach this function when every restore succeeded, so the skip set holds
 *   the harnesses that were on; the unskipped entries clean up dirs left behind
 *   by harnesses that were already off. `reportStep`: called after each
 *   cleanup step so the interactive path can tick a checklist.
 * @returns {Promise<{ path: string, message: string }[]>} removal failures
 */
async function removeFireConnectFiles(home, removeCatalog, { skipPerHarnessDirs, reportStep } = {}) {
  await removeShellEnvHook(home).catch(() => {});
  await reportStep?.("Shell environment hook");

  await deleteSecret(home);
  await reportStep?.("Stored API key");

  const perHarnessDirs = Object.values(HARNESS_DATA_DIR)
    .filter((dir) => !skipPerHarnessDirs?.has(dir));

  const pathsToRemove = [
    ...perHarnessDirs.map((dir) => path.join(home, dir)),
    ...(removeCatalog ? [path.join(home, CODEX_CATALOG_RELATIVE_PATH)] : []),
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
  await reportStep?.("FireConnect files");
  return removalFailures;
}

/**
 * Uninstall is mostly instant, which makes the checklist flash past in one
 * frame — the user can't tell what was restored. A short beat between steps
 * makes it legible. Interactive runs only; skipped under FIRECONNECT_TEST so
 * suites don't pay for it.
 * @param {boolean} interactive
 * @param {number} [ms]
 */
async function pace(interactive, ms = 220) {
  if (!interactive || process.env.FIRECONNECT_TEST === "1") {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reported when a harness could not be restored, so uninstall stopped before
 * removing FireConnect. Harnesses restored earlier in the run stay restored —
 * that is the desired end state for them — so the message says so rather than
 * claiming nothing happened.
 * @param {{ harnessId: string, label: string, message: string }[]} offErrors
 * @param {string[]} restoredLabels  harnesses already restored in this run
 */
function printUninstallAborted(offErrors, restoredLabels) {
  console.log("");
  console.log("  Stopped before removing FireConnect.");
  console.log("");
  for (const { label, message } of offErrors) {
    console.log(`  ${label} could not be restored:`);
    console.log(`    ${message}`);
  }
  if (restoredLabels.length > 0) {
    console.log("");
    console.log(`  Already restored, and left that way: ${restoredLabels.join(", ")}.`);
  }
  console.log("");
  console.log("  FireConnect is still installed and your backups are intact, so it");
  console.log("  is safe to resolve the above and run the same command again:");
  console.log(`    ${accent(`${CLI_NAME} uninstall`)}`);
  console.log("");
  console.log("  To remove FireConnect regardless, without waiting on an editor");
  console.log("  (a running editor may overwrite the restore):");
  console.log(`    ${accent(`${CLI_NAME} uninstall --force`)}`);
  console.log("");
}

/**
 * Parting message after a clean uninstall. FireConnect edits the user's tools,
 * so the important line is "your originals are back" — the send-off is warm
 * but the actionable facts (restart, how to come back) come first.
 * @param {string[]} restoredLabels
 */
function printFarewell(restoredLabels) {
  console.log("");
  if (restoredLabels.length > 0) {
    console.log(`  Your original settings are back in ${restoredLabels.join(", ")}.`);
    console.log("  Restart anything still open to pick them up.");
  } else {
    console.log("  No tool settings were touched — nothing to restore.");
  }
  console.log("");
  console.log("  Sad to see you go! If something pushed you away, we'd like to know:");
  console.log(`    ${accent("https://github.com/fw-ai/fireconnect/issues")}`);
  console.log("");
  console.log("  Reinstall anytime:");
  console.log(`    ${accent("curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh | bash")}`);
  console.log("");
}

/**
 * Print the final uninstall summary.
 * @param {{ offErrors: { harnessId: string, label: string, message: string }[], removalFailures: { path: string, message: string }[] }} state
 */
function printUninstallSummary({ offErrors, removalFailures }) {
  const hasErrors = offErrors.length > 0 || removalFailures.length > 0;
  if (!hasErrors) {
    console.log("FireConnect has been uninstalled. Restart any running harnesses (Claude Code, OpenCode, Codex, Pi, Cursor, VS Code, DeepSeek Harness) to fully apply.");
    return;
  }
  for (const { harnessId, label, message } of offErrors) {
    console.error(`Warning: failed to restore ${harnessId}: ${message}`);
    console.error(`Restart ${label} manually to clear any Fireworks settings.`);
  }
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

/**
 * Uninstall FireConnect: restore each enabled harness's pre-FireConnect
 * config, then remove FireConnect's own files.
 *
 * Interactive (TTY, no --force): restore harnesses one by one as a checklist.
 * Cursor/VS Code get the interactive "quit the IDE" wait (their `prepareOff`
 * calls `ensureCursorStopped`/`ensureVscodeStopped`); file-based harnesses
 * restore immediately. Each harness's data dir is deleted right after its
 * `off` succeeds, so a later failure never leaves restore unrecoverable.
 *
 * Non-interactive (no TTY, or --force): force-restore every harness without
 * waiting (CI/scripts), then batch-remove all files — the historical behavior.
 *
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

  const harnessIds = await discoverHarnessesToRestore(ctx, home);
  // Interactive only when stdin is a TTY and the user didn't pass --force.
  // This mirrors `ensureIdeStopped`'s own TTY gate, so the two stay consistent:
  // a non-TTY (CI/pipe) keeps the historical force-restore-all behavior.
  const interactive = Boolean(process.stdin.isTTY) && !ctx.force;

  const offErrors = [];
  const removedHarnessDirs = new Set();

  const restoredLabels = [];

  if (interactive) {
    if (harnessIds.length === 0) {
      // No harness is on, but FireConnect itself may still be
      // installed (CLI launcher, ~/.fireconnect, stored key). Don't bail —
      // fall through to file removal. Only say "not installed" when there
      // are no harnesses AND no FireConnect files on disk.
      if (!existsSync(path.join(home, ".fireconnect"))
        && !existsSync(path.join(home, ".local/bin/fireconnect"))) {
        console.log("FireConnect is not installed.");
        return;
      }
    }

    console.log("");
    console.log(`  Uninstalling ${accent("FireConnect")}`);

    if (harnessIds.length > 0) {
      console.log("");
      console.log("  Restoring your tools");
      // Pad labels so the ✓ column lines up regardless of name length.
      const width = Math.max(...harnessIds.map((id) => getHarness(id).label.length));

      for (const harnessId of harnessIds) {
        const adapter = getHarness(harnessId);
        const label = adapter.label.padEnd(width);
        // No spinner here. `off` narrates on stdout itself (and Cursor/VS Code
        // may print an interactive "quit the IDE" prompt), and a spinner
        // rewriting the current line collides with both. `quiet` silences the
        // harness's own restored/restart lines so this checklist is the single
        // source of narration; the prompt, which the user must see, still prints.
        const result = await restoreHarness(ctx, home, harnessId, false, { quiet: true });

        if (result.ok) {
          const touched = result.outcome === "restored" || result.outcome === "stripped";
          console.log(`    ${checkGlyph()} ${label}  ${touched ? "restored" : "wasn't connected"}`);
          if (touched) {
            restoredLabels.push(adapter.label);
          }
          // Delete this harness's data dir now that restore is confirmed, so
          // the backup only goes away once `off` has succeeded.
          const dir = HARNESS_DATA_DIR[harnessId];
          if (dir) {
            await removePath(path.join(home, dir));
            removedHarnessDirs.add(dir);
          }
        } else {
          offErrors.push(result.error);
          // Data dir deliberately kept — see the abort below, which stops
          // before any destructive cleanup so this backup stays usable.
          console.log(`    ${red(symbols.fail)} ${label}  could not be restored — ${result.error.message}`);
        }
        await pace(interactive);
      }
    }
  } else {
    // Non-interactive: force-restore every harness without waiting.
    for (const harnessId of harnessIds) {
      const result = await restoreHarness(ctx, home, harnessId, true);
      if (!result.ok) {
        offErrors.push(result.error);
        console.error(`Warning: failed to restore ${harnessId}: ${result.error.message}`);
        console.error(`Restart ${result.error.label} manually to clear any Fireworks settings.`);
      }
    }
  }

  // A harness that failed to restore is still routed through Fireworks, and its
  // backup under ~/.fireconnect/<id> is the only way back. Stop before any
  // destructive cleanup so that backup — plus the config and the CLI needed to
  // use it — survives for a retry. The most likely trigger is the user
  // declining to quit Cursor; deleting their backup in response to "no" would
  // be indefensible.
  //
  // Non-interactive runs keep the historical delete-everything behavior: they
  // force past the IDE guard (so this rarely trips) and a script cannot act on
  // a retry hint, whereas leaving a half-removed install would strand CI.
  if (interactive && offErrors.length > 0) {
    printUninstallAborted(offErrors, restoredLabels);
    process.exitCode = 1;
    return;
  }

  // Codex catalog: keep it if codex `off` failed, or if the restored config
  // still references the Fireworks catalog (otherwise `codex off` would 404).
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

  if (interactive) {
    console.log("");
    console.log("  Cleaning up");
  }

  const cleanupWidth = "Shell environment hook".length;
  const removalFailures = await removeFireConnectFiles(home, removeCatalog, {
    skipPerHarnessDirs: interactive ? removedHarnessDirs : undefined,
    reportStep: interactive
      ? async (label) => {
        console.log(`    ${checkGlyph()} ${label.padEnd(cleanupWidth)}  removed`);
        await pace(interactive, 160);
      }
      : undefined,
  });

  if (interactive && removalFailures.length === 0 && offErrors.length === 0) {
    printFarewell(restoredLabels);
    return;
  }

  printUninstallSummary({ offErrors, removalFailures });
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
