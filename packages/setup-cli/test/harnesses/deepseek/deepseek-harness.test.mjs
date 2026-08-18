import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deepseekBackupPath,
  deepseekCredentialsPath,
  deepseekCurrentModelId,
  deepseekDataDir,
  deepseekSettingsPath,
  buildDeepseekFireworksModelEntry,
  patchDeepseekFireworksSettings,
  readDeepseekSettingsIfExists,
} from "../../../lib/harnesses/deepseek/core.mjs";
import { writeGlobalConfig } from "../../../lib/config/global-config.mjs";
import { lookupFireworksModelLimits } from "../../../lib/fireworks/model-specs.mjs";
import { readJsonIfExists } from "../../../lib/io/json.mjs";
import { resetSecretStoreForTests } from "../../../lib/keys/secret-store.mjs";
import {
  FPK_KEY,
  runFireconnect,
  seedKeychainConfig,
} from "../../helpers.mjs";

describe("buildDeepseekFireworksModelEntry catalog metadata", () => {
  it("registers firerouter with shared catalog limits", () => {
    const entry = buildDeepseekFireworksModelEntry("firerouter", "FireRouter");
    const limits = lookupFireworksModelLimits("firerouter");

    assert.equal(entry.id, "firerouter");
    assert.equal(entry.contextWindow, limits.contextWindow);
    assert.equal(entry.maxTokens, limits.maxTokens);
    assert.equal(entry.contextWindow, 1_048_575);
    assert.deepEqual(entry.input, ["text", "image"]);
    assert.equal(entry.reasoning, true);
  });

  it("registers serverless models with shared catalog limits", () => {
    const entry = buildDeepseekFireworksModelEntry("deepseek-v4-flash", "DeepSeek V4 Flash");
    const limits = lookupFireworksModelLimits("deepseek-v4-flash");

    assert.equal(entry.id, "deepseek-v4-flash");
    assert.equal(entry.contextWindow, limits.contextWindow);
    assert.equal(entry.maxTokens, limits.maxTokens);
  });
});

describe("patchDeepseekFireworksSettings catalog metadata", () => {
  it("wires the deepseek wrapper into settings.yaml model rows", () => {
    const patched = patchDeepseekFireworksSettings({}, { modelId: "firerouter" });
    const entry = patched["llm-pi-ai"].providers.fireworks.models[0];
    assert.equal(entry.id, "firerouter");
    assert.equal(entry.contextWindow, 1_048_575);
    assert.deepEqual(entry.input, ["text", "image"]);
  });
});

describe("deepseek harness integration", () => {
  it("rejects explicit firerouter without workspace BYOK", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-firerouter-manual-"));
    await mkdir(path.join(home, ".dsh"), { recursive: true });
    const result = await runFireconnect(
      [
        "deepseek",
        "on",
        "--api-key",
        "fw_test_key_12345",
        "--model",
        "accounts/fireworks/routers/firerouter",
      ],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Ask the Fireworks team to enable FireRouter/);
  });

  it("firerouter is rejected for Fire Pass keys", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-firerouter-firepass-"));
    const result = await runFireconnect(
      ["deepseek", "on", "--api-key", FPK_KEY, "--model", "firerouter"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /FireRouter is not available for Fire Pass keys/);
  });

  it("firerouter is allowed when workspace BYOK is enabled", async () => {
    const gateway = await new Promise((resolve) => {
      const server = createServer((req, res) => {
        if (req.url === "/verifyApiKey") {
          res.writeHead(200, {
            "x-fireworks-account-id": "acct-workspace-byok",
          });
          res.end();
          return;
        }
        if (/^\/v1\/accounts\/[^/]+\/featureFlags$/.test(req.url ?? "")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            featureFlags: [{
              name: "accounts/acct-workspace-byok/featureFlags/enable-workspace-byok",
              value: "true",
            }],
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
    });
    try {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-firerouter-workspace-byok-"));
      await mkdir(path.join(home, ".dsh"), { recursive: true });
      const result = await runFireconnect(
        [
          "deepseek", "on",
          "--api-key", "fw_test_key_12345",
          "--model", "firerouter",
        ],
        {
          HOME: home,
          FIREWORKS_API_KEY: "",
          FIRECONNECT_GATEWAY_URL: gateway.url,
          FIRECONNECT_GATEWAY_GRPC_WEB_URL: `${gateway.url}/grpc`,
        },
      );
      assert.equal(result.code, 0, result.stderr);
      const settingsPath = deepseekSettingsPath(home);
      const settings = await readFile(settingsPath, "utf8");
      assert.match(settings, /model: firerouter/);
      assert.match(settings, /contextWindow: 1048575/);
      const { settings: doc } = await readDeepseekSettingsIfExists(settingsPath);
      assert.equal(deepseekCurrentModelId(doc), "firerouter");
      assert.equal(
        doc["llm-pi-ai"].providers.fireworks.models[0].contextWindow,
        1_048_575,
      );
      assert.match(result.stdout, /FireRouter is on/);
    } finally {
      gateway.server.close();
    }
  });

  it("on/off round-trip restores settings.yaml and credentials.yaml", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-"));
    await mkdir(path.join(home, ".dsh"), { recursive: true });
    const settingsPath = deepseekSettingsPath(home);
    const credentialsPath = deepseekCredentialsPath(home);
    const originalSettings = [
      "theme:",
      "  mode: dark",
      "",
    ].join("\n");
    const originalCredentials = [
      "DEEPSEEK_API_KEY: sk-deepseek-test",
      "",
    ].join("\n");
    await writeFile(settingsPath, originalSettings);
    await writeFile(credentialsPath, originalCredentials);

    const onResult = await runFireconnect(
      ["deepseek", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const enabledSettings = await readFile(settingsPath, "utf8");
    assert.match(enabledSettings, /provider: fireworks/);
    assert.match(enabledSettings, /apiKeyEnv: FIREWORKS_API_KEY/);
    assert.match(enabledSettings, /baseURL: https:\/\/api\.fireworks\.ai\/inference\/v1/);
    assert.match(enabledSettings, /kimi-fast-latest/);
    assert.match(enabledSettings, /mode: dark/);

    const enabledCredentials = await readFile(credentialsPath, "utf8");
    assert.match(enabledCredentials, /FIREWORKS_API_KEY: fw_test_key_12345/);
    assert.match(enabledCredentials, /DEEPSEEK_API_KEY: sk-deepseek-test/);

    const offResult = await runFireconnect(["deepseek", "off"], { HOME: home });
    assert.equal(offResult.code, 0, offResult.stderr);
    assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
    assert.equal(await readFile(credentialsPath, "utf8"), originalCredentials);
  });

  it("on bakes keychain key into credentials", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-keychain-"));
    await mkdir(path.join(home, ".dsh"), { recursive: true });
    await seedKeychainConfig(home, "fw_test_key_12345");
    const onResult = await runFireconnect(["deepseek", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(onResult.code, 0, onResult.stderr);
    assert.match(onResult.stdout, /DeepSeek Harness → Fireworks · kimi-fast-latest/);

    const credentials = await readFile(deepseekCredentialsPath(home), "utf8");
    assert.match(credentials, /FIREWORKS_API_KEY: fw_test_key_12345/);
  });

  it("on reuses baked credentials when global config and env are unset", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-reuse-"));
    await mkdir(path.join(home, ".dsh"), { recursive: true });
    const first = await runFireconnect(
      ["deepseek", "on", "--api-key", "fw_test_key_12345", "--model", "deepseek-v4-flash"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(first.code, 0, first.stderr);

    await writeGlobalConfig(home, { apiKey: "" });
    resetSecretStoreForTests();

    const second = await runFireconnect(
      ["deepseek", "on", "--model", "kimi-fast-latest"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(second.code, 0, second.stderr);
    assert.match(await readFile(deepseekSettingsPath(home), "utf8"), /kimi-fast-latest/);
    assert.match(
      await readFile(deepseekCredentialsPath(home), "utf8"),
      /FIREWORKS_API_KEY: fw_test_key_12345/,
    );
  });

  it("status reports fireworks provider and model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepseek-status-"));
    await mkdir(path.join(home, ".dsh"), { recursive: true });
    const on = await runFireconnect(
      ["deepseek", "on", "--api-key", "fw_test_key_12345", "--model", "deepseek-v4-flash"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);

    const status = await runFireconnect(
      ["deepseek", "status", "--json"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(status.code, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.harness, "deepseek");
    assert.equal(payload.provider, "fireworks");
    assert.equal(payload.current.main, "deepseek-v4-flash");
    assert.equal(payload.hasAuthToken, true);

    const backupPath = deepseekBackupPath(deepseekDataDir(home), deepseekSettingsPath(home));
    assert.equal((await readJsonIfExists(backupPath)).settingsSnapshot !== undefined, true);

    const off = await runFireconnect(["deepseek", "off"], { HOME: home });
    assert.equal(off.code, 0, off.stderr);
    const after = await runFireconnect(["deepseek", "status", "--json"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(after.code, 0, after.stderr);
    assert.equal(JSON.parse(after.stdout).provider, null);
  });
});
