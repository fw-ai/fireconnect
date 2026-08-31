/**
 * Interactive picker: Claude sessions from the last N days (with usage
 * snapshots) → choose one to live-track in the cost meter.
 *
 * Uses promptSelect (prompt-tier chrome) with METER gold/ghost on the
 * choice line so the jump into the live meter feels continuous.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { paint } from "../../../ui.mjs";
import { colorsEnabled } from "../../../ui/color.mjs";
import { METER } from "../../../ui/palette.mjs";
import { promptSelect } from "../../../ui/prompt.mjs";
import { sanitize } from "../../../ui/sanitize.mjs";
import { formatUsageCost } from "./format.mjs";
import { COST_COL } from "./meter-layout.mjs";
import {
  findClaudeSessionLogs,
  readClaudeUsage,
} from "./report.mjs";

/** Default lookback for the live-usage session picker. */
export const CLAUDE_USAGE_PICKER_DAYS = 3;

/** Cap so a busy machine cannot hang pricing thousands of logs. */
const PICKER_SESSION_CAP = 100;

/**
 * @param {number} mtimeMs
 * @param {number} [now]
 */
export function formatSessionAge(mtimeMs, now = Date.now()) {
  const sec = Math.max(0, Math.floor((now - mtimeMs) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

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
  const stream = opts.stream ?? process.stdout;
  // Probe the RESOLVED stream, not `opts.stream`: an explicit `stream: null`
  // still writes to process.stdout, so it should still get that stream's colour.
  const useColor = opts.color === true
    || (opts.color !== false && colorsEnabled(stream));

  const id = path.basename(entry.filePath, ".jsonl");
  const shortId = `${id.slice(0, 8)}…`;
  const grandCost = entry.report.grandTotals?.cost;
  const totalCost = entry.report.totals?.cost;
  const costValue = grandCost !== undefined
    ? grandCost
    : (totalCost !== undefined ? totalCost : 0);
  const calls = entry.report.grandRequests ?? entry.report.requests ?? 0;
  const name = typeof entry.report.sessionName === "string"
    ? sanitize(entry.report.sessionName).replace(/\s+/g, " ").trim()
    : "";
  const age = formatSessionAge(entry.mtimeMs, now);
  const costText = formatUsageCost(costValue).padStart(COST_COL);
  const callsText = `${String(calls).padStart(3)} calls`;

  if (!useColor) {
    const namePart = name ? ` · ${name.length > 36 ? `${name.slice(0, 35)}…` : name}` : "";
    return `${costText} · ${callsText} · ${shortId}${namePart} · ${age}`;
  }

  const cost = paint(METER.gold, costText, stream);
  const meta = paint(METER.ghost, `${callsText} · ${shortId}`, stream);
  const title = name
    ? paint(METER.ghost, ` · ${name.length > 36 ? `${name.slice(0, 35)}…` : name}`, stream)
    : "";
  const agePart = paint(METER.ghost, ` · ${age}`, stream);
  return `${cost} · ${meta}${title}${agePart}`;
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
    const mtimeMs = (await stat(filePath)).mtimeMs;
    const report = await readClaudeUsage({ home, session: filePath });
    return { filePath, mtimeMs, report, now };
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
} = {}) {
  const sessions = await listRecentClaudeUsageSessions({ home, withinDays, now });
  if (sessions.length === 0) {
    throw new Error(
      `No Claude Code sessions in the last ${withinDays} day${withinDays === 1 ? "" : "s"} under ${path.join(home, ".claude")}`,
    );
  }
  if (sessions.length === 1 || !input?.isTTY) {
    return sessions[0].filePath;
  }

  const chosen = await promptSelect({
    message: `Claude sessions (last ${withinDays} days) — select one to live-track`,
    pageSize: 12,
    choices: sessions.map((entry) => ({
      name: formatClaudeUsageSessionChoice(entry, now, { stream: output }),
      short: path.basename(entry.filePath, ".jsonl").slice(0, 8),
      value: entry.filePath,
    })),
    input,
    output,
  });
  return chosen;
}
