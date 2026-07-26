import process, { stdout } from "node:process";
import { spawn } from "node:child_process";

import { withSpinner as withSpinnerBase } from "./spinner.mjs";

export { colorsEnabled as colorEnabled } from "./color.mjs";
export { accent, bold, check } from "./style.mjs";
export { hyperlinksEnabled, link } from "./links.mjs";

/** Login narrates on stdout; model-list spinners use stderr (ui.mjs default). */
export function withSpinner(text, work) {
  return withSpinnerBase(text, work, { stream: stdout });
}

/**
 * Open a URL with the platform opener.
 * @param {string} url
 * @param {{ platform?: string, spawnFn?: typeof spawn, graceMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export function openInBrowser(url, { platform = process.platform, spawnFn = spawn, graceMs = 1500 } = {}) {
  const [command, args] = platform === "darwin"
    ? ["open", [url]]
    : platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command, args, { stdio: "ignore", detached: true });
    } catch {
      resolve(false);
      return;
    }
    let timer = null;
    let settled = false;
    const settle = (ok) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.unref();
      resolve(ok);
    };
    child.on("error", () => settle(false));
    child.on("exit", (code) => settle(code === 0));
    timer = setTimeout(() => settle(true), graceMs);
  });
}

/**
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
