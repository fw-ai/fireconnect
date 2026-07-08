import { mkdtemp, readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deepagentsAuthPath,
  deepagentsConfigPath,
} from "../lib/deepagents-core.mjs";
import { FIREWORKS_API_KEY_KEYCHAIN_REF, globalConfigPath } from "../lib/global-config.mjs";
import { readJsonIfExists } from "../lib/fireconnect-core.mjs";
import {
  runFireconnect,
  seedKeychainConfig,
  withoutEnvFireworksKey,
} from "./helpers.mjs";

describe("deepagents harness integration", () => {
  it("on/off round-trip restores config.toml and leaves auth.json unchanged", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepagents-"));
    const configDir = path.join(home, ".deepagents");
    await mkdir(configDir, { recursive: true });
    const configPath = deepagentsConfigPath(home);
    const authPath = deepagentsAuthPath(home);
    const original = [
      "[models]",
      'default = "anthropic:claude-sonnet-4-5"',
      "",
      "[ui]",
      'theme = "dark"',
      "",
    ].join("\n");
    await mkdir(path.dirname(authPath), { recursive: true });
    const originalAuth = {
      version: 1,
      credentials: {
        anthropic: {
          type: "api_key",
          key: "sk-ant-test",
          added_at: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    await writeJsonFile(authPath, originalAuth);
    await writeFile(configPath, original);

    const onResult = await runFireconnect(
      ["deepagents", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0);

    const enabled = await readFile(configPath, "utf8");
    assert.match(enabled, /default = "fireworks:accounts\/fireworks\/routers\/glm-fast-latest"/);
    assert.match(enabled, /\[models\.providers\.fireworks\]/);
    assert.match(enabled, /base_url = "https:\/\/api\.fireworks\.ai\/inference"/);
    assert.match(enabled, /api_key_env = "FIREWORKS_API_KEY"/);
    assert.match(enabled, /\[ui\]/);
    assert.equal((enabled.match(/^\[models\]$/gm) || []).length, 1);

    const authAfterOn = await readJsonIfExists(authPath);
    assert.deepEqual(authAfterOn, originalAuth);

    const globalConfig = await readJsonIfExists(globalConfigPath(home));
    assert.equal(globalConfig.apiKey, FIREWORKS_API_KEY_KEYCHAIN_REF);

    const offResult = await runFireconnect(["deepagents", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /original config restored/);

    const restored = await readFile(configPath, "utf8");
    assert.equal(restored, original);

    const restoredAuth = await readJsonIfExists(authPath);
    assert.deepEqual(restoredAuth, originalAuth);
  });

  it("on resolves API key from keychain when env is unset", async () => {
    await withoutEnvFireworksKey(async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepagents-keychain-"));
      await mkdir(path.join(home, ".deepagents"), { recursive: true });
      await seedKeychainConfig(home, "fw_test_key_12345");

      const onResult = await runFireconnect(["deepagents", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
      assert.equal(onResult.code, 0);
      assert.match(onResult.stdout, /api_key_env FIREWORKS_API_KEY/);

      const config = await readFile(deepagentsConfigPath(home), "utf8");
      assert.match(config, /api_key_env = "FIREWORKS_API_KEY"/);
    });
  });

  it("on with env only writes api_key_env reference", async () => {
    await withoutEnvFireworksKey(async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepagents-env-"));
      await mkdir(path.join(home, ".deepagents"), { recursive: true });

      const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };
      const onResult = await runFireconnect(["deepagents", "on"], env);
      assert.equal(onResult.code, 0);
      assert.match(onResult.stdout, /api_key_env FIREWORKS_API_KEY/);

      const config = await readFile(deepagentsConfigPath(home), "utf8");
      assert.match(config, /api_key_env = "FIREWORKS_API_KEY"/);
    });
  });

  it("on leaves dcode auth.json credentials untouched", async () => {
    await withoutEnvFireworksKey(async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepagents-dcode-auth-"));
      const authPath = deepagentsAuthPath(home);
      await mkdir(path.dirname(authPath), { recursive: true });
      const dcodeAuth = {
        version: 1,
        credentials: {
          fireworks: {
            type: "api_key",
            key: "fw_dcode_native_key_12345",
            added_at: "2026-01-01T00:00:00.000Z",
          },
          anthropic: {
            type: "api_key",
            key: "sk-ant-dcode",
            added_at: "2026-01-01T00:00:00.000Z",
          },
        },
      };
      await writeJsonFile(authPath, dcodeAuth);
      await mkdir(path.join(home, ".deepagents"), { recursive: true });

      const onResult = await runFireconnect(
        ["deepagents", "on", "--api-key", "fw_test_key_12345"],
        { HOME: home, FIREWORKS_API_KEY: "" },
      );
      assert.equal(onResult.code, 0);

      const auth = await readJsonIfExists(authPath);
      assert.deepEqual(auth, dcodeAuth);
    });
  });

  it("on snapshots duplicate [models] config so off can restore the original raw", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepagents-dup-models-"));
    const configPath = deepagentsConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });

    const original = [
      "[models]",
      'default = "anthropic:claude-sonnet-4-5"',
      "",
      "[models]",
      'default = "fireworks:accounts/fireworks/routers/glm-fast-latest"',
      "",
      "[models.providers.fireworks]",
      'base_url = "https://api.fireworks.ai/inference"',
      "enabled = true",
      'models = ["accounts/fireworks/routers/glm-fast-latest"]',
      "",
      "[ui]",
      'theme = "dark"',
      "",
    ].join("\n");
    await writeFile(configPath, original);

    const onResult = await runFireconnect(
      ["deepagents", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0);

    const enabled = await readFile(configPath, "utf8");
    assert.equal((enabled.match(/^\[models\]$/gm) || []).length, 1);

    const offResult = await runFireconnect(["deepagents", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /original config restored/);

    const restored = await readFile(configPath, "utf8");
    assert.equal(restored, original);
  });

  it("status reports fireworks provider after on", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepagents-status-"));
    await mkdir(path.join(home, ".deepagents"), { recursive: true });

    const onResult = await runFireconnect(
      ["deepagents", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0);

    const statusResult = await runFireconnect(
      ["deepagents", "status", "--json"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(statusResult.code, 0);
    const payload = JSON.parse(statusResult.stdout);
    assert.equal(payload.harness, "deepagents");
    assert.equal(payload.provider, "fireworks");
    assert.equal(payload.apiKeyMode, "env-reference");
    assert.equal(payload.current.main, "accounts/fireworks/routers/glm-fast-latest");
  });
});

async function writeJsonFile(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data)}\n`, "utf8");
  await chmod(filePath, 0o600);
}
