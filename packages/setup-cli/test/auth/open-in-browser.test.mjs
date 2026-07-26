import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { openInBrowser } from "../../lib/ui/term.mjs";

/** A fake ChildProcess: an EventEmitter with the unref() the opener calls. */
function fakeChild() {
  const child = new EventEmitter();
  child.unref = () => {};
  return child;
}

describe("openInBrowser", () => {
  it("treats a fast non-zero exit as failure (xdg-open with no browser)", async () => {
    const child = fakeChild();
    const pending = openInBrowser("https://example.test", {
      platform: "linux",
      spawnFn: () => child,
    });
    child.emit("exit", 3);
    assert.equal(await pending, false);
  });

  it("treats exit 0 as success", async () => {
    const child = fakeChild();
    const pending = openInBrowser("https://example.test", {
      platform: "linux",
      spawnFn: () => child,
    });
    child.emit("exit", 0);
    assert.equal(await pending, true);
  });

  it("assumes success when the opener keeps running past the grace period", async () => {
    const pending = openInBrowser("https://example.test", {
      platform: "linux",
      spawnFn: fakeChild,
      graceMs: 20,
    });
    assert.equal(await pending, true);
  });

  it("fails when the opener cannot be spawned", async () => {
    const result = await openInBrowser("https://example.test", {
      platform: "linux",
      spawnFn: () => { throw new Error("ENOENT"); },
    });
    assert.equal(result, false);
  });

  it("fails on a spawn error event", async () => {
    const child = fakeChild();
    const pending = openInBrowser("https://example.test", {
      platform: "linux",
      spawnFn: () => child,
    });
    child.emit("error", new Error("ENOENT"));
    assert.equal(await pending, false);
  });

  it("first outcome wins when error and exit both fire", async () => {
    const child = fakeChild();
    const pending = openInBrowser("https://example.test", {
      platform: "linux",
      spawnFn: () => child,
    });
    child.emit("exit", 0);
    child.emit("error", new Error("late"));
    assert.equal(await pending, true);
  });
});
