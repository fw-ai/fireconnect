import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { ensureIdeStopped } from "../../../lib/io/ide-running.mjs";
import {
  CHATGPT_PROCESS_SPEC,
  CHATGPT_RUNNING_MESSAGE,
  ensureChatGptStopped,
  isChatGptRunning,
} from "../../../lib/harnesses/codex/ide-running.mjs";

const SPEC = CHATGPT_PROCESS_SPEC;
const MSG = CHATGPT_RUNNING_MESSAGE;

/** POSIX ERE check (same dialect as `pgrep -f`). Node RegExp lacks `[[:space:]]`. */
function linuxCmdlineMatchesPattern(pattern, cmdline) {
  const r = spawnSync("grep", ["-E", pattern], { input: cmdline, encoding: "utf8" });
  return r.status === 0;
}

describe("ChatGPT app pgrep pattern", () => {
  it("matches the real ChatGPT.app binary path on macOS", () => {
    // Real cmdline observed on macOS: /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
    const { darwinPattern } = SPEC;
    const r = spawnSync("grep", ["-E", darwinPattern], { input: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", encoding: "utf8" });
    assert.equal(r.status, 0);
  });

  it("does not match unrelated paths that merely contain 'chatgpt'", () => {
    const { darwinPattern } = SPEC;
    for (const cmdline of [
      "/Users/x/scripts/chatgpt-helper.mjs",
      "/opt/chatgptify/bin/chatgptify",
    ]) {
      const r = spawnSync("grep", ["-E", darwinPattern], { input: cmdline, encoding: "utf8" });
      assert.notEqual(r.status, 0, `should not match: ${cmdline}`);
    }
  });

  it("matches a Linux chatgpt binary at common paths (either casing)", () => {
    assert.ok(linuxCmdlineMatchesPattern(SPEC.linuxPattern, "/usr/bin/chatgpt --no-sandbox"));
    assert.ok(linuxCmdlineMatchesPattern(SPEC.linuxPattern, "/opt/ChatGPT/ChatGPT"));
    assert.ok(linuxCmdlineMatchesPattern(SPEC.linuxPattern, "/opt/chatgpt/chatgpt"));
  });

  it("does not match unrelated Linux paths that merely contain 'chatgpt'", () => {
    assert.ok(!linuxCmdlineMatchesPattern(SPEC.linuxPattern, "/home/x/bin/chatgptify --foo"));
    assert.ok(!linuxCmdlineMatchesPattern(SPEC.linuxPattern, "/usr/bin/mychatgpt-tool"));
  });

  it("treats Electron helper processes as not running once the main process exits", () => {
    const { linuxCmdlineMatches } = SPEC;
    assert.equal(linuxCmdlineMatches("/opt/ChatGPT/ChatGPT --type=utility --utility-sub-type=network.mojom.NetworkService"), false);
    assert.equal(linuxCmdlineMatches("/opt/ChatGPT/ChatGPT --type=renderer --enable-crashpad"), false);
    assert.equal(linuxCmdlineMatches("/opt/ChatGPT/ChatGPT --no-sandbox"), true);
  });
});

describe("ensureChatGptStopped", () => {
  it("returns immediately when the app is not running", async () => {
    // Inject isRunning=false to avoid depending on a real app state.
    await ensureIdeStopped(SPEC, MSG, { isRunning: () => false });
  });

  it("throws the ChatGPT running message in non-TTY mode when running", async () => {
    await assert.rejects(
      ensureIdeStopped(SPEC, MSG, {
        isRunning: () => true,
        stdin: { isTTY: false },
      }),
      /ChatGPT app is running/,
    );
  });

  it("warns instead of waiting when force is set and the app is running", async () => {
    // Should not throw or hang.
    await ensureIdeStopped(SPEC, MSG, { force: true, isRunning: () => true });
  });

  it("isChatGptRunning returns a boolean without throwing", () => {
    assert.equal(typeof isChatGptRunning(), "boolean");
  });
});
