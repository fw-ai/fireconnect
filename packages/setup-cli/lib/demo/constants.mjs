/**
 * Race backstops used by the harness-swap runner (`claude-runner.mjs`).
 *
 * Kept in one place so the stall/cap policy for both race sides (incumbent +
 * challenger) stays identical and a change can't silently diverge them.
 */

// If a side opens but emits no first token/text delta within this window
// (stalled upstream, queued model, silent in-stream error), abort so the pane
// fails fast with a clear message instead of hanging at "waiting for first
// token" indefinitely. Generous, because an agentic turn can do tool calls
// before the first text delta — but 120s with zero text is a real stall.
export const FIRST_TOKEN_TIMEOUT_MS = 120_000;

// Hard cap so a runaway agentic loop / stream can't hang the demo forever. The
// parent AbortSignal (Ctrl-C) still wins for user cancels.
export const HARD_RUN_CAP_MS = 600_000;
