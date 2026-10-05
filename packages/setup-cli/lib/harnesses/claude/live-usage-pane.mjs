/**
 * Right-hand pane for `fireconnect claude live`.
 * Waits for the left pane's new Claude session, then execs
 * `fireconnect claude usage --session`.
 *
 * The wait-and-exec machinery is harness-neutral (`lib/usage/live-pane.mjs`);
 * only the Claude log finders, the Claude-branded waiting screens, and the
 * `claude usage --session <8-char id>` argument shape live here.
 */

import process from "node:process";
import path from "node:path";

import { killLiveLayout } from "./live-tmux.mjs";
import {
  drawLiveWaitingScreen,
  drawSessionLockedScreen,
  enterLiveWaitingScreen,
} from "./live-waiting.mjs";
import { playUsageIntroAnimation } from "./usage/display.mjs";
import {
  findClaudeSessionLog,
  waitForClaudeSessionLog,
  waitForLiveSessionLog,
} from "./usage/report.mjs";
import { runLiveUsagePane as runSharedLiveUsagePane } from "../../usage/live-pane.mjs";

/**
 * @param {string} fireconnectBin absolute path to fireconnect.mjs
 */
export async function runLiveUsagePane(fireconnectBin) {
  await runSharedLiveUsagePane({
    fireconnectBin,
    home: process.env.HOME?.trim() ?? "",
    // `claude live --session <id>`: the meter locks onto that session directly
    // instead of waiting for a brand-new log, so there is no waiting screen.
    fixedSession: process.env.FC_LIVE_SESSION?.trim() ?? "",
    snapshotPath: process.env.FC_LIVE_SNAPSHOT?.trim() ?? "",
    findSession: ({ home, session }) => findClaudeSessionLog({ home, session }),
    waitForSession: (opts) => waitForClaudeSessionLog(opts),
    waitForNewSession: (opts) => waitForLiveSessionLog(opts),
    killLayout: () => killLiveLayout(),
    enterWaitingScreen: enterLiveWaitingScreen,
    drawWaitingScreen: (stream) => drawLiveWaitingScreen(stream),
    drawLockedScreen: (stream, sessionId, tick) => drawSessionLockedScreen(stream, sessionId, tick),
    playIntro: (stream) => playUsageIntroAnimation(stream),
    usageArgs: (sessionArg) => ["claude", "usage", "--session", sessionArg],
    sessionArgOf: claudeSessionArgOf,
    lockedLabelOf: claudeSessionArgOf,
  });
}

function claudeSessionArgOf(sessionPath) {
  const base = path.basename(sessionPath, ".jsonl");
  return base.slice(0, 8);
}
