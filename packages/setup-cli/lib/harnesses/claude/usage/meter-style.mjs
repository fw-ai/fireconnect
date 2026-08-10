/**
 * Colour codes and text measurement for the live cost meter.
 *
 * The SGR values are module-level `let`s rather than constants because whether
 * the meter has colour at all is decided per run — `runUsageMeter` inspects the
 * stream's TTY-ness, `--plain`, and NO_COLOR, then calls `applyMeterStyle` once.
 * Importers see the updated values through ES module live bindings, so a
 * renderer can interpolate `GOLD` directly without threading a style object
 * through every function.
 *
 * That does mean the values are meaningless until `applyMeterStyle` runs. It is
 * called at the top of `runUsageMeter`, and tests that render a Dashboard
 * directly call it themselves.
 */

import { METER } from "../../../ui/palette.mjs";

export let COLOR = false;
export let sgr = (_c) => "";
/** Reset. */
export let R = "";
/** Bold. */
export let B = "";
/** Dim. */
export let D = "";
export let ACCENT = "";
export let GOLD = "";
export let GHOST = "";
export let GREEN = "";
export let RED = "";
/** Per-model colour cycle, indexed by first-seen order. */
export let PALETTE = METER.modelPalette;

/**
 * Enable or disable every colour this module hands out.
 *
 * @param {boolean} enabled
 */
export function applyMeterStyle(enabled) {
  COLOR = enabled;
  sgr = (c) => (COLOR ? `\x1b[${c}m` : "");
  R = sgr(0);
  B = sgr("1");
  D = sgr("2");
  ACCENT = COLOR ? METER.accent : "";
  GOLD = COLOR ? METER.gold : "";
  GHOST = COLOR ? METER.ghost : "";
  GREEN = COLOR ? METER.green : "";
  RED = COLOR ? METER.red : "";
  PALETTE = METER.modelPalette;
}

/** Braille spinner frames, indexed by poll tick. */
export const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/** Box-drawing pieces: horizontal, vertical, and the four corners. */
export const [H, V, TL, TR, BL, BR] = ["─", "│", "╭", "╮", "╰", "╯"];

/** Printable width, ignoring SGR escapes. */
export function vislen(s) {
  let out = 0;
  for (let i = 0; i < s.length;) {
    if (s[i] === "\x1b") {
      const j = s.indexOf("m", i);
      i = j === -1 ? i + 1 : j + 1;
    } else {
      out += 1;
      i += 1;
    }
  }
  return out;
}

/** Trim a plain-text line to width, so a narrow pane can't break the frame. */
export const clip = (t, w) => (t.length <= w ? t : `${t.slice(0, Math.max(0, w - 1))}…`);

/**
 * Trim a line that CONTAINS colour escapes to `w` printable columns.
 *
 * `clip` counts escape bytes as visible characters, so using it on a coloured
 * line cuts far too early and can slice an escape in half, leaking a partial
 * sequence into the terminal. Copies escapes through without spending width,
 * then resets so the colour can't bleed into the next line.
 */
export function clipAnsi(s, w) {
  let out = "";
  let seen = 0;
  for (let i = 0; i < s.length;) {
    if (s[i] === "\x1b") {
      const j = s.indexOf("m", i);
      const end = j === -1 ? s.length : j + 1;
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (seen >= w) return `${out}${R}`;
    out += s[i];
    seen += 1;
    i += 1;
  }
  return out;
}
