import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";

const runExec = promisify(execFile);

/** Agent/label for the profile-lane shim service (launchd label / systemd unit stem). */
export const SHIM_AGENT_LABEL = "ai.fireworks.fireconnect.claude-desktop-shim";
const LAUNCHCTL = "/bin/launchctl";
const SYSTEMCTL = "systemctl";
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Platforms the shim service can be installed on. */
export const SUPPORTED_PLATFORMS = ["darwin", "linux"];

/**
 * Every privileged/system-mutating helper is gated on BOTH an explicit opt-in
 * from the calling command AND the FIRECONNECT_TEST kill switch. Tests never
 * pass a real `allowSystemChanges: true` with the default runner.
 */
function systemChangesAllowed({ allowSystemChanges = false } = {}) {
  if (process.env.FIRECONNECT_TEST === "1") {
    throw new Error("FIRECONNECT_TEST=1: Desktop system changes (services) are disabled.");
  }
  if (!allowSystemChanges) {
    throw new Error("Desktop system changes require explicit opt-in.");
  }
}

/**
 * Where the owned service definition lives:
 * - macOS: ~/Library/LaunchAgents/<label>.plist
 * - Linux: ~/.config/systemd/user/<label>.service
 * @param {string} home
 * @param {{ platform?: string, label?: string }} [options]
 */
export function shimServiceFilePath(home, { platform = process.platform, label = SHIM_AGENT_LABEL } = {}) {
  if (platform === "linux") {
    return path.join(home, ".config", "systemd", "user", `${label}.service`);
  }
  return path.join(home, "Library", "LaunchAgents", `${label}.plist`);
}

/**
 * Pure launchd plist builder (no side effects; heavily unit-tested).
 * @param {{ nodeExec: string, entry: string, home: string, logPath: string, errorPath: string }} args
 */
export function buildLaunchAgentPlist({ nodeExec, entry, home, logPath, errorPath, label = SHIM_AGENT_LABEL }) {
  const escape = (value) => String(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(nodeExec)}</string>
    <string>${escape(entry)}</string>
    <string>--home</string>
    <string>${escape(home)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${escape(home)}</string>
  </dict>
  <key>StandardOutPath</key><string>${escape(logPath)}</string>
  <key>StandardErrorPath</key><string>${escape(errorPath)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
}

/**
 * Quote one word for a systemd unit `ExecStart=` / `Environment=` line:
 * double quotes with backslash-escaped `\\` and `"` (systemd.service(5),
 * "Command lines"). Always quoted so spaces and `%` specifiers in paths
 * are literal.
 */
function unitQuote(value) {
  const escaped = String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `"${escaped}"`;
}

/**
 * Pure systemd user-unit builder (the Linux counterpart of the plist).
 * Restart=always mirrors KeepAlive; the unit is enabled under default.target
 * so it comes up at login. XDG_CONFIG_HOME is baked in when set: the user
 * manager's environment need not carry it, and the shim must find the same
 * Claude-3p directory the app uses.
 * @param {{ nodeExec: string, entry: string, home: string, logPath: string, errorPath: string, env?: NodeJS.ProcessEnv }} args
 */
export function buildSystemdUnit({ nodeExec, entry, home, logPath, errorPath, env = process.env }) {
  const environment = [`Environment=${unitQuote(`HOME=${home}`)}`];
  if (env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)) {
    environment.push(`Environment=${unitQuote(`XDG_CONFIG_HOME=${env.XDG_CONFIG_HOME}`)}`);
  }
  return `[Unit]
Description=FireConnect Claude Desktop shim (Fireworks gateway on 127.0.0.1)
# Owned by fireconnect: \`fireconnect claude-desktop off\` removes it.

[Service]
Type=simple
ExecStart=${unitQuote(nodeExec)} ${unitQuote(entry)} --home ${unitQuote(home)}
${environment.join("\n")}
Restart=always
RestartSec=2
StandardOutput=append:${logPath}
StandardError=append:${errorPath}

[Install]
WantedBy=default.target
`;
}

/**
 * Start the owned LaunchAgent (bootstrap under the invoking user's GUI
 * domain). Never kills or labels anything it does not own.
 * @param {string} plistPath
 * @param {{ run?: typeof runExec, allowSystemChanges?: boolean, label?: string }} [options]
 */
export async function startLaunchAgent(plistPath, options = {}) {
  const label = options.label ?? SHIM_AGENT_LABEL;
  systemChangesAllowed(options);
  const run = options.run ?? runExec;
  const uid = process.getuid();
  await run(LAUNCHCTL, ["bootstrap", `gui/${uid}`, plistPath], {
    timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
  }).catch(async (error) => {
    // "Bootstrapped already" (5: Input/output error) means an owned agent is
    // loaded from a previous `on` — with the plist as it was THEN. bootstrap
    // never reloads a loaded job, so boot it out and load the current plist;
    // otherwise a config change on upgrade silently never takes effect.
    const message = String(error?.stderr ?? error?.message ?? "");
    if (!/already bootstrapped|5:/i.test(message)) throw error;
    await run(LAUNCHCTL, ["bootout", `gui/${uid}/${label}`], {
      timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
    }).catch(() => {});
    await run(LAUNCHCTL, ["bootstrap", `gui/${uid}`, plistPath], {
      timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
    });
  });
  await run(LAUNCHCTL, ["kickstart", `-k`, `gui/${uid}/${label}`], {
    timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
  }).catch(() => {});
}

/**
 * Stop and unload the owned LaunchAgent.
 * @param {{ run?: typeof runExec, allowSystemChanges?: boolean, label?: string }} [options]
 */
export async function stopLaunchAgent(options = {}) {
  const label = options.label ?? SHIM_AGENT_LABEL;
  systemChangesAllowed(options);
  const run = options.run ?? runExec;
  const uid = process.getuid();
  await run(LAUNCHCTL, ["bootout", `gui/${uid}/${label}`], {
    timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
  }).catch((error) => {
    const message = String(error?.stderr ?? error?.message ?? "");
    if (/No such process|not loaded|Could not find/i.test(message)) return;
    throw error;
  });
}

function systemctlUser(run, args) {
  return run(SYSTEMCTL, ["--user", ...args], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
}

/** True for the errors a `systemctl --user` call makes when there is no user manager to talk to. */
function noUserManager(error) {
  const message = String(error?.stderr ?? error?.message ?? "");
  return /Failed to connect to bus|not been booted with systemd|\$XDG_RUNTIME_DIR|No medium found/i.test(message)
    || error?.code === "ENOENT";
}

/**
 * Start the owned systemd user unit. The unit file is already written at
 * `unitPath`; daemon-reload picks up a changed definition (upgrade), enable
 * makes it come back at login, and restart (not `enable --now`, which leaves
 * a running service on its old definition) applies the current one. Only
 * ever addresses our own unit name.
 * @param {string} unitPath
 * @param {{ run?: typeof runExec, allowSystemChanges?: boolean, label?: string }} [options]
 */
export async function startSystemdUnit(_unitPath, options = {}) {
  const label = options.label ?? SHIM_AGENT_LABEL;
  const unit = `${label}.service`;
  systemChangesAllowed(options);
  const run = options.run ?? runExec;
  try {
    await systemctlUser(run, ["daemon-reload"]);
  } catch (error) {
    if (!noUserManager(error)) throw error;
    throw new Error(
      "No systemd user session is available (systemctl --user cannot reach the user manager). "
      + "Run this from a logged-in desktop session, or check `loginctl user-status`.",
      { cause: error },
    );
  }
  await systemctlUser(run, ["enable", unit]).catch((error) => {
    // A unit outside the standard search path can't be enabled, but can
    // still run; log-free best effort — the restart below is what matters.
    const message = String(error?.stderr ?? error?.message ?? "");
    if (!/does not exist|No such file|not found/i.test(message)) throw error;
  });
  await systemctlUser(run, ["restart", unit]);
}

/**
 * Stop and disable the owned systemd user unit, remove its file, and
 * reload so the manager forgets it. A unit that was never loaded is success.
 * @param {{ run?: typeof runExec, allowSystemChanges?: boolean, label?: string, unitPath?: string }} [options]
 */
export async function stopSystemdUnit(options = {}) {
  const label = options.label ?? SHIM_AGENT_LABEL;
  const unit = `${label}.service`;
  systemChangesAllowed(options);
  const run = options.run ?? runExec;
  const ignorable = (error) => {
    const message = String(error?.stderr ?? error?.message ?? "");
    if (/not loaded|does not exist|No such file|not found|Unit .* is not loaded/i.test(message)) return;
    if (noUserManager(error)) return; // nothing is running without a manager
    throw error;
  };
  await systemctlUser(run, ["disable", "--now", unit]).catch(ignorable);
  await systemctlUser(run, ["reset-failed", unit]).catch(() => {});
  if (options.unitPath) await rm(options.unitPath, { force: true });
  await systemctlUser(run, ["daemon-reload"]).catch(() => {});
}

/**
 * Platform dispatchers: the profile lane calls these and never branches on
 * the OS itself.
 */
export function buildShimServiceFile(args, { platform = process.platform } = {}) {
  return platform === "linux" ? buildSystemdUnit(args) : buildLaunchAgentPlist(args);
}

export async function startShimService(servicePath, options = {}) {
  const platform = options.platform ?? process.platform;
  return platform === "linux"
    ? startSystemdUnit(servicePath, options)
    : startLaunchAgent(servicePath, options);
}

export async function stopShimService(options = {}) {
  const platform = options.platform ?? process.platform;
  return platform === "linux"
    ? stopSystemdUnit(options)
    : stopLaunchAgent(options);
}
