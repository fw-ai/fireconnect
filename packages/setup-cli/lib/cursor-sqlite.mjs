import { ensureIdeStopped, isIdeRunning } from "./ide-running.mjs";
import {
  applyItemTableWrites,
  deleteItemTableValue,
  readItemTableValue,
  writeItemTableValue,
} from "./vscdb-sqlite.mjs";

/* -------------------------------------------------------------------------- */
/* Cursor's `state.vscdb` is a VS Code `ItemTable` key/value store. The SQLite  */
/* access is IDE-agnostic and lives in `vscdb-sqlite.mjs`; these aliases keep   */
/* the historical Cursor-named API stable for callers.                          */
/* -------------------------------------------------------------------------- */

export const readCursorValue = readItemTableValue;
export const writeCursorValue = writeItemTableValue;
export const deleteCursorValue = deleteItemTableValue;
export const applyCursorWrites = applyItemTableWrites;

/* -------------------------------------------------------------------------- */
/* Running-Cursor guard — writes while Cursor is open get clobbered by its    */
/* WAL/in-memory state, so we refuse (with --force escape).                   */
/* -------------------------------------------------------------------------- */

const CURSOR_PROCESS_SPEC = {
  darwinPattern: "Cursor.app/Contents/MacOS/Cursor",
  linuxPattern: "^cursor",
  windowsImage: "Cursor\\.exe",
};

const CURSOR_RUNNING_MESSAGE =
  "Cursor is running. Quit it first (Cmd-Q / File > Quit) so the write isn't overwritten by Cursor's in-memory state, then rerun. Or pass --force to write anyway (not recommended).";

/**
 * @returns {boolean} true if the Cursor GUI process is currently running.
 */
export function isCursorRunning() {
  return isIdeRunning(CURSOR_PROCESS_SPEC);
}

/**
 * Wait for Cursor to be quit before writing. Interactive: when Cursor is
 * running and stdin is a TTY, prints a "quit Cursor" message and re-prompts
 * (waiting for Enter) until Cursor is no longer running, then returns so the
 * caller's write proceeds. `force` skips the wait (warns instead).
 * Non-interactive throws `CURSOR_RUNNING_MESSAGE`. fireconnect does not close
 * or reopen Cursor — the user does.
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureCursorStopped({ force = false } = {}) {
  return ensureIdeStopped(CURSOR_PROCESS_SPEC, CURSOR_RUNNING_MESSAGE, { force, label: "Cursor" });
}
