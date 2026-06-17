import { mkdtemp, readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { userSettingsPath } from "../lib/fireconnect-core.mjs";
import { opencodeConfigPath } from "../lib/opencode-core.mjs";
import { globalConfigPath } from "../lib/global-config.mjs";

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

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("uninstall", () => {
  it("restores claude and opencode then removes state", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-"));
    const settingsDir = path.join(home, ".claude");
    const opencodeDir = path.join(home, ".config/opencode");
    await mkdir(settingsDir, { recursive: true });
    await mkdir(opencodeDir, { recursive: true });

    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-original" } }),
    );

    const configPath = opencodeConfigPath(home);
    const opencodeOriginal = JSON.stringify({ model: "openai/gpt-4" }, null, 2) + "\n";
    await writeFile(configPath, opencodeOriginal);

    await runFireconnect(
      ["configure", "--harnesses", "claude,opencode", "--api-key", "fw_test_key_12345", "--api-key-mode", "literal"],
      { HOME: home },
    );
    await runFireconnect(["claude", "on", "--api-key", "fw_test_key_12345"], { HOME: home });
    await runFireconnect(["opencode", "on", "--api-key", "fw_test_key_12345"], { HOME: home });

    const uninstallResult = await runFireconnect(["uninstall"], { HOME: home });
    assert.equal(uninstallResult.code, 0);

    const restoredClaude = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restoredClaude.env.ANTHROPIC_API_KEY, "sk-ant-original");

    const restoredOpencode = await readFile(configPath, "utf8");
    assert.equal(restoredOpencode, opencodeOriginal);

    assert.equal(await pathExists(globalConfigPath(home)), false);
    assert.equal(await pathExists(path.join(home, ".fireconnect/claude")), false);
    assert.equal(await pathExists(path.join(home, ".fireconnect/opencode")), false);
  });

  it("does not mutate settings when harness was configured but not enabled", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-config-only-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });

    const settingsPath = userSettingsPath(home);
    const originalSettings = JSON.stringify({
      env: { ANTHROPIC_API_KEY: "sk-ant-original" },
    });
    await writeFile(settingsPath, originalSettings);

    await runFireconnect(
      ["configure", "--harnesses", "claude", "--api-key", "fw_test_key_12345", "--api-key-mode", "literal"],
      { HOME: home },
    );

    const uninstallResult = await runFireconnect(["uninstall"], { HOME: home });
    assert.equal(uninstallResult.code, 0);

    const after = await readFile(settingsPath, "utf8");
    assert.equal(after, originalSettings);
  });
});
