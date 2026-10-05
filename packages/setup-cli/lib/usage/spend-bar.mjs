/**
 * The spend-by-model bar: a stacked one-line bar where each model's slice is
 * sized by its share of the session's spend (not its call count).
 *
 * Extracted from the Claude Code status line when the Pi footer usage bar
 * needed the same visual. Width means "share of spend"; the legend a caller
 * draws next to it names each model with exact dollars. Color is identity
 * only — words and numbers stay in the terminal's own color so the bar fits
 * any theme, and `NO_COLOR` collapses to plain glyphs.
 */

import process from "node:process";

/**
 * Series hues for bar segments and legend swatches only; text uses the
 * caller's own color tokens. Raw ANSI (rendered into a status line the host
 * harness prints verbatim), truecolor — the same codes the Claude status line
 * has always emitted.
 */
export const SERIES_COLORS = Object.freeze([
  "\x1b[38;2;57;135;229m", // #3987e5 blue
  "\x1b[38;2;217;89;38m", // #d95926 orange
  "\x1b[38;2;25;158;112m", // #199e70 aqua
  "\x1b[38;2;201;133;0m", // #c98500 yellow
  "\x1b[38;2;213;81;129m", // #d55181 magenta
  "\x1b[38;2;0;131;0m", // #008300 green
  "\x1b[38;2;144;133;233m", // #9085e9 violet
  "\x1b[38;2;230;103;103m", // #e66767 red
]);

const RESET = "\x1b[0m";

const COLORLESS = process.env.NO_COLOR ? true : false;

/**
 * A mark in a series hue — bar segment or legend swatch, never prose.
 * @param {number} index series position (wraps through the palette)
 * @param {string} mark
 * @param {boolean} [color] defaults to `!NO_COLOR`
 */
export function paintSeries(index, mark, color = !COLORLESS) {
  if (!color) {
    return String(mark);
  }
  return `${SERIES_COLORS[index % SERIES_COLORS.length]}${mark}${RESET}`;
}

/**
 * The bar's fill glyph, doubling as the legend swatch so a legend entry reads
 * as a piece of the bar. Heavy horizontal rule (U+2501): unambiguous
 * single-column width in every terminal, unlike the square/circle glyphs
 * legends usually use, which are East-Asian-ambiguous and can render
 * double-wide and misalign.
 */
export const BAR_MARK = "━";

/**
 * Stacked bar by spend share (not call count). Width only — no in-bar labels.
 * @param {Array<{ costShare: number }>} models largest first
 * @param {number} width total bar width in cells
 * @param {{ color?: boolean }} [opts]
 * @returns {string}
 */
export function renderSpendBar(models, width, { color } = {}) {
  const useColor = color ?? !COLORLESS;
  if (models.length === 0) {
    return "";
  }
  const gaps = models.length - 1;
  const inkWidth = Math.max(models.length, width - gaps);
  const widths = models.map((m) => Math.max(1, Math.round(m.costShare * inkWidth)));
  const drift = inkWidth - widths.reduce((sum, w) => sum + w, 0);
  if (drift !== 0) {
    widths[0] = Math.max(1, widths[0] + drift);
  }
  return models
    .map((_model, index) => paintSeries(index, BAR_MARK.repeat(widths[index]), useColor))
    .join(" ");
}

/**
 * Legend entry for one model: series-hue swatch, label, cost (and optional
 * extra the caller appends, e.g. `97% cache`).
 * @param {number} index series position
 * @param {string} text the label + figures, already composed by the caller
 * @param {{ color?: boolean }} [opts]
 */
export function renderSpendLegendEntry(index, text, { color } = {}) {
  return `${paintSeries(index, BAR_MARK, color)} ${text}`;
}
