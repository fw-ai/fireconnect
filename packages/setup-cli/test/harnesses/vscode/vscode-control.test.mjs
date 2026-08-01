import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { ensureIdeStopped } from "../../../lib/io/ide-running.mjs";

/** POSIX ERE check (same dialect as `pgrep -f`). Node RegExp lacks `[[:space:]]`. */
function linuxCmdlineMatches(pattern, cmdline) {
  const r = spawnSync("grep", ["-E", pattern], { input: cmdline, encoding: "utf8" });
  return r.status === 0;
}

const SPEC = {
  darwinPattern: "Visual Studio Code( - Insiders)?.app/Contents/MacOS/Electron",
  linuxPattern: "[/]code(-insiders)?([[:space:]]|$)",
  windowsImage: "Code( - Insiders)?\\.exe",
};
const MSG =
  "VS Code is running. Quit it first (Cmd-Q / File > Quit) so the API key write to state.vscdb isn't discarded when VS Code exits, then rerun. Or pass --force to write anyway (not recommended).";

describe("VS Code linux pgrep pattern", () => {
  const { linuxPattern } = SPEC;

  it("matches VS Code stable and Insiders executables", () => {
    assert.ok(linuxCmdlineMatches(linuxPattern, "/usr/share/code/code --no-sandbox"));
    assert.ok(linuxCmdlineMatches(linuxPattern, "/usr/share/code-insiders/code-insiders --extensions-dir /tmp"));
  });

  it("does not match Chrome crashpad helpers under the VS Code install dir", () => {
    assert.ok(
      !linuxCmdlineMatches(
        linuxPattern,
        "/usr/share/code/chrome_crashpad_handler --monitor-self-annotation=ptype=crashpad-handler",
      ),
    );
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
      prompt: () => assert.fail("should not prompt when not running"),
      log: () => {},
      label: "VS Code",
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
      label: "VS Code",
    });
    assert.equal(calls, 1);
  });

  it("prompts, then proceeds once VS Code is no longer running (interactive TTY)", async () => {
    const logs = [];
    let running = true;
    const prompt = () => {
      running = false;
      return Promise.resolve();
    };
    await ensureIdeStopped(SPEC, MSG, {
      isRunning: () => running,
      stdin: { isTTY: true },
      prompt,
      log: (m) => logs.push(m),
      label: "VS Code",
    });
    assert.ok(logs.some((m) => /VS Code is running/.test(m)));
    assert.ok(logs.some((m) => /press Enter to continue/.test(m)));
  });

  it("throws the running message when not interactive (no TTY)", async () => {
    await assert.rejects(
      ensureIdeStopped(SPEC, MSG, {
        isRunning: () => true,
        stdin: { isTTY: false },
        prompt: () => assert.fail("should not prompt without a TTY"),
        log: () => {},
        label: "VS Code",
      }),
      /Quit it first/,
    );
  });
});
