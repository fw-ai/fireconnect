/**
 * `fireconnect pi live`: Pi on the left, live usage meter on the right.
 * Viewer-only — never touches harness settings.
 *
 * The tmux machinery (availability checks, split lifecycle, pane chrome, the
 * stale-split probe, startup message) is harness-neutral and lives in
 * `lib/usage/tmux-live.mjs`; this module owns what is Pi-specific — the Pi pane
 * command (a pinned `--session-id`/`--session`, the working directory the
 * session belongs to, and the EXIT trap), the Pi-branded labels, and the
 * split's identity.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { shellQuote } from "../../cli/path.mjs";
import { resolveSetupCliDir } from "../../system/ensure-cli-deps.mjs";
import {
  LIVE_SESSION_COLS,
  LIVE_SESSION_ROWS,
  METER_WIDTH_PERCENT,
  configureLiveTmuxSession as configureSplitTmux,
  isLiveSplitSessionActive,
  killLayoutArgs,
  killLiveLayout as killSplitLayout,
  liveSnapshotPath as splitSnapshotPath,
  liveStartupCountdown as splitStartupCountdown,
  printLiveStartupMessage as printSplitStartupMessage,
  resolveBinOnPath,
  respawnPane,
  tmuxAvailable,
  tmuxHasSession,
  tmuxInstallHintLines,
  usagePaneCommand as splitUsagePaneCommand,
} from "../../usage/tmux-live.mjs";
import { findPiSessionLog, snapshotPiSessionLogs } from "./usage/report.mjs";

export const PI_LIVE_TMUX_SESSION = "fireconnect-pi-live";

/** Per-run snapshot — avoids races when multiple live splits overlap. */
export function piLiveSnapshotPath() {
  return splitSnapshotPath("fc-pi-live");
}

/** Tear down the live split: its window inside the caller's tmux, else the dedicated session. */
export function killPiLiveLayout(env = process.env) {
  killSplitLayout(PI_LIVE_TMUX_SESSION, env);
}

export { tmuxAvailable, tmuxInstallHintLines, tmuxHasSession };

/** comm bases that mean "Pi (or its node runtime) is running". Exact: `pi` is a substring of `pip`. */
function runsPiProcess(comm) {
  return comm === "pi" || comm === "node";
}

/**
 * Whether the dedicated live session still has a live Pi descendant.
 * @param {string} session
 * @param {{ env?: NodeJS.ProcessEnv, execFile?: typeof execFileSync }} [deps]
 */
export function isPiLiveSessionActive(session, deps = {}) {
  return isLiveSplitSessionActive(session, {
    ...deps,
    runsHarness: runsPiProcess,
  });
}

/**
 * Absolute path to the `pi` executable on the caller's PATH, falling back to
 * the bare name.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolvePiBin(env = process.env) {
  return resolveBinOnPath("pi", env);
}

/**
 * Left pane: run Pi, then tear down the whole tmux layout on exit.
 *
 * The session is always pinned so the meter knows exactly which log to watch:
 * `resume: true` runs `pi --session <path>` (`pi live --session <id>`); otherwise
 * `pi --session-id <id>` pins a fresh session to the generated id. Both panes
 * share it.
 *
 * Pi groups sessions by working directory (`~/.pi/agent/sessions/--<cwd>--/`),
 * so the pane cds to `cwd` first — the split belongs to the project the user
 * ran `fireconnect pi live` from.
 *
 * @param {{ sessionId?: string, resume?: boolean, window?: string, cwd?: string }} [session]
 * @param {string} [piBin] absolute pi path (bare "pi" to resolve via PATH)
 */
export function piPaneCommand({ sessionId = "", resume = false, window = "", cwd = "" } = {}, piBin = "pi") {
  const quotedBin = shellQuote(piBin);
  let sessionArg = "";
  if (sessionId) {
    sessionArg = resume
      ? ` --session ${shellQuote(sessionId)}`
      : ` --session-id ${shellQuote(sessionId)}`;
  }
  const kill = `tmux ${killLayoutArgs(PI_LIVE_TMUX_SESSION, window).join(" ")} 2>/dev/null`;
  const cd = cwd ? `cd ${shellQuote(cwd)}; ` : "";
  // Run pi as a CHILD, not via exec: `exec` would replace the shell, wiping the
  // EXIT trap and skipping the trailing kill — so exiting Pi left the
  // cost-meter pane running. As a child, the shell resumes and tears the split
  // down on both normal exit (/quit) and the EXIT/INT/TERM trap.
  return `${cd}trap '${kill}' EXIT INT TERM; ${quotedBin}${sessionArg}; ${kill}`;
}

function usagePaneCommand(home, snapshotPath, sessionId = "", window = "") {
  return splitUsagePaneCommand({
    home,
    snapshotPath,
    helperPath: path.join(resolveSetupCliDir(), "bin/pi-live-usage.mjs"),
    fireconnectBin: path.join(resolveSetupCliDir(), "bin/fireconnect.mjs"),
    sessionId,
    window,
  });
}

/**
 * Pane titles, borders, and mouse so the split reads as a product surface.
 *
 * @param {typeof execFileSync} execFile
 * @param {NodeJS.ProcessEnv} env
 * @param {string} target session with an empty window (fireconnect-pi-live:) or a window id (@3)
 * @param {boolean} [ownSession] false when the layout is a window in the caller's session
 */
export function configurePiLiveTmuxSession(execFile, env, target, ownSession = true) {
  configureSplitTmux(execFile, env, target, ownSession, {
    leftTitle: "Pi",
    rightTitle: "Live cost",
  });
}

/** @param {NodeJS.WriteStream} stdout */
export function printPiLiveStartupMessage(stdout) {
  printSplitStartupMessage(stdout, {
    harnessLabel: "Pi",
    exitHint: "Exit Pi (/quit) to close the layout.",
  });
}

/**
 * @param {NodeJS.WriteStream} stdout
 * @param {(ms: number) => Promise<void>} sleep
 */
export async function piLiveStartupCountdown(stdout, sleep) {
  await splitStartupCountdown(stdout, sleep, "starting pi session with live cost tracker");
}

/**
 * @param {{
 *   home: string,
 *   session?: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   execFile?: typeof execFileSync,
 *   spawn?: typeof spawnSync,
 *   enterSession?: (opts: { env: NodeJS.ProcessEnv, execFile: typeof execFileSync }) => void,
 *   resolveSession?: typeof findPiSessionLog,
 *   resolvePi?: (env: NodeJS.ProcessEnv) => string,
 *   newSessionId?: () => string,
 *   sleep?: (ms: number) => Promise<void>,
 *   stdout?: NodeJS.WriteStream,
 * }} opts
 */
export async function runPiLiveTmux({
  home,
  session = "",
  cwd = process.cwd(),
  env = process.env,
  execFile = execFileSync,
  spawn = spawnSync,
  enterSession,
  resolveSession = findPiSessionLog,
  resolvePi = resolvePiBin,
  newSessionId = randomUUID,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  stdout = process.stdout,
} = {}) {
  if (!home) {
    throw new Error("HOME is required for `fireconnect pi live`.");
  }

  if (!tmuxAvailable({ spawn })) {
    throw new Error(tmuxInstallHintLines().join("\n"));
  }

  // Pin the session id so the meter locks onto exactly one log — never onto a
  // background session that happens to bump its mtime. `--session <id>` resumes
  // (resolve up front so an unknown id fails fast before any panes open);
  // otherwise generate an id for `pi --session-id`. Both panes share it.
  let sessionId;
  let resume = false;
  if (session) {
    const sessionPath = await resolveSession({ home, session });
    if (!sessionPath) {
      throw new Error(`No Pi session log matching '${session}'.`);
    }
    // `pi --session` takes a file path or partial id; the full path is exact.
    sessionId = sessionPath;
    resume = true;
  } else {
    sessionId = newSessionId();
  }

  // Inside tmux the layout opens as a window in the caller's session, so their client never leaves it.
  const inTmux = Boolean(env.TMUX);
  if (!inTmux && tmuxHasSession(PI_LIVE_TMUX_SESSION, { env, execFile })) {
    if (isPiLiveSessionActive(PI_LIVE_TMUX_SESSION, { env, execFile })) {
      if (!stdout.isTTY) {
        stdout.write(`'${PI_LIVE_TMUX_SESSION}' already running (detached)\n`);
        stdout.write(`  attach: tmux attach -t ${PI_LIVE_TMUX_SESSION}\n`);
        return;
      }
      stdout.write(`re-attaching to existing '${PI_LIVE_TMUX_SESSION}'\n`);
      (enterSession ?? defaultEnterSession)({ env, execFile, stdout });
      return;
    }
    try {
      execFile("tmux", ["kill-session", "-t", PI_LIVE_TMUX_SESSION], { stdio: "ignore", env });
    } catch {
      /* session may already be gone */
    }
  }

  // First run on a terminal: say what's about to happen and count down before
  // the split takes over the screen, so Pi only spawns after the 3-2-1.
  // The re-attach and detached paths returned above keep their own messages.
  if (stdout.isTTY) {
    printPiLiveStartupMessage(stdout);
    await piLiveStartupCountdown(stdout, sleep);
  }

  const snapshotPath = piLiveSnapshotPath();
  const snapshot = await snapshotPiSessionLogs(home);
  await writeFile(snapshotPath, JSON.stringify(snapshot));

  // Window ids, an empty window, and {left}/{right} panes keep targets independent of base-index and pane-base-index.
  let target = `${PI_LIVE_TMUX_SESSION}:`;
  let window = "";
  try {
    if (inTmux) {
      window = String(execFile("tmux", [
        "new-window", "-P", "-F", "#{window_id}", "-n", "pi live",
      ], { encoding: "utf8", env })).trim();
      target = window;
    } else {
      execFile("tmux", [
        "new-session", "-d", "-s", PI_LIVE_TMUX_SESSION,
        "-x", String(LIVE_SESSION_COLS), "-y", String(LIVE_SESSION_ROWS),
      ], { env });
    }
    execFile("tmux", ["split-window", "-h", "-t", target, "-p", String(METER_WIDTH_PERCENT)], { env });
    // Resolve pi to the absolute binary the caller's PATH picks, so the
    // login-shell pane doesn't fall back to a stale install.
    const piBin = resolvePi(env);
    respawnPane(execFile, env, `${target}.{right}`, usagePaneCommand(home, snapshotPath, sessionId, window));
    respawnPane(execFile, env, `${target}.{left}`, piPaneCommand({ sessionId, resume, window, cwd }, piBin));
    configurePiLiveTmuxSession(execFile, env, target, !inTmux);
  } catch (error) {
    if (!inTmux || window) {
      killLayout(execFile, env, window);
    }
    throw error;
  }

  if (inTmux) {
    return;
  }

  if (!stdout.isTTY) {
    stdout.write(`started '${PI_LIVE_TMUX_SESSION}' (detached — no terminal for attach)\n`);
    stdout.write(`  attach: tmux attach -t ${PI_LIVE_TMUX_SESSION}\n`);
    stdout.write("  exit Pi (/quit) to close the layout\n");
    return;
  }

  (enterSession ?? defaultEnterSession)({ env, execFile, stdout });
}

/**
 * @param {typeof execFileSync} execFile
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [window]
 */
function killLayout(execFile, env, window = "") {
  try {
    execFile("tmux", killLayoutArgs(PI_LIVE_TMUX_SESSION, window), { stdio: "ignore", env });
  } catch {
    /* session may already be gone */
  }
}

/**
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   execFile: typeof execFileSync,
 *   stdout: NodeJS.WriteStream,
 * }} opts
 */
function defaultEnterSession({ env, execFile }) {
  execFile("tmux", ["attach", "-t", PI_LIVE_TMUX_SESSION], { stdio: "inherit", env });
}
