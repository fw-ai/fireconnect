/**
 * Live cost view for one Pi session.
 *
 * On a TTY: live-track the session with the same shared meter the Claude view
 * uses, fed through the Pi record adapter. Esc goes back to the session list;
 * q quits. Snapshots stay one-shot for `--json`, `--last-n`, `--verbose`, and
 * non-TTY.
 *
 * There is no agents pane: Pi child agents keep ordinary session logs of their
 * own (no sidecar directory links them to a parent), so the Claude view's
 * Tab/pane navigation has nothing to navigate here — the meter's footer is the
 * whole surface.
 */

import process, { stdin, stdout } from "node:process";
import { clearImmediate, setImmediate } from "node:timers";

import { ANSI } from "../../../ui/palette.mjs";
import { createKeyParser, KEY } from "../../../ui/prompt.mjs";
import { runUsageMeter } from "../../claude/usage/meter.mjs";
import { findPiSessionLog } from "./report.mjs";
import { piMeterRecord } from "./meter-records.mjs";
import { killPiLiveLayout } from "../live-tmux.mjs";

/** The meter banner for the Pi view (the Dashboard default is Claude-branded). */
export const PI_METER_TITLE = "  ✦  Pi · Live Cost Meter  ";

/**
 * Footer key hint for the live meter.
 *
 * Esc goes back to the session list — but only when one exists. With an
 * explicit `--session` there is no session list, so the key would lead nowhere.
 * In a live tmux split (`FC_LIVE_SPLIT=1`) `q` tears down the whole layout
 * (Pi included), so it advertises "quit layout" rather than just "quit".
 *
 * @param {{ canPickSession?: boolean, liveSplit?: boolean }} [opts]
 */
export function piLiveMeterKeyHint({ canPickSession = false, liveSplit = false } = {}) {
  const quit = liveSplit ? "q quit layout" : "q quit";
  return canPickSession ? `Esc sessions · ${quit}` : quit;
}

/**
 * @param {{ json?: boolean, lastN?: string, verbose?: boolean, plain?: boolean }} ctx
 * @param {{ isTTY?: boolean }} [stream]
 */
export function shouldRunPiUsageLive(ctx, stream = stdout) {
  if (ctx.json || ctx.lastN || ctx.verbose || ctx.plain) return false;
  return Boolean(stream?.isTTY);
}

/** Fullscreen meter owns the pane; wipe it before drawing a prompt-tier list. */
function clearPane(stream) {
  if (stream && typeof stream.write === "function") {
    stream.write(`${ANSI.clearScreen}${ANSI.homeCursor}${ANSI.showCursor}`);
  }
}

/**
 * Watch q / Esc / Ctrl+C while the meter runs.
 *
 * @param {{
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WritableStream,
 *   onQuit?: () => void,
 *   onSessions?: () => void,
 * }} [opts]
 * @returns {() => void} detach
 */
export function attachPiMeterKeys({
  input = stdin,
  output = stdout,
  onQuit,
  onSessions,
} = {}) {
  if (!input?.isTTY || typeof input.on !== "function") {
    return () => {};
  }
  const parser = createKeyParser();
  /** @type {ReturnType<typeof setImmediate> | null} */
  let escFlush = null;
  const wasRaw = input.isRaw;
  // `isPaused()` before we resume: a flowing stdin belongs to whoever started
  // it, so detach must not pause a stream it did not start.
  const wasPaused = typeof input.isPaused === "function" ? input.isPaused() : true;
  input.setRawMode?.(true);
  input.resume?.();
  input.setEncoding?.("utf8");

  const restoreTerminal = () => {
    if (output && typeof output.write === "function") {
      // Leave the alternate screen too: this handler calls process.exit, so the
      // meter's own teardown never runs. Without it Ctrl+C dropped back to the
      // shell with the last frame still painted over it.
      output.write(`${ANSI.showCursor}${ANSI.exitAltScreen}`);
    }
    input.setRawMode?.(false);
  };

  const onData = (chunk) => {
    if (escFlush) {
      clearImmediate(escFlush);
      escFlush = null;
    }
    for (const seq of parser.push(chunk)) {
      // Ctrl+C first: it must win over every other key.
      if (seq === KEY.CTRL_C) {
        restoreTerminal();
        process.exit(130);
      }
      if (seq === "q") {
        // Footer advertises quit — never treat q as navigation.
        if (typeof onQuit === "function") onQuit();
        return;
      }
    }
    if (parser.hasPendingEsc()) {
      // A lone Esc only resolves once we know no CSI bytes follow, so decide
      // on the next tick.
      escFlush = setImmediate(() => {
        for (const seq of parser.flush()) {
          if (seq === KEY.ESC) {
            // Esc is the "back to the session list" key. When there is no
            // session list — the locked live-split meter, where
            // `promptSession` is withheld — it has no destination, so it is a
            // no-op rather than a stuck key.
            if (typeof onSessions === "function") onSessions();
            return;
          }
        }
      });
    }
  };

  input.on("data", onData);
  return () => {
    if (escFlush) clearImmediate(escFlush);
    input.removeListener("data", onData);
    input.setRawMode?.(wasRaw);
    // Resuming stdin made it a ref'd handle holding the event loop open, so
    // `q` returned from the meter and then the process just sat there — only
    // Ctrl+C (which exits explicitly) could end it. Pause it back if we were
    // the ones who started it flowing.
    if (wasPaused) input.pause?.();
  };
}

/**
 * Resolve the session, live-track it, and let Esc open the session list.
 *
 * @param {{
 *   home: string,
 *   session?: string,
 *   plain?: boolean,
 *   pollMs?: number,
 *   follow?: boolean,
 *   stream?: NodeJS.WritableStream,
 *   input?: NodeJS.ReadStream,
 *   signal?: AbortSignal,
 *   resolveSession?: typeof findPiSessionLog,
 *   sleep?: (ms: number) => Promise<void>,
 *   promptSession?: (opts: { home: string, input?: NodeJS.ReadStream, output?: NodeJS.WriteStream }) => Promise<string | null>,
 * }} opts
 */
export async function runPiUsageLive({
  home,
  session = "",
  plain = false,
  pollMs = 250,
  follow = true,
  stream = stdout,
  input = stdin,
  signal,
  resolveSession = findPiSessionLog,
  sleep,
  promptSession,
} = {}) {
  if (!home) {
    throw new Error("HOME is required to follow Pi session usage.");
  }

  let sessionPath = await resolveSession({ home, session });

  // Non-interactive: live-track the session directly.
  if (!input?.isTTY || plain) {
    return runUsageMeter({
      filePath: sessionPath,
      plain,
      fromStart: true,
      follow,
      pollMs,
      stream,
      signal,
      sleep,
      title: PI_METER_TITLE,
      mapRecord: piMeterRecord,
    });
  }

  // Only advertise Esc when there is a picker to go back to. With an explicit
  // --session there is no session list, so the key would lead nowhere.
  const canPickSession = typeof promptSession === "function";
  const keyHint = piLiveMeterKeyHint({
    canPickSession,
    liveSplit: process.env.FC_LIVE_SPLIT === "1",
  });

  for (;;) {
    if (signal?.aborted) return;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let openSessions = false;
    let quit = false;
    const detach = attachPiMeterKeys({
      input,
      output: stream,
      onQuit: () => {
        quit = true;
        controller.abort();
      },
      ...(canPickSession
        ? {
          onSessions: () => {
            openSessions = true;
            controller.abort();
          },
        }
        : {}),
    });

    try {
      await runUsageMeter({
        filePath: sessionPath,
        plain,
        fromStart: true,
        follow,
        pollMs,
        stream,
        signal: controller.signal,
        sleep,
        keyHint,
        title: PI_METER_TITLE,
        mapRecord: piMeterRecord,
      });
    } finally {
      detach();
      signal?.removeEventListener("abort", onAbort);
    }

    if (quit) {
      // q is a hard exit. By here the meter's `finally` has exited the alt
      // screen and `detach()` has restored raw mode and paused stdin — but a
      // paused TTY stdin still holds a libuv ref, so returning up the stack
      // just hangs the process (only Ctrl+C, which exits explicitly, ended it).
      // Match that path and exit now that the terminal is restored.
      if (process.env.FC_LIVE_SPLIT === "1") {
        killPiLiveLayout();
      }
      process.exit(0);
    }
    if (signal?.aborted) {
      return;
    }
    if (!openSessions) {
      return;
    }

    clearPane(stream);

    // The session list is rebuilt on open, so an empty lookback window or an
    // unreadable log throws. Esc must not be able to kill a working meter —
    // resume what we were on.
    try {
      const nextSession = await promptSession({ home, input, output: stream });
      // Esc/q out of the session list also resumes the tracked session.
      if (nextSession == null) {
        continue;
      }
      if (nextSession !== sessionPath) {
        sessionPath = nextSession;
      }
    } catch {
      /* keep tracking the current session */
    }
  }
}
