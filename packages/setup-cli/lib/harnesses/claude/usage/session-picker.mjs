/**
 * Interactive picker: Claude sessions from the last N days (with usage
 * snapshots) → choose one to live-track in the cost meter.
 *
 * Uses promptSelect (prompt-tier chrome) with METER gold/ghost on the
 * choice line so the jump into the live meter feels continuous. Rendering and
 * prompt policy live in the harness-neutral `lib/usage/session-picker.mjs`;
 * only the entry extraction (what a choice row shows from a Claude report)
 * is Claude-specific.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { COST_COL } from "./meter-layout.mjs";
import {
  formatSessionAge,
  formatSessionChoiceLine,
  promptRecentSessionPicker,
} from "../../../usage/session-picker.mjs";
import { findClaudeSessionLogs, readClaudeUsage } from "./report.mjs";

export { formatSessionAge };

/** Default lookback for the live-usage session picker. */
export const CLAUDE_USAGE_PICKER_DAYS = 3;

/** Cap so a busy machine cannot hang pricing thousands of logs. */
const PICKER_SESSION_CAP = 100;

/**
 * @param {{
 *   filePath: string,
 *   mtimeMs: number,
 *   report: { grandTotals?: { cost?: number }, totals?: { cost?: number }, grandRequests?: number, requests?: number, sessionName?: string },
 *   now?: number,
 * }} entry
 * @param {number} [now]
 * @param {{ stream?: NodeJS.WritableStream, color?: boolean }} [opts]
 */
export function formatClaudeUsageSessionChoice(entry, now = Date.now(), opts = {}) {
  const id = path.basename(entry.filePath, ".jsonl");
  const shortId = `${id.slice(0, 8)}…`;
  const grandCost = entry.report.grandTotals?.cost;
  const totalCost = entry.report.totals?.cost;
  const cost = grandCost !== undefined ? grandCost : (totalCost ?? 0);
  const calls = entry.report.grandRequests ?? entry.report.requests ?? 0;
  return formatSessionChoiceLine({
    cost,
    calls,
    shortId,
    name: entry.report.sessionName,
    age: formatSessionAge(entry.mtimeMs, now),
  }, { ...opts, costWidth: COST_COL });
}

/**
 * Load top-level Claude sessions modified within `withinDays`, with usage.
 * Empty lookback / empty project is an empty list (picker owns that policy).
 *
 * @param {{ home: string, withinDays?: number, now?: number }} opts
 */
export async function listRecentClaudeUsageSessions({
  home,
  withinDays = CLAUDE_USAGE_PICKER_DAYS,
  now = Date.now(),
} = {}) {
  let paths;
  try {
    paths = await findClaudeSessionLogs({
      home,
      withinDays,
      lastN: PICKER_SESSION_CAP,
    });
  } catch (error) {
    // Finder throws when ~/.claude has no session logs at all; the picker
    // treats that the same as an empty lookback window.
    if (error instanceof Error && /No Claude Code session logs found/.test(error.message)) {
      return [];
    }
    throw error;
  }
  return Promise.all(paths.map(async (filePath) => {
    const st = await stat(filePath);
    const report = await readClaudeUsage({ home, session: filePath });
    return { filePath, mtimeMs: st.mtimeMs, report, now };
  }));
}

/**
 * Prompt for a recent session to live-track.
 *
 * - 0 sessions → throws
 * - 1 session → returns that path (no menu)
 * - stdin not a TTY → newest session (no menu; live still needs only stdout)
 * - Esc/q → returns null
 *
 * @param {{
 *   home: string,
 *   withinDays?: number,
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WriteStream,
 *   now?: number,
 * }} opts
 * @returns {Promise<string | null>} absolute session log path, or null if cancelled
 */
export async function promptClaudeUsageSession({
  home,
  withinDays = CLAUDE_USAGE_PICKER_DAYS,
  input = process.stdin,
  output = process.stdout,
  now = Date.now(),
}) {
  const sessions = await listRecentClaudeUsageSessions({ home, withinDays, now });
  if (sessions.length === 0) {
    throw new Error(
      `No Claude Code sessions in the last ${withinDays} day${withinDays === 1 ? "" : "s"} under ${path.join(home, ".claude")}`,
    );
  }

  return promptRecentSessionPicker({
    title: `Claude sessions (last ${withinDays} days) — select one to live-track`,
    sessions,
    formatChoice: (entry) => formatClaudeUsageSessionChoice(entry, now, { stream: output }),
    valueOf: (entry) => entry.filePath,
    input,
    output,
  });
}
