/**
 * Harness-neutral right-hand pane for `<harness> live`: wait for the left
 * pane's session, then exec `fireconnect <harness> usage --session`.
 *
 * Both panes share a pinned session id, so the waiting here is only about the
 * log being written lazily (on the first prompt) or resumed (appending to an
 * existing log). Everything harness-specific — where logs live, how the
 * waiting screens are labelled, which id names a session — is injected.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { stdin as processStdin } from "node:process";

const WAIT_POLL_MS = 250;
const LOCK_HANDOFF_MS = 450;

/**
 * @param {AbortSignal} signal
 * @param {() => void} killLayout tears down the whole tmux layout
 * @returns {() => void}
 */
function attachQuitDuringWait(signal, killLayout) {
  const input = processStdin;
  if (!input.isTTY) {
    return () => {};
  }
  const wasRaw = input.isRaw;
  const onData = (chunk) => {
    const ch = String(chunk);
    if (ch === "q" || ch === "Q" || ch === "\x03") {
      killLayout();
      process.exit(ch === "\x03" ? 130 : 0);
    }
  };
  input.setEncoding("latin1");
  input.resume();
  input.setRawMode(true);
  input.on("data", onData);
  signal.addEventListener("abort", () => {
    input.removeListener("data", onData);
    try {
      input.setRawMode(wasRaw);
    } catch {
      /* noop */
    }
    input.pause();
  }, { once: true });
  return () => {
    input.removeListener("data", onData);
    try {
      input.setRawMode(wasRaw);
    } catch {
      /* noop */
    }
    input.pause();
  };
}

/**
 * Run the live right pane.
 *
 * @param {{
 *   fireconnectBin: string, absolute path to fireconnect.mjs,
 *   home: string,
 *   fixedSession?: string, pinned session id (FC_LIVE_SESSION) — resume/lock instead of waiting for a fresh log,
 *   snapshotPath: string, per-run snapshot written by the left orchestrator (FC_LIVE_SNAPSHOT),
 *   findSession: ({ home: string, session: string }) => Promise<string | undefined>,
 *   waitForSession: (opts: { home: string, session: string, pollMs?: number, signal?: AbortSignal }) => Promise<string>,
 *   waitForNewSession: (opts: { home: string, beforeLogs: Array<{ filePath: string, mtimeMs: number, size?: number }>, pollMs?: number, signal?: AbortSignal }) => Promise<string>,
 *   killLayout: () => void,
 *   enterWaitingScreen: (stream: NodeJS.WriteStream) => () => void,
 *   drawWaitingScreen: (stream: NodeJS.WriteStream, opts: object) => void,
 *   drawLockedScreen: (stream: NodeJS.WriteStream, sessionId: string, tick: number, opts: object) => void,
 *   waitingScreenOpts?: object, labels for the waiting screens,
 *   playIntro?: (stream: NodeJS.WriteStream) => Promise<void>,
 *   usageArgs: (sessionArg: string) => string[], argv for `fireconnect … usage --session <arg>`,
 *   sessionArgOf: (sessionPath: string) => string, id passed to `usage --session`,
 *   lockedLabelOf: (sessionPath: string) => string, short id shown on the locked screen,
 * }} opts
 */
export async function runLiveUsagePane({
  fireconnectBin,
  home,
  fixedSession = "",
  snapshotPath,
  findSession,
  waitForSession,
  waitForNewSession,
  killLayout,
  enterWaitingScreen,
  drawWaitingScreen,
  drawLockedScreen,
  waitingScreenOpts = {},
  playIntro,
  usageArgs,
  sessionArgOf,
  lockedLabelOf,
}) {
  if (!fireconnectBin) {
    throw new Error("fireconnect binary path is required.");
  }
  if (!home) {
    throw new Error("HOME is required.");
  }
  if (!snapshotPath) {
    throw new Error("FC_LIVE_SNAPSHOT is required.");
  }

  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch {
    throw new Error(`Could not read the live-split snapshot at ${snapshotPath}.`);
  }
  const beforeLogs = snapshot.logs ?? [];
  let tick = 0;
  const restoreWaitingScreen = enterWaitingScreen(process.stdout);
  let sessionPath;

  const waitAbort = new AbortController();
  const detachKeys = attachQuitDuringWait(waitAbort.signal, killLayout);
  try {
    if (fixedSession) {
      try {
        // Resumed session (`<harness> live --session`): the log already exists.
        sessionPath = await findSession({ home, session: fixedSession });
      } catch {
        // Pinned fresh session (`<harness> --session-id`): its log is written
        // lazily on the first prompt, so wait for that exact id — never a
        // background session that happens to bump its own log.
        if (process.stdout.isTTY) {
          drawWaitingScreen(process.stdout, waitingScreenOpts);
        }
        sessionPath = await waitForSession({
          home,
          session: fixedSession,
          pollMs: WAIT_POLL_MS,
          signal: waitAbort.signal,
        });
      }
    } else {
      // Static waiting screen: draw once, no spinner/repaint loop — it must not
      // read as a "loading" state while the session idles, and constant repaints
      // would wipe any text the user tries to select in the pane.
      if (process.stdout.isTTY) {
        drawWaitingScreen(process.stdout, waitingScreenOpts);
      }
      sessionPath = await waitForNewSession({
        home,
        beforeLogs,
        pollMs: WAIT_POLL_MS,
        signal: waitAbort.signal,
      });
    }
  } finally {
    waitAbort.abort();
    detachKeys();
  }

  const lockedLabel = lockedLabelOf(sessionPath);

  if (process.stdout.isTTY) {
    drawLockedScreen(process.stdout, lockedLabel, tick, waitingScreenOpts);
    tick += 1;
    if (playIntro) {
      await playIntro(process.stdout);
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_HANDOFF_MS));
  }
  restoreWaitingScreen();

  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      fireconnectBin,
      ...usageArgs(sessionArgOf(sessionPath)),
    ], {
      env: {
        ...process.env,
        TERM: process.env.TERM || "xterm-256color",
        FC_LIVE_SPLIT: "1",
      },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (exitCode, signal) => {
      if (signal) {
        reject(new Error(`fireconnect usage exited on ${signal}`));
        return;
      }
      resolve(exitCode ?? 0);
    });
  });

  process.exit(Number(code) || 0);
}
