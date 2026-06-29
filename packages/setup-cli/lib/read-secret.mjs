import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * Read a single line of visible (echoed) input from stdin. Used by `readSecret`
 * on the non-TTY / Windows path, and by the IDE-running guard to wait for the
 * user to press Enter.
 * @param {string} prompt
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream }} [streams]
 * @returns {Promise<string>}
 */
export async function readLineVisible(prompt, { stdin: in_ = stdin, stdout: out_ = stdout } = {}) {
  const rl = createInterface({ input: in_, output: out_ });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/**
 * Read a secret from stdin without echoing typed characters on Unix TTYs.
 * @param {string} prompt
 * @param {{ allowEmpty?: boolean }} [options]
 */
export async function readSecret(prompt, { allowEmpty = false } = {}) {
  if (!stdin.isTTY || process.platform === "win32") {
    if (stdin.isTTY && process.platform === "win32") {
      stdout.write("Note: API key input is visible on Windows.\n");
    }
    const line = (await readLineVisible(prompt)).trim();
    if (!allowEmpty && !line) {
      throw new Error("Input required");
    }
    return line;
  }

  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  let value = "";
  try {
    value = await new Promise((resolve) => {
      const onData = (chunk) => {
        for (const char of chunk) {
          if (char === "\u0003") {
            stdin.removeListener("data", onData);
            stdout.write("^C\n");
            process.exit(130);
          }
          if (char === "\r" || char === "\n") {
            stdin.removeListener("data", onData);
            resolve(value);
            return;
          }
          if (char === "\u007f" || char === "\b") {
            value = value.slice(0, -1);
            continue;
          }
          value += char;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write("\n");
  }

  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) {
    throw new Error("Input required");
  }
  return trimmed;
}
