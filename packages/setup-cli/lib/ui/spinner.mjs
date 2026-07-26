import process, { stderr, stdout } from "node:process";

import { colorsEnabled } from "./color.mjs";
import { ANSI } from "./palette.mjs";
import { accent } from "./style.mjs";

const SPINNER_FRAMES = process.platform === "win32"
  ? ["-", "\\", "|", "/"]
  : ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Run `work` with an animated spinner. Defaults to stderr so stdout stays
 * clean for pipes/--json; pass `stream: stdout` for login-style narration.
 *
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} work
 * @param {{ stream?: NodeJS.WriteStream }} [options]
 * @returns {Promise<T>}
 */
export async function withSpinner(label, work, { stream = stderr } = {}) {
  if (!stream.isTTY || !colorsEnabled(stream)) {
    if (stream === stdout) {
      stream.write(`${label}\n`);
    }
    return work();
  }

  let frame = 0;
  const render = () => {
    stream.write(`\r${ANSI.clearLine}${accent(SPINNER_FRAMES[frame % SPINNER_FRAMES.length], stream)} ${label}`);
    frame += 1;
  };
  render();
  const timer = setInterval(render, 80);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    stream.write(`\r${ANSI.clearLine}`);
  }
}
