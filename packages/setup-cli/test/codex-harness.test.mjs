import { mkdtemp, readFile, writeFile, mkdir, unlink, access, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { codexBackupPath, codexConfigPath, codexDataDir } from "../lib/codex-core.mjs";
import { writeJson } from "../lib/fireconnect-core.mjs";
import { writeGlobalConfig } from "../lib/global-config.mjs";
import { FPK_KEY, withoutEnvFireworksKey } from "./helpers.mjs";

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

describe("codex harness integration", () => {
  it("on/off round-trip restores config.toml", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-"));
    const configDir = path.join(home, ".codex");
    await mkdir(configDir, { recursive: true });
    const configPath = codexConfigPath(home);
    const original = [
      'model_provider = "openai"',
      'model = "gpt-4.1"',
      "",
      "[[mcp_servers]]",
      'name = "test"',
      'command = "echo"',
      "",
    ].join("\n");
    await writeFile(configPath, original);

    const onResult = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);

    const enabled = await readFile(configPath, "utf8");
    assert.match(enabled, /model_provider = "fireworks-ai"/);
    assert.match(enabled, /\[model_providers\.fireworks-ai\]/);
    assert.doesNotMatch(enabled, /profile = "fireconnect"/);
    assert.doesNotMatch(enabled, /\[profiles\.fireconnect\]/);
    assert.match(enabled, /experimental_bearer_token = "fw_test_key_12345"/);
    assert.match(enabled, /wire_api = "responses"/);
    assert.match(enabled, /\[\[mcp_servers\]\]/);

    const offResult = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /original config restored/);

    const restored = await readFile(configPath, "utf8");
    assert.equal(restored, original);
  });

  it("on resolves API key from global config when env is unset", async () => {
    await withoutEnvFireworksKey(async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-global-"));
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await writeGlobalConfig(home, {
        apiKey: "fw_test_key_12345",
        harnesses: { codex: { enabled: false } },
      });

      const onResult = await runFireconnect(["codex", "on"], { HOME: home });
      assert.equal(onResult.code, 0);
      assert.match(onResult.stdout, /API key written into ~\/\.codex\/config\.toml \(passed via --api-key\)/);

      const configPath = codexConfigPath(home);
      const enabled = await readFile(configPath, "utf8");
      assert.match(enabled, /model_provider = "fireworks-ai"/);
      assert.doesNotMatch(enabled, /profile = "fireconnect"/);
    });
  });

  it("on with env only writes env_key reference", async () => {
    await withoutEnvFireworksKey(async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-env-on-"));
      await mkdir(path.join(home, ".codex"), { recursive: true });

      const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };
      const onResult = await runFireconnect(["codex", "on"], env);
      assert.equal(onResult.code, 0);
      assert.match(onResult.stdout, /env_key FIREWORKS_API_KEY/);

      const config = await readFile(codexConfigPath(home), "utf8");
      assert.match(config, /env_key = "FIREWORKS_API_KEY"/);
      assert.doesNotMatch(config, /experimental_bearer_token/);
    });
  });

  it("on with --api-key restricts config.toml to owner-only (0o600)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-perms-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const configPath = codexConfigPath(home);

    const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };
    const onResult = await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env);
    assert.equal(onResult.code, 0);

    const enabled = await readFile(configPath, "utf8");
    assert.match(enabled, /experimental_bearer_token = "fw_test_key_12345"/);

    const st = await stat(configPath);
    // Mask off file-type bits; expect owner-only read/write (0o600).
    assert.equal(st.mode & 0o777, 0o600, "config.toml should be 0o600 when a literal key is written");
  });

  it("on with env reference does not tighten config.toml permissions", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-env-perms-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const configPath = codexConfigPath(home);

    const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };
    const onResult = await runFireconnect(["codex", "on"], env);
    assert.equal(onResult.code, 0);

    const enabled = await readFile(configPath, "utf8");
    assert.match(enabled, /env_key = "FIREWORKS_API_KEY"/);
    assert.doesNotMatch(enabled, /experimental_bearer_token/);

    // No literal key, so the mode should NOT be forced to 0o600. We only assert
    // it is writable+readable by owner (the 0o600 bit is not required here).
    const st = await stat(configPath);
    assert.equal(st.mode & 0o700, 0o600, "config.toml should remain owner-readable/writable");
  });

  it("off strips routing when backup is missing or contains Fireworks config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-backup-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const configPath = codexConfigPath(home);
    const original = [
      'model_provider = "openai"',
      'model = "gpt-4.1"',
    ].join("\n") + "\n";
    await writeFile(configPath, original);

    const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };
    assert.equal((await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env)).code, 0);

    const backupPath = codexBackupPath(codexDataDir(home), configPath);
    await unlink(backupPath);

    assert.equal((await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env)).code, 0);
    await assert.rejects(access(backupPath));

    let offResult = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /FireConnect routing removed from config\.toml/);

    let restored = await readFile(configPath, "utf8");
    assert.doesNotMatch(restored, /model_provider = "fireworks-ai"/);
    assert.doesNotMatch(restored, /\[model_providers\.fireworks-ai\]/);

    assert.equal((await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env)).code, 0);
    const fireworksConfig = await readFile(configPath, "utf8");
    await writeJson(backupPath, {
      configPath: path.resolve(configPath),
      snapshot: { existed: true, raw: fireworksConfig },
    });

    offResult = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /FireConnect routing removed from config\.toml/);

    restored = await readFile(configPath, "utf8");
    assert.doesNotMatch(restored, /model_provider = "fireworks-ai"/);
    await assert.rejects(access(backupPath));
  });

  it("on snapshots and off restores when user already has fireworks-ai provider", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-existing-provider-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const configPath = codexConfigPath(home);
    const original = [
      'model_provider = "fireworks-ai"',
      'model = "accounts/fireworks/models/custom-model"',
      "",
      "[model_providers.fireworks-ai]",
      'name = "My Fireworks"',
      'base_url = "https://custom.example/v1"',
      'env_key = "FIREWORKS_API_KEY"',
      "",
    ].join("\n");
    await writeFile(configPath, original);

    const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };
    assert.equal((await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env)).code, 0);

    const enabled = await readFile(configPath, "utf8");
    assert.match(enabled, /model_provider = "fireworks-ai"/);
    assert.doesNotMatch(enabled, /profile = "fireconnect"/);
    assert.match(enabled, /base_url = "https:\/\/api\.fireworks\.ai\/inference\/v1"/);

    const offResult = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /original config restored/);

    const restored = await readFile(configPath, "utf8");
    assert.equal(restored, original);
  });

  it("codex on rejects Fire Pass key with helpful error", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-fpk-env-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });

    const env = {
      HOME: home,
      FIREWORKS_API_KEY: "fw_test_key_different_000000",
    };
    const result = await runFireconnect(["codex", "on", "--api-key", FPK_KEY], env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /\/responses endpoint is not supported for Fire Pass keys yet/);
    assert.match(result.stderr, /standard Fireworks API key/);
  });

  it("model reset keeps stored bearer when FIREWORKS_API_KEY env differs", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-reset-env-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });

    const env = {
      HOME: home,
      FIREWORKS_API_KEY: "fw_test_key_different_000000",
    };
    assert.equal(
      (await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env)).code,
      0,
    );

    const resetResult = await runFireconnect(["codex", "model", "reset"], env);
    assert.equal(resetResult.code, 0);

    const config = await readFile(codexConfigPath(home), "utf8");
    assert.match(config, /experimental_bearer_token = "fw_test_key_12345"/);
    assert.doesNotMatch(config, /fw_test_key_different/);
  });

  it("codex on rejects Fire Pass key sourced from global config", async () => {
    await withoutEnvFireworksKey(async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-reset-"));
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await writeGlobalConfig(home, {
        apiKey: FPK_KEY,
        harnesses: { codex: { enabled: false } },
      });

      const env = { HOME: home };
      const result = await runFireconnect(["codex", "on"], env);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /\/responses endpoint is not supported for Fire Pass keys yet/);
      assert.match(result.stderr, /standard Fireworks API key/);
    });
  });
});
