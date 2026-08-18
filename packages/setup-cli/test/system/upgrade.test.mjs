import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { runUpgradeCommand } from "../../lib/cli/commands/global.mjs";
import { FIREWORKS_BASE_URL } from "../../lib/fireworks/model-id.mjs";
import { userSettingsPath } from "../../lib/harnesses/claude/core.mjs";
import {
  CLAUDE_OFF_UPGRADE_BEFORE_VERSION,
  CLAUDE_UPGRADE_PROMPT,
  claudeUpgradeState,
  needsClaudeOffBeforeUpgrade,
  runClaudeUpgradePreflight,
} from "../../lib/system/upgrade.mjs";
import { runCli, withTempHome } from "../helpers.mjs";

function managedClaudeEvidence() {
  return {
    settings: {
      env: {
        ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
      },
    },
    backup: {
      snapshot: {
        existed: false,
        raw: "",
      },
    },
  };
}

function fakeGit({ head = "old", target = "new", events = [] } = {}) {
  return (_file, args) => {
    const command = args.slice(2);
    events.push(command.join(" "));
    if (command[0] === "rev-parse" && command[1] === "HEAD") {
      return `${head}\n`;
    }
    if (command[0] === "rev-parse" && command[1] === "FETCH_HEAD") {
      return `${target}\n`;
    }
    return "";
  };
}

function upgradeDependencies(overrides = {}) {
  return {
    home: "/tmp/fireconnect-upgrade-test",
    exists: () => true,
    // Pre-0.9 so Claude-off preflight still applies unless a test overrides.
    readVersion: async () => "0.8.0",
    finalize: async () => {},
    printNotes: async () => {},
    getClaudeAdapter: () => ({ id: "claude", off: async () => {} }),
    printBannerFn: () => {},
    infoFn: () => {},
    successFn: () => {},
    log: () => {},
    ...overrides,
  };
}

describe("needsClaudeOffBeforeUpgrade", () => {
  it(`requires Claude-off only for FireConnect before ${CLAUDE_OFF_UPGRADE_BEFORE_VERSION}`, () => {
    assert.equal(needsClaudeOffBeforeUpgrade(""), true);
    assert.equal(needsClaudeOffBeforeUpgrade("0.8.9"), true);
    assert.equal(needsClaudeOffBeforeUpgrade("v0.8.0"), true);
    assert.equal(needsClaudeOffBeforeUpgrade("0.9.0"), false);
    assert.equal(needsClaudeOffBeforeUpgrade("v0.9.0"), false);
    assert.equal(needsClaudeOffBeforeUpgrade("1.0.0"), false);
  });
});

describe("Claude upgrade state", () => {
  it("detects either the global flag or managed settings evidence", () => {
    assert.equal(claudeUpgradeState({ globalEnabled: true }).enabled, true);

    const managed = claudeUpgradeState(managedClaudeEvidence());
    assert.equal(managed.enabled, true);
    assert.equal(managed.globalEnabled, false);
    assert.equal(managed.managedSettings, true);
  });

  it("does not treat an unowned Fireworks URL as enabled", () => {
    const state = claudeUpgradeState({
      settings: {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
        },
      },
    });
    assert.deepEqual(state, {
      enabled: false,
      globalEnabled: false,
      managedSettings: false,
    });
  });
});

describe("Claude upgrade preflight", () => {
  it("skips Claude-off entirely for FireConnect 0.9.0+", async () => {
    let offCalled = false;
    let inspected = false;
    const result = await runClaudeUpgradePreflight({
      home: "/tmp/home",
      installedVersion: "0.9.0",
      adapter: { off: async () => { offCalled = true; } },
      input: { isTTY: false },
      environment: {},
      inspect: async () => {
        inspected = true;
        return { enabled: true, globalEnabled: true, managedSettings: true };
      },
      prompt: async () => {
        throw new Error("must not prompt on 0.9.0+");
      },
    });
    assert.deepEqual(result, { proceed: true, restored: false });
    assert.equal(offCalled, false);
    assert.equal(inspected, false);
  });

  it("fails closed without a TTY and tells the user how to restore", async () => {
    let offCalled = false;
    await assert.rejects(
      runClaudeUpgradePreflight({
        home: "/tmp/home",
        adapter: { off: async () => { offCalled = true; } },
        input: { isTTY: false },
        environment: {},
        inspect: async () => ({ enabled: true, globalEnabled: true, managedSettings: false }),
      }),
      /Run `fireconnect claude off`, then retry `fireconnect upgrade`/,
    );
    assert.equal(offCalled, false);
  });

  it("automatically restores without a TTY when explicitly enabled", async () => {
    const events = [];
    let inspection = 0;
    const result = await runClaudeUpgradePreflight({
      home: "/tmp/home",
      adapter: {
        off: async () => {
          events.push("off");
        },
      },
      input: { isTTY: false },
      environment: { FIRECONNECT_AUTO_OFF_CLAUDE: "1" },
      prompt: async () => {
        throw new Error("automatic restoration must not prompt");
      },
      inspect: async () => {
        inspection += 1;
        events.push(`inspect-${inspection}`);
        return inspection === 1
          ? { enabled: true, globalEnabled: true, managedSettings: true }
          : { enabled: false, globalEnabled: false, managedSettings: false };
      },
    });

    assert.deepEqual(result, { proceed: true, restored: true });
    assert.deepEqual(events, ["inspect-1", "off", "inspect-2"]);
  });

  it("uses the exact default-yes prompt and cancels without calling off", async () => {
    let offCalled = false;
    const result = await runClaudeUpgradePreflight({
      home: "/tmp/home",
      adapter: { off: async () => { offCalled = true; } },
      input: { isTTY: true },
      environment: {},
      inspect: async () => ({ enabled: true, globalEnabled: false, managedSettings: true }),
      prompt: async (question, options) => {
        assert.equal(question, CLAUDE_UPGRADE_PROMPT);
        assert.equal(options.defaultYes, true);
        return false;
      },
    });

    assert.deepEqual(result, { proceed: false, restored: false });
    assert.equal(offCalled, false);
  });

  it("calls the loaded adapter and verifies both evidence sources are clear", async () => {
    const events = [];
    let inspection = 0;
    const result = await runClaudeUpgradePreflight({
      home: "/tmp/home",
      adapter: {
        off: async (ctx) => {
          events.push("off");
          assert.equal(ctx.home, "/tmp/home");
        },
      },
      input: { isTTY: true },
      environment: {},
      prompt: async () => {
        events.push("prompt");
        return true;
      },
      inspect: async () => {
        inspection += 1;
        events.push(`inspect-${inspection}`);
        return inspection === 1
          ? { enabled: true, globalEnabled: true, managedSettings: true }
          : { enabled: false, globalEnabled: false, managedSettings: false };
      },
    });

    assert.deepEqual(result, { proceed: true, restored: true });
    assert.deepEqual(events, ["inspect-1", "prompt", "off", "inspect-2"]);
  });

  it("aborts when off leaves managed settings behind", async () => {
    let inspection = 0;
    await assert.rejects(
      runClaudeUpgradePreflight({
        home: "/tmp/home",
        adapter: { off: async () => {} },
        input: { isTTY: false },
        environment: { FIRECONNECT_AUTO_OFF_CLAUDE: "1" },
        prompt: async () => {
          throw new Error("automatic restoration must not prompt");
        },
        inspect: async () => {
          inspection += 1;
          return inspection === 1
            ? { enabled: true, globalEnabled: true, managedSettings: true }
            : { enabled: true, globalEnabled: false, managedSettings: true };
        },
      }),
      /settings were not fully restored; upgrade cancelled/,
    );
  });
});

describe("Claude upgrade restoration fallback", () => {
  it("strips backup-less legacy managed settings through the old adapter's off", async () => {
    await withTempHome("upgrade-legacy-off", async (home) => {
      const settingsPath = userSettingsPath(home);
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, `${JSON.stringify({
        model: "accounts/fireworks/routers/firerouter[1m]",
        env: {
          ANTHROPIC_BASE_URL: "https://router.fireworks.ai",
          ANTHROPIC_AUTH_TOKEN: "sk-ant-original",
          ANTHROPIC_CUSTOM_HEADERS: [
            "X-FireRouter-Fireworks-Key: fw_test_key",
            "X-User-Header: keep-me",
          ].join("\n"),
          CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
          CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
          USER_ENV: "keep-me",
        },
        unrelated: { keep: true },
      }, null, 2)}\n`);

      const result = await runCli(["claude", "off"], { home });
      assert.equal(result.code, 0, result.stderr);

      const restored = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(restored.model, undefined);
      assert.deepEqual(restored.env, {
        ANTHROPIC_CUSTOM_HEADERS: "X-User-Header: keep-me",
        USER_ENV: "keep-me",
      });
      assert.deepEqual(restored.unrelated, { keep: true });
    });
  });
});

describe("upgrade fetch, compare, and reset ordering", () => {
  it("does not run the Claude preflight or reset when already current", async () => {
    const events = [];
    let finalized = false;
    await runUpgradeCommand(upgradeDependencies({
      execFile: fakeGit({ head: "same", target: "same", events }),
      preflight: async () => {
        throw new Error("preflight should not run");
      },
      finalize: async () => {
        finalized = true;
      },
    }));

    assert.deepEqual(events, [
      "rev-parse HEAD",
      "fetch --depth=1 origin main --quiet",
      "rev-parse FETCH_HEAD",
    ]);
    assert.equal(finalized, true);
  });

  it("cancels before reset when the user declines the preflight", async () => {
    const events = [];
    await runUpgradeCommand(upgradeDependencies({
      execFile: fakeGit({ events }),
      preflight: async () => {
        events.push("preflight");
        return { proceed: false, restored: false };
      },
    }));

    assert.deepEqual(events, [
      "rev-parse HEAD",
      "fetch --depth=1 origin main --quiet",
      "rev-parse FETCH_HEAD",
      "preflight",
    ]);
  });

  it("resets only after restoration and prints reconnect instructions", async () => {
    const events = [];
    const output = [];
    const oldAdapter = { id: "claude", off: async () => {} };
    let versionRead = 0;
    await runUpgradeCommand(upgradeDependencies({
      execFile: fakeGit({ events }),
      readVersion: async () => {
        versionRead += 1;
        return versionRead === 1 ? "0.8.0" : "1.0.0";
      },
      getClaudeAdapter: () => oldAdapter,
      preflight: async ({ adapter, installedVersion }) => {
        assert.equal(adapter, oldAdapter);
        assert.equal(installedVersion, "0.8.0");
        events.push("preflight");
        return { proceed: true, restored: true };
      },
      successFn: () => {
        throw new Error("generic success output should be replaced");
      },
      log: (message) => output.push(message),
    }));

    assert.deepEqual(events, [
      "rev-parse HEAD",
      "fetch --depth=1 origin main --quiet",
      "rev-parse FETCH_HEAD",
      "preflight",
      "reset --hard new",
      "diff --quiet old new -- packages/setup-cli/package-lock.json",
    ]);
    assert.deepEqual(output, [
      "Upgrade complete. Your original Claude Code settings were restored.",
      "To reconnect with FireConnect v1.0.0:\n  fireconnect claude",
    ]);
  });

  it("passes the installed FireConnect version into Claude preflight", async () => {
    const events = [];
    await runUpgradeCommand(upgradeDependencies({
      execFile: fakeGit({ events }),
      readVersion: async () => "0.9.1",
      preflight: async ({ installedVersion }) => {
        assert.equal(installedVersion, "0.9.1");
        events.push("preflight");
        return { proceed: true, restored: false };
      },
    }));

    assert.ok(events.includes("preflight"));
    assert.ok(events.includes("reset --hard new"));
  });
});
