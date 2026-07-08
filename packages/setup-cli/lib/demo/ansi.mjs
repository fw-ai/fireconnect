/**
 * Minimal raw-ANSI escape helpers for the demo split-pane TUI.
 *
 * No dependency on a TUI framework — just the sequences we need for in-place
 * redraw: cursor save/restore, line clear, cursor hide/show, and color/dim.
 * Everything degrades to plain text when stdout is not a TTY (see tui.mjs).
 */

export const ESC = "\x1b[";
export const RESET = `${ESC}0m`;
export const BOLD = `${ESC}1m`;
export const GREEN = `${ESC}32m`;
export const CYAN = `${ESC}36m`;
export const YELLOW = `${ESC}33m`;
export const RED = `${ESC}31m`;
// Reverse-video: swaps fg/bg so a wrapped span has guaranteed contrast on any
// terminal background — used for the "selected" chip so it can never render as
// invisible white-on-white (the bug on light-background terminals where bare
// BOLD maps to bright-default = bright white).
export const REVERSE = `${ESC}7m`;

/**
 * Pick a "secondary text" color that stays readable on any background.
 *
 * ANSI `DIM` (`\x1b[2m`, faint) washes out to near-white on light backgrounds,
 * making labels and unselected options invisible. Many terminals (macOS
 * Terminal, iTerm2, VS Code) don't set COLORFGBG, so we can't reliably detect a
 * light bg from env. Bright-black (`\x1b[90m`, a medium gray) is readable on
 * both light and dark backgrounds, so we use it unless COLORFGBG positively
 * reports a dark bg (0 or 8), in which case the fainter `\x1b[2m` is safe.
 * @returns {boolean}
 */
function detectDarkBg() {
  const fgbg = process.env.COLORFGBG ?? "";
  const parts = fgbg.split(";");
  const bg = parts.length === 2 ? Number(parts[1]) : NaN;
  return bg === 0 || bg === 8;
}

export const DIM = detectDarkBg() ? `${ESC}2m` : `${ESC}90m`;

export const HIDE_CURSOR = `${ESC}?25l`;
export const SHOW_CURSOR = `${ESC}?25h`;
export const SAVE_CURSOR = `${ESC}s`;
export const RESTORE_CURSOR = `${ESC}u`;
export const CLEAR_SCREEN = `${ESC}2J`;
export const HOME_CURSOR = `${ESC}H`;

/** Move cursor to row, col (1-indexed). */
export function moveTo(row, col) {
  return `${ESC}${row};${col}H`;
}

/** Clear from cursor to end of line. */
export const CLEAR_LINE = `${ESC}K`;

/** Clear the whole line the cursor is on, then move to its start. */
export const CLEAR_FULL_LINE = `\r${CLEAR_LINE}`;

/**
 * Strip ANSI escapes from a string (used when measuring visible width for
 * column layout, and when writing non-TTY output).
 * @param {string} s
 * @returns {string}
 */
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

/**
 * Visible width of a string (ANSI stripped). Note: does not handle wide CJK
 * glyphs as 2 cells — the demo output is overwhelmingly ASCII code, so a
 * 1-char == 1-column approximation is accurate enough and avoids a unicode
 * dependency.
 * @param {string} s
 * @returns {number}
 */
export function visibleWidth(s) {
  return stripAnsi(s).length;
}

/**
 * Truncate a string to a visible width, preserving any trailing ANSI reset.
 * @param {string} s
 * @param {number} width
 * @returns {string}
 */
export function truncateVisible(s, width) {
  const stripped = stripAnsi(s);
  if (stripped.length <= width) {
    return s;
  }
  return `${stripped.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * Pad a string to a visible width on the right with spaces.
 * @param {string} s
 * @param {number} width
 * @returns {string}
 */
export function padRight(s, width) {
  const stripped = stripAnsi(s);
  if (stripped.length >= width) {
    return s;
  }
  return `${s}${" ".repeat(width - stripped.length)}`;
}

/**
 * A simple progress bar of `width` cells, `filled`/`total` complete.
 * @param {number} filled
 * @param {number} total
 * @param {number} width
 * @returns {string}
 */
export function progressBar(filled, total, width) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, filled / total)) : 0;
  const cells = Math.round(ratio * width);
  return `${"▓".repeat(cells)}${"░".repeat(Math.max(0, width - cells))}`;
}
