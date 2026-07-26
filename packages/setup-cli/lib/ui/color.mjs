import process from "node:process";

/**
 * Single color-enable policy for the whole CLI (ui, term, usage, spinners).
 * Honors NO_COLOR, FORCE_COLOR, TERM=dumb, and TTY — per no-color.org and
 * common Node/chalk conventions. `NO_COLOR=""` still allows color (legacy
 * interactive flows relied on this).
 *
 * @param {{ isTTY?: boolean }} [stream]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function colorsEnabled(stream = process.stdout, env = process.env) {
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") {
    return true;
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return false;
  }
  if (env.TERM === "dumb") {
    return false;
  }
  return Boolean(stream && stream.isTTY);
}

/** @deprecated Use {@link colorsEnabled} — alias kept for theme/banner callers. */
export function isColorEnabled(stream = process.stdout) {
  return colorsEnabled(stream);
}

/** @deprecated Use {@link colorsEnabled} — alias kept for term.mjs callers. */
export function isInteractiveColorEnabled(stream = process.stdout) {
  return colorsEnabled(stream);
}
