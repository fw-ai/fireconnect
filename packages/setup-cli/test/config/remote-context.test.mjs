import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRemoteContext } from "../../lib/config/remote-context.mjs";

const noProc = () => "";

describe("isRemoteContext", () => {
  it("is false on a plain local machine", () => {
    assert.equal(
      isRemoteContext({ env: {}, platform: "darwin", readProcVersion: noProc }),
      false,
    );
    assert.equal(
      isRemoteContext({ env: {}, platform: "linux", readProcVersion: noProc }),
      false,
    );
  });

  it("detects SSH sessions from any of the ssh env markers", () => {
    for (const key of ["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"]) {
      assert.equal(
        isRemoteContext({ env: { [key]: "value" }, platform: "linux", readProcVersion: noProc }),
        true,
        key,
      );
    }
    // Empty/whitespace markers don't count (some shells leave them set-but-blank).
    assert.equal(
      isRemoteContext({ env: { SSH_TTY: "  " }, platform: "linux", readProcVersion: noProc }),
      false,
    );
  });

  it("detects WSL via /proc/version on linux only", () => {
    const wslProc = () => "Linux version 5.15.90.1-microsoft-standard-WSL2";
    assert.equal(
      isRemoteContext({ env: {}, platform: "linux", readProcVersion: wslProc }),
      true,
    );
    assert.equal(
      isRemoteContext({ env: {}, platform: "darwin", readProcVersion: wslProc }),
      false,
    );
  });

  it("treats a missing /proc/version as local (default reader never throws)", () => {
    // The default reader swallows read errors and returns "" — off-linux or
    // sandboxed environments must read as local, not crash the sign-in flow.
    assert.equal(isRemoteContext({ env: {}, platform: "darwin" }), false);
  });
});
