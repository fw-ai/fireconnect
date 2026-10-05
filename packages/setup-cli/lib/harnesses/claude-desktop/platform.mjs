import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runExec = promisify(execFile);

/** Agent/label for the profile-lane shim LaunchAgent (launchd). */
export const SHIM_AGENT_LABEL = "ai.fireworks.fireconnect.claude-desktop-shim";
const LAUNCHCTL = "/bin/launchctl";
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

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
