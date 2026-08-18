/** Banner-only truecolor theme (ansis). Command output uses style.mjs + palette.mjs. */
import { Ansis } from "ansis";

import { isColorEnabled } from "./color.mjs";
import { BRAND } from "./tokens.mjs";

/**
 * We already decide on/off ourselves via `isColorEnabled(stream)` below, so
 * force this instance to truecolor (level 3) rather than letting ansis
 * re-detect support from `process.stdout`/env -- keeps a single source of
 * truth for the enable/disable decision and guarantees exact brand hex
 * values instead of a downsampled approximation.
 *
 * ansis (unlike picocolors) also tracks nested styles: wrapping one style's
 * output inside another correctly re-opens the outer color after the inner
 * one resets, instead of falling back to the terminal default.
 */
const ansi = new Ansis(3);

/**
 * @param {NodeJS.WriteStream | { isTTY?: boolean }} [stream]
 */
export function createTheme(stream = process.stdout) {
  const color = isColorEnabled(stream);

  if (!color) {
    const plain = (text) => text;
    return {
      color: false,
      brand: plain,
      muted: plain,
      interactive: plain,
      success: plain,
      warn: plain,
      error: plain,
      heading: plain,
      spark: plain,
      burst: plain,
      core: plain,
      trail: plain,
      ember: plain,
      symbols: {
        success: "*",
        warn: "!",
        error: "x",
        info: ">",
      },
    };
  }

  return {
    color: true,
    brand: ansi.hex(BRAND.purple),
    muted: ansi.dim,
    interactive: ansi.cyan,
    success: ansi.cyan,
    warn: ansi.yellow,
    error: ansi.red,
    heading: ansi.bold,
    spark: ansi.hex(BRAND.glow),
    burst: ansi.hex(BRAND.violet),
    core: ansi.bold.white,
    trail: ansi.hex(BRAND.deep),
    ember: ansi.hex(BRAND.magenta),
    symbols: {
      success: "\u2713",
      warn: "!",
      error: "\u2717",
      info: "\u2192",
    },
  };
}
