import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  kimiBackupPath,
  kimiConfigPath,
  kimiDataDir,
  kimiCurrentModelId,
  readKimiTomlIfExists,
  refreshKimiGatewayKey,
} from "../../../lib/harnesses/kimi/core.mjs";
import { FIREWORKS_API_KEY_KEYCHAIN_REF, globalConfigPath } from "../../../lib/config/global-config.mjs";
import { readJsonIfExists } from "../../../lib/io/json.mjs";
import {
  FPK_KEY,
  runFireconnect,
  seedKeychainConfig,
  withoutEnvFireworksKey,
} from "../../helpers.mjs";

describe("kimi harness integration", () => {
  it("firerouter is rejected for Fire Pass keys", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-kimi-firerouter-firepass-"));
    const result = await runFireconnect(
      ["kimi", "on", "--api-key", FPK_KEY, "--model", "firerouter"],
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
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-kimi-firerouter-workspace-byok-"));
      await mkdir(path.join(home, ".kimi-code"), { recursive: true });
      const result = await runFireconnect(
        [
          "kimi", "on",
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
      const configPath = kimiConfigPath(home);
      const config = await readFile(configPath, "utf8");
      assert.match(config, /default_model = "fireworks\/firerouter"/);
      const { doc } = await readKimiTomlIfExists(configPath);
      assert.equal(kimiCurrentModelId(doc), "firerouter");
      assert.match(result.stdout, /FireRouter is on/);
    } finally {
      gateway.server.close();
    }
  });

  it("on/off round-trip restores config.toml byte-for-byte", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-kimi-"));
    await mkdir(path.join(home, ".kimi-code"), { recursive: true });
    const configPath = kimiConfigPath(home);
    const original = [
      'default_model = "kimi-code/k3"',
      "",
      "[providers.custom]",
      'type = "openai"',
      'base_url = "https://my-gateway.example/v1"',
      'api_key = "user-key"',
      "",
    ].join("\n");
    await writeFile(configPath, original);

    const onResult = await runFireconnect(
      ["kimi", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const enabled = await readFile(configPath, "utf8");
    assert.match(enabled, /default_model = "fireworks\/kimi-fast-latest"/);
    assert.match(enabled, /\[providers\.fireworks\]/);
    assert.match(enabled, /type = "openai"/);
    assert.match(enabled, /base_url = "https:\/\/api\.fireworks\.ai\/inference\/v1"/);
    assert.match(enabled, /api_key = "fw_test_key_12345"/);
    assert.match(enabled, /\[models\."fireworks\/kimi-fast-latest"\]/);
    assert.match(enabled, /provider = "fireworks"/);
    assert.match(enabled, /model = "kimi-fast-latest"/);
    assert.match(enabled, /max_context_size = \d+/);
    assert.match(enabled, /capabilities = \["image_in", "tool_use", "thinking"\]/);
    assert.match(enabled, /\[providers\.custom\]/);
    assert.doesNotMatch(enabled, /default_model = "kimi-code\/k3"/);

    const globalConfig = await readJsonIfExists(globalConfigPath(home));
    assert.equal(globalConfig.apiKey, FIREWORKS_API_KEY_KEYCHAIN_REF);

    const offResult = await runFireconnect(["kimi", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /restored to your previous setup/);

    const restored = await readFile(configPath, "utf8");
    assert.equal(restored, original);
  });

  it("on resolves API key from keychain when env is unset", async () => {
    await withoutEnvFireworksKey(async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-kimi-keychain-"));
      await mkdir(path.join(home, ".kimi-code"), { recursive: true });
      await seedKeychainConfig(home, "fw_test_key_12345");

      const onResult = await runFireconnect(["kimi", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
      assert.equal(onResult.code, 0);
      assert.match(onResult.stdout, /Kimi Code → Fireworks · kimi-fast-latest/);

      const config = await readFile(kimiConfigPath(home), "utf8");
      assert.match(config, /api_key = "fw_test_key_12345"/);
    });
  });

  it("on with env only writes a literal api_key", async () => {
    await withoutEnvFireworksKey(async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-kimi-env-"));
      await mkdir(path.join(home, ".kimi-code"), { recursive: true });

      const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };
      const onResult = await runFireconnect(["kimi", "on"], env);
      assert.equal(onResult.code, 0);

      const config = await readFile(kimiConfigPath(home), "utf8");
      assert.match(config, /api_key = "fw_test_key_12345"/);
    });
  });

  it("on with --model writes that model's alias and entry", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-kimi-model-"));
    await mkdir(path.join(home, ".kimi-code"), { recursive: true });

    const onResult = await runFireconnect(
      ["kimi", "on", "--api-key", "fw_test_key_12345", "--model", "accounts/fireworks/models/deepseek-v4-flash"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const configPath = kimiConfigPath(home);
    const config = await readFile(configPath, "utf8");
    assert.match(config, /default_model = "fireworks\/deepseek-v4-flash"/);
    assert.match(config, /\[models\."fireworks\/deepseek-v4-flash"\]/);
    const { doc } = await readKimiTomlIfExists(configPath);
    assert.equal(kimiCurrentModelId(doc), "deepseek-v4-flash");
  });

  it("re-on of a managed config without backup strips on off", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-kimi-managed-"));
    const configPath = kimiConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      'default_model = "fireworks/glm-5p2-fast"',
      "",
      "[providers.fireworks]",
      'type = "openai"',
      'base_url = "https://api.fireworks.ai/inference/v1"',
      'api_key = "fw_old_key_12345"',
      "",
      '[models."fireworks/glm-5p2-fast"]',
      'provider = "fireworks"',
      'model = "glm-5p2-fast"',
      "max_context_size = 128000",
      'capabilities = ["tool_use"]',
      "",
    ].join("\n"));

    const on = await runFireconnect(
      ["kimi", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);
    const reenabled = await readFile(configPath, "utf8");
    assert.match(reenabled, /default_model = "fireworks\/glm-5p2-fast"/);
    assert.match(reenabled, /api_key = "fw_test_key_12345"/);
    const backupPath = kimiBackupPath(kimiDataDir(home), configPath);
    assert.equal((await readJsonIfExists(backupPath)).snapshot, undefined);

    const off = await runFireconnect(["kimi", "off"], { HOME: home });
    assert.equal(off.code, 0, off.stderr);
    const stripped = await readFile(configPath, "utf8");
    assert.doesNotMatch(stripped, /fireworks/);
  });

  it("repeated on leaves the config unchanged", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-kimi-idempotent-"));
    const configPath = kimiConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '# header comment\ndefault_model = "kimi-code/k3"\n\n[tui]\ntheme = "dark"\n');

    const snapshots = [];
    for (let i = 0; i < 3; i += 1) {
      const result = await runFireconnect(
        ["kimi", "on", "--api-key", "fw_test_key_12345"],
        { HOME: home, FIREWORKS_API_KEY: "" },
      );
      assert.equal(result.code, 0, result.stderr);
      snapshots.push(await readFile(configPath, "utf8"));
    }
    assert.equal(snapshots[1], snapshots[0]);
    assert.equal(snapshots[2], snapshots[0]);
  });

  it("switching models replaces the previous model entry", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-kimi-switch-"));
    await mkdir(path.join(home, ".kimi-code"), { recursive: true });
    const configPath = kimiConfigPath(home);

    for (const model of ["glm-5p2-fast", "deepseek-v4-flash"]) {
      const result = await runFireconnect(
        ["kimi", "on", "--api-key", "fw_test_key_12345", "--model", model],
        { HOME: home, FIREWORKS_API_KEY: "" },
      );
      assert.equal(result.code, 0, result.stderr);
    }

    const config = await readFile(configPath, "utf8");
    assert.doesNotMatch(config, /glm-5p2-fast/);
    assert.equal((config.match(/^default_model/gm) || []).length, 1);
    assert.equal((config.match(/^\[providers\.fireworks\]$/gm) || []).length, 1);
    assert.equal((config.match(/^\[models\./gm) || []).length, 1);
  });

  it("on keeps a config with root-level multiline arrays parseable", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-kimi-root-array-"));
    const configPath = kimiConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    const original = [
      "skills = [",
      '  "code-review",',
      '  "docs",',
      "]",
      'default_model = "kimi-code/k3"',
      "",
      "[tui]",
      'theme = "dark"',
      "",
    ].join("\n");
    await writeFile(configPath, original);

    const onResult = await runFireconnect(
      ["kimi", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const { doc } = await readKimiTomlIfExists(configPath);
    assert.equal(doc.root.default_model, "fireworks/kimi-fast-latest");
    assert.deepEqual(doc.root.skills, ["code-review", "docs"]);
    assert.equal(kimiCurrentModelId(doc), "kimi-fast-latest");

    const offResult = await runFireconnect(["kimi", "off"], { HOME: home });
    assert.equal(offResult.code, 0, offResult.stderr);
    assert.equal(await readFile(configPath, "utf8"), original);
  });

  it("refreshKimiGatewayKey replaces only the stored api_key", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-kimi-refresh-"));
    const configPath = kimiConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    const managed = [
      'default_model = "fireworks/kimi-fast-latest"',
      "",
      "[providers.fireworks]",
      'type = "openai"',
      'base_url = "https://api.fireworks.ai/inference/v1"',
      'api_key = "fw_old_key_12345"',
      "",
      '[models."fireworks/kimi-fast-latest"]',
      'provider = "fireworks"',
      'model = "kimi-fast-latest"',
      "max_context_size = 1048576",
      'capabilities = ["image_in", "tool_use"]',
      "",
    ].join("\n");
    await writeFile(configPath, managed);

    const updated = await refreshKimiGatewayKey({ configPath, fireworksKey: "fw_new_key_67890" });
    assert.equal(updated, true);
    const refreshed = await readFile(configPath, "utf8");
    assert.equal(refreshed, managed.replace("fw_old_key_12345", "fw_new_key_67890"));

    assert.equal(
      await refreshKimiGatewayKey({ configPath, fireworksKey: "fw_new_key_67890" }),
      false,
    );
  });

  it("off without a prior on changes nothing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-kimi-noop-"));
    const off = await runFireconnect(["kimi", "off"], { HOME: home });
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, /was not connected; nothing changed/);
  });

  it("status reports fireworks provider after on", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-kimi-status-"));
    await mkdir(path.join(home, ".kimi-code"), { recursive: true });

    const onResult = await runFireconnect(
      ["kimi", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0);

    const statusResult = await runFireconnect(
      ["kimi", "status", "--json"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(statusResult.code, 0);
    const payload = JSON.parse(statusResult.stdout);
    assert.equal(payload.harness, "kimi");
    assert.equal(payload.provider, "fireworks");
    assert.equal(payload.apiKeyMode, "literal");
    assert.equal(payload.current.main, "kimi-fast-latest");

    const off = await runFireconnect(["kimi", "off"], {
      HOME: home,
      FIREWORKS_API_KEY: "fw_test_key_12345",
    });
    assert.equal(off.code, 0, off.stderr);
    const after = await runFireconnect(["kimi", "status", "--json"], {
      HOME: home,
      FIREWORKS_API_KEY: "fw_test_key_12345",
    });
    assert.equal(after.code, 0, after.stderr);
    assert.equal(JSON.parse(after.stdout).provider, "default");
  });
});
