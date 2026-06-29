import { mkdtemp, readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { userSettingsPath } from "../lib/fireconnect-core.mjs";
import { opencodeConfigPath } from "../lib/opencode-core.mjs";
import { codexBackupPath, codexConfigPath, codexDataDir, CODEX_CATALOG_TOML_REF } from "../lib/codex-core.mjs";
import { patchCodexCatalogRefRaw } from "../lib/codex-toml-patch.mjs";
import { globalConfigPath } from "../lib/global-config.mjs";
import { writeJson } from "../lib/fireconnect-core.mjs";

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
  it("restores claude, opencode, and codex then removes state", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-"));
    const settingsDir = path.join(home, ".claude");
    const opencodeDir = path.join(home, ".config/opencode");
    const codexDir = path.join(home, ".codex");
    await mkdir(settingsDir, { recursive: true });
    await mkdir(opencodeDir, { recursive: true });
    await mkdir(codexDir, { recursive: true });

    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-original" } }),
    );

    const configPath = opencodeConfigPath(home);
    const opencodeOriginal = JSON.stringify({ model: "openai/gpt-4" }, null, 2) + "\n";
    await writeFile(configPath, opencodeOriginal);

    const codexPath = codexConfigPath(home);
    const codexOriginal = [
      'model_provider = "openai"',
      'model = "gpt-4.1"',
    ].join("\n") + "\n";
    await writeFile(codexPath, codexOriginal);

    await runFireconnect(
      ["configure", "--harnesses", "claude,opencode,codex", "--api-key", "fw_test_key_12345"],
      { HOME: home },
    );
    await runFireconnect(["claude", "on", "--api-key", "fw_test_key_12345"], { HOME: home });
    await runFireconnect(["opencode", "on", "--api-key", "fw_test_key_12345"], { HOME: home });
    await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );

    const uninstallResult = await runFireconnect(["uninstall"], { HOME: home });
    assert.equal(uninstallResult.code, 0);

    const restoredClaude = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restoredClaude.env.ANTHROPIC_API_KEY, "sk-ant-original");

    const restoredOpencode = await readFile(configPath, "utf8");
    assert.equal(restoredOpencode, opencodeOriginal);

    const restoredCodex = await readFile(codexPath, "utf8");
    assert.equal(restoredCodex, codexOriginal);

    assert.equal(await pathExists(globalConfigPath(home)), false);
    assert.equal(await pathExists(path.join(home, ".fireconnect/claude")), false);
    assert.equal(await pathExists(path.join(home, ".fireconnect/opencode")), false);
    assert.equal(await pathExists(path.join(home, ".fireconnect/codex")), false);
    assert.equal(await pathExists(path.join(home, ".codex/fireworks-model-catalog.json")), false);
  });

  it("keeps codex catalog when uninstall cannot disable codex", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-codex-off-fail-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });

    await runFireconnect(
      ["configure", "--harnesses", "codex", "--api-key", "fw_test_key_12345"],
      { HOME: home },
    );
    await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );

    const configPath = codexConfigPath(home);
    const catalogPath = path.join(home, ".codex/fireworks-model-catalog.json");
    await writeFile(
      configPath,
      patchCodexCatalogRefRaw(await readFile(configPath, "utf8"), CODEX_CATALOG_TOML_REF),
      "utf8",
    );
    await writeFile(catalogPath, '{"models":[]}', "utf8");

    const backupPath = codexBackupPath(codexDataDir(home), configPath);
    await writeJson(backupPath, {
      configPath: "/different/config.toml",
      snapshot: { existed: true, raw: 'model = "gpt-4.1"\n' },
    });

    const uninstallResult = await runFireconnect(["uninstall"], { HOME: home });
    assert.notEqual(uninstallResult.code, 0);
    assert.match(uninstallResult.stderr, /failed to restore codex/i);
    assert.equal(await pathExists(catalogPath), true);
    assert.match(await readFile(configPath, "utf8"), /model_catalog_json/);
  });

  it("keeps codex catalog on uninstall when restored config still references it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-keep-catalog-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });

    await runFireconnect(
      ["configure", "--harnesses", "codex", "--api-key", "fw_test_key_12345"],
      { HOME: home },
    );
    await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );

    const configPath = codexConfigPath(home);
    const catalogPath = path.join(home, ".codex/fireworks-model-catalog.json");
    await writeFile(
      configPath,
      patchCodexCatalogRefRaw(await readFile(configPath, "utf8"), CODEX_CATALOG_TOML_REF),
      "utf8",
    );
    await writeFile(catalogPath, '{"models":[]}', "utf8");

    const original = [
      'model_provider = "openai"',
      `model_catalog_json = "${CODEX_CATALOG_TOML_REF}"`,
      'model = "gpt-4.1"',
      "",
    ].join("\n");
    await writeJson(codexBackupPath(codexDataDir(home), configPath), {
      configPath: path.resolve(configPath),
      snapshot: { existed: true, raw: original },
    });

    const offResult = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.equal(await pathExists(catalogPath), true);

    const uninstallResult = await runFireconnect(["uninstall"], { HOME: home });
    assert.equal(uninstallResult.code, 0);
    assert.equal(await pathExists(catalogPath), true);
    assert.match(await readFile(configPath, "utf8"), /model_catalog_json/);
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
      ["configure", "--harnesses", "claude", "--api-key", "fw_test_key_12345"],
      { HOME: home },
    );

    const uninstallResult = await runFireconnect(["uninstall"], { HOME: home });
    assert.equal(uninstallResult.code, 0);

    const after = await readFile(settingsPath, "utf8");
    assert.equal(after, originalSettings);
  });
});
