/**
 * Right-hand pane for `fireconnect pi live`.
 * Waits for the left pane's new Pi session, then execs
 * `fireconnect pi usage --session`.
 *
 * The wait-and-exec machinery is harness-neutral (`lib/usage/live-pane.mjs`);
 * only the Pi log finders, the Pi-branded waiting screens, and the
 * `pi usage --session <uuid>` argument shape live here.
 */

import path from "node:path";
import process from "node:process";

import {
  drawLiveWaitingScreen,
  drawSessionLockedScreen,
  enterLiveWaitingScreen,
} from "../../claude/live-waiting.mjs";
import { playUsageIntroAnimation } from "../../claude/usage/display.mjs";
import { runLiveUsagePane } from "../../usage/live-pane.mjs";
import { killPiLiveLayout } from "./live-tmux.mjs";
import {
  findPiSessionLog,
  waitForPiLiveSessionLog,
  waitForPiSessionLog,
} from "./usage/report.mjs";

const PI_WAITING_LABELS = {
  harnessLabel: "Pi",
  title: "  ✦  Pi · Live Cost Meter  ",
  tips: [
    "send your first prompt on the left — costs stream here live",
    "Ctrl+b then arrow keys switch between Pi and the meter",
    "exit Pi with /quit to close this split layout",
    "token counts and cost update on every model response",
  ],
};

/** The session uuid of a `<timestamp>_<uuid>.jsonl` Pi session log. */
export function piSessionIdOf(sessionPath) {
  const base = path.basename(sessionPath, ".jsonl");
  const underscore = base.lastIndexOf("_");
  return underscore >= 0 ? base.slice(underscore + 1) : base;
}

/** Short id for the locked screen: the uuid's first 8 chars. */
export function piLockedLabelOf(sessionPath) {
  return `${piSessionIdOf(sessionPath).slice(0, 8)}…`;
}

/**
 * @param {string} fireconnectBin absolute path to fireconnect.mjs
 */
export async function runPiLiveUsagePane(fireconnectBin) {
  await runLiveUsagePane({
    fireconnectBin,
    home: process.env.HOME?.trim() ?? "",
    // `pi live --session <id>`: the meter locks onto that session directly
    // instead of waiting for a brand-new log, so there is no waiting screen.
    fixedSession: process.env.FC_LIVE_SESSION?.trim() ?? "",
    snapshotPath: process.env.FC_LIVE_SNAPSHOT?.trim() ?? "",
    findSession: ({ home, session }) => findPiSessionLog({ home, session }),
    waitForSession: (opts) => waitForPiSessionLog(opts),
    waitForNewSession: (opts) => waitForPiLiveSessionLog(opts),
    killLayout: () => killPiLiveLayout(),
    enterWaitingScreen: enterLiveWaitingScreen,
    drawWaitingScreen: (stream, opts) => drawLiveWaitingScreen(stream, { ...opts, ...PI_WAITING_LABELS }),
    drawLockedScreen: (stream, sessionId, tick, opts) => drawSessionLockedScreen(
      stream, sessionId, tick, { ...opts, title: PI_WAITING_LABELS.title },
    ),
    playIntro: (stream) => playUsageIntroAnimation(stream),
    usageArgs: (sessionArg) => ["pi", "usage", "--session", sessionArg],
    sessionArgOf: piSessionIdOf,
    lockedLabelOf: piLockedLabelOf,
  });
}
