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

/**
 * Dark unless `NEXUS_THEME=light`, or `COLORFGBG` reports a light background
 * (bg 7 or 15) and `NEXUS_THEME` doesn't force dark.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"dark" | "light"}
 */
export function terminalTheme(env = process.env) {
  const forced = String(env.NEXUS_THEME ?? "").trim().toLowerCase();
  if (forced === "light" || forced === "dark") {
    return forced;
  }
  const background = String(env.COLORFGBG ?? "").split(";").at(-1);
  return background === "7" || background === "15" ? "light" : "dark";
}

/**
 * False for macOS Terminal.app unless it advertises truecolor via COLORTERM.
 * A Terminal.app without truecolor reads `38;2;R;G;B` as separate SGR codes,
 * so a channel of 100-107 turns on a bright background that the `39` close
 * never resets. Callers fall back to the nearest 256-color index.
 *
 * Kept free of npm deps so CI helpers that load `ui` (via model-list) work
 * without `npm ci`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function truecolorSupported(env = process.env) {
  const colorterm = String(env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") {
    return true;
  }
  return env.TERM_PROGRAM !== "Apple_Terminal";
}

/** @deprecated Use {@link colorsEnabled} — alias kept for theme/banner callers. */
export function isColorEnabled(stream = process.stdout) {
  return colorsEnabled(stream);
}

/** @deprecated Use {@link colorsEnabled} — alias kept for term.mjs callers. */
export function isInteractiveColorEnabled(stream = process.stdout) {
  return colorsEnabled(stream);
}
