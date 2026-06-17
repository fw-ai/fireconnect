import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  userSettingsPath,
} from "../lib/fireconnect-core.mjs";

const CLI = path.join(import.meta.dirname, "..", "bin", "fireconnect.mjs");

function runFireconnect(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
  });
}

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
      { HOME: home },
    );
    assert.equal(onResult.code, 0);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(enabled.env.ANTHROPIC_BASE_URL, "https://api.fireworks.ai/inference");
    assert.equal(enabled.env.ANTHROPIC_API_KEY, "fw_test_key_12345");

    const offResult = await runFireconnect(["claude", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
    assert.equal(restored.env.ANTHROPIC_API_KEY, "sk-ant-original");

    const { readGlobalConfig } = await import("../lib/global-config.mjs");
    const config = await readGlobalConfig(home);
    assert.equal(config.harnesses.claude.enabled, false);
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

    await runFireconnect(["claude", "on", "--api-key", "fw_test_key_12345"], { HOME: home });
    await runFireconnect(["claude", "off"], { HOME: home });

    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.env.ANTHROPIC_API_KEY, "sk-ant-original");

    await runFireconnect(["claude", "off"], { HOME: home });

    const afterSecondOff = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(afterSecondOff.env.ANTHROPIC_API_KEY, "sk-ant-original");
    assert.equal(afterSecondOff.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  });
});
