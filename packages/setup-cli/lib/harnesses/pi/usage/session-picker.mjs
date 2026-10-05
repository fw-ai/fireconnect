/**
 * Interactive picker: Pi sessions from the last N days (with usage snapshots)
 * → choose one to live-track in the cost meter.
 *
 * Rendering and prompt policy live in the harness-neutral
 * `lib/usage/session-picker.mjs`; only the entry extraction — what a choice
 * row shows from a Pi usage report — is Pi-specific.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  formatSessionAge,
  formatSessionChoiceLine,
  promptRecentSessionPicker,
} from "../../../usage/session-picker.mjs";
import { COST_COL } from "../../claude/usage/meter-layout.mjs";
import { findPiSessionLogs, readPiUsage } from "./report.mjs";

export { formatSessionAge };

/** Default lookback for the live-usage session picker. */
export const PI_USAGE_PICKER_DAYS = 3;

/** Cap so a busy machine cannot hang pricing thousands of logs. */
const PICKER_SESSION_CAP = 100;

/** Short id for a `<timestamp>_<uuid>.jsonl` Pi session: the uuid's first 8. */
export function piShortSessionId(filePath) {
  const base = path.basename(filePath, ".jsonl");
  const underscore = base.lastIndexOf("_");
  const id = underscore >= 0 ? base.slice(underscore + 1) : base;
  return `${id.slice(0, 8)}…`;
}

/**
 * @param {{
 *   filePath: string,
 *   mtimeMs: number,
 *   report: { totals?: { cost?: number }, requests?: number, sessionName?: string },
 *   now?: number,
 * }} entry
 * @param {number} [now]
 * @param {{ stream?: NodeJS.WritableStream, color?: boolean }} [opts]
 */
export function formatPiUsageSessionChoice(entry, now = Date.now(), opts = {}) {
  return formatSessionChoiceLine({
    // Pass through: `null` (an unpriced call) must stay n/a, never zero.
    cost: entry.report.totals?.cost,
    calls: entry.report.requests ?? 0,
    shortId: piShortSessionId(entry.filePath),
    name: entry.report.sessionName,
    age: formatSessionAge(entry.mtimeMs, now),
  }, { ...opts, costWidth: COST_COL });
}

/**
 * Load Pi sessions modified within `withinDays`, with usage.
 * Empty lookback / empty store is an empty list (picker owns that policy).
 *
 * @param {{ home: string, withinDays?: number, now?: number, sessionsDir?: string }} opts
 */
export async function listRecentPiUsageSessions({
  home,
  withinDays = PI_USAGE_PICKER_DAYS,
  now = Date.now(),
  sessionsDir = "",
} = {}) {
  let paths;
  try {
    paths = await findPiSessionLogs({
      home,
      withinDays,
      lastN: PICKER_SESSION_CAP,
      sessionsDir,
    });
  } catch (error) {
    // Finder throws when the sessions store has no logs at all; the picker
    // treats that the same as an empty lookback window.
    if (error instanceof Error && /No Pi session logs found/.test(error.message)) {
      return [];
    }
    throw error;
  }
  return Promise.all(paths.map(async (filePath) => {
    const st = await stat(filePath);
    const report = await readPiUsage({ home, session: filePath, sessionsDir });
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
 *   sessionsDir?: string,
 * }} opts
 * @returns {Promise<string | null>} absolute session log path, or null if cancelled
 */
export async function promptPiUsageSession({
  home,
  withinDays = PI_USAGE_PICKER_DAYS,
  input = process.stdin,
  output = process.stdout,
  now = Date.now(),
  sessionsDir = "",
}) {
  const sessions = await listRecentPiUsageSessions({ home, withinDays, now, sessionsDir });
  if (sessions.length === 0) {
    throw new Error(
      `No Pi sessions in the last ${withinDays} day${withinDays === 1 ? "" : "s"} under ${path.join(home, ".pi/agent/sessions")}`,
    );
  }

  return promptRecentSessionPicker({
    title: `Pi sessions (last ${withinDays} days) — select one to live-track`,
    sessions,
    formatChoice: (entry) => formatPiUsageSessionChoice(entry, now, { stream: output }),
    valueOf: (entry) => entry.filePath,
    input,
    output,
  });
}
