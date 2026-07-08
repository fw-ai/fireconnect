import { spawn } from "node:child_process";
import process, { stdout } from "node:process";

/**
 * Minimal terminal presentation helpers for guided flows (login). Hand-rolled
 * to preserve the CLI's zero-dependency posture: one accent color, one success
 * glyph, a spinner that degrades to plain lines. Color and animation are
 * dropped when NO_COLOR is set or stdout is not a TTY; the words stay.
 */

const ANSI_CYAN = "\u001b[36m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_RESET = "\u001b[0m";

export function colorEnabled(stream = stdout) {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  return Boolean(stream.isTTY);
}

/** Accent for commands, URLs, and codes the user is meant to act on. */
export function accent(text, stream = stdout) {
  return colorEnabled(stream) ? `${ANSI_CYAN}${text}${ANSI_RESET}` : text;
}

export function bold(text, stream = stdout) {
  return colorEnabled(stream) ? `${ANSI_BOLD}${text}${ANSI_RESET}` : text;
}

/** The single success glyph: "✓" (green when color is on). */
export function check(stream = stdout) {
  return colorEnabled(stream) ? `${ANSI_GREEN}✓${ANSI_RESET}` : "✓";
}

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

const OSC8_OPEN = (url) => `\u001b]8;;${url}\u001b\\`;
const OSC8_CLOSE = "\u001b]8;;\u001b\\";

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

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Show a live status line while `work` runs. On a TTY this animates a spinner
 * in place; otherwise it prints the text once so the wait is still narrated.
 * The line is cleared (TTY) before the result is returned, so callers print
 * the outcome themselves.
 *
 * @template T
 * @param {string} text
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withSpinner(text, work) {
  if (!stdout.isTTY || (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "")) {
    stdout.write(`${text}\n`);
    return work();
  }

  let frame = 0;
  const render = () => {
    stdout.write(`\r${ANSI_CYAN}${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}${ANSI_RESET} ${text}`);
    frame += 1;
  };
  render();
  const timer = setInterval(render, 80);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    stdout.write(`\r${" ".repeat(text.length + 2)}\r`);
  }
}

/**
 * Open a URL with the platform opener. Resolves true when the opener was
 * spawned successfully, false otherwise — callers fall back to printing the
 * URL, never to an error.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export function openInBrowser(url) {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: "ignore", detached: true });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

/**
 * Copy text to the clipboard when a clipboard utility is available. Resolves
 * true on success. Failure is silent by design — callers omit the
 * "(copied…)" line rather than surfacing an error.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export function copyToClipboard(text) {
  const candidates = process.platform === "darwin"
    ? [["pbcopy", []]]
    : process.platform === "win32"
      ? [["clip", []]]
      : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]];

  const tryOne = ([command, args]) => new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });

  return candidates.reduce(
    (prev, candidate) => prev.then((ok) => (ok ? true : tryOne(candidate))),
    Promise.resolve(false),
  );
}
