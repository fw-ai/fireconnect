import { spawnSync } from "node:child_process";
import os from "node:os";
import { readLineVisible } from "./read-secret.mjs";

/**
 * Shared "is the IDE GUI process running?" guard used by every harness that
 * writes to an on-disk store the IDE may also be writing (Cursor's state.vscdb,
 * VS Code's chatLanguageModels.json). Writes while the IDE is open can be
 * clobbered by its in-memory/WAL cache, so the harness refuses — with a
 * `--force` escape that downgrades to a stderr warning.
 *
 * Each harness supplies its own process-name matchers via {@link IdeProcessSpec}
 * and its own human-readable warning message. The harness-specific
 * `isXxxRunning`/`assertXxxStopped` wrappers live next to their harness code and
 * delegate here so the per-platform pgrep/tasklist logic has one source of truth.
 */

/**
 * @typedef {Object} IdeProcessSpec
 * @property {string} darwinPattern  `pgrep -f` ERE on macOS (app bundle path).
 * @property {string} linuxPattern   `pgrep -f` ERE on Linux (binary path/name).
 * @property {string} windowsImage   Regex fragment for a whole `tasklist` image
 *   name, e.g. `Cursor\\.exe` or `Code(- Insiders)?\\.exe`. Matched anchored at
 *   the start of a line (tasklist lists the image name in column 0) so it isn't
 *   a substring match — `MyCode.exe` / `VSCode.exe` must not match `Code...exe`.
 */

/**
 * @param {IdeProcessSpec} spec
 * @returns {boolean} true if the IDE GUI process is currently running.
 */
export function isIdeRunning(spec) {
  const platform = os.platform();
  try {
    if (platform === "win32") {
      const r = spawnSync("tasklist", ["/NH"], { encoding: "utf8" });
      // Anchor at line start (tasklist puts the image name in column 0) and
      // require a word boundary after, so the pattern matches a whole image
      // name and not a substring (MyCode.exe / VSCode.exe vs Code.exe).
      const re = new RegExp(`^\\s*${spec.windowsImage}\\b`, "im");
      return r.status === 0 && re.test(r.stdout || "");
    }
    const pattern = platform === "darwin" ? spec.darwinPattern : spec.linuxPattern;
    const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    return r.status === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Throw (or warn with `force`) if the IDE GUI process is running.
 * @param {IdeProcessSpec} spec
 * @param {string} runningMessage  the harness-specific "quit it first" message
 * @param {{ force?: boolean }} [opts]
 */
export function assertIdeStopped(spec, runningMessage, { force = false } = {}) {
  if (!isIdeRunning(spec)) {
    return;
  }
  if (force) {
    console.warn(`warning: ${runningMessage}`);
    return;
  }
  throw new Error(runningMessage);
}

/**
 * Wait for the IDE GUI process to stop before writing. Unlike the sync
 * `assertIdeStopped` (which throws if the IDE is running), this is interactive:
 * when the IDE is running and stdin is a TTY, it asks the user to quit the IDE
 * and press Enter, re-prompting until the IDE is no longer running, after which
 * the caller's write proceeds. fireconnect does not close or reopen the IDE —
 * the user does. Ctrl-C cancels the wait.
 *
 * `force` skips the wait (downgrades to a stderr warning, like `assertIdeStopped`).
 * Non-interactive (no TTY) throws `runningMessage`, matching the historical
 * behavior. Deps (`isRunning`, `stdin`, `stdout`, `prompt`, `log`) are injectable
 * so the logic is unit-testable without a real IDE or a real terminal.
 *
 * @param {IdeProcessSpec} spec
 * @param {string} runningMessage  used for the `--force` warning and the non-TTY error
 * @param {{ force?: boolean, stdin?: { isTTY?: boolean }, stdout?: object, isRunning?: () => boolean, log?: (msg: string) => void, label?: string, prompt?: () => Promise<void> }} [opts]
 */
export async function ensureIdeStopped(spec, runningMessage, {
  force = false,
  stdin = process.stdin,
  stdout = process.stdout,
  isRunning = () => isIdeRunning(spec),
  log = (msg) => console.log(msg),
  label = "the IDE",
  prompt = () => readLineVisible("Press Enter to continue once it's quit: ", { stdin, stdout }),
} = {}) {
  if (!isRunning()) {
    return;
  }
  if (force) {
    console.warn(`warning: ${runningMessage}`);
    return;
  }
  if (!stdin.isTTY) {
    throw new Error(runningMessage);
  }
  log(`${label} is running. Quit it (Cmd-Q / File > Quit), then come back here and press Enter to continue.`);
  while (isRunning()) {
    // eslint-disable-next-line no-await-in-loop -- intentional sequential re-prompt
    await prompt();
  }
}
