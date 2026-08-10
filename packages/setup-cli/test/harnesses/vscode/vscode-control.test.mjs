import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { ensureIdeStopped } from "../../../lib/io/ide-running.mjs";

/** POSIX ERE check (same dialect as `pgrep -f`). Node RegExp lacks `[[:space:]]`. */
function linuxCmdlineMatchesPattern(pattern, cmdline) {
  const r = spawnSync("grep", ["-E", pattern], { input: cmdline, encoding: "utf8" });
  return r.status === 0;
}

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

const SPEC = {
  darwinPattern: "Visual Studio Code( - Insiders)?.app/Contents/MacOS/Electron",
  linuxPattern: "[/]code(-insiders)?([[:space:]]|$)",
  linuxCmdlineMatches: (cmdline) => !/\s--type=/.test(cmdline),
  windowsImage: "Code( - Insiders)?\\.exe",
};
const MSG =
  "VS Code is running. Quit it first (Cmd-Q / File > Quit) so the API key write to state.vscdb isn't discarded when VS Code exits, then rerun. Or pass --force to write anyway (not recommended).";

describe("VS Code linux pgrep pattern", () => {
  const { linuxPattern, linuxCmdlineMatches } = SPEC;

  it("matches VS Code stable and Insiders executables", () => {
    assert.ok(linuxCmdlineMatchesPattern(linuxPattern, "/usr/share/code/code --no-sandbox"));
    assert.ok(linuxCmdlineMatchesPattern(linuxPattern, "/usr/share/code-insiders/code-insiders --extensions-dir /tmp"));
  });

  it("does not match Chrome crashpad helpers under the VS Code install dir", () => {
    assert.ok(
      !linuxCmdlineMatchesPattern(
        linuxPattern,
        "/usr/share/code/chrome_crashpad_handler --monitor-self-annotation=ptype=crashpad-handler",
      ),
    );
  });

  it("treats Electron helper processes as not running once the main process exits", () => {
    assert.equal(
      linuxCmdlineMatches("/usr/share/code/code --type=utility --utility-sub-type=network.mojom.NetworkService"),
      false,
    );
    assert.equal(
      linuxCmdlineMatches("/usr/share/code/code --type=renderer --enable-crash-reporter=abc"),
      false,
    );
    assert.equal(linuxCmdlineMatches("/usr/share/code/code --no-sandbox"), true);
    assert.equal(linuxCmdlineMatches("/usr/share/code-insiders/code-insiders --unity-launch"), true);
  });
});

describe("ensureVscodeStopped (via ensureIdeStopped)", () => {
  it("returns immediately when VS Code is not running", async () => {
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
      label: "VS Code",
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
      label: "VS Code",
    });
    assert.equal(calls, 1);
  });

  it("auto-continues once VS Code exits (no Enter required)", async () => {
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
      label: "VS Code",
    });
    assert.ok(logs.some((m) => /VS Code is running/.test(m)));
    assert.ok(logs.some((m) => /press Enter/.test(m)));
    assert.ok(polls >= 3);
  });

  it("continues when the user presses Enter after quitting", async () => {
    let running = true;
    const logs = [];
    await ensureIdeStopped(SPEC, MSG, {
      isRunning: () => running,
      stdin: { isTTY: true },
      // Poll sleep never resolves — Enter must win the race.
      sleep: () => new Promise(() => {}),
      now: () => 0,
      maxWaitMs: 60_000,
      prompt: async () => {
        running = false;
      },
      confirm: () => assert.fail("should not reach continue-anyway"),
      log: (m) => logs.push(m),
      label: "VS Code",
    });
    assert.ok(logs.some((m) => /press Enter/.test(m)));
  });

  it("re-prompts with guidance when Enter is pressed before VS Code has quit", async () => {
    const logs = [];
    let enters = 0;
    let running = true;
    await ensureIdeStopped(SPEC, MSG, {
      isRunning: () => running,
      stdin: { isTTY: true },
      sleep: () => new Promise(() => {}),
      now: () => 0,
      maxWaitMs: 60_000,
      prompt: async () => {
        enters += 1;
        if (enters >= 2) {
          running = false;
        }
      },
      confirm: () => assert.fail("should not reach continue-anyway"),
      log: (m) => logs.push(m),
      label: "VS Code",
    });
    assert.equal(enters, 2);
    assert.ok(logs.some((m) => /still appears to be running/.test(m)));
    assert.ok(logs.some((m) => /press Enter again/.test(m)));
  });

  it("offers continue-anyway after the wait timeout", async () => {
    const logs = [];
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
      confirm: async (question, opts) => {
        confirmed = true;
        assert.match(question, /Continue anyway/);
        assert.equal(opts.defaultYes, false);
        return true;
      },
      log: (m) => logs.push(m),
      label: "VS Code",
    });
    assert.equal(confirmed, true);
    assert.ok(logs.some((m) => /still appears to be running/.test(m)));
  });

  it("throws when the user declines continue-anyway after timeout", async () => {
    let t = 0;
    await assert.rejects(
      ensureIdeStopped(SPEC, MSG, {
        isRunning: () => true,
        stdin: { isTTY: true },
        pollIntervalMs: 1,
        maxWaitMs: 100,
        sleep: async () => {
          t += 50;
        },
        now: () => t,
        prompt: hangingPrompt,
        confirm: async () => false,
        log: () => {},
        label: "VS Code",
      }),
      /Quit it first/,
    );
  });

  it("proceeds if the IDE quits while the continue-anyway prompt is open", async () => {
    let t = 0;
    let running = true;
    await ensureIdeStopped(SPEC, MSG, {
      isRunning: () => running,
      stdin: { isTTY: true },
      pollIntervalMs: 1,
      maxWaitMs: 100,
      sleep: async () => {
        t += 50;
      },
      now: () => t,
      prompt: hangingPrompt,
      confirm: async () => {
        running = false;
        return false;
      },
      log: () => {},
      label: "VS Code",
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
        label: "VS Code",
      }),
      /Quit it first/,
    );
  });
});
