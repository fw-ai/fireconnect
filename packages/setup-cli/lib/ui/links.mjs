import process, { stdout } from "node:process";

import { accent } from "./interactive.mjs";

const OSC8_OPEN = (url) => `\u001b]8;;${url}\u001b\\`;
const OSC8_CLOSE = "\u001b]8;;\u001b\\";

/**
 * OSC 8 hyperlink support. An allowlist rather than a capability query:
 * terminals that don't understand OSC 8 may render the raw escape bytes, so
 * only emit it where support is known. FORCE_HYPERLINK overrides both ways
 * (the de-facto convention; "" and "0" mean off).
 * @param {NodeJS.WriteStream} [stream]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function hyperlinksEnabled(stream = stdout, env = process.env) {
  if (env.FORCE_HYPERLINK !== undefined) {
    return env.FORCE_HYPERLINK !== "" && env.FORCE_HYPERLINK !== "0";
  }
  if (!stream.isTTY) {
    return false;
  }
  if (env.TERM === "xterm-kitty" || env.TERM === "alacritty") {
    return true;
  }
  if (env.WT_SESSION || env.KONSOLE_VERSION) {
    return true;
  }
  const vte = Number.parseInt(env.VTE_VERSION ?? "", 10);
  if (Number.isInteger(vte) && vte >= 5000) {
    return true;
  }
  return ["iTerm.app", "WezTerm", "vscode", "ghostty", "Hyper", "Tabby"].includes(env.TERM_PROGRAM ?? "");
}

/**
 * A URL the user is meant to open: accent-colored, and clickable (OSC 8)
 * where the terminal supports it. The URL itself stays the visible text so
 * copy/paste and unsupported terminals lose nothing.
 * @param {string} url
 * @param {NodeJS.WriteStream} [stream]
 */
export function link(url, stream = stdout) {
  const text = accent(url, stream);
  return hyperlinksEnabled(stream) ? `${OSC8_OPEN(url)}${text}${OSC8_CLOSE}` : text;
}
