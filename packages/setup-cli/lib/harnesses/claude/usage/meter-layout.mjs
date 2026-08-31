/**
 * Column geometry and value formatting for the live cost meter.
 *
 * Everything about how wide a cell is and how a number turns into text lives
 * here. The header, turn rows, footer rows, the agents pane, and the footer's
 * right-align anchor all derive from `TOKEN_COLUMNS`, so a width can only be
 * wrong in one place — these used to be literals repeated across four renderers
 * that had to agree, and didn't.
 */

import { formatUsageCost, roundCachePct, usageCacheHitRatio } from "./format.mjs";

// ── value formatting ─────────────────────────────────────────────────────────

/**
 * A cost — one call or a total — right-aligned so the `$` sits against the
 * digits. `formatUsageCost` is the CLI-wide rule (4 decimals, `n/a` when there
 * is no rate); all this adds is the column width.
 */
export const money = (v, w = COST_COL) => formatUsageCost(v).padStart(w);

/** Token count as a short magnitude: 1234 -> "1.2k", 2.3e6 -> "2.3M". */
export function tok(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * Cache-hit share of prompt tokens for one tally.
 *
 * Claude Code (and Fireworks' Anthropic-compatible gateway) splits the prompt
 * into uncached `input`, `cache_read`, and optional Anthropic-style cache
 * writes. Hit rate is read / (input + read + write) — the fraction of the prompt
 * that did not need a full prefill bill.
 *
 * Returns unpadded text; the column table owns alignment.
 */
export function cachePct(t) {
  const ratio = usageCacheHitRatio({
    input: t.input,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
  });
  if (ratio == null) return "—";
  // roundCachePct, not Math.round: a 99.85% turn must not print "100%" and claim
  // nothing was billed at the full prompt rate.
  return `${roundCachePct(ratio)}%`;
}

// ── column geometry ──────────────────────────────────────────────────────────

/** Widest string `tok()` can produce, e.g. "235.8M" — 6 columns. */
const TOK_WIDTH = 6;

/**
 * The numeric columns: heading, minimum data width, and how to read a Tally.
 *
 * Each column's width is the wider of its heading and its data. `tok()` can emit
 * 6 characters ("235.8M"), which is wider than "write" or "out" — taking the
 * heading length alone would let a large count shove every column right.
 *
 * Every column spent here is one the prompt text does not get, so the headings
 * are as short as they can be while still being words you can look up:
 *
 * - `uncached` / `cached` are Fireworks' own billing pair ("cached prompt tokens
 *   are discounted compared to uncached tokens").
 * - `write` is Anthropic's cache-creation bucket, which its usage output calls
 *   "cache write tokens". Not spelled out in full: sitting between `cached` and
 *   `cache%`, the cache context is already given, and the saved columns go to
 *   prompt text.
 */
export const TOKEN_COLUMNS = [
  { head: "uncached", data: TOK_WIDTH, read: (t) => tok(t.input) },
  { head: "cached", data: TOK_WIDTH, read: (t) => tok(t.cacheRead) },
  { head: "write", data: TOK_WIDTH, read: (t) => tok(t.cacheWrite) },
  // "100%" is 4; the em-dash placeholder is 1.
  { head: "cache%", data: 4, read: (t) => cachePct(t) },
  { head: "out", data: TOK_WIDTH, read: (t) => tok(t.output) },
].map((c) => ({ ...c, width: Math.max(c.head.length, c.data) }));

/** Printable width of the numeric block, including its single-space gutters. */
export const TOKEN_COLUMNS_WIDTH = TOKEN_COLUMNS.reduce((n, c) => n + c.width, 0)
  + (TOKEN_COLUMNS.length - 1);

/** Model badge column — 8 fits "GLM5.2" and "Opus5" but not two models joined. */
export const MODEL_COL = 8;

/** Cost column — wide enough for "$1234.5678". */
export const COST_COL = 10;

/** Turn-number column, e.g. " 7" or "28". */
export const TURN_NO_WIDTH = 2;

/**
 * Everything left of the model badge on a header or turn row: gutter, status
 * glyph, turn number, gutter. The header's `#` sits over the number.
 *
 * One space between the number and the badge rather than two — at an 80-column
 * pane every column here is one the prompt text does not get.
 */
export const TURN_NO_PREFIX = `    ${"#".padStart(TURN_NO_WIDTH)} `;

/** Footer share column ("100%"). */
export const SHARE_COL = 5;

/**
 * Width of everything left of the numeric block, shared by the header, turn
 * rows, and footer rows.
 *
 * The footer's `● label` prefix is narrower than the header's `# model`, so
 * without a common width its numbers sit three columns left of the headings they
 * are read against.
 */
export const LABEL_BLOCK = TURN_NO_PREFIX.length + MODEL_COL;

/** Gutter + coloured dot that opens a footer model row, before its label. */
export const FOOTER_LABEL_INDENT = 4;

/** Widest the elastic share bar is allowed to get. */
export const BAR_MAX = 22;

/** The numeric block's headings, right-aligned in their columns. */
export const tokenHeadings = () => TOKEN_COLUMNS
  .map((c) => c.head.padStart(c.width))
  .join(" ");

/** One Tally rendered across the numeric block, aligned under `tokenHeadings`. */
export const tokenCells = (t) => TOKEN_COLUMNS
  .map((c) => c.read(t).padStart(c.width))
  .join(" ");
