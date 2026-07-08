import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  userSettingsPath,
  providerBackupPath,
  resolveDataDir,
} from "../lib/fireconnect-core.mjs";
import { runFireconnect, writeClaudeSettings } from "./helpers.mjs";

describe("claude harness integration", () => {
  it("on/off round-trip restores settings", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_API_KEY: "sk-ant-original",
        },
      }),
    );

    const onResult = await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(enabled.env.ANTHROPIC_BASE_URL, "https://api.fireworks.ai/inference");
    assert.ok(enabled.apiKeyHelper);
    assert.equal(enabled.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(enabled.env.DISABLE_TELEMETRY, "1");
    assert.equal(enabled.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");

    // The backup captures the user's pre-existing ANTHROPIC_API_KEY, so it must
    // be owner-only (0600) like the other harnesses' backups — no group/other
    // access bits. (Masking with 0o077 distinguishes 0600 from the 0644 default.)
    const backupPath = providerBackupPath(resolveDataDir({ home }));
    const backupStat = await stat(backupPath);
    assert.equal(backupStat.mode & 0o077, 0o000, "provider-backup.json should be owner-only (0600)");
    const backup = JSON.parse(await readFile(backupPath, "utf8"));
    assert.equal(backup.values.ANTHROPIC_API_KEY, "sk-ant-original");

    const offResult = await runFireconnect(["claude", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
    assert.equal(restored.env.ANTHROPIC_API_KEY, "sk-ant-original");
    assert.equal(restored.apiKeyHelper, undefined);
    assert.equal(Object.hasOwn(restored.env, "DISABLE_TELEMETRY"), false);

    const { readGlobalConfig } = await import("../lib/global-config.mjs");
    const config = await readGlobalConfig(home);
    assert.equal(config.harnesses.claude.enabled, false);
  });

  it("on --api-key persists to keychain for key export", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-keychain-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const apiKey = "fw_test_key_12345";

    const onResult = await runFireconnect(
      ["claude", "on", "--api-key", apiKey],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const { readGlobalConfig } = await import("../lib/global-config.mjs");
    const config = await readGlobalConfig(home);
    assert.equal(config.apiKey, "{keychain:fireworks-api-key}");

    const exportResult = await runFireconnect(["key", "export"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(exportResult.code, 0, exportResult.stderr);
    assert.equal(exportResult.stdout.trim(), apiKey);
  });

  it("on persists harness-local Fireworks key before switching to apiKeyHelper", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-harness-local-"));
    const harnessKey = "fw_claude_harness_only_key123";
    await writeClaudeSettings(home, harnessKey);
    const settingsPath = userSettingsPath(home);

    const onResult = await runFireconnect(["claude", "on"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(onResult.code, 0, onResult.stderr);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.ok(enabled.apiKeyHelper);
    assert.equal(enabled.env.ANTHROPIC_API_KEY, undefined);

    const exportResult = await runFireconnect(["key", "export"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(exportResult.code, 0, exportResult.stderr);
    assert.equal(exportResult.stdout.trim(), harnessKey);
  });

  it("off without on leaves user settings unchanged", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-off-noop-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    const originalSettings = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_API_KEY: "sk-ant-original",
      },
    });
    await writeFile(settingsPath, originalSettings);

    const offResult = await runFireconnect(["claude", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const after = await readFile(settingsPath, "utf8");
    assert.equal(after, originalSettings);
  });

  it("second off after on/off round-trip leaves settings unchanged", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-double-off-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_API_KEY: "sk-ant-original",
        },
      }),
    );

    await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    await runFireconnect(["claude", "off"], { HOME: home });

    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.env.ANTHROPIC_API_KEY, "sk-ant-original");

    await runFireconnect(["claude", "off"], { HOME: home });

    const afterSecondOff = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(afterSecondOff.env.ANTHROPIC_API_KEY, "sk-ant-original");
    assert.equal(afterSecondOff.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  });
});
