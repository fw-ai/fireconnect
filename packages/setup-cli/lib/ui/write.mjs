import process from "node:process";

import { createTheme } from "./theme.mjs";
import { fail, ok, warn as uiWarn } from "./style.mjs";

const stdoutTheme = createTheme(process.stdout);

/**
 * @param {NodeJS.WriteStream} stream
 * @param {string} message
 */
function writeLine(stream, message) {
  stream.write(`${message}\n`);
}

export function blank() {
  process.stdout.write("\n");
}

/**
 * @param {string} title
 */
export function section(title) {
  blank();
  writeLine(process.stdout, stdoutTheme.heading(title));
}

/**
 * @param {string} message
 */
export function info(message) {
  const { symbols, muted } = stdoutTheme;
  writeLine(process.stdout, `${muted(symbols.info)} ${message}`);
}

/**
 * @param {string} message
 */
export function success(message) {
  writeLine(process.stdout, ok(message));
}

/**
 * @param {string} message
 */
export function warn(message) {
  writeLine(process.stderr, uiWarn(message));
}

/**
 * @param {string} message
 */
export function error(message) {
  writeLine(process.stderr, fail(`Error: ${message}`));
}
