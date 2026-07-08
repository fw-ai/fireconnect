import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ENV_SHELL_HARNESS_IDS,
  writeGlobalConfig,
} from "../lib/global-config.mjs";
import {
  installShellEnvHook,
  removeShellEnvHook,
  shellHookBlock,
  stripShellHookBlock,
  syncShellEnvHookForHarnessOff,
  syncShellEnvHookForHarnessOn,
} from "../lib/shell-env-hook.mjs";
import { seedKeychainConfig } from "./helpers.mjs";

describe("shell-env-hook", () => {
  it("installs and removes a marked block idempotently", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-shell-hook-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    try {
      const firstPath = await installShellEnvHook(home);
      const secondPath = await installShellEnvHook(home);
      assert.equal(firstPath, secondPath);

      const raw = await readFile(path.join(home, ".zshrc"), "utf8");
      assert.match(raw, /# >>> fireconnect >>>/);
      assert.match(raw, /export FIREWORKS_API_KEY="\$\(/);
      assert.equal((raw.match(/# >>> fireconnect >>>/g) ?? []).length, 1);

      assert.equal(await removeShellEnvHook(home), true);
      assert.doesNotMatch(await readFile(path.join(home, ".zshrc"), "utf8"), /fireconnect/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("stripShellHookBlock removes only the marked region", () => {
    const raw = [
      "export PATH=/usr/bin",
      shellHookBlock("/tmp/home").trimEnd(),
      "alias ll='ls -la'",
    ].join("\n");
    const stripped = stripShellHookBlock(raw);
    assert.match(stripped, /export PATH/);
    assert.match(stripped, /alias ll/);
    assert.doesNotMatch(stripped, /fireconnect/);
  });

  it("syncShellEnvHookForHarnessOn installs for keychain mode", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-shell-sync-on-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    try {
      await seedKeychainConfig(home, "fw_test_key_12345");
      await writeGlobalConfig(home, {
        apiKey: "{keychain:fireworks-api-key}",
        harnesses: Object.fromEntries(
          ENV_SHELL_HARNESS_IDS.map((id) => [id, { enabled: id === "codex" }]),
        ),
      });

      const shellPath = await syncShellEnvHookForHarnessOn(home);
      assert.ok(shellPath?.endsWith(".zshrc"));
      assert.match(await readFile(shellPath, "utf8"), /key export/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("syncShellEnvHookForHarnessOff removes hook when no env harnesses remain", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-shell-sync-off-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    try {
      await seedKeychainConfig(home, "fw_test_key_12345");
      await writeGlobalConfig(home, {
        apiKey: "{keychain:fireworks-api-key}",
        harnesses: Object.fromEntries(
          ENV_SHELL_HARNESS_IDS.map((id) => [id, { enabled: false }]),
        ),
      });
      await installShellEnvHook(home);

      assert.equal(await syncShellEnvHookForHarnessOff(home), true);
      assert.doesNotMatch(await readFile(path.join(home, ".zshrc"), "utf8"), /fireconnect/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
