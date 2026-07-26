import { BRAND } from "./tokens.mjs";

/** Raw ANSI sequences — shared by CLI output, usage dashboard, and demo TUI. */
export const ANSI = Object.freeze({
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dimFaint: "\u001b[2m",
  muted: "\u001b[90m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  white: "\u001b[97m",
  orange: "\u001b[38;5;208m",
  blue: "\u001b[36m",
  violet: "\u001b[38;5;105m",
  purple: `\u001b[38;2;103;32;255m`,
  selectedBg: "\u001b[48;5;236m",
  hideCursor: "\u001b[?25l",
  showCursor: "\u001b[?25h",
  clearScreen: "\u001b[2J",
  homeCursor: "\u001b[H",
  clearLine: "\u001b[K",
});

/** Brand purple as RGB tuple (matches BRAND.purple #6720FF). */
export const BRAND_RGB = Object.freeze({ r: 103, g: 32, b: 255 });

export { BRAND };
