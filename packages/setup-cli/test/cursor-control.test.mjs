import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ensureIdeStopped } from "../lib/ide-running.mjs";

const SPEC = { darwinPattern: "Cursor", linuxPattern: "^cursor", windowsImage: "Cursor\\.exe" };
const MSG = "Cursor is running. Quit it first.";

describe("ensureIdeStopped", () => {
  it("returns immediately when the IDE is not running", async () => {
    let calls = 0;
    await ensureIdeStopped(SPEC, MSG, {
      isRunning: () => {
        calls += 1;
        return false;
      },
      stdin: { isTTY: true },
      prompt: () => assert.fail("should not prompt when not running"),
      log: () => {},
    });
    assert.equal(calls, 1);
  });

  it("warns and returns without prompting when force is set", async () => {
    let calls = 0;
    await ensureIdeStopped(SPEC, MSG, {
      force: true,
      isRunning: () => {
        calls += 1;
        return true;
      },
      stdin: { isTTY: true },
      prompt: () => assert.fail("should not prompt when --force is set"),
      log: () => {},
    });
    // force path checks once, warns, and returns without prompting.
    assert.equal(calls, 1);
  });

  it("prompts, then proceeds once the IDE is no longer running (interactive TTY)", async () => {
    const logs = [];
    let running = true;
    // Pressing Enter (the prompt resolving) models the user having quit.
    const prompt = () => {
      running = false;
      return Promise.resolve();
    };
    await ensureIdeStopped(SPEC, MSG, {
      isRunning: () => running,
      stdin: { isTTY: true },
      prompt,
      log: (m) => logs.push(m),
      label: "Cursor",
    });
    assert.ok(logs.some((m) => /Cursor is running/.test(m)));
    assert.ok(logs.some((m) => /press Enter to continue/.test(m)));
  });

  it("throws the running message when not interactive (no TTY)", async () => {
    await assert.rejects(
      ensureIdeStopped(SPEC, MSG, {
        isRunning: () => true,
        stdin: { isTTY: false },
        prompt: () => assert.fail("should not prompt without a TTY"),
        log: () => {},
      }),
      /Quit it first/,
    );
  });

  it("re-prompts until the IDE is no longer running (does not throw on a mis-timed Enter)", async () => {
    let prompts = 0;
    let running = true;
    // The user presses Enter once before Cursor has fully exited, then again
    // after it has — modeling the realistic "pressed Enter too early" case.
    const prompt = () => {
      prompts += 1;
      if (prompts >= 2) {
        running = false;
      }
      return Promise.resolve();
    };
    await ensureIdeStopped(SPEC, MSG, {
      isRunning: () => running,
      stdin: { isTTY: true },
      prompt,
      log: () => {},
      label: "Cursor",
    });
    assert.ok(prompts >= 2, "should re-prompt at least once when the IDE is still running");
  });
});
