import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ensureIdeStopped } from "../../../lib/io/ide-running.mjs";

const SPEC = { darwinPattern: "Cursor", linuxPattern: "^cursor", windowsImage: "Cursor\\.exe" };
const MSG = "Cursor is running. Quit it first.";

/** Prompt that never resolves until aborted (so auto-poll can win). */
function hangingPrompt({ signal }) {
  return new Promise((_, reject) => {
    const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

describe("ensureIdeStopped", () => {
  it("returns immediately when the IDE is not running", async () => {
    let calls = 0;
    await ensureIdeStopped(SPEC, MSG, {
      isRunning: () => {
        calls += 1;
        return false;
      },
      stdin: { isTTY: true },
      confirm: () => assert.fail("should not confirm when not running"),
      prompt: () => assert.fail("should not prompt when not running"),
      log: () => {},
    });
    assert.equal(calls, 1);
  });

  it("warns and returns without waiting when force is set", async () => {
    let calls = 0;
    await ensureIdeStopped(SPEC, MSG, {
      force: true,
      isRunning: () => {
        calls += 1;
        return true;
      },
      stdin: { isTTY: true },
      confirm: () => assert.fail("should not confirm when --force is set"),
      prompt: () => assert.fail("should not prompt when --force is set"),
      sleep: () => assert.fail("should not sleep when --force is set"),
      log: () => {},
    });
    assert.equal(calls, 1);
  });

  it("auto-continues once the IDE exits (no Enter required)", async () => {
    const logs = [];
    let polls = 0;
    await ensureIdeStopped(SPEC, MSG, {
      isRunning: () => {
        polls += 1;
        return polls < 3;
      },
      stdin: { isTTY: true },
      pollIntervalMs: 1,
      maxWaitMs: 60_000,
      sleep: async () => {},
      now: () => 0,
      prompt: hangingPrompt,
      confirm: () => assert.fail("should not ask to force when quit is detected"),
      log: (m) => logs.push(m),
      label: "Cursor",
    });
    assert.ok(logs.some((m) => /Cursor is running/.test(m)));
    assert.ok(logs.some((m) => /press Enter/.test(m)));
    assert.ok(polls >= 3);
  });

  it("continues when the user presses Enter after quitting", async () => {
    let running = true;
    await ensureIdeStopped(SPEC, MSG, {
      isRunning: () => running,
      stdin: { isTTY: true },
      sleep: () => new Promise(() => {}),
      now: () => 0,
      maxWaitMs: 60_000,
      prompt: async () => {
        running = false;
      },
      confirm: () => assert.fail("should not reach continue-anyway"),
      log: () => {},
      label: "Cursor",
    });
  });

  it("throws the running message when not interactive (no TTY)", async () => {
    await assert.rejects(
      ensureIdeStopped(SPEC, MSG, {
        isRunning: () => true,
        stdin: { isTTY: false },
        confirm: () => assert.fail("should not confirm without a TTY"),
        prompt: () => assert.fail("should not prompt without a TTY"),
        log: () => {},
      }),
      /Quit it first/,
    );
  });

  it("offers continue-anyway after the wait timeout instead of looping forever", async () => {
    let confirmed = false;
    let t = 0;
    await ensureIdeStopped(SPEC, MSG, {
      isRunning: () => true,
      stdin: { isTTY: true },
      pollIntervalMs: 1,
      maxWaitMs: 100,
      sleep: async () => {
        t += 50;
      },
      now: () => t,
      prompt: hangingPrompt,
      confirm: async () => {
        confirmed = true;
        return true;
      },
      log: () => {},
      label: "Cursor",
    });
    assert.equal(confirmed, true);
  });
});
