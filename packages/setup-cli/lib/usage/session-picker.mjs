/**
 * Harness-neutral session picker: the age formatting, choice-line rendering,
 * and prompt policy shared by the usage session pickers.
 *
 * Only the entry extraction is per-harness (where a display name, a cost, and a
 * call count come from in that harness's report); this module renders a
 * formatted choice line and owns the picker policy:
 * one session (or a non-TTY stdin) auto-selects the newest, a TTY gets a list.
 */

import path from "node:path";
import process from "node:process";

import { paint } from "../ui.mjs";
import { colorsEnabled } from "../ui/color.mjs";
import { METER } from "../ui/palette.mjs";
import { promptSelect } from "../ui/prompt.mjs";
import { sanitize } from "../ui/sanitize.mjs";
import { formatUsageCost } from "./format.mjs";

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

/** Clip a display name to `width` cells with an ellipsis. */
function clipName(name, width) {
  return name.length > width ? `${name.slice(0, width - 1)}…` : name;
}

/**
 * One picker row: cost · calls · short id · name · age, meter-gold cost.
 *
 * @param {{
 *   cost: number | null,
 *   calls: number,
 *   shortId: string,
 *   name?: string,
 *   age: string,
 * }} entry
 * @param {{ stream?: NodeJS.WritableStream, color?: boolean, costWidth?: number, nameWidth?: number }} [opts]
 */
export function formatSessionChoiceLine(entry, opts = {}) {
  const stream = opts.stream ?? process.stdout;
  // Probe the RESOLVED stream, not `opts.stream`: an explicit `stream: null`
  // still writes to process.stdout, so it should still get that stream's colour.
  const useColor = opts.color === true
    || (opts.color !== false && colorsEnabled(stream));
  const costWidth = opts.costWidth ?? 8;

  const costText = formatUsageCost(entry.cost).padStart(costWidth);
  const callsText = `${String(entry.calls).padStart(3)} calls`;
  const shortId = entry.shortId;
  const name = typeof entry.name === "string" && entry.name
    ? sanitize(entry.name).replace(/\s+/g, " ").trim()
    : "";
  const nameWidth = opts.nameWidth ?? 36;

  if (!useColor) {
    const namePart = name ? ` · ${clipName(name, nameWidth)}` : "";
    return `${costText} · ${callsText} · ${shortId}${namePart} · ${entry.age}`;
  }

  const cost = paint(METER.gold, costText, stream);
  const meta = paint(METER.ghost, `${callsText} · ${shortId}`, stream);
  const title = name
    ? paint(METER.ghost, ` · ${clipName(name, nameWidth)}`, stream)
    : "";
  const agePart = paint(METER.ghost, ` · ${entry.age}`, stream);
  return `${cost} · ${meta}${title}${agePart}`;
}

/**
 * Prompt policy shared by the usage session pickers.
 *
 * - 1 session, or stdin not a TTY → the newest session's value (no menu)
 * - otherwise → promptSelect over `formatChoice(entry)` rows
 * - Esc/q → null
 *
 * @param {{
 *   title: string,
 *   sessions: Array<object>, newest first,
 *   formatChoice: (entry: object) => string,
 *   valueOf: (entry: object) => string,
 *   pageSize?: number,
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WriteStream,
 * }} opts
 * @returns {Promise<string | null>}
 */
export async function promptRecentSessionPicker({
  title,
  sessions,
  formatChoice,
  valueOf,
  pageSize = 12,
  input = process.stdin,
  output = process.stdout,
}) {
  if (sessions.length === 1 || !input?.isTTY) {
    return valueOf(sessions[0]);
  }
  const chosen = await promptSelect({
    message: title,
    pageSize,
    choices: sessions.map((entry) => ({
      name: formatChoice(entry),
      short: path.basename(String(valueOf(entry)), ".jsonl").slice(0, 8),
      value: valueOf(entry),
    })),
    input,
    output,
  });
  return chosen ?? null;
}
