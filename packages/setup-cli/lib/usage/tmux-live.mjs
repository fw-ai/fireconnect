/**
 * Harness-neutral tmux split machinery for `<harness> live`: availability
 * checks, the dedicated-session/window lifecycle, pane chrome, the process-tree
 * probe that decides a stale split, and the startup message/countdown.
 *
 * Only the split's identity (session key, window name, pane titles, startup
 * labels), the left pane's command (how the harness is launched), and the
 * process probe (which comm names mean "the harness is running") are injected.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { shellQuote } from "../cli/path.mjs";
import { BRAND } from "../ui/palette.mjs";
import { accent, bold, muted, symbols } from "../ui/style.mjs";

/** Meter pane width as a percentage of the split. */
export const METER_WIDTH_PERCENT = 50;
/** Detached-session geometry so the split is roomy before the first attach. */
export const LIVE_SESSION_COLS = 240;
export const LIVE_SESSION_ROWS = 55;

/** @param {string} [prefix] per-run snapshot prefix — avoids races when multiple live splits overlap. */
export function liveSnapshotPath(prefix = "fc-live") {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}.json`);
}

/** @param {string} sessionKey @param {string} [window] tmux window id when the layout lives in the caller's session */
export function killLayoutArgs(sessionKey, window = "") {
  return window
    ? ["kill-window", "-t", window]
    : ["kill-session", "-t", sessionKey];
}

/** Tear down the live split: its window inside the caller's tmux, else the dedicated session. */
export function killLiveLayout(sessionKey, env = process.env) {
  try {
    execFileSync("tmux", killLayoutArgs(sessionKey, env.FC_LIVE_WINDOW), { stdio: "ignore", env });
  } catch {
    /* session may already be gone */
  }
}

/**
 * @param {{ execFile?: typeof execFileSync, spawn?: typeof spawnSync }} [deps]
 */
export function tmuxAvailable(deps = {}) {
  const spawn = deps.spawn ?? spawnSync;
  return spawn("tmux", ["-V"], { encoding: "utf8" }).status === 0;
}

/** @returns {string[]} */
export function tmuxInstallHintLines() {
  const lines = ["tmux is required for the split-pane layout. Install it with:"];
  if (commandAvailable("brew")) {
    lines.push("  brew install tmux");
  } else if (commandAvailable("apt-get")) {
    lines.push("  sudo apt-get install -y tmux");
  } else if (commandAvailable("dnf")) {
    lines.push("  sudo dnf install -y tmux");
  } else if (commandAvailable("pacman")) {
    lines.push("  sudo pacman -S tmux");
  } else {
    lines.push("  your platform's package manager (package: tmux)");
  }
  return lines;
}

function commandAvailable(name) {
  return spawnSync("which", [name], { encoding: "utf8", stdio: "ignore" }).status === 0;
}

/**
 * @param {string} session
 * @param {{ env?: NodeJS.ProcessEnv, execFile?: typeof execFileSync }} [deps]
 */
export function tmuxHasSession(session, deps = {}) {
  const execFile = deps.execFile ?? execFileSync;
  const env = deps.env ?? process.env;
  try {
    execFile("tmux", ["has-session", "-t", session], { stdio: "ignore", env });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the left pane's shell has a live harness (or its node runtime)
 * descendant.
 *
 * `pane_current_command` is unreliable here: the left pane runs the harness as
 * a child of a non-interactive `bash -lc` (no job control), so the pane often
 * reports "bash" even while the harness is running. Walk the process tree
 * instead.
 *
 * @param {typeof execFileSync} execFile
 * @param {NodeJS.ProcessEnv} env
 * @param {string} panePid root process id of the left pane
 * @param {(comm: string) => boolean} runsHarness comm-base predicate
 * @returns {boolean | null} true/false when probed, null when the probe could not run
 */
export function paneRunsHarnessProcess(execFile, env, panePid, runsHarness) {
  let ps;
  try {
    ps = execFile("ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf8", env });
  } catch {
    return null;
  }
  const childrenOf = new Map();
  const commOf = new Map();
  for (const line of String(ps).split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) {
      continue;
    }
    const [, pid, ppid, comm] = match;
    commOf.set(pid, comm.trim().toLowerCase());
    if (!childrenOf.has(ppid)) {
      childrenOf.set(ppid, []);
    }
    childrenOf.get(ppid).push(pid);
  }
  const queue = [...(childrenOf.get(String(panePid)) ?? [])];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    const base = (commOf.get(pid) ?? "").split("/").pop();
    if (runsHarness(base)) {
      return true;
    }
    queue.push(...(childrenOf.get(pid) ?? []));
  }
  return false;
}

/**
 * Whether the split's dedicated session is still genuinely alive: the left
 * pane must still be running the harness.
 *
 * Fail-safe: this gates a destructive kill+recreate. Only return false on a
 * CONFIRMED stale session (left pane gone, or a successful probe that finds no
 * harness process). Any probe error means "unknown", so preserve the session.
 *
 * @param {string} session
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   execFile?: typeof execFileSync,
 *   runsHarness?: (comm: string) => boolean,
 * }} [deps]
 */
export function isLiveSplitSessionActive(session, deps = {}) {
  const execFile = deps.execFile ?? execFileSync;
  const env = deps.env ?? process.env;
  const runsHarness = deps.runsHarness ?? ((comm) => comm === "node");
  let output;
  try {
    output = execFile("tmux", [
      "list-panes", "-t", `${session}:`, "-F", "#{pane_at_left} #{pane_pid}",
    ], { encoding: "utf8", env }).trim();
  } catch {
    return true;
  }
  if (!output) {
    return true;
  }
  const panes = output.split("\n").map((line) => {
    const space = line.indexOf(" ");
    return {
      atLeft: line.slice(0, space),
      pid: line.slice(space + 1).trim(),
    };
  });
  if (panes.length < 2) {
    return false;
  }
  const left = panes.find((pane) => pane.atLeft === "1");
  if (!left?.pid) {
    return false;
  }
  const active = paneRunsHarnessProcess(execFile, env, left.pid, runsHarness);
  return active === null ? true : active;
}

/**
 * Absolute path to a named executable on the caller's PATH, falling back to
 * the bare name.
 *
 * The live pane runs `bash -lc`, whose login-shell PATH can resolve the
 * harness to a different (e.g. older Homebrew) install than the shell that
 * ran `fireconnect <harness> live`. Pinning the absolute path keeps the pane
 * on the same binary the user invoked.
 *
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveBinOnPath(name, env = process.env) {
  const pathEnv = env.PATH ?? process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* not in this directory */
    }
  }
  return name;
}

/** Right pane: wait for the left pane's session, then exec `<harness> usage`. */
export function usagePaneCommand({ home, snapshotPath, helperPath, fireconnectBin, sessionId = "", window = "" }) {
  const lines = [
    `export HOME=${shellQuote(home)}`,
    `export FC_LIVE_SNAPSHOT=${shellQuote(snapshotPath)}`,
    `export FC_LIVE_SPLIT=1`,
    `export TERM=xterm-256color`,
  ];
  if (sessionId) {
    lines.push(`export FC_LIVE_SESSION=${shellQuote(sessionId)}`);
  }
  if (window) {
    lines.push(`export FC_LIVE_WINDOW=${shellQuote(window)}`);
  }
  lines.push(`exec ${shellQuote(process.execPath)} ${shellQuote(helperPath)} ${shellQuote(fireconnectBin)}`);
  return lines.join("; ");
}

export function respawnPane(execFile, env, target, command) {
  execFile("tmux", [
    "respawn-pane", "-k", "-t", target,
    "bash", "-lc", `export TERM=xterm-256color; ${command}`,
  ], { env });
}

/**
 * Pane titles, borders, and mouse so the split reads as a product surface.
 *
 * @param {typeof execFileSync} execFile
 * @param {NodeJS.ProcessEnv} env
 * @param {string} target session with an empty window (`fireconnect-…-live:`) or a window id (`@3`)
 * @param {boolean} [ownSession] false when the layout is a window in the caller's session
 * @param {{ leftTitle?: string, rightTitle?: string, accent?: string }} [labels]
 */
export function configureLiveTmuxSession(execFile, env, target, ownSession = true, labels = {}) {
  // Brand purple (matches the meter accent) for the active pane chrome; a
  // visible muted gray for inactive panes so the divider shows up full instead
  // of the near-invisible colour238.
  const active = labels.accent ?? BRAND.purple;
  const inactive = "colour240";
  const leftTitle = labels.leftTitle ?? "Harness";
  const rightTitle = labels.rightTitle ?? "Live cost";
  const borderFormat = `#{?pane_active,#[fg=${active},bold],#[fg=colour245]} #{pane_title}`;
  const opts = [
    ["set-option", "-t", target, "-w", "pane-border-status", "top"],
    ["set-option", "-t", target, "-w", "pane-border-format", borderFormat],
    ["set-option", "-t", target, "-w", "pane-active-border-style", `fg=${active}`],
    ["set-option", "-t", target, "-w", "pane-border-style", `fg=${inactive}`],
    // mouse is a session option and focus-events a server option, so skip them in the caller's session.
    ...(ownSession
      ? [
        ["set-option", "-t", target, "-w", "mouse", "on"],
        ["set-option", "-t", target, "-w", "focus-events", "on"],
      ]
      : []),
    ["select-pane", "-t", `${target}.{left}`, "-T", leftTitle],
    ["select-pane", "-t", `${target}.{right}`, "-T", rightTitle],
    ["select-pane", "-t", `${target}.{left}`],
  ];
  for (const args of opts) {
    execFile("tmux", args, { env });
  }
}

/**
 * @param {NodeJS.WriteStream} stdout
 * @param {{ harnessLabel?: string, leftDesc?: string, exitHint?: string }} [labels]
 */
export function printLiveStartupMessage(stdout, labels = {}) {
  const harnessLabel = labels.harnessLabel ?? "the harness";
  const leftDesc = labels.leftDesc ?? `${harnessLabel} — chat as usual`;
  const exitHint = labels.exitHint ?? `Exit ${harnessLabel} to close the layout.`;
  const lines = [
    "",
    bold(`Opening a live split for ${harnessLabel}`),
    "",
    `  ${symbols.pointer} ${accent("left", stdout)}  ${muted(leftDesc, stdout)}`,
    `  ${symbols.pointer} ${accent("right", stdout)} ${muted("live cost meter — updates as you chat", stdout)}`,
    "",
    muted("Tip: Ctrl+b then arrow keys switch panes · click a pane with the mouse", stdout),
    muted(exitHint, stdout),
    "",
  ];
  stdout.write(`${lines.join("\n")}\n`);
}

/**
 * 3-2-1 lead-in before the split takes over the screen, so the startup message
 * is actually readable before the harness spawns.
 *
 * @param {NodeJS.WriteStream} stdout
 * @param {(ms: number) => Promise<void>} sleep
 * @param {string} [message]
 */
export async function liveStartupCountdown(stdout, sleep, message = "starting session with live cost tracker") {
  for (const n of [3, 2, 1]) {
    stdout.write(`${accent(String(n), stdout)}${muted(" … ", stdout)}`);
    await sleep(1000);
  }
  stdout.write(`${muted(message, stdout)}\n`);
}
