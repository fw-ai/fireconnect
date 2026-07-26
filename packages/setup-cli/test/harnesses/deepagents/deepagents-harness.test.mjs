import { mkdtemp, readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deepagentsBackupPath,
  deepagentsAuthPath,
  deepagentsConfigPath,
  deepagentsDataDir,
  deepagentsCurrentModelId,
  readDeepagentsTomlIfExists,
} from "../../../lib/harnesses/deepagents/core.mjs";
import { FIREWORKS_API_KEY_KEYCHAIN_REF, globalConfigPath } from "../../../lib/config/global-config.mjs";
import { readJsonIfExists } from "../../../lib/io/json.mjs";
import {
  FPK_KEY,
  runFireconnect,
  seedKeychainConfig,
  withoutEnvFireworksKey,
} from "../../helpers.mjs";

describe("deepagents harness integration", () => {
  it("rejects explicit firerouter without workspace BYOK", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepagents-firerouter-manual-"));
    await mkdir(path.join(home, ".deepagents"), { recursive: true });
    const result = await runFireconnect(
      [
        "deepagents",
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
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepagents-firerouter-firepass-"));
    const result = await runFireconnect(
      ["deepagents", "on", "--api-key", FPK_KEY, "--model", "firerouter"],
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
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepagents-firerouter-workspace-byok-"));
      await mkdir(path.join(home, ".deepagents"), { recursive: true });
      const result = await runFireconnect(
        [
          "deepagents", "on",
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
      const configPath = deepagentsConfigPath(home);
      const config = await readFile(configPath, "utf8");
      assert.match(config, /default = "fireworks:firerouter"/);
      const { doc } = await readDeepagentsTomlIfExists(configPath);
      assert.equal(deepagentsCurrentModelId(doc), "firerouter");
      assert.match(result.stdout, /FireRouter is on/);
    } finally {
      gateway.server.close();
    }
  });

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
    assert.match(enabled, /default = "fireworks:glm-fast-latest"/);
    assert.match(enabled, /models = \["glm-fast-latest"\]/);
    assert.match(enabled, /\[models\.providers\.fireworks\]/);
    assert.match(enabled, /base_url = "https:\/\/api\.fireworks\.ai\/inference"/);
    assert.match(enabled, /api_key = "fw_test_key_12345"/);
    assert.match(enabled, /\[ui\]/);
    assert.equal((enabled.match(/^\[models\]$/gm) || []).length, 1);

    const authAfterOn = await readJsonIfExists(authPath);
    assert.deepEqual(authAfterOn, originalAuth);

    const globalConfig = await readJsonIfExists(globalConfigPath(home));
    assert.equal(globalConfig.apiKey, FIREWORKS_API_KEY_KEYCHAIN_REF);

    const offResult = await runFireconnect(["deepagents", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /restored to your previous setup/);

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
      assert.match(onResult.stdout, /Deep Agents → Fireworks · glm-fast-latest/);

      const config = await readFile(deepagentsConfigPath(home), "utf8");
      assert.match(config, /api_key = "fw_test_key_12345"/);
    });
  });

  it("on with env only writes a literal api_key", async () => {
    await withoutEnvFireworksKey(async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepagents-env-"));
      await mkdir(path.join(home, ".deepagents"), { recursive: true });

      const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };
      const onResult = await runFireconnect(["deepagents", "on"], env);
      assert.equal(onResult.code, 0);
      assert.match(onResult.stdout, /Deep Agents → Fireworks · glm-fast-latest/);

      const config = await readFile(deepagentsConfigPath(home), "utf8");
      assert.match(config, /api_key = "fw_test_key_12345"/);
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
    assert.match(enabled, /default = "fireworks:glm-fast-latest"/);

    const offResult = await runFireconnect(["deepagents", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /restored to your previous setup/);

    const restored = await readFile(configPath, "utf8");
    assert.equal(restored, original);
  });

  it("re-on migrates legacy canonical routing without backing it up", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-deepagents-legacy-model-"));
    const configPath = deepagentsConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      "[models]",
      'default = "fireworks:accounts/fireworks/routers/glm-fast-latest"',
      "",
      "[models.providers.fireworks]",
      'base_url = "https://api.fireworks.ai/inference"',
      "enabled = true",
      'models = ["accounts/fireworks/routers/glm-fast-latest"]',
      'api_key_env = "FIREWORKS_API_KEY"',
      "",
    ].join("\n"));

    const on = await runFireconnect(
      ["deepagents", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);
    const migrated = await readFile(configPath, "utf8");
    assert.match(migrated, /default = "fireworks:glm-fast-latest"/);
    assert.match(migrated, /models = \["glm-fast-latest"\]/);
    const backupPath = deepagentsBackupPath(deepagentsDataDir(home), configPath);
    assert.equal((await readJsonIfExists(backupPath)).snapshot, undefined);

    const off = await runFireconnect(["deepagents", "off"], { HOME: home });
    assert.equal(off.code, 0, off.stderr);
    const stripped = await readFile(configPath, "utf8");
    assert.doesNotMatch(stripped, /fireworks:|models\.providers\.fireworks/);
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
    assert.equal(payload.apiKeyMode, "literal");
    assert.equal(payload.current.main, "glm-fast-latest");

    const off = await runFireconnect(["deepagents", "off"], {
      HOME: home,
      FIREWORKS_API_KEY: "fw_test_key_12345",
    });
    assert.equal(off.code, 0, off.stderr);
    const after = await runFireconnect(["deepagents", "status", "--json"], {
      HOME: home,
      FIREWORKS_API_KEY: "fw_test_key_12345",
    });
    assert.equal(after.code, 0, after.stderr);
    assert.equal(JSON.parse(after.stdout).provider, "default");
  });
});

async function writeJsonFile(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data)}\n`, "utf8");
  await chmod(filePath, 0o600);
}
