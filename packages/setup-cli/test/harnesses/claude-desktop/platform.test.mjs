import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import {
  SHIM_AGENT_LABEL,
  buildLaunchAgentPlist,
  startLaunchAgent,
  stopLaunchAgent,
} from "../../../lib/harnesses/claude-desktop/platform.mjs";

/** Fake command runner: records invocations, replays scripted outputs. */
function fakeRunner(script = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    const argv = [cmd, ...args];
    calls.push(argv.join(" "));
    const key = argv.slice(0, 2).join(" ");
    const reply = script[key] ?? script[argv.join(" ")];
    if (reply instanceof Error) throw reply;
    return { stdout: typeof reply === "string" ? reply : "", stderr: "" };
  };
  return { run, calls };
}

/**
 * The global test preload sets FIRECONNECT_TEST=1, which correctly gates the
 * default runner. These tests use injected fakes, so the gate is lifted for
 * the duration while every real binary path stays unreached.
 */
function withoutTestGate(fn) {
  return async () => {
    const prev = process.env.FIRECONNECT_TEST;
    delete process.env.FIRECONNECT_TEST;
    try {
      await fn();
    } finally {
      if (prev !== undefined) process.env.FIRECONNECT_TEST = prev;
    }
  };
}

test("launchd plist is deterministic, escaped, and owned by our label", () => {
  const plist = buildLaunchAgentPlist({
    nodeExec: "/usr/local/bin/node <&>",
    entry: "/tmp/shim <script>.mjs",
    home: "/Users/test <home>",
    logPath: "/tmp/log",
    errorPath: "/tmp/err",
  });
  assert.match(plist, new RegExp(`<string>${SHIM_AGENT_LABEL.replace(/\./g, "\\.")}</string>`));
  assert.ok(plist.includes("/usr/local/bin/node &lt;&amp;&gt;"));
  assert.ok(plist.includes("<key>RunAtLoad</key><true/>"));
  // The shim is stateless and never exits deliberately: always keep it alive
  // (launchd throttles respawns to 10s). `off` bootouts the job first, so a
  // removed lane never respawns.
  assert.ok(plist.includes("<key>KeepAlive</key><true/>"));
  assert.ok(!plist.includes("FIREWORKS"), "no credentials in the plist");
});

test("startLaunchAgent reloads an already-loaded agent with the current plist", withoutTestGate(async () => {
  const already = new Error("bootstrap failed");
  already.stderr = "5: Input/output error (bootstrap already done)";
  const calls = [];
  let bootstraps = 0;
  const run = async (cmd, args) => {
    const argv = [cmd, ...args];
    calls.push(argv.join(" "));
    if (argv[1] === "bootstrap") {
      bootstraps += 1;
      // First bootstrap hits the loaded job; the reload bootstrap succeeds.
      if (bootstraps === 1) throw already;
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  await startLaunchAgent("/tmp/owned.plist", { run, allowSystemChanges: true });
  // Fresh load: bootstrap -> bootout (stale job) -> bootstrap -> kickstart.
  assert.equal(bootstraps, 2);
  assert.ok(calls.some((c) => c.includes("bootout") && c.includes(SHIM_AGENT_LABEL)));
  assert.ok(calls.some((c) => c.includes("kickstart") && c.includes(SHIM_AGENT_LABEL)));
}));

test("startLaunchAgent propagates real bootstrap failures", withoutTestGate(async () => {
  const { run } = fakeRunner({ "/bin/launchctl bootstrap": new Error("bootstrap: no such file") });
  await assert.rejects(startLaunchAgent("/tmp/x.plist", { run, allowSystemChanges: true }), /no such file/);
}));

test("stopLaunchAgent treats an unloaded agent as success", withoutTestGate(async () => {
  const gone = new Error("bootout failed");
  gone.stderr = "No such process";
  const { run, calls } = fakeRunner({ "/bin/launchctl bootout": gone });
  await stopLaunchAgent({ run, allowSystemChanges: true });
  assert.ok(calls.some((c) => c.includes("bootout")));
}));

test("launchd helpers refuse to run without the explicit opt-in", withoutTestGate(async () => {
  await assert.rejects(startLaunchAgent("/tmp/x.plist", {}), /explicit opt-in/);
  await assert.rejects(stopLaunchAgent({}), /explicit opt-in/);
}));

test("launchd helpers stay gated under FIRECONNECT_TEST=1", async () => {
  const { run } = fakeRunner();
  await assert.rejects(startLaunchAgent("/tmp/x.plist", { run, allowSystemChanges: true }), /FIRECONNECT_TEST=1/);
  await assert.rejects(stopLaunchAgent({ run, allowSystemChanges: true }), /FIRECONNECT_TEST=1/);
});
