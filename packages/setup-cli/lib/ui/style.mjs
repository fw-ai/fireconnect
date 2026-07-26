import process from "node:process";

import { colorsEnabled } from "./color.mjs";
import { ANSI } from "./palette.mjs";

let enabled = colorsEnabled();

/** Whether styling is currently active (test hook + help coloring). */
export function isStyleEnabled() {
  return enabled;
}

/** Test hook: force styling on/off regardless of the ambient terminal. */
export function _setColorEnabled(value) {
  enabled = Boolean(value);
}

function wrap(open, close) {
  return (text) => (enabled ? `${open}${text}${close}` : String(text));
}

export const bold = wrap(ANSI.bold, "\u001b[22m");
export const dim = wrap(ANSI.dimFaint, "\u001b[22m");
export const muted = wrap(ANSI.muted, "\u001b[39m");
export const red = wrap(ANSI.red, "\u001b[39m");
export const green = wrap(ANSI.green, "\u001b[39m");
export const yellow = wrap(ANSI.yellow, "\u001b[39m");

/**
 * Cyan emphasis for commands and interactive tokens.
 */
export function accent(text, stream = undefined) {
  const useColor = stream === undefined
    ? enabled
    : colorsEnabled(stream);
  return useColor ? `${ANSI.cyan}${text}\u001b[39m` : String(text);
}

/** Spend bars and brand highlights. */
export const orange = wrap(ANSI.orange, "\u001b[39m");

function unicodeOk(env = process.env) {
  if (process.platform === "win32") {
    return false;
  }
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return /utf-?8/i.test(locale);
}

const glyphs = unicodeOk()
  ? { ok: "✓", fail: "✗", warn: "!", bullet: "•", pointer: "❯" }
  : { ok: "ok", fail: "x", warn: "!", bullet: "*", pointer: ">" };

export const symbols = Object.freeze(glyphs);

export function ok(message) {
  return `${green(symbols.ok)} ${message}`;
}

export function fail(message) {
  return `${red(symbols.fail)} ${message}`;
}

export function warn(message) {
  return `${yellow(symbols.warn)} ${message}`;
}

export function yesNo(value) {
  return value ? green("yes") : red("no");
}

/** Green "✓" success glyph (login/status). */
export function check(stream = process.stdout) {
  return (enabled || colorsEnabled(stream)) ? green(symbols.ok) : symbols.ok;
}

/**
 * Paint raw ANSI when color is enabled on `stream`.
 * @param {string} openSeq
 * @param {string} text
 * @param {{ isTTY?: boolean }} [stream]
 */
export function paint(openSeq, text, stream = process.stdout) {
  return colorsEnabled(stream) ? `${openSeq}${text}${ANSI.reset}` : text;
}
