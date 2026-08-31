import { ensureIdeStopped, isIdeRunning, quitInstruction } from "../../io/ide-running.mjs";

/* -------------------------------------------------------------------------- */
/* Running-ChatGPT guard — the ChatGPT app shares ~/.codex/config.toml and the  */
/* fireworks-model-catalog.json that `codex on`/`off` writes, but it loads the  */
/* model catalog into memory at boot. Writing while it's open leaves its        */
/* dropdown stale (the "custom" provider with no Fireworks models to pick)      */
/* until the user quits & reopens, so we refuse — with a --force escape.         */
/* -------------------------------------------------------------------------- */

export const CHATGPT_PROCESS_SPEC = {
  darwinPattern: "ChatGPT.app/Contents/MacOS/ChatGPT",
  // The official ChatGPT app's Linux build ships the same Electron shell; the
  // binary casing varies by distribution, so match either. Ignore Electron
  // helper/GPU/utility children (`--type=…`); only the main process is named
  // bare. Mirrors the Cursor/VS Code Linux spec.
  linuxPattern: "[/](chatgpt|ChatGPT)([[:space:]]|$)",
  linuxCmdlineMatches: (cmdline) => !/\s--type=/.test(cmdline),
  windowsImage: "ChatGPT\\.exe",
};

export const CHATGPT_RUNNING_MESSAGE =
  `The ChatGPT app is running. ${quitInstruction("the ChatGPT app")} `
  + "so it reloads the Fireworks model catalog, then rerun. Or pass --force to write anyway (not recommended).";

/**
 * @returns {boolean} true if the ChatGPT app GUI process is running.
 */
export function isChatGptRunning() {
  return isIdeRunning(CHATGPT_PROCESS_SPEC);
}

/**
 * Wait for the ChatGPT app to be quit before writing config/catalog.
 * Interactive: when the app is running and stdin is a TTY, prints a "quit it"
 * message and re-prompts (waiting for Enter) until it's no longer running, then
 * returns so the caller's write proceeds. `force` skips the wait (warns
 * instead). Non-interactive throws `CHATGPT_RUNNING_MESSAGE`. fireconnect does
 * not close or reopen the app — the user does.
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureChatGptStopped({ force = false } = {}) {
  return ensureIdeStopped(CHATGPT_PROCESS_SPEC, CHATGPT_RUNNING_MESSAGE, { force, label: "the ChatGPT app" });
}

